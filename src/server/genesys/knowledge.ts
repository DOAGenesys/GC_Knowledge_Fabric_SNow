import { z } from "zod";
import { AppError } from "@/lib/errors";
import { HttpError, httpRequest } from "../http";
import { type Logger, scopedLogger } from "../log";
import { type GcAuth, gcRequest } from "./client";

/**
 * Genesys Cloud Knowledge Fabric "File Upload" sources (V3 API).
 * Flow per round: start synchronization → request upload URL per file → PUT bytes →
 * mark deletions → PATCH Completed → poll until status Completed and ingestion Complete.
 */

const log = scopedLogger("gc.knowledge");

export type GcSyncStatus = "InQueue" | "InProgress" | "PostProcessing" | "Completed" | "Failed" | "Unknown" | "Cancelled" | "Throttled";
export type GcIngestionStatus = "Unknown" | "InQueue" | "Starting" | "InProgress" | "Complete" | "Failed" | "Stopping" | "Stopped";

const errorBodySchema = z.object({ message: z.string().optional(), code: z.string().optional() }).passthrough().nullish();

const synchronizationSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    status: z.string().optional(),
    ingestionStatus: z.string().optional(),
    dateStart: z.string().optional(),
    dateEnd: z.string().optional(),
    statistics: z
      .object({ synchronizedItemCount: z.number().optional(), failedItemCount: z.number().optional() })
      .partial()
      .nullish(),
    error: errorBodySchema,
  })
  .passthrough();

export type GcSynchronization = z.infer<typeof synchronizationSchema>;

const sourceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    status: z.string().optional(),
    dateModified: z.string().optional(),
    lastSync: synchronizationSchema.partial().extend({ id: z.string().optional() }).nullish(),
  })
  .passthrough();

export type GcSource = z.infer<typeof sourceSchema>;

const sourceListSchema = z.object({ entities: z.array(z.unknown()).default([]) }).passthrough();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("GC_REQUEST_REJECTED", {
      message: "Genesys Cloud returned an unexpected response.",
      detail: `${operation}: response did not match the expected shape (${parsed.error.issues[0]?.path.join(".") ?? "root"})`,
    });
  }
  return parsed.data;
}

export async function listFileUploadSources(auth: GcAuth, logger: Logger = log): Promise<GcSource[]> {
  const { data } = await gcRequest<unknown>(auth, {
    operation: "gc.listSources",
    method: "GET",
    path: "/api/v2/knowledge/sources",
    log: logger,
  });
  const list = parseOrThrow(sourceListSchema, data, "gc.listSources");
  const sources: GcSource[] = [];
  for (const entity of list.entities) {
    const parsed = sourceSchema.safeParse(entity);
    if (parsed.success && parsed.data.type === "FileUpload" && parsed.data.status !== "Deleted") sources.push(parsed.data);
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSource(auth: GcAuth, sourceId: string, logger: Logger = log): Promise<GcSource> {
  const { data } = await gcRequest<unknown>(auth, {
    operation: "gc.getSource",
    method: "GET",
    path: `/api/v2/knowledge/sources/${encodeURIComponent(sourceId)}`,
    notFound: "GC_SOURCE_NOT_FOUND",
    log: logger,
  });
  return parseOrThrow(sourceSchema, data, "gc.getSource");
}

/** Creates a File Upload source. Only name and type are accepted by the API. */
export async function createFileUploadSource(auth: GcAuth, name: string, logger: Logger = log): Promise<GcSource> {
  try {
    const { data } = await gcRequest<unknown>(auth, {
      operation: "gc.createSource",
      method: "POST",
      path: "/api/v2/knowledge/sources",
      body: { name, type: "FileUpload" },
      log: logger,
    });
    return parseOrThrow(sourceSchema, data, "gc.createSource");
  } catch (error) {
    if (error instanceof AppError && error.code === "GC_OUTCOME_UNKNOWN") {
      const existing = (await listFileUploadSources(auth, logger)).find((source) => source.name === name);
      if (existing) {
        logger.info("Recovered source created by an interrupted request", { sourceId: existing.id });
        return existing;
      }
    }
    throw error;
  }
}

/** Best effort: total file count per source, or an empty map without the sourceFileCount permission. */
export async function getSourceFileCounts(auth: GcAuth, sourceIds: string[], logger: Logger = log): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (sourceIds.length === 0) return counts;
  try {
    const { data } = await gcRequest<{ entities?: Array<{ source?: { id?: string }; totalFileCount?: number }> }>(auth, {
      operation: "gc.fileCounts",
      method: "POST",
      path: "/api/v2/knowledge/sources/files/counts",
      body: { sourceIds: sourceIds.slice(0, 100) },
      idempotent: true,
      log: logger,
    });
    for (const entry of data?.entities ?? []) {
      if (entry.source?.id && typeof entry.totalFileCount === "number") counts.set(entry.source.id, entry.totalFileCount);
    }
  } catch (error) {
    logger.debug("File counts unavailable", { err: error, dedupeKey: "gc.fileCounts" });
  }
  return counts;
}

export async function startSynchronization(
  auth: GcAuth,
  sourceId: string,
  type: "Incremental" | "Full",
  logger: Logger = log,
): Promise<GcSynchronization> {
  const { data } = await gcRequest<unknown>(auth, {
    operation: "gc.startSync",
    method: "POST",
    path: `/api/v2/knowledge/sources/${encodeURIComponent(sourceId)}/synchronizations`,
    body: { type },
    notFound: "GC_SOURCE_NOT_FOUND",
    conflict: "GC_SOURCE_BUSY",
    log: logger,
  });
  return parseOrThrow(synchronizationSchema, data, "gc.startSync");
}

export async function getSynchronization(auth: GcAuth, sourceId: string, syncId: string, logger: Logger = log): Promise<GcSynchronization> {
  const { data } = await gcRequest<unknown>(auth, {
    operation: "gc.getSync",
    method: "GET",
    path: `/api/v2/knowledge/sources/${encodeURIComponent(sourceId)}/synchronizations/${encodeURIComponent(syncId)}`,
    notFound: "GC_SOURCE_NOT_FOUND",
    log: logger,
  });
  return parseOrThrow(synchronizationSchema, data, "gc.getSync");
}

export async function listSynchronizations(auth: GcAuth, sourceId: string, pageSize = 10, logger: Logger = log): Promise<GcSynchronization[]> {
  const { data } = await gcRequest<{ entities?: unknown[] }>(auth, {
    operation: "gc.listSyncs",
    method: "GET",
    path: `/api/v2/knowledge/sources/${encodeURIComponent(sourceId)}/synchronizations`,
    query: { pageSize },
    notFound: "GC_SOURCE_NOT_FOUND",
    log: logger,
  });
  return (data?.entities ?? []).flatMap((entity) => {
    const parsed = synchronizationSchema.safeParse(entity);
    return parsed.success ? [parsed.data] : [];
  });
}

const uploadTicketSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.unknown()).nullish(),
  fileId: z.string().optional(),
});

export interface UploadFile {
  fileName: string;
  bytes: Uint8Array;
  contentType: string;
  contentMd5: string;
  originUri?: string;
  tags?: string[];
}

/** Requests a pre-signed URL and PUTs the file. Re-requesting a ticket for the same file name is safe. */
export async function uploadFile(auth: GcAuth, sourceId: string, syncId: string, file: UploadFile, logger: Logger = log): Promise<void> {
  const { data } = await gcRequest<unknown>(auth, {
    operation: "gc.uploadTicket",
    method: "POST",
    path: `/api/v2/knowledge/sources/${encodeURIComponent(sourceId)}/synchronizations/${encodeURIComponent(syncId)}/uploads`,
    body: {
      fileName: file.fileName,
      contentMd5: file.contentMd5,
      contentType: file.contentType,
      contentLength: file.bytes.byteLength,
      metadata: {
        ...(file.originUri ? { originUri: file.originUri } : {}),
        ...(file.tags?.length ? { tags: file.tags.map((name) => ({ name })) } : {}),
      },
    },
    idempotent: true,
    notFound: "GC_SOURCE_NOT_FOUND",
    log: logger,
  });
  const ticket = parseOrThrow(uploadTicketSchema, data, "gc.uploadTicket");
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(ticket.headers ?? {})) {
    if (typeof value === "string") headers[key] = value;
    else if (Array.isArray(value) && typeof value[0] === "string") headers[key] = value[0];
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["Content-Type"] = file.contentType;

  let response;
  try {
    response = await httpRequest({
      operation: "gc.uploadPut",
      method: "PUT",
      url: ticket.url,
      headers,
      body: file.bytes,
      timeoutMs: 60_000,
      maxResponseBytes: 64 * 1024,
      log: logger,
    });
  } catch (error) {
    throw new AppError("GC_UNAVAILABLE", {
      message: "Uploading the file to Genesys Cloud storage failed.",
      detail: `PUT upload URL: ${error instanceof HttpError ? error.kind : "request failed"}`,
      cause: error,
    });
  }
  if (!response.ok) {
    const code = response.status >= 500 || response.status === 429 ? "GC_UNAVAILABLE" : "GC_REQUEST_REJECTED";
    throw new AppError(code, {
      message: "Genesys Cloud storage rejected the file upload.",
      detail: `PUT upload URL → HTTP ${response.status}`,
    });
  }
}

/** Marks a previously synchronized file for deletion. Returns "not_found" when the file isn't in the source. */
export async function markFileForDeletion(
  auth: GcAuth,
  sourceId: string,
  syncId: string,
  fileName: string,
  logger: Logger = log,
): Promise<"marked" | "not_found"> {
  try {
    await gcRequest<unknown>(auth, {
      operation: "gc.markDeletion",
      method: "POST",
      path: `/api/v2/knowledge/sources/${encodeURIComponent(sourceId)}/synchronizations/${encodeURIComponent(syncId)}/deletions`,
      body: { fileName },
      idempotent: true,
      log: logger,
    });
    return "marked";
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return "not_found";
    throw error;
  }
}

export async function completeSynchronization(auth: GcAuth, sourceId: string, syncId: string, logger: Logger = log): Promise<GcSynchronization | null> {
  const { data } = await gcRequest<unknown>(auth, {
    operation: "gc.completeSync",
    method: "PATCH",
    path: `/api/v2/knowledge/sources/${encodeURIComponent(sourceId)}/synchronizations/${encodeURIComponent(syncId)}`,
    body: { status: "Completed" },
    notFound: "GC_SOURCE_NOT_FOUND",
    log: logger,
  });
  const parsed = synchronizationSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Best effort: never throws. */
export async function cancelSynchronization(auth: GcAuth, sourceId: string, syncId: string, logger: Logger = log): Promise<boolean> {
  try {
    await gcRequest<unknown>(auth, {
      operation: "gc.cancelSync",
      method: "PATCH",
      path: `/api/v2/knowledge/sources/${encodeURIComponent(sourceId)}/synchronizations/${encodeURIComponent(syncId)}`,
      body: { status: "Cancelled" },
      idempotent: true,
      log: logger,
    });
    return true;
  } catch (error) {
    logger.warn("Couldn't cancel Genesys Cloud synchronization", { sourceId, gcSyncId: syncId, err: error });
    return false;
  }
}

export function isTerminalSync(sync: Pick<GcSynchronization, "status" | "ingestionStatus">): boolean {
  if (sync.status === "Failed" || sync.status === "Cancelled") return true;
  if (sync.status !== "Completed") return false;
  return sync.ingestionStatus === "Complete" || sync.ingestionStatus === "Failed" || sync.ingestionStatus === "Stopped";
}
