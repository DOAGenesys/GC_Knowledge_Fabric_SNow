import type { ArticleDTO, ArticlePage, ArticleState, RunItemDTO } from "@/lib/api-types";
import { db, type Statement, toInt, toIso } from "../db";
import type { ManifestEntry, PlannedDeletion, PlannedUpload } from "../sync/plan";

export type RunItemStatus = RunItemDTO["status"];

export interface RunItemRow {
  seq: number;
  op: "upload" | "delete";
  articleId: string;
  number: string;
  title: string;
  kbName: string;
  fileName: string;
  snUpdatedAt: string | null;
  reason: string;
  status: RunItemStatus;
  contentHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Content hash recorded for this article by the last successful upload (from the manifest). */
  priorHash: string | null;
}

function mapRunItem(row: Record<string, unknown>): RunItemRow {
  return {
    seq: toInt(row.seq),
    op: row.op as RunItemRow["op"],
    articleId: String(row.article_id),
    number: String(row.number ?? ""),
    title: String(row.title ?? ""),
    kbName: String(row.kb_name ?? ""),
    fileName: String(row.file_name),
    snUpdatedAt: (row.sn_updated_at as string | null) ?? null,
    reason: String(row.reason),
    status: row.status as RunItemStatus,
    contentHash: (row.content_hash as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    priorHash: (row.prior_hash as string | null) ?? null,
  };
}

/** One INSERT for any number of planned items (arrays + unnest keep it to a single round trip). */
export function buildRunItemsInsert(runId: string, uploads: PlannedUpload[], deletions: PlannedDeletion[]): Statement {
  const seqs: number[] = [];
  const ops: string[] = [];
  const articleIds: string[] = [];
  const numbers: string[] = [];
  const titles: string[] = [];
  const kbNames: string[] = [];
  const fileNames: string[] = [];
  const updatedAts: Array<string | null> = [];
  const reasons: string[] = [];
  let seq = 0;
  for (const upload of uploads) {
    seqs.push(++seq);
    ops.push("upload");
    articleIds.push(upload.articleId);
    numbers.push(upload.number);
    titles.push(upload.title);
    kbNames.push(upload.kbName);
    fileNames.push(upload.fileName);
    updatedAts.push(upload.snUpdatedAt);
    reasons.push(upload.reason);
  }
  for (const deletion of deletions) {
    seqs.push(++seq);
    ops.push("delete");
    articleIds.push(deletion.articleId);
    numbers.push("");
    titles.push("");
    kbNames.push("");
    fileNames.push(deletion.fileName);
    updatedAts.push(null);
    reasons.push(deletion.reason);
  }
  return {
    text: `INSERT INTO run_items (run_id, seq, op, article_id, number, title, kb_name, file_name, sn_updated_at, reason)
           SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])`,
    params: [runId, seqs, ops, articleIds, numbers, titles, kbNames, fileNames, updatedAts, reasons],
  };
}

/** Deletion titles/numbers come from the manifest so the run history stays readable. */
export function buildDeletionLabelsUpdate(runId: string, syncId: string): Statement {
  return {
    text: `UPDATE run_items ri SET number = si.number, title = si.title, kb_name = si.kb_name
             FROM sync_items si
            WHERE ri.run_id = $1 AND ri.op = 'delete' AND si.sync_id = $2 AND si.article_id = ri.article_id`,
    params: [runId, syncId],
  };
}

export async function clearRunItems(runId: string): Promise<void> {
  const database = await db();
  await database.query("DELETE FROM run_items WHERE run_id = $1", [runId]);
}

export async function nextPendingItems(runId: string, syncId: string, op: "upload" | "delete", limit: number): Promise<RunItemRow[]> {
  const database = await db();
  const rows = await database.query(
    `SELECT ri.*, si.content_hash AS prior_hash
       FROM run_items ri
       LEFT JOIN sync_items si ON si.sync_id = $2 AND si.article_id = ri.article_id
      WHERE ri.run_id = $1 AND ri.status = 'pending' AND ri.op = $3
      ORDER BY ri.seq
      LIMIT $4`,
    [runId, syncId, op, limit],
  );
  return rows.map(mapRunItem);
}

export async function countPendingItems(runId: string): Promise<number> {
  const database = await db();
  const rows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM run_items WHERE run_id = $1 AND status = 'pending'", [runId]);
  return toInt(rows[0]?.count);
}

export interface ItemResult {
  seq: number;
  status: Exclude<RunItemStatus, "pending">;
  contentHash?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export function buildItemResultsUpdate(runId: string, results: ItemResult[]): Statement {
  return {
    text: `UPDATE run_items ri SET status = u.status, content_hash = COALESCE(u.content_hash, ri.content_hash),
             error_code = u.error_code, error_message = u.error_message
             FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u(seq, status, content_hash, error_code, error_message)
            WHERE ri.run_id = $1 AND ri.seq = u.seq`,
    params: [
      runId,
      results.map((result) => result.seq),
      results.map((result) => result.status),
      results.map((result) => result.contentHash ?? null),
      results.map((result) => result.errorCode ?? null),
      results.map((result) => (result.errorMessage ? result.errorMessage.slice(0, 500) : null)),
    ],
  };
}

export async function recordItemResults(runId: string, results: ItemResult[], counters: Statement): Promise<void> {
  if (results.length === 0) return;
  const database = await db();
  await database.transaction([buildItemResultsUpdate(runId, results), counters]);
}

/** Marks the run's pending uploads as failed (and counts them) so the next run retries them. */
export async function failPendingUploads(runId: string, errorCode: string, errorMessage: string): Promise<number> {
  const database = await db();
  const rows = await database.query<{ count: number }>(
    `WITH abandoned AS (
       UPDATE run_items SET status = 'failed', error_code = $2, error_message = $3
        WHERE run_id = $1 AND status = 'pending' AND op = 'upload'
        RETURNING seq
     )
     UPDATE sync_runs SET failed = failed + (SELECT count(*) FROM abandoned), heartbeat_at = now()
      WHERE id = $1
      RETURNING (SELECT count(*)::int FROM abandoned) AS count`,
    [runId, errorCode, errorMessage.slice(0, 500)],
  );
  return toInt(rows[0]?.count);
}

/** Marks every still-pending item of a run as skipped (cancelled or aborted runs) and counts them. */
export async function skipPendingItems(runId: string, message: string): Promise<number> {
  const database = await db();
  const rows = await database.query<{ count: number }>(
    `WITH skipped AS (
       UPDATE run_items SET status = 'skipped', error_message = $2
        WHERE run_id = $1 AND status = 'pending'
        RETURNING seq
     )
     UPDATE sync_runs SET skipped = skipped + (SELECT count(*) FROM skipped)
      WHERE id = $1
      RETURNING (SELECT count(*)::int FROM skipped) AS count`,
    [runId, message],
  );
  return toInt(rows[0]?.count);
}

export async function listRunItems(
  runId: string,
  options: { status?: RunItemStatus | "attention"; limit: number },
): Promise<{ items: RunItemDTO[]; counts: Record<RunItemStatus, number> }> {
  const database = await db();
  const filter =
    options.status === "attention" ? "AND status IN ('failed', 'skipped')" : options.status ? "AND status = $3" : "";
  const params: unknown[] = [runId, options.limit];
  if (options.status && options.status !== "attention") params.push(options.status);
  const [rows, countRows] = await Promise.all([
    database.query(`SELECT * FROM run_items WHERE run_id = $1 ${filter} ORDER BY (status = 'failed') DESC, seq LIMIT $2`, params),
    database.query<{ status: RunItemStatus; count: number }>(
      "SELECT status, count(*)::int AS count FROM run_items WHERE run_id = $1 GROUP BY status",
      [runId],
    ),
  ]);
  const counts: Record<RunItemStatus, number> = { pending: 0, done: 0, unchanged: 0, failed: 0, skipped: 0 };
  for (const row of countRows) counts[row.status] = toInt(row.count);
  return {
    items: rows.map(mapRunItem).map((item) => ({
      articleId: item.articleId,
      number: item.number,
      title: item.title || item.fileName,
      op: item.op,
      reason: item.reason,
      status: item.status,
      error: item.errorMessage,
    })),
    counts,
  };
}

/* ------------------------------ manifest ------------------------------ */

export async function loadManifest(syncId: string): Promise<ManifestEntry[]> {
  const database = await db();
  const rows = await database.query("SELECT article_id, file_name, sn_updated_at, content_hash, state FROM sync_items WHERE sync_id = $1", [syncId]);
  return rows.map((row) => ({
    articleId: String(row.article_id),
    fileName: String(row.file_name),
    snUpdatedAt: (row.sn_updated_at as string | null) ?? null,
    contentHash: (row.content_hash as string | null) ?? null,
    state: row.state as ArticleState,
  }));
}

export async function countManifestIssues(syncId: string): Promise<number> {
  const database = await db();
  const rows = await database.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM sync_items WHERE sync_id = $1 AND state IN ('error', 'pending_delete')",
    [syncId],
  );
  return toInt(rows[0]?.count);
}

/**
 * Statements that fold a run's item results into the sync's manifest.
 * `committed` means Genesys Cloud accepted and processed the round, so uploads and
 * deletions really happened. Otherwise only facts that don't depend on the round are kept
 * (unchanged articles, failures, skips) and everything else is retried next time.
 */
export function buildManifestStatements(params: { syncId: string; runId: string; committed: boolean; fullRebuild: boolean }): Statement[] {
  const { syncId, runId } = params;
  const statements: Statement[] = [
    {
      text: `UPDATE sync_items si SET sn_updated_at = ri.sn_updated_at, number = ri.number, title = ri.title, kb_name = ri.kb_name,
               content_hash = COALESCE(ri.content_hash, si.content_hash), state = 'synced', error_code = NULL, error_message = NULL,
               last_run_id = $2, updated_at = now()
               FROM run_items ri
              WHERE ri.run_id = $2 AND ri.op = 'upload' AND ri.status = 'unchanged' AND si.sync_id = $1 AND si.article_id = ri.article_id`,
      params: [syncId, runId],
    },
    {
      text: `INSERT INTO sync_items (sync_id, article_id, number, title, kb_name, file_name, sn_updated_at, state, error_code, error_message, last_run_id)
             SELECT $1, ri.article_id, ri.number, ri.title, ri.kb_name, ri.file_name, NULL, 'error', ri.error_code, ri.error_message, $2
               FROM run_items ri WHERE ri.run_id = $2 AND ri.op = 'upload' AND ri.status = 'failed'
             ON CONFLICT (sync_id, article_id) DO UPDATE SET state = 'error', error_code = EXCLUDED.error_code,
               error_message = EXCLUDED.error_message, number = EXCLUDED.number, title = EXCLUDED.title,
               last_run_id = EXCLUDED.last_run_id, updated_at = now()`,
      params: [syncId, runId],
    },
    {
      text: `INSERT INTO sync_items (sync_id, article_id, number, title, kb_name, file_name, sn_updated_at, state, error_code, error_message, last_run_id)
             SELECT $1, ri.article_id, ri.number, ri.title, ri.kb_name, ri.file_name, ri.sn_updated_at, 'skipped', ri.error_code, ri.error_message, $2
               FROM run_items ri WHERE ri.run_id = $2 AND ri.op = 'upload' AND ri.status = 'skipped' AND ri.error_code IS NOT NULL
             ON CONFLICT (sync_id, article_id) DO UPDATE SET state = 'skipped', sn_updated_at = EXCLUDED.sn_updated_at,
               error_code = EXCLUDED.error_code, error_message = EXCLUDED.error_message, number = EXCLUDED.number,
               title = EXCLUDED.title, last_run_id = EXCLUDED.last_run_id, updated_at = now()`,
      params: [syncId, runId],
    },
  ];

  if (!params.committed) return statements;

  statements.push(
    {
      text: `INSERT INTO sync_items (sync_id, article_id, number, title, kb_name, file_name, sn_updated_at, content_hash, state, last_run_id, synced_at)
             SELECT $1, ri.article_id, ri.number, ri.title, ri.kb_name, ri.file_name, ri.sn_updated_at, ri.content_hash, 'synced', $2, now()
               FROM run_items ri WHERE ri.run_id = $2 AND ri.op = 'upload' AND ri.status = 'done'
             ON CONFLICT (sync_id, article_id) DO UPDATE SET number = EXCLUDED.number, title = EXCLUDED.title, kb_name = EXCLUDED.kb_name,
               file_name = EXCLUDED.file_name, sn_updated_at = EXCLUDED.sn_updated_at, content_hash = EXCLUDED.content_hash,
               state = 'synced', error_code = NULL, error_message = NULL, last_run_id = EXCLUDED.last_run_id, synced_at = now(), updated_at = now()`,
      params: [syncId, runId],
    },
    {
      text: `DELETE FROM sync_items si USING run_items ri
              WHERE ri.run_id = $2 AND ri.op = 'delete' AND ri.status = 'done' AND si.sync_id = $1 AND si.article_id = ri.article_id`,
      params: [syncId, runId],
    },
    {
      text: `UPDATE sync_items si SET state = 'pending_delete', error_code = ri.error_code, error_message = ri.error_message,
               last_run_id = $2, updated_at = now()
               FROM run_items ri
              WHERE ri.run_id = $2 AND ri.op = 'delete' AND ri.status = 'failed' AND si.sync_id = $1 AND si.article_id = ri.article_id`,
      params: [syncId, runId],
    },
  );

  if (params.fullRebuild) {
    statements.push({
      text: `DELETE FROM sync_items si
              WHERE si.sync_id = $1
                AND NOT EXISTS (SELECT 1 FROM run_items ri WHERE ri.run_id = $2 AND ri.article_id = si.article_id AND ri.status IN ('done', 'skipped'))`,
      params: [syncId, runId],
    });
  }
  return statements;
}

function mapArticle(row: Record<string, unknown>): ArticleDTO {
  return {
    articleId: String(row.article_id),
    number: String(row.number ?? ""),
    title: String(row.title ?? ""),
    kbName: String(row.kb_name ?? ""),
    fileName: String(row.file_name),
    state: row.state as ArticleState,
    lastError: (row.error_message as string | null) ?? null,
    syncedAt: toIso(row.synced_at),
    snUpdatedAt: (row.sn_updated_at as string | null) ?? null,
  };
}

export async function listArticles(
  syncId: string,
  options: { state?: ArticleState; search?: string; limit: number; offset: number },
): Promise<ArticlePage> {
  const database = await db();
  const conditions = ["sync_id = $1"];
  const params: unknown[] = [syncId];
  if (options.state) {
    params.push(options.state);
    conditions.push(`state = $${params.length}`);
  }
  if (options.search?.trim()) {
    params.push(`%${options.search.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    conditions.push(`(number ILIKE $${params.length} OR title ILIKE $${params.length} OR file_name ILIKE $${params.length})`);
  }
  const where = conditions.join(" AND ");
  const [rows, totalRows, countRows] = await Promise.all([
    database.query(
      `SELECT * FROM sync_items WHERE ${where}
        ORDER BY (state = 'error') DESC, (state = 'pending_delete') DESC, number, article_id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, options.limit, options.offset],
    ),
    database.query<{ count: number }>(`SELECT count(*)::int AS count FROM sync_items WHERE ${where}`, params),
    database.query<{ state: ArticleState; count: number }>("SELECT state, count(*)::int AS count FROM sync_items WHERE sync_id = $1 GROUP BY state", [syncId]),
  ]);
  const counts: Record<ArticleState, number> = { synced: 0, error: 0, skipped: 0, pending_delete: 0 };
  for (const row of countRows) counts[row.state] = toInt(row.count);
  return { items: rows.map(mapArticle), total: toInt(totalRows[0]?.count), counts };
}
