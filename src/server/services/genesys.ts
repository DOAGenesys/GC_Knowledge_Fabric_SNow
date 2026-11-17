import { z } from "zod";
import type { GcCredentialsDTO, GcSourceDTO } from "@/lib/api-types";
import { AppError } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "../crypto";
import { createClientAuth, type GcAuth } from "../genesys/client";
import { getOrganization } from "../genesys/identity";
import { createFileUploadSource, type GcSource, getSourceFileCounts, listFileUploadSources } from "../genesys/knowledge";
import { clearClientTokenCache } from "../genesys/oauth";
import { type OrgRow, clearOrgGcCredentials, getOrg, setOrgGcCredentials, setOrgGcError } from "../repo/orgs";
import { countSyncs, listSourceUsage } from "../repo/syncs";
import type { ActorContext } from "./actor";

export const gcCredentialsInputSchema = z.object({
  clientId: z.string().trim().min(1, "Required").max(200),
  clientSecret: z.string().min(1, "Required").max(1000),
});

export const sourceNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the source a name")
    .max(100, "Keep the name under 100 characters"),
});

function credentialsContext(orgId: string): string {
  return `gc-credentials:${orgId}`;
}

export function gcCredentialsDTO(org: OrgRow): GcCredentialsDTO {
  if (!org.gcClientId || !org.gcClientSecretEnc) return { status: "missing", clientId: null, verifiedAt: null, message: null };
  return {
    status: org.gcLastError ? "error" : "ok",
    clientId: org.gcClientId,
    verifiedAt: org.gcVerifiedAt,
    message: org.gcLastError,
  };
}

async function requireOrg(orgId: string): Promise<OrgRow> {
  const org = await getOrg(orgId);
  if (!org) throw new AppError("UNAUTHENTICATED", { detail: `org ${orgId} not found` });
  return org;
}

/** Client-credentials auth used for all Knowledge Fabric calls, including background runs. */
export async function getOrgGcAuth(orgId: string): Promise<GcAuth> {
  const org = await requireOrg(orgId);
  if (!org.gcClientId || !org.gcClientSecretEnc) throw new AppError("GC_CREDENTIALS_MISSING");
  const clientSecret = decryptSecret<string>(org.gcClientSecretEnc, credentialsContext(orgId));
  if (typeof clientSecret !== "string" || !clientSecret) {
    throw new AppError("GC_CREDENTIALS_MISSING", {
      message: "The saved Genesys Cloud credentials can't be read anymore.",
      hint: "Open Connections and enter the Genesys Cloud client credentials again.",
      detail: `org ${orgId}: stored client secret could not be decrypted`,
    });
  }
  const auth = createClientAuth({ region: org.region, clientId: org.gcClientId, clientSecret });
  return {
    ...auth,
    async getToken(options) {
      try {
        const token = await auth.getToken(options);
        if (org.gcLastError) await setOrgGcError(orgId, null).catch(() => undefined);
        return token;
      } catch (error) {
        if (error instanceof AppError && error.code === "GC_AUTH_FAILED") await setOrgGcError(orgId, error.message).catch(() => undefined);
        throw error;
      }
    },
  };
}

/** Validates the client against the signed-in org before storing it (encrypted). */
export async function saveGcCredentials(actor: ActorContext, input: z.infer<typeof gcCredentialsInputSchema>): Promise<GcCredentialsDTO> {
  const org = await requireOrg(actor.orgId);
  const auth = createClientAuth({ region: org.region, clientId: input.clientId, clientSecret: input.clientSecret });
  await auth.getToken({ forceRefresh: true });
  const clientOrg = await getOrganization(auth, actor.log);
  if (clientOrg.id.toLowerCase() !== org.id.toLowerCase()) {
    throw new AppError("GC_ORG_MISMATCH", { detail: "client credentials belong to a different organization" });
  }
  await listFileUploadSources(auth, actor.log);
  await setOrgGcCredentials(org.id, { clientId: input.clientId, secretEnc: encryptSecret(input.clientSecret, credentialsContext(org.id)) });
  clearClientTokenCache();
  actor.log.info("Genesys Cloud sync credentials saved", { clientId: input.clientId });
  return gcCredentialsDTO((await requireOrg(org.id)));
}

export async function removeGcCredentials(actor: ActorContext): Promise<GcCredentialsDTO> {
  await clearOrgGcCredentials(actor.orgId);
  clearClientTokenCache();
  actor.log.info("Genesys Cloud sync credentials removed", { syncs: await countSyncs(actor.orgId) });
  return gcCredentialsDTO(await requireOrg(actor.orgId));
}

export async function getGcCredentialsStatus(orgId: string): Promise<GcCredentialsDTO> {
  return gcCredentialsDTO(await requireOrg(orgId));
}

function toSourceDTO(source: GcSource, counts: Map<string, number>, usage: Map<string, { syncId: string; syncName: string }>): GcSourceDTO {
  return {
    id: source.id,
    name: source.name,
    status: source.status ?? "Unknown",
    fileCount: counts.get(source.id) ?? null,
    lastSync: source.lastSync
      ? {
          status: source.lastSync.status ?? null,
          ingestionStatus: source.lastSync.ingestionStatus ?? null,
          dateEnd: source.lastSync.dateEnd ?? null,
        }
      : null,
    usedBy: usage.get(source.id) ?? null,
  };
}

export async function listSources(actor: ActorContext): Promise<GcSourceDTO[]> {
  const auth = await getOrgGcAuth(actor.orgId);
  const sources = await listFileUploadSources(auth, actor.log);
  const [counts, usage] = await Promise.all([
    getSourceFileCounts(auth, sources.map((source) => source.id), actor.log),
    listSourceUsage(actor.orgId),
  ]);
  return sources.map((source) => toSourceDTO(source, counts, usage));
}

export async function createSource(actor: ActorContext, name: string): Promise<GcSourceDTO> {
  const auth = await getOrgGcAuth(actor.orgId);
  const source = await createFileUploadSource(auth, name, actor.log);
  actor.log.info("Knowledge source created", { sourceId: source.id });
  return toSourceDTO(source, new Map([[source.id, 0]]), new Map());
}
