import { sessionRoute } from "@/server/api";
import { listKnowledgeBases } from "@/server/servicenow/knowledge";
import { requireConnection, resolveConnection } from "@/server/services/connections";

export const GET = sessionRoute<undefined, { id: string }>({ operation: "connections.knowledgeBases" }, async ({ actor, params }) => {
  const row = await requireConnection(actor, params.id);
  return { knowledgeBases: await listKnowledgeBases(resolveConnection(row), actor.log) };
});
