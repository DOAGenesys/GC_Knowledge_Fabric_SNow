import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as logout from "@/app/api/auth/logout/route";
import * as clientLog from "@/app/api/client-log/route";
import * as connection from "@/app/api/connections/[id]/route";
import * as knowledgeBases from "@/app/api/connections/[id]/knowledge-bases/route";
import * as preview from "@/app/api/connections/[id]/preview/route";
import * as connectionTest from "@/app/api/connections/[id]/test/route";
import * as connections from "@/app/api/connections/route";
import * as cronTick from "@/app/api/cron/tick/route";
import * as credentials from "@/app/api/genesys/credentials/route";
import * as sources from "@/app/api/genesys/sources/route";
import * as health from "@/app/api/health/route";
import * as sessionInfo from "@/app/api/session/route";
import * as articles from "@/app/api/syncs/[id]/articles/route";
import * as syncRoute from "@/app/api/syncs/[id]/route";
import * as syncRun from "@/app/api/syncs/[id]/run/route";
import * as runCancel from "@/app/api/syncs/[id]/runs/[runId]/cancel/route";
import * as runDetail from "@/app/api/syncs/[id]/runs/[runId]/route";
import * as syncRuns from "@/app/api/syncs/[id]/runs/route";
import * as syncs from "@/app/api/syncs/route";
import { cookieNames } from "@/server/auth/session";
import { setDbOverride } from "@/server/db";
import { upsertOrg } from "@/server/repo/orgs";
import { callRoute, cookieJar, ORIGIN, type SignedInClient, signedInClient } from "../helpers/api";
import { useTestDatabase } from "../helpers/db";
import { capturedLogs } from "../helpers/logs";
import { createWorld, GC_CLIENT, type World } from "../helpers/world";

const database = useTestDatabase();
let world: World;
let browser: SignedInClient;
let ipCounter = 0;

const sessionFor = (orgId: string) => ({ userId: "user-0001", userName: "Ada Admin", orgId, orgName: "Acme Corp", region: "mypurecloud.de" });

beforeEach(async () => {
  world = await createWorld();
  browser = signedInClient(sessionFor(world.gc.orgId));
});

afterEach(() => {
  world.dispose();
  delete process.env.APP_ALLOWED_ORG_IDS;
  delete process.env.DATABASE_URL;
  process.env.LOG_LEVEL = "debug";
});

function syncBody(connectionId: string, kb: { sys_id: string; title: string }, overrides: Record<string, unknown> = {}) {
  return {
    name: "Customer help center",
    connectionId,
    audience: "csm",
    knowledgeBases: [{ id: kb.sys_id, title: kb.title }],
    filterQuery: "",
    linkStyle: "csp",
    linkCustom: "",
    schedule: { kind: "interval", minutes: 60 },
    enabled: true,
    source: { mode: "new", name: "ServiceNow - Customer KB" },
    runNow: true,
    ...overrides,
  };
}

describe("the setup journey through the API", () => {
  it("connects both systems, creates a sync, runs it and manages it", async () => {
    const kb = world.sn.addKb({ title: "Customer Help", portals: ["csm"] });
    world.sn.addArticles(kb, 3);

    let response = await browser.call(sessionInfo.GET, "/api/session");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ user: { name: "Ada Admin" }, org: { id: world.gc.orgId }, setup: { connections: 0, gcCredentials: "missing", syncs: 0 } });

    response = await browser.call(connections.POST, "/api/connections", { method: "POST", body: { name: "Acme ServiceNow", instanceUrl: "acme", auth: world.snAuthInput() } });
    expect(response.status).toBe(201);
    expect(response.body.connection).toMatchObject({ instanceUrl: "https://acme.service-now.com", status: "ok", principal: "kf.integration" });
    const connectionId: string = response.body.connection.id;

    response = await browser.call(credentials.PUT, "/api/genesys/credentials", { method: "PUT", body: { clientId: GC_CLIENT.id, clientSecret: GC_CLIENT.secret } });
    expect(response.status).toBe(200);
    expect(response.body.credentials).toMatchObject({ status: "ok", clientId: GC_CLIENT.id });

    response = await browser.call(knowledgeBases.GET, `/api/connections/${connectionId}/knowledge-bases`, { params: { id: connectionId } });
    expect(response.body.knowledgeBases).toEqual([expect.objectContaining({ id: kb.sys_id, title: "Customer Help", articleCount: 3, suggestedAudience: "csm" })]);

    response = await browser.call(preview.POST, `/api/connections/${connectionId}/preview`, { method: "POST", params: { id: connectionId }, body: { kbIds: [kb.sys_id] } });
    expect(response.body.preview).toMatchObject({ count: 3 });
    expect(response.body.preview.sample).toHaveLength(3);

    response = await browser.call(sources.GET, "/api/genesys/sources");
    expect(response.body.sources).toEqual([]);

    response = await browser.call(syncs.POST, "/api/syncs", { method: "POST", body: syncBody(connectionId, kb) });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ sync: { name: "Customer help center", health: "new" }, run: { status: "queued", trigger: "initial" }, runError: null });
    const syncId: string = response.body.sync.id;
    await world.runWorkflows();

    response = await browser.call(syncs.GET, "/api/syncs");
    expect(response.body.syncs).toEqual([expect.objectContaining({ id: syncId, health: "healthy", articleCount: 3, lastRun: expect.objectContaining({ status: "succeeded", uploaded: 3 }) })]);

    response = await browser.call(syncRuns.GET, `/api/syncs/${syncId}/runs`, { params: { id: syncId } });
    const runId: string = response.body.runs[0].id;
    response = await browser.call(runDetail.GET, `/api/syncs/${syncId}/runs/${runId}`, { params: { id: syncId, runId } });
    expect(response.body.itemCounts).toMatchObject({ done: 3 });
    expect(response.body.items).toHaveLength(3);

    response = await browser.call(articles.GET, `/api/syncs/${syncId}/articles?state=synced&limit=2`, { params: { id: syncId } });
    expect(response.body).toMatchObject({ total: 3, counts: { synced: 3 } });
    expect(response.body.items).toHaveLength(2);

    response = await browser.call(syncRun.POST, `/api/syncs/${syncId}/run`, { method: "POST", params: { id: syncId }, body: {} });
    expect(response.body).toMatchObject({ outcome: "up_to_date", run: { status: "noop" } });

    response = await browser.call(syncRoute.PATCH, `/api/syncs/${syncId}`, { method: "PATCH", params: { id: syncId }, body: { enabled: false } });
    expect(response.body.sync).toMatchObject({ enabled: false, nextRunAt: null });

    response = await browser.call(connection.DELETE, `/api/connections/${connectionId}`, { method: "DELETE", params: { id: connectionId } });
    expect(response.status).toBe(409);

    response = await browser.call(syncRoute.DELETE, `/api/syncs/${syncId}`, { method: "DELETE", params: { id: syncId } });
    expect(response.body).toEqual({ ok: true });
    response = await browser.call(syncRoute.GET, `/api/syncs/${syncId}`, { params: { id: syncId } });
    expect(response.status).toBe(404);

    response = await browser.call(connection.DELETE, `/api/connections/${connectionId}`, { method: "DELETE", params: { id: connectionId } });
    expect(response.status).toBe(200);
  });

  it("never returns secrets in responses", async () => {
    await world.setup();
    const auth = world.snAuthInput();
    const responses = [
      await browser.call(connections.GET, "/api/connections"),
      await browser.call(credentials.GET, "/api/genesys/credentials"),
      await browser.call(sessionInfo.GET, "/api/session"),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      if (auth.type === "basic") expect(response.text).not.toContain(auth.password);
      expect(response.text).not.toContain(GC_CLIENT.secret);
    }
  });

  it("reports a broken ServiceNow connection with an actionable message", async () => {
    const created = await world.setup();
    if (world.sn.auth.type === "basic") world.sn.auth.password = "changed-by-admin";

    const response = await browser.call(connectionTest.POST, `/api/connections/${created.id}/test`, { method: "POST", params: { id: created.id } });

    expect(response.status).toBe(200);
    expect(response.body.connection).toMatchObject({ status: "error" });
    expect(response.body.connection.statusMessage).toBe("ServiceNow didn't accept the connection's credentials.");
  });

  it("validates the ServiceNow filter before previewing", async () => {
    const created = await world.setup();
    const kb = world.sn.addKb({ title: "KB" });

    const response = await browser.call(preview.POST, `/api/connections/${created.id}/preview`, {
      method: "POST",
      params: { id: created.id },
      body: { kbIds: [kb.sys_id], filterQuery: "workflow_state=published^NQactive=true" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.fields[0].path).toBe("filterQuery");
  });
});

describe("authentication and request safety", () => {
  it("rejects requests without a session", async () => {
    const response = await callRoute(syncs.GET, "/api/syncs");

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: "UNAUTHENTICATED", requestId: expect.any(String) });
    expect(response.headers.get("x-request-id")).toBe(response.body.error.requestId);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects expired and tampered sessions", async () => {
    const expired = signedInClient(sessionFor(world.gc.orgId), Date.now() - 13 * 60 * 60 * 1000);
    expect((await expired.call(syncs.GET, "/api/syncs")).status).toBe(401);

    const names = cookieNames();
    const token = browser.cookies[names.session]!;
    const tampered = `${token.slice(0, -2)}${token.endsWith("A") ? "B" : "A"}${token.slice(-1)}`;
    expect((await browser.call(syncs.GET, "/api/syncs", { cookies: { [names.session]: tampered } })).status).toBe(401);
  });

  it("requires the CSRF token and a same-origin request for writes", async () => {
    const body = { name: "x", instanceUrl: "acme", auth: world.snAuthInput() };

    const missing = await browser.call(connections.POST, "/api/connections", { method: "POST", body, csrf: false });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe("CSRF_FAILED");

    const wrong = await browser.call(connections.POST, "/api/connections", { method: "POST", body, headers: { "x-csrf-token": "forged-token-value" } });
    expect(wrong.status).toBe(403);

    const crossSite = await browser.call(connections.POST, "/api/connections", { method: "POST", body, headers: { origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
  });

  it("enforces the organization allowlist on every request", async () => {
    process.env.APP_ALLOWED_ORG_IDS = "11111111-2222-3333-4444-555555555555";

    const response = await browser.call(syncs.GET, "/api/syncs");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ORG_NOT_ALLOWED");
  });

  it("keeps every organization's data separate", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 1);
    const { sync } = await world.createSync({ kbs: [kb], runNow: false });
    const otherOrg = "0d6f3b2a-9c4e-4b1a-8f7d-6e5c4b3a2f10";
    await upsertOrg({ id: otherOrg, name: "Other Corp", region: "mypurecloud.de" });
    const intruder = signedInClient(sessionFor(otherOrg));

    expect((await intruder.call(syncRoute.GET, `/api/syncs/${sync.id}`, { params: { id: sync.id } })).status).toBe(404);
    expect((await intruder.call(syncRun.POST, `/api/syncs/${sync.id}/run`, { method: "POST", params: { id: sync.id }, body: {} })).status).toBe(404);
    expect((await intruder.call(syncRoute.DELETE, `/api/syncs/${sync.id}`, { method: "DELETE", params: { id: sync.id } })).status).toBe(404);
    expect((await intruder.call(connection.DELETE, `/api/connections/${sync.connection.id}`, { method: "DELETE", params: { id: sync.connection.id } })).status).toBe(404);
    expect((await intruder.call(syncs.GET, "/api/syncs")).body.syncs).toEqual([]);
    expect((await browser.call(syncRoute.GET, `/api/syncs/${sync.id}`, { params: { id: sync.id } })).status).toBe(200);
  });

  it("returns field-level validation errors", async () => {
    const response = await browser.call(connections.POST, "/api/connections", { method: "POST", body: { name: "", instanceUrl: "", auth: { type: "basic" } } });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION");
    const paths = response.body.error.fields.map((field: { path: string }) => field.path);
    expect(paths).toEqual(expect.arrayContaining(["name", "instanceUrl"]));
  });

  it("rejects malformed and oversized bodies", async () => {
    const malformed = await browser.call(connections.POST, "/api/connections", { method: "POST", rawBody: "{not json", headers: { "content-type": "application/json" } });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.message).toBe("The request body isn't valid JSON.");

    const oversized = await browser.call(connections.POST, "/api/connections", { method: "POST", rawBody: JSON.stringify({ name: "x".repeat(1_100_000) }) });
    expect(oversized.status).toBe(413);
  });

  it("validates query parameters", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    const { sync } = await world.createSync({ kbs: [kb], runNow: false });

    const response = await browser.call(syncRuns.GET, `/api/syncs/${sync.id}/runs?before=not-a-uuid`, { params: { id: sync.id } });

    expect(response.status).toBe(400);
  });

  it("hides internal errors behind a request ID", async () => {
    setDbOverride({
      query: async () => {
        throw new Error("connection reset by 10.20.30.40");
      },
      transaction: async () => {
        throw new Error("connection reset by 10.20.30.40");
      },
    });
    try {
      const response = await browser.call(syncs.GET, "/api/syncs", { headers: { "x-request-id": "req-test-000123" } });

      expect(response.status).toBe(500);
      expect(response.body.error).toMatchObject({ code: "INTERNAL", requestId: "req-test-000123" });
      expect(response.text).not.toContain("10.20.30.40");
      const [logged] = capturedLogs.withMessage("Unhandled API error");
      expect(logged).toMatchObject({ level: "error", requestId: "req-test-000123", operation: "syncs.list" });
    } finally {
      setDbOverride(database.db);
    }
  });

  it("cancels a queued run through the API", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 1);
    const { sync, run } = await world.createSync({ kbs: [kb] });

    const response = await browser.call(runCancel.POST, `/api/syncs/${sync.id}/runs/${run!.id}/cancel`, { method: "POST", params: { id: sync.id, runId: run!.id } });

    expect(response.status).toBe(200);
    expect(response.body.run).toMatchObject({ status: "cancelled" });
  });

  it("signs out only same-origin requests", async () => {
    const crossSite = await callRoute(logout.POST, "/api/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);

    const response = await callRoute(logout.POST, "/api/auth/logout", { method: "POST", headers: { origin: ORIGIN } });
    expect(response.status).toBe(200);
    const jar = cookieJar(response.setCookies);
    expect(jar[cookieNames().session]).toMatchObject({ value: "" });
    expect(jar[cookieNames().session]!.attributes).toMatch(/Max-Age=0/i);
  });
});

describe("operational endpoints", () => {
  it("protects the scheduler endpoint with the cron secret", async () => {
    expect((await callRoute(cronTick.GET, "/api/cron/tick")).status).toBe(401);
    expect((await callRoute(cronTick.GET, "/api/cron/tick", { headers: { authorization: "Bearer wrong-secret-value" } })).status).toBe(401);

    const response = await callRoute(cronTick.GET, "/api/cron/tick", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "ce-id": "exec-1" } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, checked: 0, started: 0, recovered: 0 });
  });

  it("reports health with booleans only", async () => {
    const degraded = await callRoute(health.GET, "/api/health");
    expect(degraded.status).toBe(503);
    expect(degraded.body).toMatchObject({ status: "degraded", checks: { configuration: false, database: false } });

    process.env.DATABASE_URL = "postgres://placeholder.invalid/test";
    const healthy = await callRoute(health.GET, "/api/health");
    expect(healthy.status).toBe(200);
    expect(healthy.body).toMatchObject({ status: "ok", checks: { configuration: true, database: true } });
    expect(healthy.text).not.toContain("postgres://");
  });

  it("forwards browser errors to the server log", async () => {
    const response = await browser.call(clientLog.POST, "/api/client-log", {
      method: "POST",
      headers: { origin: ORIGIN, "x-forwarded-for": `203.0.113.${++ipCounter}` },
      body: { entries: [{ level: "error", scope: "sync-page", message: "Render failed", name: "TypeError", path: "/syncs/abc?tab=runs" }] },
    });

    expect(response.status).toBe(202);
    const [logged] = capturedLogs.withMessage("Render failed");
    expect(logged).toMatchObject({ level: "error", scope: "browser", browserScope: "sync-page", path: "/syncs/abc", orgId: world.gc.orgId });
  });

  it("rate-limits and validates browser log reports", async () => {
    const ip = `203.0.113.${++ipCounter}`;
    const entries = Array.from({ length: 10 }, (_, index) => ({ level: "warn", message: `warning ${index}` }));
    const send = () => callRoute(clientLog.POST, "/api/client-log", { method: "POST", headers: { origin: ORIGIN, "x-forwarded-for": ip }, body: { entries } });

    for (let batch = 0; batch < 3; batch += 1) expect((await send()).body).toEqual({ ok: true });
    expect((await send()).body).toEqual({ ok: true, dropped: true });

    const crossSite = await callRoute(clientLog.POST, "/api/client-log", { method: "POST", headers: { origin: "https://evil.example" }, body: { entries } });
    expect(crossSite.status).toBe(403);
    const invalid = await callRoute(clientLog.POST, "/api/client-log", { method: "POST", headers: { origin: ORIGIN }, body: { entries: [] } });
    expect(invalid.status).toBe(400);
  });
});

describe("request logging", () => {
  it("logs writes at info, reads at debug and deduplicates repeated 401s", async () => {
    process.env.LOG_LEVEL = "info";
    await browser.call(syncs.GET, "/api/syncs");
    await browser.call(credentials.DELETE, "/api/genesys/credentials", { method: "DELETE" });
    for (let attempt = 0; attempt < 5; attempt += 1) await callRoute(syncs.GET, "/api/syncs");

    const requests = capturedLogs.withMessage(/^API request/);
    expect(requests.map((record) => [record.level, record.msg, record.operation, record.status])).toEqual([
      ["info", "API request", "genesys.credentials.delete", 200],
      ["info", "API request rejected", "syncs.list", 401],
    ]);
    expect(capturedLogs.withMessage("Genesys Cloud sync credentials removed")).toEqual([expect.objectContaining({ level: "info", userId: "user-0001" })]);
  });

  it("raises the log level for a single request with the debug header", async () => {
    process.env.LOG_LEVEL = "info";

    await browser.call(syncs.GET, "/api/syncs", { headers: { "x-kf-debug": "1" } });

    expect(capturedLogs.withMessage("API request")).toEqual([expect.objectContaining({ level: "debug", operation: "syncs.list", status: 200 })]);
  });
});
