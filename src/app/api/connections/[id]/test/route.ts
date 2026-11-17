import { sessionRoute } from "@/server/api";
import { retestConnection } from "@/server/services/connections";

export const POST = sessionRoute<undefined, { id: string }>({ operation: "connections.test" }, async ({ actor, params }) => {
  return { connection: await retestConnection(actor, params.id) };
});
