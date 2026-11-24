import { sessionRoute } from "@/server/api";
import { type ImpactInput, impactSchema, previewSyncImpact } from "@/server/services/syncs";

export const maxDuration = 60;

export const POST = sessionRoute<ImpactInput, { id: string }>({ operation: "syncs.impact", body: impactSchema }, async ({ actor, params, body }) => {
  return { impact: await previewSyncImpact(actor, params.id, body) };
});
