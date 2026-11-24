import { randomUUID } from "node:crypto";
import { getRun } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";
import type { RunTrigger } from "@/lib/api-types";
import { AppError, toErrorRecord } from "@/lib/errors";
import { computeNextRun, nextRunAfterFailure } from "@/lib/schedule";
import { type Logger, scopedLogger } from "../log";
import { countManifestIssues } from "../repo/items";
import { insertFinishedRun, listStaleRuns, type RunRow } from "../repo/runs";
import { claimDueSyncs, markSyncChecked, setSyncOutcome, type SyncRow } from "../repo/syncs";
import { articleFilters, listArticleSummaries } from "../servicenow/knowledge";
import { resolveConnectionById } from "../services/connections";
import { finishRun } from "./engine";
import { computeConfigHash, computeFingerprint } from "./fingerprint";
import { startRun } from "./runner";

const log = scopedLogger("sync.scheduler");

export const STALE_RUN_MINUTES = 20;
export const MAX_RUN_MINUTES = 180;

/** Idle ticks stay at debug level apart from this heartbeat, so the logs show the scheduler is alive. */
const IDLE_HEARTBEAT_MS = 60 * 60_000;
let lastIdleHeartbeatAt = 0;

export type CheckOutcome =
  | { outcome: "started" | "already_running"; run: RunRow }
  | { outcome: "up_to_date"; run: RunRow | null; articleCount: number }
  | { outcome: "failed"; run: RunRow };

/**
 * Cheap change detection before starting a workflow: list article ids + update stamps and
 * compare with the fingerprint of the last good run. Unchanged syncs cost one API call.
 */
export async function checkSync(
  sync: SyncRow,
  options: { trigger: RunTrigger; requestedBy: string | null; recordNoop: boolean; logger?: Logger },
): Promise<CheckOutcome> {
  const logger = (options.logger ?? log).child({ syncId: sync.id, orgId: sync.orgId });
  const startedAt = new Date();
  let fingerprint: string;
  let articleCount: number;
  let issues: number;
  try {
    const connection = await resolveConnectionById(sync.connectionId);
    const articles = await listArticleSummaries(connection, { kbIds: sync.kbIds, filter: articleFilters(sync.filters, sync.filterQuery) }, logger);
    const configHash = computeConfigHash({ instanceUrl: connection.instanceUrl, audience: sync.audience, linkStyle: sync.linkStyle, linkCustom: sync.linkCustom });
    fingerprint = computeFingerprint(articles, configHash);
    articleCount = articles.length;
    issues = await countManifestIssues(sync.id);
  } catch (error) {
    const record = toErrorRecord(error);
    const failures = sync.consecutiveFailures + 1;
    const run = await insertFinishedRun({
      id: randomUUID(),
      syncId: sync.id,
      orgId: sync.orgId,
      trigger: options.trigger,
      status: "failed",
      requestedBy: options.requestedBy,
      error: record,
      startedAt,
    });
    await setSyncOutcome(sync.id, {
      health: "error",
      statusMessage: record.message,
      consecutiveFailures: failures,
      nextRunAt: sync.enabled ? nextRunAfterFailure(sync.schedule, failures, new Date()) : null,
      fingerprint: sync.fingerprint,
      succeeded: false,
    });
    logger.warn("Sync check failed", { code: record.code, detail: record.detail, failures, dedupeKey: `check-failed:${sync.id}:${record.code}` });
    return { outcome: "failed", run };
  }

  if (fingerprint === sync.fingerprint && issues === 0) {
    const nextRunAt = sync.enabled ? computeNextRun(sync.schedule, new Date()) : null;
    await markSyncChecked(sync.id, nextRunAt, articleCount);
    let run: RunRow | null = null;
    if (options.recordNoop) {
      run = await insertFinishedRun({
        id: randomUUID(),
        syncId: sync.id,
        orgId: sync.orgId,
        trigger: options.trigger,
        status: "noop",
        requestedBy: options.requestedBy,
        totalArticles: articleCount,
        note: "Everything was already up to date.",
        startedAt,
      });
    }
    logger.debug("Sync is up to date", { articles: articleCount });
    return { outcome: "up_to_date", run, articleCount };
  }

  const result = await startRun({ sync, trigger: options.trigger, mode: "incremental", requestedBy: options.requestedBy });
  return result;
}

type WorkflowVerdict = "alive" | "gone" | "unknown";

async function inspectWorkflow(run: RunRow): Promise<WorkflowVerdict> {
  if (!run.workflowRunId) return "gone";
  try {
    const status = await getRun(run.workflowRunId).status;
    return status === "pending" || status === "running" ? "alive" : "gone";
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) return "gone";
    log.warn("Couldn't read workflow status", { runId: run.id, workflowRunId: run.workflowRunId, err: error, dedupeKey: "watchdog.inspect" });
    return "unknown";
  }
}

/** Closes runs whose workflow died (crash, deployment removed, start lost) so syncs never get stuck. */
export async function runWatchdog(now: Date = new Date()): Promise<number> {
  const stale = await listStaleRuns(STALE_RUN_MINUTES);
  let recovered = 0;
  for (const run of stale) {
    try {
      const verdict = await inspectWorkflow(run);
      const ageMinutes = (now.getTime() - Date.parse(run.createdAt)) / 60_000;
      if (verdict === "unknown") continue;
      if (verdict === "alive" && ageMinutes < MAX_RUN_MINUTES) continue;
      if (verdict === "alive" && run.workflowRunId) {
        await getRun(run.workflowRunId)
          .cancel({ cancelReason: "Exceeded the maximum run time" })
          .catch(() => undefined);
      }
      const code = !run.workflowRunId ? "WORKFLOW_START_FAILED" : "WORKFLOW_LOST";
      await finishRun(run.id, {
        kind: "failed",
        error: toErrorRecord(new AppError(code, { detail: `heartbeat older than ${STALE_RUN_MINUTES} minutes, workflow ${verdict}` })),
      });
      recovered += 1;
      log.warn("Recovered a stuck run", { runId: run.id, syncId: run.syncId, code, ageMinutes: Math.round(ageMinutes) });
    } catch (error) {
      log.error("Watchdog couldn't recover a run", { runId: run.id, err: error });
    }
  }
  return recovered;
}

export interface TickSummary {
  recovered: number;
  checked: number;
  started: number;
  upToDate: number;
  alreadyRunning: number;
  failed: number;
  durationMs: number;
}

async function forEachConcurrent<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) await worker(items[index++] as T);
    }),
  );
}

/** One scheduler pass: recover stuck runs, then check every due sync within the time budget. */
export async function runTick(options: { budgetMs?: number; batchSize?: number; concurrency?: number; logger?: Logger } = {}): Promise<TickSummary> {
  const logger = options.logger ?? log;
  const started = Date.now();
  const budgetMs = options.budgetMs ?? 45_000;
  const summary: TickSummary = { recovered: 0, checked: 0, started: 0, upToDate: 0, alreadyRunning: 0, failed: 0, durationMs: 0 };

  summary.recovered = await runWatchdog();

  while (Date.now() - started < budgetMs) {
    const due = await claimDueSyncs(options.batchSize ?? 6);
    if (due.length === 0) break;
    await forEachConcurrent(due, options.concurrency ?? 3, async (sync) => {
      summary.checked += 1;
      try {
        const result = await checkSync(sync, { trigger: "schedule", requestedBy: null, recordNoop: false, logger });
        if (result.outcome === "started") summary.started += 1;
        else if (result.outcome === "up_to_date") summary.upToDate += 1;
        else if (result.outcome === "already_running") summary.alreadyRunning += 1;
        else summary.failed += 1;
      } catch (error) {
        summary.failed += 1;
        logger.error("Scheduled check crashed", { syncId: sync.id, err: error });
      }
    });
  }

  summary.durationMs = Date.now() - started;
  if (summary.checked > 0 || summary.recovered > 0) {
    logger.info("Scheduler tick", { ...summary });
  } else if (Date.now() - lastIdleHeartbeatAt >= IDLE_HEARTBEAT_MS) {
    lastIdleHeartbeatAt = Date.now();
    logger.info("Scheduler is running, nothing due", { durationMs: summary.durationMs });
  } else {
    logger.debug("Scheduler tick: nothing due", { durationMs: summary.durationMs });
  }
  return summary;
}
