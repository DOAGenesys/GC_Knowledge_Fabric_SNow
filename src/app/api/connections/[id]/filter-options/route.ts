import { z } from "zod";
import { sessionRoute } from "@/server/api";
import { kbIdsParam } from "@/server/params";
import { listFilterOptions } from "@/server/servicenow/knowledge";
import { requireConnection, resolveConnection } from "@/server/services/connections";

const querySchema = z.object({ kb: kbIdsParam });

export const GET = sessionRoute<undefined, { id: string }>({ operation: "connections.filterOptions" }, async ({ actor, params, req }) => {
  const query = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  const row = await requireConnection(actor, params.id);
  return { options: await listFilterOptions(resolveConnection(row), query.kb, actor.log) };
});
