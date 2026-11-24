import { z } from "zod";
import { sessionRoute } from "@/server/api";
import { kbIdsParam } from "@/server/params";
import { searchArticles } from "@/server/servicenow/knowledge";
import { requireConnection, resolveConnection } from "@/server/services/connections";

const querySchema = z.object({
  kb: kbIdsParam,
  q: z.string().max(100, "Keep the search under 100 characters").default(""),
});

export const GET = sessionRoute<undefined, { id: string }>({ operation: "connections.searchArticles" }, async ({ actor, params, req }) => {
  const query = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  const row = await requireConnection(actor, params.id);
  return searchArticles(resolveConnection(row), { kbIds: query.kb, text: query.q }, actor.log);
});
