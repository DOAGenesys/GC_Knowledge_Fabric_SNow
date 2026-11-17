import { NextResponse } from "next/server";
import { sessionRoute } from "@/server/api";
import { createSource, listSources, sourceNameSchema } from "@/server/services/genesys";

export const GET = sessionRoute({ operation: "genesys.sources.list" }, async ({ actor }) => {
  return { sources: await listSources(actor) };
});

export const POST = sessionRoute({ operation: "genesys.sources.create", body: sourceNameSchema }, async ({ actor, body }) => {
  return NextResponse.json({ source: await createSource(actor, body.name) }, { status: 201 });
});
