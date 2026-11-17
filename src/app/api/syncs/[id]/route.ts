import { z } from "zod";
import { sessionRoute } from "@/server/api";
import { getSyncDetail, removeSync, setSyncEnabled, type UpdateSyncInput, updateSync, updateSyncSchema } from "@/server/services/syncs";

const toggleSchema = z.object({ enabled: z.boolean() });

export const GET = sessionRoute<undefined, { id: string }>({ operation: "syncs.get" }, async ({ actor, params }) => {
  return { sync: await getSyncDetail(actor, params.id) };
});

export const PUT = sessionRoute<UpdateSyncInput, { id: string }>({ operation: "syncs.update", body: updateSyncSchema }, async ({ actor, params, body }) => {
  return { sync: await updateSync(actor, params.id, body) };
});

export const PATCH = sessionRoute<z.infer<typeof toggleSchema>, { id: string }>({ operation: "syncs.toggle", body: toggleSchema }, async ({ actor, params, body }) => {
  return { sync: await setSyncEnabled(actor, params.id, body.enabled) };
});

export const DELETE = sessionRoute<undefined, { id: string }>({ operation: "syncs.delete" }, async ({ actor, params }) => {
  await removeSync(actor, params.id);
  return { ok: true };
});
