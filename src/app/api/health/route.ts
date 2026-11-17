import { NextResponse } from "next/server";
import { publicRoute } from "@/server/api";
import { pingDb } from "@/server/db";
import { appVersion, configStatus } from "@/server/env";

/** Liveness for uptime monitors. Reports booleans only, never configuration values or names. */
export const GET = publicRoute({ operation: "health" }, async () => {
  const configuration = Object.values(configStatus()).every(Boolean);
  const database = configuration ? await pingDb() : false;
  const ok = configuration && database;
  return NextResponse.json({ status: ok ? "ok" : "degraded", version: appVersion(), checks: { configuration, database } }, { status: ok ? 200 : 503 });
});
