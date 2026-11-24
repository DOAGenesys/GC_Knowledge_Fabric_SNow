import { z } from "zod";
import { sessionRoute } from "@/server/api";
import { runSyncNow } from "@/server/services/syncs";

const runSchema = z.object({ mode: z.enum(["incremental", "full"]).default("incremental"), allowRemovals: z.boolean().default(false) });

export const maxDuration = 60;

export const POST = sessionRoute<z.infer<typeof runSchema>, { id: string }>({ operation: "syncs.run", body: runSchema }, async ({ actor, params, body }) => {
  return runSyncNow(actor, params.id, body.mode, { allowRemovals: body.allowRemovals });
});
