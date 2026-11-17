import { afterEach, describe, expect, it } from "vitest";
import * as callback from "@/app/api/auth/callback/route";
import * as login from "@/app/api/auth/login/route";
import * as connections from "@/app/api/connections/route";
import { cookieNames } from "@/server/auth/session";
import { scopedLogger } from "@/server/log";
import { runSyncNow } from "@/server/services/syncs";
import { runTick } from "@/server/sync/scheduler";
import { callRoute, cookieJar, signedInClient } from "../helpers/api";
import { useTestDatabase } from "../helpers/db";
import { capturedLogs } from "../helpers/logs";
import { createWorld, GC_CLIENT, type World } from "../helpers/world";

const database = useTestDatabase();
let world: World | null = null;

afterEach(() => {
  world?.dispose();
  world = null;
});

async function secretsInPlay(current: World): Promise<string[]> {
  const values = [process.env.APP_SESSION_SECRET!, process.env.APP_ENCRYPTION_KEY!, process.env.CRON_SECRET!, GC_CLIENT.secret, ...current.gc.issuedSecrets, ...current.sn.issuedSecrets];
  const auth = current.sn.auth;
  if (auth.type === "basic") values.push(auth.password);
  if (auth.type === "oauth") values.push(auth.clientSecret);
  if (auth.type === "apikey") values.push(auth.apiKey);
  const encrypted = await database.query<{ value: string | null }>(
    "SELECT secret_enc AS value FROM sn_connections UNION ALL SELECT gc_client_secret_enc AS value FROM orgs",
  );
  values.push(...encrypted.flatMap((row) => (row.value ? [row.value] : [])));
  return values.filter((value) => value.length >= 8);
}

async function expectNoSecretsLogged(current: World, extra: string[] = []) {
  expect(capturedLogs.records.length).toBeGreaterThan(0);
  const logged = capturedLogs.serialized();
  const leaked = [...(await secretsInPlay(current)), ...extra].filter((secret) => logged.includes(secret));
  expect(leaked.length, "secret values found in log output").toBe(0);
  expect(logged).not.toMatch(/X-Amz-Signature=(?!\[REDACTED\])/);
  expect(logged).not.toMatch(/Bearer (?!\[REDACTED\])[A-Za-z0-9._-]{6,}/);
}

const infoAndAbove = () => capturedLogs.atLeast("info");

describe("log volume", () => {
  it("logs the same handful of info lines for 5 or 500 articles", async () => {
    world = await createWorld();
    await world.setup();

    const small = world.sn.addKb({ title: "Small" });
    world.sn.addArticles(small, 5);
    capturedLogs.clear();
    await world.createSync({ kbs: [small], name: "Small" });
    await world.runWorkflows();
    const smallCount = infoAndAbove().length;

    const large = world.sn.addKb({ title: "Large" });
    world.sn.addArticles(large, 500);
    capturedLogs.clear();
    await world.createSync({ kbs: [large], name: "Large", source: { mode: "new", name: "Large source" } });
    await world.runWorkflows();
    const largeCount = infoAndAbove().length;

    expect(smallCount).toBeLessThanOrEqual(12);
    expect(largeCount).toBe(smallCount);
  });

  it("logs one warning for many failures of the same kind", async () => {
    world = await createWorld();
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 40);
    world.gc.rejectUploads.set("KB00", { status: 400, message: "Rejected" });

    const { run } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();

    expect(await world.run(run!.id)).toMatchObject({ status: "failed", failed: 40 });
    expect(capturedLogs.withMessage("Article upload failed")).toHaveLength(1);
  });

  it("keeps an idle scheduler quiet", async () => {
    world = await createWorld();
    process.env.LOG_LEVEL = "info";
    try {
      for (let tick = 0; tick < 10; tick += 1) await runTick();
    } finally {
      process.env.LOG_LEVEL = "debug";
    }
    expect(capturedLogs.records).toHaveLength(0);
  });
});

describe("secret hygiene", () => {
  it("has a detector that really catches a leak", async () => {
    world = await createWorld();
    scopedLogger("test").info("Careless log line", { note: GC_CLIENT.secret });

    const leaked = (await secretsInPlay(world)).filter((secret) => capturedLogs.serialized().includes(secret));

    expect(leaked).toEqual([GC_CLIENT.secret]);
  });

  it("never logs credentials, tokens or pre-signed URLs during a full lifecycle", async () => {
    world = await createWorld({ snAuth: { type: "oauth", clientId: "sn-oauth-client", clientSecret: "fake-sn-oauth-secret-0001" } });
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    const articles = world.sn.addArticles(kb, 30);
    const { sync } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>Changed</p>" });
    world.sn.updateArticle(articles[1]!.sys_id, { workflow_state: "retired" });
    await runSyncNow(world.actor, sync.id, "incremental");
    await world.runWorkflows();
    await runSyncNow(world.actor, sync.id, "full");
    await world.runWorkflows();

    expect(world.gc.issuedSecrets.length).toBeGreaterThan(30);
    expect(world.sn.issuedSecrets.length).toBeGreaterThan(0);
    await expectNoSecretsLogged(world);
  });

  it("never logs secrets when things go wrong", async () => {
    world = await createWorld({ snAuth: { type: "apikey", apiKey: "fake-sn-api-key-000000000001" } });
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    const articles = world.sn.addArticles(kb, 6);
    const { sync } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();

    world.gc.fail(/\/uploads$/, 500, { times: 2, body: { message: "Internal error", token: "leaky-upstream-token-value" } });
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>v2</p>" });
    await runSyncNow(world.actor, sync.id, "incremental");
    await world.runWorkflows();

    world.gc.clients.get(GC_CLIENT.id)!.secret = "rotated-somewhere-else";
    world.gc.revokeTokens();
    world.sn.updateArticle(articles[1]!.sys_id, { text: "<p>v2</p>" });
    await runSyncNow(world.actor, sync.id, "incremental");
    await world.runWorkflows();

    world.sn.fail(/\/api\/now\/table\/kb_knowledge$/, { status: 401, body: { error: { message: "Bearer abcdefghijklmnop rejected" } } }, 5);
    await runSyncNow(world.actor, sync.id, "incremental").catch(() => undefined);

    expect(capturedLogs.atLeast("warn").length).toBeGreaterThan(0);
    await expectNoSecretsLogged(world, ["leaky-upstream-token-value", "abcdefghijklmnop"]);
  });

  it("never logs session cookies, PKCE values or OAuth codes", async () => {
    world = await createWorld();
    const clientId = "6a8f2c1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    const started = await callRoute(login.GET, `/api/auth/login?region=mypurecloud.de&clientId=${clientId}`);
    const authorize = new URL(started.location!);
    const oauthCookie = cookieJar(started.setCookies)[cookieNames().oauth]!.value;
    const code = world.gc.issueAuthorizationCode({
      clientId,
      challenge: authorize.searchParams.get("code_challenge")!,
      redirectUri: authorize.searchParams.get("redirect_uri")!,
      userId: "user-0001",
    });
    const state = authorize.searchParams.get("state")!;
    const done = await callRoute(callback.GET, `/api/auth/callback?code=${code}&state=${state}`, { cookies: { [cookieNames().oauth]: oauthCookie } });
    const session = cookieJar(done.setCookies)[cookieNames().session]!.value;

    const browser = signedInClient({ userId: "user-0001", userName: "Ada Admin", orgId: world.gc.orgId, orgName: "Acme Corp", region: "mypurecloud.de" });
    await browser.call(connections.POST, "/api/connections", { method: "POST", body: { name: "Acme", instanceUrl: "acme", auth: world.snAuthInput() } });
    await browser.call(connections.POST, "/api/connections", { method: "POST", body: { name: "Acme" }, csrf: false });

    await expectNoSecretsLogged(world, [oauthCookie, code, state, session, browser.csrfToken, ...Object.values(browser.cookies)]);
  });
});
