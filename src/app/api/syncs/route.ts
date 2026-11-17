import { NextResponse } from "next/server";
import { sessionRoute } from "@/server/api";
import { type CreateSyncInput, createSync, createSyncSchema, listSyncs } from "@/server/services/syncs";

export const GET = sessionRoute({ operation: "syncs.list" }, async ({ actor }) => {
  return { syncs: await listSyncs(actor) };
});

export const POST = sessionRoute<CreateSyncInput>({ operation: "syncs.create", body: createSyncSchema }, async ({ actor, body }) => {
  return NextResponse.json(await createSync(actor, body), { status: 201 });
});
