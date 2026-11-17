import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArticlePage, ArticleState, RunDetailDTO, RunDTO, RunNowResult, SyncDTO } from "@/lib/api-types";
import { AppError, ERROR_CATALOG, isErrorCode } from "@/lib/errors";
import { computeNextRun, scheduleSchema } from "@/lib/schedule";
import { getSource, createFileUploadSource, type GcSource } from "../genesys/knowledge";
import { listArticles, listRunItems, type RunItemStatus } from "../repo/items";
import { getActiveRun, getRunForOrg, listRuns, type RunRow, toRunDTO } from "../repo/runs";
import { deleteSync, findSyncBySource, getSync, getSyncDTO, insertSync, listSyncDTOs, type SyncRow, updateSyncSettings } from "../repo/syncs";
import { validateFilterQuery } from "../servicenow/knowledge";
import { cancelRun, startRun } from "../sync/runner";
import { checkSync } from "../sync/scheduler";
import type { ActorContext } from "./actor";
import { requireConnection } from "./connections";
import { getOrgGcAuth } from "./genesys";

const SYS_ID = /^[0-9a-f]{32}$/;

const syncFields = z
  .object({
    name: z.string().trim().min(1, "Give the sync a name").max(100, "Keep the name under 100 characters"),
    connectionId: z.string().uuid("Pick a ServiceNow connection"),
    audience: z.enum(["csm", "itsm"]),
    knowledgeBases: z
      .array(z.object({ id: z.string().regex(SYS_ID, "Invalid knowledge base"), title: z.string().trim().max(200) }))
      .min(1, "Pick at least one knowledge base")
      .max(25, "Pick at most 25 knowledge bases"),
    filterQuery: z
      .string()
      .max(1000)
      .default("")
      .superRefine((value, ctx) => {
        const problem = validateFilterQuery(value);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
    linkStyle: z.enum(["classic", "sp", "esc", "csm", "csp", "custom"]),
    linkCustom: z
      .string()
      .trim()
      .max(40)
      .regex(/^[a-z0-9_-]*$/i, "Use letters, numbers, - or _")
      .default(""),
    schedule: scheduleSchema,
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.linkStyle === "custom" && !value.linkCustom) {
      ctx.addIssue({ code: "custom", path: ["linkCustom"], message: "Enter the portal's URL suffix" });
    }
  });

export const updateSyncSchema = syncFields;

export const createSyncSchema = z.intersection(
  syncFields,
  z.object({
    source: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("existing"), id: z.string().trim().min(1, "Pick a knowledge source").max(100) }),
      z.object({ mode: z.literal("new"), name: z.string().trim().min(1, "Name the new source").max(100) }),
    ]),
    runNow: z.boolean().default(true),
  }),
);

export type CreateSyncInput = z.infer<typeof createSyncSchema>;
export type UpdateSyncInput = z.infer<typeof updateSyncSchema>;

function normalizedFilter(filter: string): string {
  return filter.trim().replace(/^\^+/, "").replace(/\^+$/, "");
}

async function requireSync(actor: ActorContext, id: string): Promise<SyncRow> {
  const sync = await getSync(actor.orgId, id);
  if (!sync) throw new AppError("NOT_FOUND", { message: "That sync doesn't exist anymore." });
  return sync;
}

export async function listSyncs(actor: ActorContext): Promise<SyncDTO[]> {
  return listSyncDTOs(actor.orgId);
}

export async function getSyncDetail(actor: ActorContext, id: string): Promise<SyncDTO> {
  const dto = await getSyncDTO(actor.orgId, id);
  if (!dto) throw new AppError("NOT_FOUND", { message: "That sync doesn't exist anymore." });
  return dto;
}

export async function createSync(actor: ActorContext, input: CreateSyncInput): Promise<{ sync: SyncDTO; run: RunDTO | null; runError: string | null }> {
  await requireConnection(actor, input.connectionId);
  const auth = await getOrgGcAuth(actor.orgId);

  let source: GcSource;
  if (input.source.mode === "existing") {
    const used = await findSyncBySource(actor.orgId, input.source.id);
    if (used) throw new AppError("SOURCE_ALREADY_USED", { message: `The sync "${used.name}" already writes to this knowledge source.` });
    source = await getSource(auth, input.source.id, actor.log);
    if (source.type && source.type !== "FileUpload") {
      throw new AppError("VALIDATION", { message: "Pick a File Upload knowledge source.", fields: [{ path: "source.id", message: "Not a File Upload source" }] });
    }
  } else {
    source = await createFileUploadSource(auth, input.source.name, actor.log);
  }

  const id = randomUUID();
  const now = new Date();
  const inserted = await insertSync({
    id,
    orgId: actor.orgId,
    connectionId: input.connectionId,
    name: input.name,
    audience: input.audience,
    kbIds: input.knowledgeBases.map((kb) => kb.id),
    kbNames: input.knowledgeBases.map((kb) => kb.title),
    filterQuery: normalizedFilter(input.filterQuery),
    linkStyle: input.linkStyle,
    linkCustom: input.linkStyle === "custom" ? input.linkCustom : "",
    sourceId: source.id,
    sourceName: source.name,
    schedule: input.schedule,
    enabled: input.enabled,
    nextRunAt: input.enabled ? computeNextRun(input.schedule, now) : null,
    createdBy: actor.userName,
  });
  if (!inserted) throw new AppError("SOURCE_ALREADY_USED");
  actor.log.info("Sync created", { syncId: id, sourceId: source.id, sourceMode: input.source.mode, kbCount: input.knowledgeBases.length, schedule: input.schedule.kind });

  let run: RunRow | null = null;
  let runError: string | null = null;
  if (input.runNow) {
    try {
      run = (await startRun({ sync: (await getSync(actor.orgId, id))!, trigger: "initial", mode: "incremental", requestedBy: actor.userName })).run;
    } catch (error) {
      runError = error instanceof AppError ? error.message : "The first run couldn't be started.";
    }
  }
  return { sync: await getSyncDetail(actor, id), run: run ? toRunDTO(run) : null, runError };
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

export async function updateSync(actor: ActorContext, id: string, input: UpdateSyncInput): Promise<SyncDTO> {
  const sync = await requireSync(actor, id);
  if (input.connectionId !== sync.connectionId) await requireConnection(actor, input.connectionId);

  const kbIds = input.knowledgeBases.map((kb) => kb.id);
  const filterQuery = normalizedFilter(input.filterQuery);
  const linkCustom = input.linkStyle === "custom" ? input.linkCustom : "";
  const contentChanged =
    input.connectionId !== sync.connectionId ||
    !sameIds(kbIds, sync.kbIds) ||
    filterQuery !== sync.filterQuery ||
    input.audience !== sync.audience ||
    input.linkStyle !== sync.linkStyle ||
    linkCustom !== sync.linkCustom;
  const scheduleChanged = JSON.stringify(input.schedule) !== JSON.stringify(sync.schedule) || input.enabled !== sync.enabled;
  const nextRunAt = !input.enabled
    ? null
    : scheduleChanged || !sync.nextRunAt
      ? computeNextRun(input.schedule, new Date())
      : new Date(sync.nextRunAt);

  await updateSyncSettings(actor.orgId, id, {
    name: input.name,
    connectionId: input.connectionId,
    audience: input.audience,
    kbIds,
    kbNames: input.knowledgeBases.map((kb) => kb.title),
    filterQuery,
    linkStyle: input.linkStyle,
    linkCustom,
    schedule: input.schedule,
    enabled: input.enabled,
    nextRunAt,
    resetFingerprint: contentChanged,
  });
  actor.log.info("Sync updated", { syncId: id, contentChanged, scheduleChanged, enabled: input.enabled });
  return getSyncDetail(actor, id);
}

export async function setSyncEnabled(actor: ActorContext, id: string, enabled: boolean): Promise<SyncDTO> {
  const sync = await requireSync(actor, id);
  return updateSync(actor, id, {
    name: sync.name,
    connectionId: sync.connectionId,
    audience: sync.audience,
    knowledgeBases: sync.kbIds.map((kbId, index) => ({ id: kbId, title: sync.kbNames[index] ?? "" })),
    filterQuery: sync.filterQuery,
    linkStyle: sync.linkStyle,
    linkCustom: sync.linkCustom,
    schedule: sync.schedule,
    enabled,
  });
}

export async function removeSync(actor: ActorContext, id: string): Promise<void> {
  const sync = await requireSync(actor, id);
  if (await getActiveRun(sync.id)) {
    throw new AppError("SYNC_ALREADY_RUNNING", {
      message: "This sync is running right now.",
      hint: "Cancel the run or wait for it to finish, then delete the sync.",
    });
  }
  await deleteSync(actor.orgId, id);
  actor.log.info("Sync deleted", { syncId: id, sourceId: sync.sourceId });
}

/** "Sync now": a quick change check first (instant "up to date"), or a full rebuild on request. */
export async function runSyncNow(actor: ActorContext, id: string, mode: "incremental" | "full"): Promise<RunNowResult> {
  const sync = await requireSync(actor, id);
  const active = await getActiveRun(sync.id);
  if (active) return { outcome: "already_running", run: toRunDTO(active) };

  if (mode === "full") {
    const result = await startRun({ sync, trigger: "manual", mode: "full", requestedBy: actor.userName });
    return { outcome: result.outcome, run: toRunDTO(result.run) };
  }

  const result = await checkSync(sync, { trigger: "manual", requestedBy: actor.userName, recordNoop: true, logger: actor.log });
  if (result.outcome === "failed") {
    const code = result.run.errorCode && isErrorCode(result.run.errorCode) ? result.run.errorCode : "INTERNAL";
    throw new AppError(code, {
      message: result.run.errorMessage ?? ERROR_CATALOG[code].message,
      ...(result.run.errorHint ? { hint: result.run.errorHint } : {}),
      ...(result.run.errorDetail ? { detail: result.run.errorDetail } : {}),
    });
  }
  return { outcome: result.outcome, run: result.run ? toRunDTO(result.run) : null };
}

export async function cancelSyncRun(actor: ActorContext, syncId: string, runId: string): Promise<RunDTO> {
  const run = await getRunForOrg(actor.orgId, syncId, runId);
  if (!run) throw new AppError("NOT_FOUND", { message: "That run doesn't exist." });
  return toRunDTO(await cancelRun(run, actor.userName));
}

export async function listSyncRuns(actor: ActorContext, syncId: string, options: { limit: number; before: string | null }): Promise<RunDTO[]> {
  await requireSync(actor, syncId);
  return (await listRuns(syncId, options)).map(toRunDTO);
}

export async function getRunDetail(actor: ActorContext, syncId: string, runId: string, status: RunItemStatus | "attention" | undefined): Promise<RunDetailDTO> {
  const run = await getRunForOrg(actor.orgId, syncId, runId);
  if (!run) throw new AppError("NOT_FOUND", { message: "That run doesn't exist." });
  const { items, counts } = await listRunItems(runId, { status, limit: 200 });
  return { run: toRunDTO(run), items, itemCounts: counts };
}

export async function listSyncArticles(
  actor: ActorContext,
  syncId: string,
  options: { state?: ArticleState; search?: string; limit: number; offset: number },
): Promise<ArticlePage> {
  await requireSync(actor, syncId);
  return listArticles(syncId, options);
}
