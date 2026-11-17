import { sessionRoute } from "@/server/api";
import { type ConnectionInput, connectionInputSchema, editConnection, removeConnection } from "@/server/services/connections";

export const PUT = sessionRoute<ConnectionInput, { id: string }>(
  { operation: "connections.update", body: connectionInputSchema },
  async ({ actor, params, body }) => ({ connection: await editConnection(actor, params.id, body) }),
);

export const DELETE = sessionRoute<undefined, { id: string }>({ operation: "connections.delete" }, async ({ actor, params }) => {
  await removeConnection(actor, params.id);
  return { ok: true };
});
