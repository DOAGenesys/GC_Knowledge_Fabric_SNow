import { z } from "zod";
import { sessionRoute } from "@/server/api";
import { listSyncRuns } from "@/server/services/syncs";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().uuid().optional(),
});

export const GET = sessionRoute<undefined, { id: string }>({ operation: "syncs.runs" }, async ({ actor, params, req }) => {
  const query = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return { runs: await listSyncRuns(actor, params.id, { limit: query.limit, before: query.before ?? null }) };
});
