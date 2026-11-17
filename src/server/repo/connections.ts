import type { ConnectionDTO, ConnectionStatus, SnAuthType } from "@/lib/api-types";
import { db, toInt, toIso } from "../db";

export interface ConnectionRow {
  id: string;
  orgId: string;
  name: string;
  instanceUrl: string;
  authType: SnAuthType;
  principal: string;
  secretEnc: string;
  status: ConnectionStatus;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  syncCount: number;
}

function mapConnection(row: Record<string, unknown>): ConnectionRow {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    name: String(row.name),
    instanceUrl: String(row.instance_url),
    authType: row.auth_type as SnAuthType,
    principal: String(row.principal ?? ""),
    secretEnc: String(row.secret_enc),
    status: (row.status as ConnectionStatus) ?? "unknown",
    lastCheckedAt: toIso(row.last_checked_at),
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorMessage: (row.last_error_message as string | null) ?? null,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    syncCount: toInt(row.sync_count),
  };
}

export function toConnectionDTO(row: ConnectionRow): ConnectionDTO {
  return {
    id: row.id,
    name: row.name,
    instanceUrl: row.instanceUrl,
    authType: row.authType,
    principal: row.authType === "apikey" ? null : row.principal || null,
    status: row.status,
    statusMessage: row.status === "error" ? row.lastErrorMessage : null,
    checkedAt: row.lastCheckedAt,
    syncCount: row.syncCount,
    createdAt: row.createdAt,
  };
}

const SELECT_WITH_USAGE = `SELECT c.*, (SELECT count(*)::int FROM syncs s WHERE s.connection_id = c.id) AS sync_count FROM sn_connections c`;

export async function listConnections(orgId: string): Promise<ConnectionRow[]> {
  const database = await db();
  const rows = await database.query(`${SELECT_WITH_USAGE} WHERE c.org_id = $1 ORDER BY lower(c.name), c.created_at`, [orgId]);
  return rows.map(mapConnection);
}

export async function getConnection(orgId: string, id: string): Promise<ConnectionRow | null> {
  const database = await db();
  const rows = await database.query(`${SELECT_WITH_USAGE} WHERE c.org_id = $1 AND c.id = $2`, [orgId, id]);
  return rows[0] ? mapConnection(rows[0]) : null;
}

/** For background work, where the org scope comes from the sync itself. */
export async function getConnectionById(id: string): Promise<ConnectionRow | null> {
  const database = await db();
  const rows = await database.query(`${SELECT_WITH_USAGE} WHERE c.id = $1`, [id]);
  return rows[0] ? mapConnection(rows[0]) : null;
}

export async function insertConnection(row: {
  id: string;
  orgId: string;
  name: string;
  instanceUrl: string;
  authType: SnAuthType;
  principal: string;
  secretEnc: string;
  status: ConnectionStatus;
  createdBy: string;
}): Promise<void> {
  const database = await db();
  await database.query(
    `INSERT INTO sn_connections (id, org_id, name, instance_url, auth_type, principal, secret_enc, status, last_checked_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)`,
    [row.id, row.orgId, row.name, row.instanceUrl, row.authType, row.principal, row.secretEnc, row.status, row.createdBy],
  );
}

export async function updateConnection(
  orgId: string,
  id: string,
  patch: { name: string; instanceUrl: string; authType: SnAuthType; principal: string; secretEnc: string },
): Promise<void> {
  const database = await db();
  await database.query(
    `UPDATE sn_connections SET name = $3, instance_url = $4, auth_type = $5, principal = $6, secret_enc = $7,
       status = 'ok', last_checked_at = now(), last_error_code = NULL, last_error_message = NULL, updated_at = now()
     WHERE org_id = $1 AND id = $2`,
    [orgId, id, patch.name, patch.instanceUrl, patch.authType, patch.principal, patch.secretEnc],
  );
}

export async function renameConnection(orgId: string, id: string, name: string): Promise<void> {
  const database = await db();
  await database.query("UPDATE sn_connections SET name = $3, updated_at = now() WHERE org_id = $1 AND id = $2", [orgId, id, name]);
}

export async function setConnectionStatus(id: string, status: ConnectionStatus, error?: { code: string; message: string }): Promise<void> {
  const database = await db();
  await database.query(
    `UPDATE sn_connections SET status = $2, last_checked_at = now(), last_error_code = $3, last_error_message = $4, updated_at = now()
     WHERE id = $1`,
    [id, status, error?.code ?? null, error?.message ?? null],
  );
}

export async function deleteConnection(orgId: string, id: string): Promise<boolean> {
  const database = await db();
  const rows = await database.query("DELETE FROM sn_connections WHERE org_id = $1 AND id = $2 RETURNING id", [orgId, id]);
  return rows.length > 0;
}

export async function countConnections(orgId: string): Promise<number> {
  const database = await db();
  const rows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM sn_connections WHERE org_id = $1", [orgId]);
  return toInt(rows[0]?.count);
}
