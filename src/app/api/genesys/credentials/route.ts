import { sessionRoute } from "@/server/api";
import { gcCredentialsInputSchema, getGcCredentialsStatus, removeGcCredentials, saveGcCredentials } from "@/server/services/genesys";

export const GET = sessionRoute({ operation: "genesys.credentials.get" }, async ({ actor }) => {
  return { credentials: await getGcCredentialsStatus(actor.orgId) };
});

export const PUT = sessionRoute({ operation: "genesys.credentials.save", body: gcCredentialsInputSchema }, async ({ actor, body }) => {
  return { credentials: await saveGcCredentials(actor, body) };
});

export const DELETE = sessionRoute({ operation: "genesys.credentials.delete" }, async ({ actor }) => {
  return { credentials: await removeGcCredentials(actor) };
});
