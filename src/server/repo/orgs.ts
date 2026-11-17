import { db, toIso } from "../db";

export interface OrgRow {
  id: string;
  name: string;
  region: string;
  gcClientId: string | null;
  gcClientSecretEnc: string | null;
  gcVerifiedAt: string | null;
  gcLastError: string | null;
}

function mapOrg(row: Record<string, unknown>): OrgRow {
  return {
    id: String(row.id),
    name: String(row.name),
    region: String(row.region),
    gcClientId: (row.gc_client_id as string | null) ?? null,
    gcClientSecretEnc: (row.gc_client_secret_enc as string | null) ?? null,
    gcVerifiedAt: toIso(row.gc_verified_at),
    gcLastError: (row.gc_last_error as string | null) ?? null,
  };
}

export async function upsertOrg(org: { id: string; name: string; region: string }): Promise<OrgRow> {
  const database = await db();
  const rows = await database.query(
    `INSERT INTO orgs (id, name, region) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, region = EXCLUDED.region, updated_at = now()
     RETURNING *`,
    [org.id, org.name, org.region],
  );
  return mapOrg(rows[0]!);
}

export async function getOrg(id: string): Promise<OrgRow | null> {
  const database = await db();
  const rows = await database.query("SELECT * FROM orgs WHERE id = $1", [id]);
  return rows[0] ? mapOrg(rows[0]) : null;
}

export async function setOrgGcCredentials(id: string, credentials: { clientId: string; secretEnc: string }): Promise<void> {
  const database = await db();
  await database.query(
    `UPDATE orgs SET gc_client_id = $2, gc_client_secret_enc = $3, gc_verified_at = now(), gc_last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, credentials.clientId, credentials.secretEnc],
  );
}

export async function clearOrgGcCredentials(id: string): Promise<void> {
  const database = await db();
  await database.query(
    `UPDATE orgs SET gc_client_id = NULL, gc_client_secret_enc = NULL, gc_verified_at = NULL, gc_last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

/** Records (or clears) the last background authentication problem, shown on the Connections page. */
export async function setOrgGcError(id: string, message: string | null): Promise<void> {
  const database = await db();
  await database.query("UPDATE orgs SET gc_last_error = $2, updated_at = now() WHERE id = $1 AND gc_last_error IS DISTINCT FROM $2", [id, message]);
}
