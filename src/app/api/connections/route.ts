import { NextResponse } from "next/server";
import { sessionRoute } from "@/server/api";
import { listConnections, toConnectionDTO } from "@/server/repo/connections";
import { connectionInputSchema, createConnection } from "@/server/services/connections";

export const GET = sessionRoute({ operation: "connections.list" }, async ({ actor }) => {
  return { connections: (await listConnections(actor.orgId)).map(toConnectionDTO) };
});

export const POST = sessionRoute({ operation: "connections.create", body: connectionInputSchema }, async ({ actor, body }) => {
  return NextResponse.json({ connection: await createConnection(actor, body) }, { status: 201 });
});
