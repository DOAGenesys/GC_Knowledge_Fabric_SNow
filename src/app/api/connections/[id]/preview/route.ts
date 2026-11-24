import { z } from "zod";
import { AppError } from "@/lib/errors";
import { filtersSchema, noFilters } from "@/lib/filters";
import { sessionRoute } from "@/server/api";
import { articleFilters, previewArticles, validateFilterQuery } from "@/server/servicenow/knowledge";
import { requireConnection, resolveConnection } from "@/server/services/connections";

const previewSchema = z.object({
  kbIds: z.array(z.string().regex(/^[0-9a-f]{32}$/)).min(1).max(25),
  filters: filtersSchema.default(noFilters),
  filterQuery: z.string().max(5000).default(""),
});

export const POST = sessionRoute<z.infer<typeof previewSchema>, { id: string }>(
  { operation: "connections.preview", body: previewSchema },
  async ({ actor, params, body }) => {
    const problem = validateFilterQuery(body.filterQuery);
    if (problem) throw new AppError("VALIDATION", { message: problem, fields: [{ path: "filterQuery", message: problem }] });
    const row = await requireConnection(actor, params.id);
    const filter = articleFilters(body.filters, body.filterQuery);
    const chosen = body.filters.articles?.map((article) => article.number) ?? null;
    return { preview: await previewArticles(resolveConnection(row), { kbIds: body.kbIds, filter, chosen }, actor.log) };
  },
);
