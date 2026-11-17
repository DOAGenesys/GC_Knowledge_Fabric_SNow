import type { Audience, LinkStyle, SyncDTO, SyncHealth } from "@/lib/api-types";
import { parseSchedule, type Schedule } from "@/lib/schedule";
import { db, isUniqueViolation, toInt, toIso, toJson, toStringArray } from "../db";
import { mapRun, toRunDTO } from "./runs";

export interface SyncRow {
  id: string;
  orgId: string;
  connectionId: string;
  name: string;
  audience: Audience;
  kbIds: string[];
  kbNames: string[];
  filterQuery: string;
  linkStyle: LinkStyle;
  linkCustom: string;
  sourceId: string;
  sourceName: string;
  schedule: Schedule;
  enabled: boolean;
  nextRunAt: string | null;
  health: SyncHealth;
  statusMessage: string | null;
  consecutiveFailures: number;
  articleCount: number;
  fingerprint: string | null;
  configHash: string | null;
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

function safeSchedule(value: unknown): Schedule {
  try {
    return parseSchedule(toJson(value));
  } catch {
    return { kind: "manual" };
  }
}

export function mapSync(row: Record<string, unknown>): SyncRow {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    connectionId: String(row.connection_id),
    name: String(row.name),
    audience: row.audience as Audience,
    kbIds: toStringArray(row.kb_ids),
    kbNames: toStringArray(row.kb_names),
    filterQuery: String(row.filter_query ?? ""),
    linkStyle: row.link_style as LinkStyle,
    linkCustom: String(row.link_custom ?? ""),
    sourceId: String(row.source_id),
    sourceName: String(row.source_name),
    schedule: safeSchedule(row.schedule),
    enabled: Boolean(row.enabled),
    nextRunAt: toIso(row.next_run_at),
    health: (row.health as SyncHealth) ?? "new",
    statusMessage: (row.status_message as string | null) ?? null,
    consecutiveFailures: toInt(row.consecutive_failures),
    articleCount: toInt(row.article_count),
    fingerprint: (row.fingerprint as string | null) ?? null,
    configHash: (row.config_hash as string | null) ?? null,
    lastSuccessAt: toIso(row.last_success_at),
    lastCheckedAt: toIso(row.last_checked_at),
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

const LIST_QUERY = `
  SELECT s.*,
         c.name AS connection_name, c.instance_url AS connection_instance_url,
         to_jsonb(a.*) AS active_run, to_jsonb(l.*) AS last_run
    FROM syncs s
    JOIN sn_connections c ON c.id = s.connection_id
    LEFT JOIN LATERAL (
      SELECT * FROM sync_runs r WHERE r.sync_id = s.id AND r.status IN ('queued', 'running') LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT * FROM sync_runs r WHERE r.sync_id = s.id AND r.status NOT IN ('queued', 'running')
       ORDER BY r.created_at DESC LIMIT 1
    ) l ON true`;

export function toSyncDTO(row: Record<string, unknown>): SyncDTO {
  const sync = mapSync(row);
  const active = toJson<Record<string, unknown>>(row.active_run);
  const last = toJson<Record<string, unknown>>(row.last_run);
  return {
    id: sync.id,
    name: sync.name,
    audience: sync.audience,
    connection: { id: sync.connectionId, name: String(row.connection_name ?? ""), instanceUrl: String(row.connection_instance_url ?? "") },
    kbIds: sync.kbIds,
    kbNames: sync.kbNames,
    filterQuery: sync.filterQuery,
    linkStyle: sync.linkStyle,
    linkCustom: sync.linkCustom,
    source: { id: sync.sourceId, name: sync.sourceName },
    schedule: sync.schedule,
    enabled: sync.enabled,
    nextRunAt: sync.enabled ? sync.nextRunAt : null,
    health: sync.health,
    statusMessage: sync.statusMessage,
    consecutiveFailures: sync.consecutiveFailures,
    articleCount: sync.articleCount,
    lastSuccessAt: sync.lastSuccessAt,
    lastCheckedAt: sync.lastCheckedAt,
    activeRun: active ? toRunDTO(mapRun(active)) : null,
    lastRun: last ? toRunDTO(mapRun(last)) : null,
    createdAt: sync.createdAt,
  };
}

export async function listSyncDTOs(orgId: string): Promise<SyncDTO[]> {
  const database = await db();
  const rows = await database.query(`${LIST_QUERY} WHERE s.org_id = $1 ORDER BY lower(s.name), s.created_at`, [orgId]);
  return rows.map(toSyncDTO);
}

export async function getSyncDTO(orgId: string, id: string): Promise<SyncDTO | null> {
  const database = await db();
  const rows = await database.query(`${LIST_QUERY} WHERE s.org_id = $1 AND s.id = $2`, [orgId, id]);
  return rows[0] ? toSyncDTO(rows[0]) : null;
}

export async function getSync(orgId: string, id: string): Promise<SyncRow | null> {
  const database = await db();
  const rows = await database.query("SELECT * FROM syncs WHERE org_id = $1 AND id = $2", [orgId, id]);
  return rows[0] ? mapSync(rows[0]) : null;
}

export async function getSyncById(id: string): Promise<SyncRow | null> {
  const database = await db();
  const rows = await database.query("SELECT * FROM syncs WHERE id = $1", [id]);
  return rows[0] ? mapSync(rows[0]) : null;
}

export async function findSyncBySource(orgId: string, sourceId: string): Promise<{ id: string; name: string } | null> {
  const database = await db();
  const rows = await database.query<{ id: string; name: string }>("SELECT id, name FROM syncs WHERE org_id = $1 AND source_id = $2", [orgId, sourceId]);
  return rows[0] ?? null;
}

export async function listSourceUsage(orgId: string): Promise<Map<string, { syncId: string; syncName: string }>> {
  const database = await db();
  const rows = await database.query<{ id: string; name: string; source_id: string }>("SELECT id, name, source_id FROM syncs WHERE org_id = $1", [orgId]);
  return new Map(rows.map((row) => [row.source_id, { syncId: row.id, syncName: row.name }]));
}

export interface NewSync {
  id: string;
  orgId: string;
  connectionId: string;
  name: string;
  audience: Audience;
  kbIds: string[];
  kbNames: string[];
  filterQuery: string;
  linkStyle: LinkStyle;
  linkCustom: string;
  sourceId: string;
  sourceName: string;
  schedule: Schedule;
  enabled: boolean;
  nextRunAt: Date | null;
  createdBy: string;
}

/** Returns false when another sync already targets the same Genesys Cloud source. */
export async function insertSync(sync: NewSync): Promise<boolean> {
  const database = await db();
  try {
    await database.query(
      `INSERT INTO syncs (id, org_id, connection_id, name, audience, kb_ids, kb_names, filter_query, link_style, link_custom,
         source_id, source_name, schedule, enabled, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16)`,
      [
        sync.id,
        sync.orgId,
        sync.connectionId,
        sync.name,
        sync.audience,
        JSON.stringify(sync.kbIds),
        JSON.stringify(sync.kbNames),
        sync.filterQuery,
        sync.linkStyle,
        sync.linkCustom,
        sync.sourceId,
        sync.sourceName,
        JSON.stringify(sync.schedule),
        sync.enabled,
        sync.nextRunAt?.toISOString() ?? null,
        sync.createdBy,
      ],
    );
    return true;
  } catch (error) {
    if (isUniqueViolation(error, "syncs_org_source_unique")) return false;
    throw error;
  }
}

export interface SyncSettingsPatch {
  name: string;
  connectionId: string;
  audience: Audience;
  kbIds: string[];
  kbNames: string[];
  filterQuery: string;
  linkStyle: LinkStyle;
  linkCustom: string;
  schedule: Schedule;
  enabled: boolean;
  nextRunAt: Date | null;
  resetFingerprint: boolean;
}

export async function updateSyncSettings(orgId: string, id: string, patch: SyncSettingsPatch): Promise<void> {
  const database = await db();
  await database.query(
    `UPDATE syncs SET name = $3, audience = $4, kb_ids = $5::jsonb, kb_names = $6::jsonb, filter_query = $7, link_style = $8,
       link_custom = $9, schedule = $10::jsonb, enabled = $11, next_run_at = $12,
       fingerprint = CASE WHEN $13 THEN NULL ELSE fingerprint END, connection_id = $14, updated_at = now()
     WHERE org_id = $1 AND id = $2`,
    [
      orgId,
      id,
      patch.name,
      patch.audience,
      JSON.stringify(patch.kbIds),
      JSON.stringify(patch.kbNames),
      patch.filterQuery,
      patch.linkStyle,
      patch.linkCustom,
      JSON.stringify(patch.schedule),
      patch.enabled,
      patch.nextRunAt?.toISOString() ?? null,
      patch.resetFingerprint,
      patch.connectionId,
    ],
  );
}

export async function deleteSync(orgId: string, id: string): Promise<boolean> {
  const database = await db();
  const rows = await database.query("DELETE FROM syncs WHERE org_id = $1 AND id = $2 RETURNING id", [orgId, id]);
  return rows.length > 0;
}

export async function countSyncs(orgId: string): Promise<number> {
  const database = await db();
  const rows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM syncs WHERE org_id = $1", [orgId]);
  return toInt(rows[0]?.count);
}

/**
 * Atomically claims enabled syncs that are due and have no active run, pushing their
 * next_run_at forward by a lease so overlapping ticks never pick the same sync twice.
 */
export async function claimDueSyncs(limit: number, leaseMinutes = 10): Promise<SyncRow[]> {
  const database = await db();
  const rows = await database.query(
    `WITH due AS (
       SELECT s.id FROM syncs s
        WHERE s.enabled AND s.next_run_at IS NOT NULL AND s.next_run_at <= now()
          AND NOT EXISTS (SELECT 1 FROM sync_runs r WHERE r.sync_id = s.id AND r.status IN ('queued', 'running'))
        ORDER BY s.next_run_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE syncs SET next_run_at = now() + make_interval(mins => $2)
       FROM due WHERE syncs.id = due.id
     RETURNING syncs.*`,
    [limit, leaseMinutes],
  );
  return rows.map(mapSync);
}

/** Result of a scheduled check that found nothing to do. */
export async function markSyncChecked(id: string, nextRunAt: Date | null, articleCount: number): Promise<void> {
  const database = await db();
  await database.query(
    `UPDATE syncs SET last_checked_at = now(), next_run_at = $2, article_count = $3,
       health = CASE WHEN health IN ('new', 'error') AND consecutive_failures = 0 THEN 'healthy' ELSE health END
     WHERE id = $1`,
    [id, nextRunAt?.toISOString() ?? null, articleCount],
  );
}

export interface SyncOutcome {
  health: SyncHealth;
  statusMessage: string | null;
  consecutiveFailures: number;
  nextRunAt: Date | null;
  fingerprint: string | null;
  configHash?: string | null;
  articleCount?: number;
  succeeded: boolean;
}

export async function setSyncOutcome(id: string, outcome: SyncOutcome): Promise<void> {
  const database = await db();
  await database.query(
    `UPDATE syncs SET health = $2, status_message = $3, consecutive_failures = $4, next_run_at = $5, fingerprint = $6,
       config_hash = COALESCE($7, config_hash), article_count = COALESCE($8, article_count),
       last_success_at = CASE WHEN $9 THEN now() ELSE last_success_at END,
       last_checked_at = now(), updated_at = now()
     WHERE id = $1`,
    [
      id,
      outcome.health,
      outcome.statusMessage,
      outcome.consecutiveFailures,
      outcome.nextRunAt?.toISOString() ?? null,
      outcome.fingerprint,
      outcome.configHash ?? null,
      outcome.articleCount ?? null,
      outcome.succeeded,
    ],
  );
}
