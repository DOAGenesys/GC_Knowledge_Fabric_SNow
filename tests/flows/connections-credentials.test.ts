import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as connection from "@/app/api/connections/[id]/route";
import * as connectionTest from "@/app/api/connections/[id]/test/route";
import * as credentials from "@/app/api/genesys/credentials/route";
import * as sources from "@/app/api/genesys/sources/route";
import type { ConnectionDTO } from "@/lib/api-types";
import { ERROR_CATALOG } from "@/lib/errors";
import { type SignedInClient, signedInClient } from "../helpers/api";
import { useTestDatabase } from "../helpers/db";
import { capturedLogs } from "../helpers/logs";
import { createWorld, GC_CLIENT, type World } from "../helpers/world";

useTestDatabase();
let world: World;
let browser: SignedInClient;

beforeEach(async () => {
  world = await createWorld();
  browser = signedInClient({ userId: "user-0001", userName: "Ada Admin", orgId: world.gc.orgId, orgName: "Acme Corp", region: "mypurecloud.de" });
});

afterEach(() => {
  world.dispose();
  vi.unstubAllEnvs();
});

const snRequests = () => world.network.requests.filter((request) => request.url.host === world.sn.host).length;

function editConnection(existing: ConnectionDTO, body: Record<string, unknown>) {
  return browser.call(connection.PUT, `/api/connections/${existing.id}`, {
    method: "PUT",
    params: { id: existing.id },
    body: { name: existing.name, instanceUrl: existing.instanceUrl, ...body },
  });
}

describe("editing ServiceNow connections", () => {
  it("renames without contacting ServiceNow when nothing else changed", async () => {
    const created = await world.connect();
    const before = snRequests();
    const response = await editConnection(created, { name: "Renamed", auth: { type: "basic", username: "kf.integration" } });
    expect(response.status).toBe(200);
    expect(response.body.connection).toMatchObject({ name: "Renamed", status: "ok" });
    expect(snRequests()).toBe(before);
  });

  it("tests new credentials before saving them and keeps the old ones when the test fails", async () => {
    const created = await world.connect();
    const rejected = await editConnection(created, { auth: { type: "basic", username: "kf.integration", password: "wrong-password" } });
    // Upstream auth failures must not be 401: the browser treats 401 as "your session expired".
    expect(rejected.status).toBe(502);
    expect(rejected.body.error.code).toBe("SN_AUTH_FAILED");

    const retest = await browser.call(connectionTest.POST, `/api/connections/${created.id}/test`, { method: "POST", params: { id: created.id } });
    expect(retest.body.connection).toMatchObject({ status: "ok" });

    world.sn.auth = { type: "basic", username: "kf.integration", password: "rotated-password" };
    const accepted = await editConnection(created, { auth: { type: "basic", username: "kf.integration", password: "rotated-password" } });
    expect(accepted.status).toBe(200);
    const after = await browser.call(connectionTest.POST, `/api/connections/${created.id}/test`, { method: "POST", params: { id: created.id } });
    expect(after.body.connection).toMatchObject({ status: "ok" });
  });

  it("needs the new secret when switching authentication type", async () => {
    const created = await world.connect();
    const response = await editConnection(created, { auth: { type: "apikey" } });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "VALIDATION", fields: [{ path: "auth.apiKey", message: "Required" }] });
  });

  it("records the result of a re-test instead of failing the request", async () => {
    const created = await world.connect();
    world.sn.hibernating = true;
    const response = await browser.call(connectionTest.POST, `/api/connections/${created.id}/test`, { method: "POST", params: { id: created.id } });
    expect(response.status).toBe(200);
    expect(response.body.connection).toMatchObject({ status: "error", statusMessage: ERROR_CATALOG.SN_HIBERNATING.message });

    world.sn.hibernating = false;
    const recovered = await browser.call(connectionTest.POST, `/api/connections/${created.id}/test`, { method: "POST", params: { id: created.id } });
    expect(recovered.body.connection).toMatchObject({ status: "ok", statusMessage: null });
  });

  it("explains what to do when stored secrets can't be decrypted anymore", async () => {
    const created = await world.setup();
    vi.stubEnv("APP_ENCRYPTION_KEY", "a-different-encryption-key-not-real-0123456789");

    const snResponse = await browser.call(connectionTest.POST, `/api/connections/${created.id}/test`, { method: "POST", params: { id: created.id } });
    expect(snResponse.body.connection).toMatchObject({ status: "error", statusMessage: "The saved ServiceNow credentials can't be read anymore." });

    const gcResponse = await browser.call(sources.GET, "/api/genesys/sources");
    expect(gcResponse.status).toBe(409);
    expect(gcResponse.body.error).toMatchObject({ code: "GC_CREDENTIALS_MISSING", message: "The saved Genesys Cloud credentials can't be read anymore." });
  });
});

describe("Genesys Cloud sync credentials", () => {
  const save = (clientId: string, clientSecret: string) => browser.call(credentials.PUT, "/api/genesys/credentials", { method: "PUT", body: { clientId, clientSecret } });
  const status = async () => (await browser.call(credentials.GET, "/api/genesys/credentials")).body.credentials;

  it("refuses a client from another organization", async () => {
    world.gc.addClient("other-org-client", "other-org-secret", { orgId: "0d6c0b6e-1111-4c1e-9a5d-222222222222" });
    const response = await save("other-org-client", "other-org-secret");
    expect(response.body.error.code).toBe("GC_ORG_MISMATCH");
    expect(await status()).toMatchObject({ status: "missing" });
  });

  it("refuses wrong secrets and clients without knowledge permissions", async () => {
    expect((await save(GC_CLIENT.id, "not-the-secret")).body.error.code).toBe("GC_AUTH_FAILED");
    world.gc.addClient("no-perms", "no-perms-secret", { permissions: [] });
    const response = await save("no-perms", "no-perms-secret");
    expect(response.body.error).toMatchObject({ code: "GC_PERMISSION_DENIED", message: expect.stringContaining("knowledge:source:view") });
    expect(await status()).toMatchObject({ status: "missing" });
  });

  it("flags revoked credentials and recovers once they work again", async () => {
    await world.saveGcCredentials();
    const client = world.gc.clients.get(GC_CLIENT.id)!;
    client.secret = "revoked-in-genesys";

    const failed = await browser.call(sources.GET, "/api/genesys/sources");
    expect(failed.body.error.code).toBe("GC_AUTH_FAILED");
    expect(await status()).toMatchObject({ status: "error", clientId: GC_CLIENT.id, message: expect.any(String) });

    client.secret = GC_CLIENT.secret;
    expect((await browser.call(sources.GET, "/api/genesys/sources")).status).toBe(200);
    expect(await status()).toMatchObject({ status: "ok", message: null });
  });

  it("can be removed", async () => {
    await world.saveGcCredentials();
    const response = await browser.call(credentials.DELETE, "/api/genesys/credentials", { method: "DELETE" });
    expect(response.body.credentials).toEqual({ status: "missing", clientId: null, verifiedAt: null, message: null });
    expect((await browser.call(sources.GET, "/api/genesys/sources")).body.error.code).toBe("GC_CREDENTIALS_MISSING");
  });
});

describe("knowledge sources", () => {
  it("lists File Upload sources with file counts and which sync uses them", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "Customer Help", portals: ["csm"] });
    world.sn.addArticles(kb, 3);
    const created = await world.createSync({ kbs: [kb], name: "Help center" });
    await world.runWorkflows();
    world.gc.addSource("Product manuals", "FileUpload");
    world.gc.addSource("Salesforce articles", "Salesforce");

    const response = await browser.call(sources.GET, "/api/genesys/sources");
    expect(response.body.sources).toEqual([
      expect.objectContaining({ name: "Product manuals", fileCount: 0, usedBy: null }),
      expect.objectContaining({
        name: "ServiceNow - Customer KB",
        fileCount: 3,
        usedBy: { syncId: created.sync.id, syncName: "Help center" },
        lastSync: expect.objectContaining({ status: "Completed" }),
      }),
    ]);
  });

  it("still lists sources without the file count permission", async () => {
    world.gc.addClient("no-counts", "no-counts-secret", { permissions: ["knowledge:source:view", "knowledge:source:add"] });
    await browser.call(credentials.PUT, "/api/genesys/credentials", { method: "PUT", body: { clientId: "no-counts", clientSecret: "no-counts-secret" } });
    world.gc.addSource("Product manuals", "FileUpload");
    const response = await browser.call(sources.GET, "/api/genesys/sources");
    expect(response.status).toBe(200);
    expect(response.body.sources).toEqual([expect.objectContaining({ name: "Product manuals", fileCount: null })]);
  });

  it("creates sources and validates names", async () => {
    await world.saveGcCredentials();
    const created = await browser.call(sources.POST, "/api/genesys/sources", { method: "POST", body: { name: "  Help center  " } });
    expect(created.status).toBe(201);
    expect(created.body.source).toMatchObject({ name: "Help center", fileCount: 0, usedBy: null });

    const invalid = await browser.call(sources.POST, "/api/genesys/sources", { method: "POST", body: { name: "" } });
    expect(invalid.body.error).toMatchObject({ code: "VALIDATION", fields: [{ path: "name", message: "Give the source a name" }] });
  });

  it("recovers a source whose creation response was lost", async () => {
    await world.saveGcCredentials();
    world.gc.fail(/^\/api\/v2\/knowledge\/sources$/, 0, { method: "POST", afterHandling: true });
    const response = await browser.call(sources.POST, "/api/genesys/sources", { method: "POST", body: { name: "Help center" } });
    expect(response.status).toBe(201);
    expect([...world.gc.sources.values()].filter((source) => source.name === "Help center")).toHaveLength(1);
    expect(capturedLogs.withMessage("Recovered source created by an interrupted request")).toHaveLength(1);
  });
});
