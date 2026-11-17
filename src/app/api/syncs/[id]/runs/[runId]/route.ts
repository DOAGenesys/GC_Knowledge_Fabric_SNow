import { z } from "zod";
import { sessionRoute } from "@/server/api";
import { getRunDetail } from "@/server/services/syncs";

const querySchema = z.object({ status: z.enum(["pending", "done", "unchanged", "failed", "skipped", "attention"]).optional() });

export const GET = sessionRoute<undefined, { id: string; runId: string }>({ operation: "syncs.runDetail" }, async ({ actor, params, req }) => {
  const query = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return getRunDetail(actor, params.id, params.runId, query.status);
});
