import { randomUUID } from "node:crypto";
import type { RunStatus, SyncHealth } from "@/lib/api-types";
import { AppError, type ErrorCode, type ErrorRecord, isAppError, toErrorRecord } from "@/lib/errors";
import { computeNextRun, nextRunAfterFailure } from "@/lib/schedule";
import { db, type Statement } from "../db";
import type { GcAuth } from "../genesys/client";
import {
  cancelSynchronization,
  completeSynchronization,
  getSynchronization,
  isTerminalSync,
  listSynchronizations,
  markFileForDeletion,
  startSynchronization,
  uploadFile,
} from "../genesys/knowledge";
import { type Logger, scopedLogger } from "../log";
import {
  buildDeletionLabelsUpdate,
  buildManifestStatements,
  buildRunItemsInsert,
  clearRunItems,
  countPendingItems,
  failPendingUploads,
  type ItemResult,
  loadManifest,
  nextPendingItems,
  recordItemResults,
  type RunItemRow,
  skipPendingItems,
} from "../repo/items";
import { buildRunUpdate, getRunById, isRunFinished, mapRun, pruneRunHistory, type RunRow, updateRun } from "../repo/runs";
import { getSyncById, type SyncRow } from "../repo/syncs";
import type { SnConnection } from "../servicenow/client";
import { type ArticleContent, fetchArticleContents, listArticleSummaries } from "../servicenow/knowledge";
import { resolveConnectionById } from "../services/connections";
import { getOrgGcAuth } from "../services/genesys";
import { buildArticleDocument, CONTENT_TYPE } from "./document";
import { computeConfigHash, computeFingerprint } from "./fingerprint";
import { planSync } from "./plan";

/**
 * The sync engine. Each exported function is one durable workflow step: it reloads state
 * from the database, does a bounded amount of work and records progress, so any step can be
 * retried or resumed after a crash without duplicating effects.
 */

const engineLog = scopedLogger("sync.engine");

export const UPLOAD_CONCURRENCY = 6;
export const DELETE_CONCURRENCY = 8;
export const DELETE_BATCH_SIZE = 200;
const CONTENT_FETCH_CHUNK = 50;
const ROUND_READY_POLLS = 8;
const COMPLETION_RESEND_MS = 60_000;
const INGESTION_GRACE_MS = 5 * 60_000;

/** Errors that would fail every remaining item the same way: stop the run instead. */
const RUN_FATAL_CODES = new Set<ErrorCode>([
  "GC_AUTH_FAILED",
  "GC_PERMISSION_DENIED",
  "GC_SOURCE_NOT_FOUND",
  "GC_SOURCE_BUSY",
  "GC_CREDENTIALS_MISSING",
  "SN_AUTH_FAILED",
  "SN_HIBERNATING",
  "CONFIG_MISSING",
]);

/** Uploads per step: larger batches for larger runs keep the workflow event log small. */
export function uploadBatchSize(plannedUploads: number): number {
  return Math.min(150, Math.max(25, Math.ceil(plannedUploads / 100)));
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let roundPollDelayMs = 2000;
/** Test hook: shorten the wait for a new synchronization round to leave the queue. */
export function configureEngineTiming(options: { roundPollDelayMs?: number } | null): void {
  roundPollDelayMs = options?.roundPollDelayMs ?? 2000;
}

async function forEachConcurrent<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++] as T;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

interface RunContext {
  run: RunRow;
  sync: SyncRow;
  log: Logger;
}

async function loadRun(runId: string): Promise<RunContext | null> {
  const run = await getRunById(runId);
  if (!run) return null;
  const sync = await getSyncById(run.syncId);
  if (!sync) return null;
  return { run, sync, log: engineLog.child({ runId, syncId: sync.id, orgId: sync.orgId }) };
}

/* ------------------------------- planning ------------------------------- */

export type PrepareResult = { action: "stop" } | { action: "continue"; uploads: number; deletions: number };

export async function prepareRun(runId: string): Promise<PrepareResult> {
  const ctx = await loadRun(runId);
  if (!ctx || isRunFinished(ctx.run)) return { action: "stop" };
  const { run, sync } = ctx;

  if (run.cancelRequested) {
    await finishRun(runId, { kind: "cancelled" }, WORKFLOW_CLAIMANT);
    return { action: "stop" };
  }
  if (run.phase !== "queued" && run.phase !== "planning") {
    return { action: "continue", uploads: run.plannedUploads, deletions: run.plannedDeletions };
  }

  await updateRun(runId, { status: "running", phase: "planning", startedAt: run.startedAt ? undefined : new Date() }, { onlyActive: true });
  await clearRunItems(runId);

  const connection = await resolveConnectionById(sync.connectionId);
  const articles = await listArticleSummaries(connection, { kbIds: sync.kbIds, filter: sync.filterQuery }, ctx.log);
  const manifest = await loadManifest(sync.id);
  // ServiceNow answers an account that lost read access with an empty list, not an error.
  if (articles.length === 0 && run.mode === "incremental" && manifest.some((entry) => entry.state === "synced")) {
    throw new AppError("SN_NO_ARTICLES", { detail: `ServiceNow returned 0 articles while ${manifest.length} files are synced` });
  }
  const configHash = computeConfigHash({
    instanceUrl: connection.instanceUrl,
    audience: sync.audience,
    linkStyle: sync.linkStyle,
    linkCustom: sync.linkCustom,
  });
  const configChanged = sync.configHash !== null && sync.configHash !== configHash && manifest.length > 0;
  const plan = planSync({ articles, manifest, mode: run.mode, configChanged });

  const statements: Statement[] = [];
  if (plan.uploads.length || plan.deletions.length) statements.push(buildRunItemsInsert(runId, plan.uploads, plan.deletions));
  if (plan.deletions.length) statements.push(buildDeletionLabelsUpdate(runId, sync.id));
  statements.push(
    buildRunUpdate(
      runId,
      {
        phase: plan.uploads.length ? "uploading" : plan.deletions.length ? "deleting" : "finalizing",
        totalArticles: articles.length,
        plannedUploads: plan.uploads.length,
        plannedDeletions: plan.deletions.length,
        unchanged: plan.unchanged,
        fingerprint: computeFingerprint(articles, configHash),
        configHash,
        note: configChanged ? "Settings changed, so every article is refreshed once." : null,
      },
      { onlyActive: true },
    )!,
  );
  await (await db()).transaction(statements);

  ctx.log.info("Run planned", {
    mode: run.mode,
    trigger: run.trigger,
    articles: articles.length,
    uploads: plan.uploads.length,
    deletions: plan.deletions.length,
    unchanged: plan.unchanged,
    configChanged,
  });
  return { action: "continue", uploads: plan.uploads.length, deletions: plan.deletions.length };
}

/* ---------------------------- the GC round ----------------------------- */

const OPEN_GC_STATUSES = new Set(["InQueue", "InProgress", "Throttled"]);

/** Cancels rounds this sync opened in earlier runs that were never closed (they block new rounds). */
async function cancelOrphanedRounds(ctx: RunContext, auth: GcAuth): Promise<number> {
  const database = await db();
  const ours = await database.query<{ gc_sync_id: string }>(
    "SELECT gc_sync_id FROM sync_runs WHERE sync_id = $1 AND id <> $2 AND gc_sync_id IS NOT NULL ORDER BY created_at DESC LIMIT 50",
    [ctx.sync.id, ctx.run.id],
  );
  const known = new Set(ours.map((row) => row.gc_sync_id));
  const recent = await listSynchronizations(auth, ctx.sync.sourceId, 10, ctx.log);
  let cancelled = 0;
  for (const round of recent) {
    if (known.has(round.id) && OPEN_GC_STATUSES.has(round.status ?? "")) {
      if (await cancelSynchronization(auth, ctx.sync.sourceId, round.id, ctx.log)) cancelled += 1;
    }
  }
  if (cancelled) ctx.log.warn("Cancelled leftover Genesys Cloud synchronizations", { cancelled });
  return cancelled;
}

async function openRound(ctx: RunContext, auth: GcAuth): Promise<string> {
  const type = ctx.run.mode === "full" ? "Full" : "Incremental";
  const startedAt = Date.now();
  let round;
  try {
    round = await startSynchronization(auth, ctx.sync.sourceId, type, ctx.log);
  } catch (error) {
    if (isAppError(error) && error.code === "GC_SOURCE_BUSY" && (await cancelOrphanedRounds(ctx, auth)) > 0) {
      round = await startSynchronization(auth, ctx.sync.sourceId, type, ctx.log);
    } else if (isAppError(error) && error.code === "GC_OUTCOME_UNKNOWN") {
      const recent = await listSynchronizations(auth, ctx.sync.sourceId, 5, ctx.log);
      round = recent.find(
        (candidate) =>
          OPEN_GC_STATUSES.has(candidate.status ?? "") &&
          (!candidate.dateStart || Date.parse(candidate.dateStart) >= startedAt - 5 * 60_000),
      );
      if (!round) throw error;
      ctx.log.warn("Adopted synchronization after an ambiguous start", { gcSyncId: round.id });
    } else {
      throw error;
    }
  }

  await updateRun(ctx.run.id, { gcSyncId: round.id, gcStatus: round.status ?? null }, { onlyActive: true });
  ctx.run.gcSyncId = round.id;

  let status = round.status;
  for (let attempt = 0; attempt < ROUND_READY_POLLS && (status === "InQueue" || status === "Throttled"); attempt++) {
    await pause(roundPollDelayMs);
    status = (await getSynchronization(auth, ctx.sync.sourceId, round.id, ctx.log)).status;
  }
  ctx.log.info("Genesys Cloud synchronization started", { gcSyncId: round.id, type, gcStatus: status });
  return round.id;
}

function lazyRound(ctx: RunContext, auth: GcAuth): () => Promise<string> {
  let pending: Promise<string> | null = ctx.run.gcSyncId ? Promise.resolve(ctx.run.gcSyncId) : null;
  return () => (pending ??= openRound(ctx, auth));
}

/* ------------------------------- batches -------------------------------- */

export interface BatchResult {
  done: boolean;
  processed: number;
  fatal?: ErrorRecord;
}

interface ItemOutcome {
  results: ItemResult[];
  fatal?: ErrorRecord;
}

export async function processBatch(runId: string): Promise<BatchResult> {
  const ctx = await loadRun(runId);
  if (!ctx || isRunFinished(ctx.run) || ctx.run.cancelRequested) return { done: true, processed: 0 };
  const { run, sync } = ctx;

  let op: "upload" | "delete" = "upload";
  let items = await nextPendingItems(runId, sync.id, "upload", uploadBatchSize(run.plannedUploads));
  if (items.length === 0) {
    op = "delete";
    items = await nextPendingItems(runId, sync.id, "delete", DELETE_BATCH_SIZE);
  }
  if (items.length === 0) {
    await updateRun(runId, { phase: "committing" }, { onlyActive: true });
    return { done: true, processed: 0 };
  }

  const phase = op === "upload" ? "uploading" : "deleting";
  if (run.phase !== phase) await updateRun(runId, { phase }, { onlyActive: true });

  const auth = await getOrgGcAuth(sync.orgId);
  const getRound = lazyRound(ctx, auth);
  const outcome =
    op === "upload"
      ? await uploadItems(ctx, items, auth, getRound, await resolveConnectionById(sync.connectionId))
      : await deleteItems(ctx, items, auth, getRound);

  const tally = { uploaded: 0, unchanged: 0, deleted: 0, failed: 0, skipped: 0 };
  for (const result of outcome.results) {
    if (result.status === "done") tally[op === "upload" ? "uploaded" : "deleted"] += 1;
    else if (result.status === "unchanged") tally.unchanged += 1;
    else if (result.status === "failed") tally.failed += 1;
    else if (result.status === "skipped") tally.skipped += 1;
  }
  await recordItemResults(runId, outcome.results, {
    text: `UPDATE sync_runs SET uploaded = uploaded + $2, unchanged = unchanged + $3, deleted = deleted + $4,
             failed = failed + $5, skipped = skipped + $6, heartbeat_at = now() WHERE id = $1`,
    params: [runId, tally.uploaded, tally.unchanged, tally.deleted, tally.failed, tally.skipped],
  });

  ctx.log.debug("Batch processed", { op, items: items.length, ...tally, fatal: outcome.fatal?.code });
  if (outcome.fatal) return { done: true, processed: outcome.results.length, fatal: outcome.fatal };
  const remaining = await countPendingItems(runId);
  return { done: remaining === 0, processed: outcome.results.length };
}

async function uploadItems(
  ctx: RunContext,
  items: RunItemRow[],
  auth: GcAuth,
  getRound: () => Promise<string>,
  connection: SnConnection,
): Promise<ItemOutcome> {
  const { run, sync } = ctx;
  const contents = new Map<string, ArticleContent>();
  for (const ids of chunk(items.map((item) => item.articleId), CONTENT_FETCH_CHUNK)) {
    for (const [id, article] of await fetchArticleContents(connection, ids, ctx.log)) contents.set(id, article);
  }

  const results: ItemResult[] = [];
  let fatal: ErrorRecord | undefined;

  await forEachConcurrent(items, UPLOAD_CONCURRENCY, async (item) => {
    if (fatal) return;
    const article = contents.get(item.articleId);
    if (!article) {
      results.push({ seq: item.seq, status: "skipped", errorCode: "MISSING", errorMessage: "The article is no longer published in ServiceNow." });
      return;
    }
    const doc = buildArticleDocument({
      article,
      fileName: item.fileName,
      instanceUrl: connection.instanceUrl,
      audience: sync.audience,
      linkStyle: sync.linkStyle,
      linkCustom: sync.linkCustom,
    });
    if (doc.isEmpty) {
      results.push({ seq: item.seq, status: "skipped", errorCode: "EMPTY", errorMessage: "The article has no text to sync." });
      return;
    }
    if (doc.tooLarge) {
      results.push({ seq: item.seq, status: "skipped", errorCode: "TOO_LARGE", errorMessage: "The article is larger than 8 MB." });
      return;
    }
    if (run.mode === "incremental" && item.reason !== "retry" && item.priorHash === doc.contentHash) {
      results.push({ seq: item.seq, status: "unchanged", contentHash: doc.contentHash });
      return;
    }

    let roundId: string;
    try {
      roundId = await getRound();
    } catch (error) {
      fatal ??= toErrorRecord(error, "GC_UNAVAILABLE");
      return;
    }
    try {
      await uploadFile(
        auth,
        sync.sourceId,
        roundId,
        { fileName: doc.fileName, bytes: doc.bytes, contentType: CONTENT_TYPE, contentMd5: doc.contentMd5, originUri: doc.originUri, tags: doc.tags },
        ctx.log,
      );
      results.push({ seq: item.seq, status: "done", contentHash: doc.contentHash });
    } catch (error) {
      const record = toErrorRecord(error, "GC_REQUEST_REJECTED");
      if (RUN_FATAL_CODES.has(record.code)) {
        fatal ??= record;
        return;
      }
      results.push({ seq: item.seq, status: "failed", errorCode: record.code, errorMessage: record.message });
      ctx.log.warn("Article upload failed", {
        articleId: item.articleId,
        number: item.number,
        code: record.code,
        detail: record.detail,
        dedupeKey: `upload-failed:${run.id}:${record.code}`,
      });
    }
  });
  return { results, fatal };
}

async function deleteItems(ctx: RunContext, items: RunItemRow[], auth: GcAuth, getRound: () => Promise<string>): Promise<ItemOutcome> {
  const results: ItemResult[] = [];
  let fatal: ErrorRecord | undefined;
  await forEachConcurrent(items, DELETE_CONCURRENCY, async (item) => {
    if (fatal) return;
    let roundId: string;
    try {
      roundId = await getRound();
    } catch (error) {
      fatal ??= toErrorRecord(error, "GC_UNAVAILABLE");
      return;
    }
    try {
      const outcome = await markFileForDeletion(auth, ctx.sync.sourceId, roundId, item.fileName, ctx.log);
      results.push({ seq: item.seq, status: "done", errorMessage: outcome === "not_found" ? "The file was already gone from Genesys Cloud." : null });
    } catch (error) {
      const record = toErrorRecord(error, "GC_REQUEST_REJECTED");
      if (RUN_FATAL_CODES.has(record.code)) {
        fatal ??= record;
        return;
      }
      results.push({ seq: item.seq, status: "failed", errorCode: record.code, errorMessage: record.message });
      ctx.log.warn("File deletion failed", { articleId: item.articleId, code: record.code, detail: record.detail, dedupeKey: `delete-failed:${ctx.run.id}:${record.code}` });
    }
  });
  return { results, fatal };
}

/* ------------------------------ commit/poll ----------------------------- */

export type CommitResult = { action: "finalize" } | { action: "poll" } | { action: "fail"; error: ErrorRecord };

export async function commitRound(runId: string): Promise<CommitResult> {
  const ctx = await loadRun(runId);
  if (!ctx || isRunFinished(ctx.run)) return { action: "finalize" };
  const { run, sync } = ctx;
  if (!run.gcSyncId) return { action: "finalize" };
  if (run.completionRequestedAt) return { action: "poll" };

  const auth = await getOrgGcAuth(sync.orgId);
  const cancelReason = run.cancelRequested
    ? "cancelled"
    : run.mode === "full" && run.failed > 0
      ? "full_with_failures"
      : run.uploaded + run.deleted === 0
        ? "nothing_to_commit"
        : null;

  if (cancelReason) {
    await cancelSynchronization(auth, sync.sourceId, run.gcSyncId, ctx.log);
    const patch =
      cancelReason === "full_with_failures"
        ? {
            gcStatus: "Cancelled",
            errorCode: "GC_SYNC_FAILED",
            errorMessage: `The full rebuild was stopped because ${run.failed} article${run.failed === 1 ? "" : "s"} couldn't be uploaded, so the source was left unchanged.`,
            errorHint: "Fix the failing articles (see the list below) and run the full rebuild again.",
          }
        : { gcStatus: "Cancelled" };
    await updateRun(runId, patch, { onlyActive: true });
    ctx.log.info("Genesys Cloud synchronization cancelled", { gcSyncId: run.gcSyncId, reason: cancelReason });
    return { action: "finalize" };
  }

  await updateRun(runId, { phase: "committing", completionRequestedAt: new Date() }, { onlyActive: true });
  try {
    const result = await completeSynchronization(auth, sync.sourceId, run.gcSyncId, ctx.log);
    await updateRun(runId, { phase: "processing", gcStatus: result?.status ?? null, gcIngestion: result?.ingestionStatus ?? null }, { onlyActive: true });
    ctx.log.info("Synchronization submitted to Genesys Cloud", { gcSyncId: run.gcSyncId, uploaded: run.uploaded, deleted: run.deleted });
    return { action: "poll" };
  } catch (error) {
    if (isAppError(error) && (error.code === "GC_OUTCOME_UNKNOWN" || error.retryable)) {
      await updateRun(runId, { phase: "processing" }, { onlyActive: true });
      ctx.log.warn("Completion outcome unclear, verifying through status polling", { gcSyncId: run.gcSyncId, code: error.code });
      return { action: "poll" };
    }
    return { action: "fail", error: toErrorRecord(error, "GC_SYNC_FAILED") };
  }
}

export interface PollResult {
  terminal: boolean;
  status: string | null;
  ingestion: string | null;
}

export async function pollRound(runId: string, now: Date = new Date()): Promise<PollResult> {
  const ctx = await loadRun(runId);
  if (!ctx || isRunFinished(ctx.run) || !ctx.run.gcSyncId) return { terminal: true, status: null, ingestion: null };
  const { run, sync } = ctx;
  const auth = await getOrgGcAuth(sync.orgId);
  const round = await getSynchronization(auth, sync.sourceId, run.gcSyncId!, ctx.log);
  const status = round.status ?? null;
  const ingestion = round.ingestionStatus ?? null;

  await updateRun(
    runId,
    {
      gcStatus: status,
      gcIngestion: ingestion,
      gcSynchronized: round.statistics?.synchronizedItemCount ?? null,
      gcFailed: round.statistics?.failedItemCount ?? null,
    },
    { onlyActive: true },
  );
  if (status !== run.gcStatus || ingestion !== run.gcIngestion) {
    ctx.log.info("Genesys Cloud status changed", { gcSyncId: run.gcSyncId, gcStatus: status, gcIngestion: ingestion });
  }

  const requestedAt = run.completionRequestedAt ? Date.parse(run.completionRequestedAt) : null;
  if ((status === "InProgress" || status === "InQueue") && requestedAt && now.getTime() - requestedAt > COMPLETION_RESEND_MS) {
    try {
      await completeSynchronization(auth, sync.sourceId, run.gcSyncId!, ctx.log);
      await updateRun(runId, { completionRequestedAt: now }, { onlyActive: true });
      ctx.log.warn("Re-sent synchronization completion", { gcSyncId: run.gcSyncId });
    } catch (error) {
      ctx.log.debug("Completion re-send failed", { err: error, dedupeKey: `resend:${runId}` });
    }
  }

  const ingestionUnknown = !ingestion || ingestion === "Unknown";
  const graceOver = requestedAt !== null && now.getTime() - requestedAt > INGESTION_GRACE_MS;
  const terminal = isTerminalSync(round) || (status === "Completed" && ingestionUnknown && graceOver);
  return { terminal, status, ingestion };
}

/* ------------------------------- closing -------------------------------- */

export type RunOutcome = { kind: "committed" } | { kind: "no_round" } | { kind: "cancelled" } | { kind: "failed"; error: ErrorRecord };

/** Decides how a run ended from the last known Genesys Cloud state. */
export function outcomeFromRound(run: Pick<RunRow, "gcSyncId" | "gcStatus" | "gcIngestion" | "cancelRequested" | "errorCode" | "errorMessage">, pollTimedOut: boolean): RunOutcome {
  const status = run.gcStatus;
  const ingestion = run.gcIngestion;
  if (run.cancelRequested && status !== "Completed") return { kind: "cancelled" };
  if (!run.gcSyncId) return { kind: "no_round" };
  if (status === "Completed" && ingestion === "Complete") return { kind: "committed" };
  if (status === "Completed" && (!ingestion || ingestion === "Unknown") && !pollTimedOut) return { kind: "committed" };
  if (status === "Completed" && (ingestion === "Failed" || ingestion === "Stopped")) {
    return { kind: "failed", error: toErrorRecord(new AppError("GC_INGESTION_FAILED", { detail: `ingestion status ${ingestion}` })) };
  }
  if (status === "Failed") return { kind: "failed", error: toErrorRecord(new AppError("GC_SYNC_FAILED", { detail: "synchronization status Failed" })) };
  if (status === "Cancelled") {
    if (run.cancelRequested) return { kind: "cancelled" };
    if (run.errorCode === "GC_SYNC_FAILED") {
      return { kind: "failed", error: toErrorRecord(new AppError("GC_SYNC_FAILED", run.errorMessage ? { message: run.errorMessage } : {})) };
    }
    return { kind: "no_round" };
  }
  return {
    kind: "failed",
    error: toErrorRecord(new AppError("GC_OUTCOME_UNKNOWN", { detail: `last status ${status ?? "unknown"}/${ingestion ?? "unknown"}` })),
  };
}

/** Closer identity used by workflow steps, so a retried step can reclaim its own close. */
export const WORKFLOW_CLAIMANT = "workflow";

export async function finalizeRun(runId: string, options: { pollTimedOut?: boolean } = {}): Promise<RunStatus | null> {
  const run = await getRunById(runId);
  if (!run) return null;
  if (isRunFinished(run)) return run.status;
  return finishRun(runId, outcomeFromRound(run, options.pollTimedOut ?? false), WORKFLOW_CLAIMANT);
}

export async function failRun(runId: string, error: ErrorRecord): Promise<RunStatus | null> {
  return finishRun(runId, { kind: "failed", error }, WORKFLOW_CLAIMANT);
}

/**
 * After a ServiceNow failure part-way through an incremental run, keeps what was already
 * uploaded: the remaining uploads are marked failed (retried next run) and the round is
 * committed as usual. Returns false when the run can't be salvaged and should fail instead.
 */
export async function salvageRun(runId: string, error: ErrorRecord): Promise<boolean> {
  const ctx = await loadRun(runId);
  if (!ctx || isRunFinished(ctx.run)) return false;
  const { run } = ctx;
  if (run.mode !== "incremental" || !run.gcSyncId || run.cancelRequested || !error.code.startsWith("SN_")) return false;
  const abandoned = await failPendingUploads(runId, error.code, error.message);
  await updateRun(
    runId,
    { note: `ServiceNow stopped responding part-way through, so ${plural(abandoned, "article")} will be retried on the next run.` },
    { onlyActive: true },
  );
  ctx.log.warn("Continuing with partial results after a ServiceNow error", { code: error.code, detail: error.detail, abandoned });
  return true;
}

const FINALIZER_STALE_MINUTES = 10;

/** Claims the right to close a run; only one closer (workflow, watchdog or cancel) wins. */
async function claimFinalizer(runId: string, claimant: string): Promise<RunRow | null> {
  const database = await db();
  const rows = await database.query(
    `UPDATE sync_runs SET finalizer = $2, phase = 'finalizing', heartbeat_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')
        AND (finalizer IS NULL OR finalizer = $2 OR heartbeat_at < now() - make_interval(mins => $3))
      RETURNING *`,
    [runId, claimant, FINALIZER_STALE_MINUTES],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

async function firstItemError(runId: string): Promise<{ code: string | null; message: string | null } | null> {
  const database = await db();
  const rows = await database.query<{ error_code: string | null; error_message: string | null }>(
    `SELECT error_code, error_message FROM run_items WHERE run_id = $1 AND status = 'failed'
      GROUP BY error_code, error_message ORDER BY count(*) DESC LIMIT 1`,
    [runId],
  );
  return rows[0] ? { code: rows[0].error_code, message: rows[0].error_message } : null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Closes a run: skips leftovers, closes an open round, folds results into the manifest and updates the sync. */
export async function finishRun(runId: string, outcome: RunOutcome, claimant: string = randomUUID()): Promise<RunStatus | null> {
  const claimed = await claimFinalizer(runId, claimant);
  if (!claimed) return (await getRunById(runId))?.status ?? null;
  const sync = await getSyncById(claimed.syncId);
  if (!sync) return null;
  const log = engineLog.child({ runId, syncId: sync.id, orgId: sync.orgId });

  await skipPendingItems(runId, outcome.kind === "cancelled" ? "Cancelled before it was processed." : "Not processed because the run stopped.");

  let gcStatus = claimed.gcStatus;
  if (outcome.kind !== "committed" && claimed.gcSyncId && !claimed.completionRequestedAt && OPEN_GC_STATUSES.has(gcStatus ?? "InProgress")) {
    try {
      const auth = await getOrgGcAuth(sync.orgId);
      if (await cancelSynchronization(auth, sync.sourceId, claimed.gcSyncId, log)) gcStatus = "Cancelled";
    } catch (error) {
      log.warn("Couldn't close the Genesys Cloud synchronization", { gcSyncId: claimed.gcSyncId, err: error });
    }
  }

  const run = (await getRunById(runId)) ?? claimed;
  const committed = outcome.kind === "committed";
  let status: RunStatus;
  let error: ErrorRecord | null = null;
  let note = run.note;

  switch (outcome.kind) {
    case "committed":
      status = run.failed > 0 || (run.gcFailed ?? 0) > 0 ? "partial" : "succeeded";
      if ((run.gcFailed ?? 0) > 0) note = `Genesys Cloud couldn't process ${plural(run.gcFailed ?? 0, "file")}.`;
      break;
    case "no_round":
      if (run.failed > 0) {
        status = run.unchanged > 0 || run.skipped > 0 ? "partial" : "failed";
        if (status === "failed") {
          const first = await firstItemError(runId);
          error = toErrorRecord(new AppError("GC_SYNC_FAILED", { message: first?.message ?? `${plural(run.failed, "article")} couldn't be synced.`, detail: first?.code ?? undefined }));
        }
      } else if (run.plannedUploads + run.plannedDeletions === 0) {
        status = "noop";
        note ??= "Everything was already up to date.";
      } else {
        status = "succeeded";
        note ??= "No content changes needed in Genesys Cloud.";
      }
      break;
    case "cancelled":
      status = "cancelled";
      error = toErrorRecord(new AppError("RUN_CANCELLED"));
      break;
    case "failed":
      status = "failed";
      error = outcome.error;
      break;
  }

  const outcomeForSync = computeSyncOutcome(sync, run, status, error, committed);
  const statements: Statement[] = [
    ...buildManifestStatements({ syncId: sync.id, runId, committed, fullRebuild: run.mode === "full" && committed }),
    {
      text: `UPDATE sync_runs SET status = $2, phase = 'done', finished_at = now(), gc_status = $3,
               error_code = COALESCE($4, error_code), error_message = COALESCE($5, error_message),
               error_hint = COALESCE($6, error_hint), error_detail = COALESCE($7, error_detail), note = $8,
               started_at = COALESCE(started_at, created_at), heartbeat_at = now()
             WHERE id = $1`,
      params: [runId, status, gcStatus, error?.code ?? null, error?.message ?? null, error?.hint ?? null, error?.detail ?? null, note],
    },
    {
      text: `UPDATE syncs SET health = $2, status_message = $3, consecutive_failures = $4, next_run_at = $5, fingerprint = $6,
               config_hash = COALESCE($7, config_hash), article_count = COALESCE($8, article_count),
               last_success_at = CASE WHEN $9 THEN now() ELSE last_success_at END, last_checked_at = now(), updated_at = now()
             WHERE id = $1`,
      params: [
        sync.id,
        outcomeForSync.health,
        outcomeForSync.statusMessage,
        outcomeForSync.consecutiveFailures,
        outcomeForSync.nextRunAt?.toISOString() ?? null,
        outcomeForSync.fingerprint,
        outcomeForSync.configHash,
        outcomeForSync.articleCount,
        outcomeForSync.succeeded,
      ],
    },
  ];
  await (await db()).transaction(statements);
  await pruneRunHistory(sync.id).catch((pruneError: unknown) => log.warn("Couldn't prune run history", { err: pruneError }));

  const durationMs = Date.now() - Date.parse(run.startedAt ?? run.createdAt);
  const fields = {
    status,
    mode: run.mode,
    trigger: run.trigger,
    articles: run.totalArticles,
    uploaded: run.uploaded,
    unchanged: run.unchanged,
    deleted: run.deleted,
    failed: run.failed,
    skipped: run.skipped,
    gcSyncId: run.gcSyncId,
    gcStatus,
    gcIngestion: run.gcIngestion,
    code: error?.code,
    detail: error?.detail,
    durationMs,
  };
  if (status === "failed") log.warn("Run failed", fields);
  else log.info("Run finished", fields);
  return status;
}

interface SyncOutcomeValues {
  health: SyncHealth;
  statusMessage: string | null;
  consecutiveFailures: number;
  nextRunAt: Date | null;
  fingerprint: string | null;
  configHash: string | null;
  articleCount: number | null;
  succeeded: boolean;
}

export function computeSyncOutcome(
  sync: Pick<SyncRow, "schedule" | "enabled" | "health" | "consecutiveFailures">,
  run: Pick<RunRow, "failed" | "gcFailed" | "fingerprint" | "configHash" | "totalArticles" | "plannedUploads" | "plannedDeletions">,
  status: RunStatus,
  error: ErrorRecord | null,
  committed: boolean,
  now: Date = new Date(),
): SyncOutcomeValues {
  const schedule = (date: Date | null) => (sync.enabled ? date : null);
  const articleCount = run.totalArticles > 0 || run.plannedUploads + run.plannedDeletions > 0 ? run.totalArticles : null;
  switch (status) {
    case "succeeded":
    case "noop":
      return {
        health: "healthy",
        statusMessage: null,
        consecutiveFailures: 0,
        nextRunAt: schedule(computeNextRun(sync.schedule, now)),
        fingerprint: run.fingerprint,
        configHash: run.configHash,
        articleCount,
        succeeded: true,
      };
    case "partial": {
      const itemFailures = run.failed > 0;
      const failures = itemFailures ? sync.consecutiveFailures + 1 : 0;
      return {
        health: "warning",
        statusMessage: itemFailures
          ? `${plural(run.failed, "article")} couldn't be synced. They'll be retried automatically.`
          : `Genesys Cloud couldn't process ${plural(run.gcFailed ?? 0, "file")}.`,
        consecutiveFailures: failures,
        nextRunAt: schedule(itemFailures ? nextRunAfterFailure(sync.schedule, failures, now) : computeNextRun(sync.schedule, now)),
        fingerprint: run.fingerprint,
        configHash: committed ? run.configHash : null,
        articleCount,
        succeeded: committed,
      };
    }
    case "cancelled":
      return {
        health: sync.health,
        statusMessage: "The last run was cancelled.",
        consecutiveFailures: sync.consecutiveFailures,
        nextRunAt: schedule(computeNextRun(sync.schedule, now)),
        fingerprint: null,
        configHash: null,
        articleCount: null,
        succeeded: false,
      };
    default: {
      const failures = sync.consecutiveFailures + 1;
      return {
        health: "error",
        statusMessage: error?.message ?? "The last run failed.",
        consecutiveFailures: failures,
        nextRunAt: schedule(nextRunAfterFailure(sync.schedule, failures, now)),
        fingerprint: null,
        configHash: null,
        articleCount: null,
        succeeded: false,
      };
    }
  }
}
