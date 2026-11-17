import { z } from "zod";
import { sessionRoute } from "@/server/api";
import { listSyncArticles } from "@/server/services/syncs";

const querySchema = z.object({
  state: z.enum(["synced", "error", "skipped", "pending_delete"]).optional(),
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const GET = sessionRoute<undefined, { id: string }>({ operation: "syncs.articles" }, async ({ actor, params, req }) => {
  const query = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return listSyncArticles(actor, params.id, query);
});
