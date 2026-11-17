import type { RunDTO, RunMode, RunPhase, RunStatus, RunTrigger } from "@/lib/api-types";
import { ERROR_CATALOG, type ErrorRecord, isErrorCode } from "@/lib/errors";
import { db, isUniqueViolation, toInt, toIso } from "../db";

export interface RunRow {
  id: string;
  syncId: string;
  orgId: string;
  trigger: RunTrigger;
  mode: RunMode;
  status: RunStatus;
  phase: RunPhase;
  requestedBy: string | null;
  workflowRunId: string | null;
  gcSyncId: string | null;
  gcStatus: string | null;
  gcIngestion: string | null;
  completionRequestedAt: string | null;
  cancelRequested: boolean;
  totalArticles: number;
  plannedUploads: number;
  plannedDeletions: number;
  uploaded: number;
  unchanged: number;
  deleted: number;
  failed: number;
  skipped: number;
  gcSynchronized: number | null;
  gcFailed: number | null;
  fingerprint: string | null;
  configHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorHint: string | null;
  errorDetail: string | null;
  note: string | null;
  heartbeatAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const FINISHED_STATUSES: readonly RunStatus[] = ["succeeded", "partial", "failed", "cancelled", "noop"];

export function isRunFinished(run: Pick<RunRow, "status">): boolean {
  return FINISHED_STATUSES.includes(run.status);
}

const nullableInt = (value: unknown) => (value === null || value === undefined ? null : toInt(value));

export function mapRun(row: Record<string, unknown>): RunRow {
  return {
    id: String(row.id),
    syncId: String(row.sync_id),
    orgId: String(row.org_id),
    trigger: row.trigger as RunTrigger,
    mode: row.mode as RunMode,
    status: row.status as RunStatus,
    phase: row.phase as RunPhase,
    requestedBy: (row.requested_by as string | null) ?? null,
    workflowRunId: (row.workflow_run_id as string | null) ?? null,
    gcSyncId: (row.gc_sync_id as string | null) ?? null,
    gcStatus: (row.gc_status as string | null) ?? null,
    gcIngestion: (row.gc_ingestion as string | null) ?? null,
    completionRequestedAt: toIso(row.completion_requested_at),
    cancelRequested: Boolean(row.cancel_requested),
    totalArticles: toInt(row.total_articles),
    plannedUploads: toInt(row.planned_uploads),
    plannedDeletions: toInt(row.planned_deletions),
    uploaded: toInt(row.uploaded),
    unchanged: toInt(row.unchanged),
    deleted: toInt(row.deleted),
    failed: toInt(row.failed),
    skipped: toInt(row.skipped),
    gcSynchronized: nullableInt(row.gc_synchronized),
    gcFailed: nullableInt(row.gc_failed),
    fingerprint: (row.fingerprint as string | null) ?? null,
    configHash: (row.config_hash as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    errorHint: (row.error_hint as string | null) ?? null,
    errorDetail: (row.error_detail as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    heartbeatAt: toIso(row.heartbeat_at) ?? new Date(0).toISOString(),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
  };
}

export function toRunDTO(run: RunRow): RunDTO {
  const started = run.startedAt ?? run.createdAt;
  const code = run.errorCode && isErrorCode(run.errorCode) ? run.errorCode : run.errorCode ? "INTERNAL" : null;
  return {
    id: run.id,
    syncId: run.syncId,
    trigger: run.trigger,
    mode: run.mode,
    status: run.status,
    phase: run.phase,
    plannedUploads: run.plannedUploads,
    plannedDeletions: run.plannedDeletions,
    uploaded: run.uploaded,
    unchanged: run.unchanged,
    deleted: run.deleted,
    failed: run.failed,
    skipped: run.skipped,
    gcSyncId: run.gcSyncId,
    gcSyncStatus: run.gcStatus,
    gcIngestionStatus: run.gcIngestion,
    cancelRequested: run.cancelRequested,
    error: code
      ? {
          code,
          title: ERROR_CATALOG[code].title,
          message: run.errorMessage ?? ERROR_CATALOG[code].message,
          hint: run.errorHint,
          detail: run.errorDetail,
        }
      : null,
    note: run.note,
    requestedBy: run.requestedBy,
    startedAt: started,
    finishedAt: run.finishedAt,
    durationMs: run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(started)) : null,
  };
}

/** Creates a queued run. Returns null when the sync already has an active run. */
export async function createRun(params: {
  id: string;
  syncId: string;
  orgId: string;
  trigger: RunTrigger;
  mode: RunMode;
  requestedBy: string | null;
}): Promise<RunRow | null> {
  const database = await db();
  try {
    const rows = await database.query(
      `INSERT INTO sync_runs (id, sync_id, org_id, trigger, mode, status, phase, requested_by)
       VALUES ($1, $2, $3, $4, $5, 'queued', 'queued', $6) RETURNING *`,
      [params.id, params.syncId, params.orgId, params.trigger, params.mode, params.requestedBy],
    );
    return mapRun(rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error, "sync_runs_one_active")) return null;
    throw error;
  }
}

/** Records a run that finished without doing work (an up-to-date check or a failed check). */
export async function insertFinishedRun(params: {
  id: string;
  syncId: string;
  orgId: string;
  trigger: RunTrigger;
  status: "noop" | "failed";
  requestedBy: string | null;
  totalArticles?: number;
  error?: ErrorRecord;
  note?: string;
  startedAt: Date;
}): Promise<RunRow> {
  const database = await db();
  const rows = await database.query(
    `INSERT INTO sync_runs (id, sync_id, org_id, trigger, mode, status, phase, requested_by, total_articles,
       error_code, error_message, error_hint, error_detail, note, created_at, started_at, finished_at)
     VALUES ($1, $2, $3, $4, 'incremental', $5, 'done', $6, $7, $8, $9, $10, $11, $12, $13, $13, now()) RETURNING *`,
    [
      params.id,
      params.syncId,
      params.orgId,
      params.trigger,
      params.status,
      params.requestedBy,
      params.totalArticles ?? 0,
      params.error?.code ?? null,
      params.error?.message ?? null,
      params.error?.hint ?? null,
      params.error?.detail ?? null,
      params.note ?? null,
      params.startedAt.toISOString(),
    ],
  );
  return mapRun(rows[0]!);
}

export async function getRunById(id: string): Promise<RunRow | null> {
  const database = await db();
  const rows = await database.query("SELECT * FROM sync_runs WHERE id = $1", [id]);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function getRunForOrg(orgId: string, syncId: string, runId: string): Promise<RunRow | null> {
  const database = await db();
  const rows = await database.query("SELECT * FROM sync_runs WHERE org_id = $1 AND sync_id = $2 AND id = $3", [orgId, syncId, runId]);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function getActiveRun(syncId: string): Promise<RunRow | null> {
  const database = await db();
  const rows = await database.query("SELECT * FROM sync_runs WHERE sync_id = $1 AND status IN ('queued', 'running') LIMIT 1", [syncId]);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listRuns(syncId: string, options: { limit: number; before?: string | null }): Promise<RunRow[]> {
  const database = await db();
  const rows = options.before
    ? await database.query(
        `SELECT * FROM sync_runs WHERE sync_id = $1 AND created_at < (SELECT created_at FROM sync_runs WHERE id = $2)
         ORDER BY created_at DESC LIMIT $3`,
        [syncId, options.before, options.limit],
      )
    : await database.query("SELECT * FROM sync_runs WHERE sync_id = $1 ORDER BY created_at DESC LIMIT $2", [syncId, options.limit]);
  return rows.map(mapRun);
}

export interface RunPatch {
  status: RunStatus;
  phase: RunPhase;
  workflowRunId: string | null;
  gcSyncId: string | null;
  gcStatus: string | null;
  gcIngestion: string | null;
  completionRequestedAt: Date | null;
  totalArticles: number;
  plannedUploads: number;
  plannedDeletions: number;
  unchanged: number;
  gcSynchronized: number | null;
  gcFailed: number | null;
  fingerprint: string | null;
  configHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorHint: string | null;
  errorDetail: string | null;
  note: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const PATCH_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  phase: "phase",
  workflowRunId: "workflow_run_id",
  gcSyncId: "gc_sync_id",
  gcStatus: "gc_status",
  gcIngestion: "gc_ingestion",
  completionRequestedAt: "completion_requested_at",
  totalArticles: "total_articles",
  plannedUploads: "planned_uploads",
  plannedDeletions: "planned_deletions",
  unchanged: "unchanged",
  gcSynchronized: "gc_synchronized",
  gcFailed: "gc_failed",
  fingerprint: "fingerprint",
  configHash: "config_hash",
  errorCode: "error_code",
  errorMessage: "error_message",
  errorHint: "error_hint",
  errorDetail: "error_detail",
  note: "note",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

export function buildRunUpdate(id: string, patch: Partial<RunPatch>, options: { onlyActive?: boolean } = {}): { text: string; params: unknown[] } | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof RunPatch, unknown]>) {
    if (value === undefined) continue;
    params.push(value instanceof Date ? value.toISOString() : value);
    sets.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
  }
  if (sets.length === 0) return null;
  params.push(id);
  const guard = options.onlyActive ? " AND status IN ('queued', 'running')" : "";
  return { text: `UPDATE sync_runs SET ${sets.join(", ")}, heartbeat_at = now() WHERE id = $${params.length}${guard} RETURNING *`, params };
}

/** Applies a patch; with `onlyActive` it's a no-op for runs that already finished. Returns the updated row. */
export async function updateRun(id: string, patch: Partial<RunPatch>, options: { onlyActive?: boolean } = {}): Promise<RunRow | null> {
  const statement = buildRunUpdate(id, patch, options);
  if (!statement) return getRunById(id);
  const database = await db();
  const rows = await database.query(statement.text, statement.params);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function addRunCounters(
  id: string,
  deltas: { uploaded?: number; unchanged?: number; deleted?: number; failed?: number; skipped?: number },
): Promise<void> {
  const database = await db();
  await database.query(
    `UPDATE sync_runs SET uploaded = uploaded + $2, unchanged = unchanged + $3, deleted = deleted + $4,
       failed = failed + $5, skipped = skipped + $6, heartbeat_at = now()
     WHERE id = $1`,
    [id, deltas.uploaded ?? 0, deltas.unchanged ?? 0, deltas.deleted ?? 0, deltas.failed ?? 0, deltas.skipped ?? 0],
  );
}

export async function touchRun(id: string): Promise<void> {
  const database = await db();
  await database.query("UPDATE sync_runs SET heartbeat_at = now() WHERE id = $1", [id]);
}

export async function requestRunCancel(id: string): Promise<RunRow | null> {
  const database = await db();
  const rows = await database.query(
    "UPDATE sync_runs SET cancel_requested = true WHERE id = $1 AND status IN ('queued', 'running') RETURNING *",
    [id],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** Active runs whose heartbeat is older than `staleMinutes`. */
export async function listStaleRuns(staleMinutes: number, limit = 20): Promise<RunRow[]> {
  const database = await db();
  const rows = await database.query(
    `SELECT * FROM sync_runs WHERE status IN ('queued', 'running') AND heartbeat_at < now() - make_interval(mins => $1)
     ORDER BY heartbeat_at LIMIT $2`,
    [staleMinutes, limit],
  );
  return rows.map(mapRun);
}

/** Keeps item-level detail for the most recent runs and the run history bounded. */
export async function pruneRunHistory(syncId: string, keepItemsForRuns = 20, keepRuns = 200): Promise<void> {
  const database = await db();
  await database.transaction([
    {
      text: `DELETE FROM run_items WHERE run_id IN (
               SELECT id FROM sync_runs WHERE sync_id = $1 ORDER BY created_at DESC OFFSET $2)`,
      params: [syncId, keepItemsForRuns],
    },
    {
      text: `DELETE FROM sync_runs WHERE id IN (
               SELECT id FROM sync_runs WHERE sync_id = $1 AND status NOT IN ('queued', 'running') ORDER BY created_at DESC OFFSET $2)`,
      params: [syncId, keepRuns],
    },
  ]);
}
