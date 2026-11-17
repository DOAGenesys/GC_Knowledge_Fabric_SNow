import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConnectionDTO } from "@/lib/api-types";
import { AppError } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "../crypto";
import {
  type ConnectionRow,
  deleteConnection,
  getConnection,
  getConnectionById,
  insertConnection,
  renameConnection,
  setConnectionStatus,
  toConnectionDTO,
  updateConnection,
} from "../repo/connections";
import type { SnConnection, SnCredentials } from "../servicenow/client";
import { normalizeInstanceUrl } from "../servicenow/instance";
import { testConnection } from "../servicenow/knowledge";
import type { ActorContext } from "./actor";

const secret = z.string().min(1, "Required").max(1000);

export const connectionInputSchema = z.object({
  name: z.string().trim().min(1, "Give the connection a name").max(80),
  instanceUrl: z.string().trim().min(1, "Enter your ServiceNow instance").max(300),
  auth: z.discriminatedUnion("type", [
    z.object({ type: z.literal("basic"), username: z.string().trim().min(1, "Required").max(200), password: secret.optional() }),
    z.object({ type: z.literal("oauth"), clientId: z.string().trim().min(1, "Required").max(200), clientSecret: secret.optional() }),
    z.object({ type: z.literal("apikey"), apiKey: secret.optional() }),
  ]),
});

export type ConnectionInput = z.infer<typeof connectionInputSchema>;

function credentialsContext(connectionId: string): string {
  return `sn-connection:${connectionId}`;
}

function principalOf(credentials: SnCredentials): string {
  if (credentials.type === "basic") return credentials.username;
  if (credentials.type === "oauth") return credentials.clientId;
  return "";
}

/** Merges submitted auth with stored credentials: a blank secret keeps the saved one. */
export function buildCredentials(auth: ConnectionInput["auth"], existing: SnCredentials | null): SnCredentials {
  const keep = existing?.type === auth.type ? existing : null;
  const missing = (path: string): never => {
    throw new AppError("VALIDATION", { message: "Please fill in the missing credentials.", fields: [{ path, message: "Required" }] });
  };
  switch (auth.type) {
    case "basic": {
      const password = auth.password ?? (keep?.type === "basic" ? keep.password : undefined) ?? missing("auth.password");
      return { type: "basic", username: auth.username, password };
    }
    case "oauth": {
      const clientSecret = auth.clientSecret ?? (keep?.type === "oauth" ? keep.clientSecret : undefined) ?? missing("auth.clientSecret");
      return { type: "oauth", clientId: auth.clientId, clientSecret };
    }
    case "apikey": {
      const apiKey = auth.apiKey ?? (keep?.type === "apikey" ? keep.apiKey : undefined) ?? missing("auth.apiKey");
      return { type: "apikey", apiKey };
    }
  }
}

/** Decrypted connection for API calls. */
export function resolveConnection(row: ConnectionRow): SnConnection {
  const credentials = decryptSecret<SnCredentials>(row.secretEnc, credentialsContext(row.id));
  if (!credentials || typeof credentials !== "object" || !("type" in credentials)) {
    throw new AppError("SN_AUTH_FAILED", {
      message: "The saved ServiceNow credentials can't be read anymore.",
      hint: "Open Connections and enter the credentials again (the app's encryption key may have changed).",
      detail: `connection ${row.id}: stored credentials could not be decrypted`,
    });
  }
  return { id: row.id, instanceUrl: row.instanceUrl, credentials };
}

export async function resolveConnectionById(connectionId: string): Promise<SnConnection> {
  const row = await getConnectionById(connectionId);
  if (!row) throw new AppError("NOT_FOUND", { message: "The ServiceNow connection for this sync no longer exists.", detail: `connection ${connectionId} missing` });
  return resolveConnection(row);
}

export async function requireConnection(actor: ActorContext, id: string): Promise<ConnectionRow> {
  const row = await getConnection(actor.orgId, id);
  if (!row) throw new AppError("NOT_FOUND", { message: "That ServiceNow connection doesn't exist." });
  return row;
}

export async function createConnection(actor: ActorContext, input: ConnectionInput): Promise<ConnectionDTO> {
  const instanceUrl = normalizeInstanceUrl(input.instanceUrl);
  const credentials = buildCredentials(input.auth, null);
  const id = randomUUID();
  const result = await testConnection({ id, instanceUrl, credentials }, actor.log);
  await insertConnection({
    id,
    orgId: actor.orgId,
    name: input.name,
    instanceUrl,
    authType: credentials.type,
    principal: principalOf(credentials),
    secretEnc: encryptSecret(credentials, credentialsContext(id)),
    status: "ok",
    createdBy: actor.userId,
  });
  actor.log.info("ServiceNow connection created", { connectionId: id, host: new URL(instanceUrl).host, authType: credentials.type, knowledgeBases: result.knowledgeBases });
  return toConnectionDTO((await getConnection(actor.orgId, id))!);
}

export async function editConnection(actor: ActorContext, id: string, input: ConnectionInput): Promise<ConnectionDTO> {
  const row = await requireConnection(actor, id);
  const instanceUrl = normalizeInstanceUrl(input.instanceUrl);
  const existing = resolveConnectionSafe(row);
  const credentials = buildCredentials(input.auth, existing);
  const unchanged =
    instanceUrl === row.instanceUrl && existing !== null && JSON.stringify(existing) === JSON.stringify(credentials);
  if (unchanged) {
    if (input.name !== row.name) await renameConnection(actor.orgId, id, input.name);
  } else {
    await testConnection({ id, instanceUrl, credentials }, actor.log);
    await updateConnection(actor.orgId, id, {
      name: input.name,
      instanceUrl,
      authType: credentials.type,
      principal: principalOf(credentials),
      secretEnc: encryptSecret(credentials, credentialsContext(id)),
    });
    actor.log.info("ServiceNow connection updated", { connectionId: id, host: new URL(instanceUrl).host, authType: credentials.type });
  }
  return toConnectionDTO((await getConnection(actor.orgId, id))!);
}

function resolveConnectionSafe(row: ConnectionRow): SnCredentials | null {
  try {
    return resolveConnection(row).credentials;
  } catch {
    return null;
  }
}

/** Re-tests a saved connection and records the result. Errors are returned in the DTO, not thrown. */
export async function retestConnection(actor: ActorContext, id: string): Promise<ConnectionDTO> {
  const row = await requireConnection(actor, id);
  try {
    await testConnection(resolveConnection(row), actor.log);
    await setConnectionStatus(id, "ok");
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await setConnectionStatus(id, "error", { code: error.code, message: error.message });
    actor.log.info("ServiceNow connection test failed", { connectionId: id, code: error.code, detail: error.detail });
  }
  return toConnectionDTO((await getConnection(actor.orgId, id))!);
}

export async function removeConnection(actor: ActorContext, id: string): Promise<void> {
  const row = await requireConnection(actor, id);
  if (row.syncCount > 0) throw new AppError("CONNECTION_IN_USE");
  await deleteConnection(actor.orgId, id);
  actor.log.info("ServiceNow connection deleted", { connectionId: id });
}
