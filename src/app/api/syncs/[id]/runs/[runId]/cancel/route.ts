import { sessionRoute } from "@/server/api";
import { cancelSyncRun } from "@/server/services/syncs";

export const POST = sessionRoute<undefined, { id: string; runId: string }>({ operation: "syncs.cancelRun" }, async ({ actor, params }) => {
  return { run: await cancelSyncRun(actor, params.id, params.runId) };
});
