import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { type GcAuth, gcRequest, mapGcError } from "@/server/genesys/client";
import { buildAuthorizeUrl, clearClientTokenCache, exchangeAuthorizationCode, getClientCredentialsToken } from "@/server/genesys/oauth";
import { configureRetryTiming, type HttpResponse } from "@/server/http";
import { buildSnUrl, clearSnTokenCache, mapSnError, type SnConnection, snGet } from "@/server/servicenow/client";
import { assertPublicHost, configureHostResolver, isPrivateAddress, normalizeInstanceUrl } from "@/server/servicenow/instance";
import { capturedLogs } from "../helpers/logs";
import { type FakeHandler, installFetch, json } from "../helpers/fetch-router";

const SN_HOST = "acme.service-now.com";
const SN_URL = `https://${SN_HOST}`;

let snHandler: FakeHandler;
let gcHandler: FakeHandler;
let fetchStub: ReturnType<typeof installFetch>;

beforeEach(() => {
  configureRetryTiming({ sleep: async () => undefined });
  configureHostResolver(async () => ["93.184.216.34"]);
  clearSnTokenCache();
  clearClientTokenCache();
  snHandler = () => json({ result: [] });
  gcHandler = () => json({});
  fetchStub = installFetch([
    { host: SN_HOST, handle: (request, url) => snHandler(request, url) },
    { host: /^(api|login)\.mypurecloud\.de$/, handle: (request, url) => gcHandler(request, url) },
  ]);
});

afterEach(() => {
  fetchStub.restore();
  configureRetryTiming(null);
  configureHostResolver(null);
});

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("normalizeInstanceUrl", () => {
  it.each([
    ["acme", SN_URL],
    ["acme.service-now.com", SN_URL],
    ["https://acme.service-now.com/now/nav/ui/classic/params/target/kb", SN_URL],
    ["  ACME.Service-Now.com.  ", SN_URL],
    ["https://acme.service-now.com:443", SN_URL],
    ["support.example.com", "https://support.example.com"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeInstanceUrl(input)).toBe(expected);
  });

  it.each([
    "",
    "http://acme.service-now.com",
    "ftp://acme.service-now.com",
    "https://user:pw@acme.service-now.com",
    "https://acme.service-now.com:8443",
    "https://10.0.0.5",
    "https://[::1]",
    "https://localhost",
    "https://intranet.corp",
    "https://acme.local",
    "https://acme",
    "my_instance",
    "https://-bad-.service-now.com",
    "https://acme.service-now.123",
  ])("rejects %j", (input) => {
    expect(() => normalizeInstanceUrl(input)).toThrow(expect.objectContaining({ code: "SN_INVALID_URL" }));
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::",
    "::1",
    "fd00::1",
    "fe80::1%eth0",
    "ff02::1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:c0a8:0101::1",
    "2001:db8::1",
    "::10.0.0.1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "52.84.10.20", "172.32.0.1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2a00:1450:4001:82a::200e", "2606:4700::6810:84e5"])(
    "allows %s",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("assertPublicHost", () => {
  it("rejects hosts that resolve to private addresses", async () => {
    configureHostResolver(async () => ["93.184.216.34", "10.0.0.8"]);
    expect((await failure(assertPublicHost("rebind.example.com"))).code).toBe("SN_INVALID_URL");
  });

  it("reports DNS failures as unreachable", async () => {
    configureHostResolver(async () => {
      throw new Error("ENOTFOUND");
    });
    expect((await failure(assertPublicHost("missing.example.com"))).code).toBe("SN_UNREACHABLE");
    configureHostResolver(async () => []);
    expect((await failure(assertPublicHost("empty.example.com"))).code).toBe("SN_UNREACHABLE");
  });

  it("caches successful checks", async () => {
    const resolver = vi.fn(async () => ["93.184.216.34"]);
    configureHostResolver(resolver);
    await assertPublicHost("cached.example.com");
    await assertPublicHost("cached.example.com");
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});

describe("ServiceNow client", () => {
  const basic: SnConnection = { id: "c1", instanceUrl: SN_URL, credentials: { type: "basic", username: "svc.kf", password: "pw-value" } };
  const apikey: SnConnection = { id: "c2", instanceUrl: SN_URL, credentials: { type: "apikey", apiKey: "key-value" } };
  const oauth: SnConnection = { id: "c3", instanceUrl: SN_URL, credentials: { type: "oauth", clientId: "client-1", clientSecret: "secret-value" } };
  const get = (connection: SnConnection) => snGet<{ result: unknown[] }>(connection, { operation: "sn.test", path: "/api/now/table/kb_knowledge", query: { sysparm_limit: 1, skip: undefined } });

  it("builds URLs with encoded queries and no undefined params", () => {
    expect(buildSnUrl(SN_URL, "/api/now/table/kb_knowledge", { sysparm_query: "active=true^ORDERBYnumber", sysparm_limit: 5, skip: undefined })).toBe(
      `${SN_URL}/api/now/table/kb_knowledge?sysparm_query=active%3Dtrue%5EORDERBYnumber&sysparm_limit=5`,
    );
  });

  it("sends Basic and API key credentials in the right headers", async () => {
    const seen: Array<Record<string, string | null>> = [];
    snHandler = (request) => {
      seen.push({ authorization: request.headers.get("authorization"), apiKey: request.headers.get("x-sn-apikey"), accept: request.headers.get("accept") });
      return json({ result: [] });
    };
    await get(basic);
    await get(apikey);
    expect(seen[0]).toEqual({ authorization: `Basic ${Buffer.from("svc.kf:pw-value").toString("base64")}`, apiKey: null, accept: "application/json" });
    expect(seen[1]).toEqual({ authorization: null, apiKey: "key-value", accept: "application/json" });
  });

  it("fetches, caches and refreshes OAuth tokens", async () => {
    let issued = 0;
    let rejectNext = false;
    snHandler = async (request, url) => {
      if (url.pathname === "/oauth_token.do") {
        const form = new URLSearchParams(await request.text());
        expect(form.get("grant_type")).toBe("client_credentials");
        issued += 1;
        return json({ access_token: `token-${issued}`, expires_in: 1800 });
      }
      if (rejectNext) {
        rejectNext = false;
        return json({ error: { message: "User Not Authenticated" } }, 401);
      }
      expect(request.headers.get("authorization")).toBe(`Bearer token-${issued}`);
      return json({ result: [] });
    };
    await get(oauth);
    await get(oauth);
    expect(issued).toBe(1);
    rejectNext = true;
    await get(oauth);
    expect(issued).toBe(2);
  });

  it("explains OAuth setup problems", async () => {
    snHandler = () => json({ error: "invalid_client" }, 401);
    const error = await failure(get(oauth));
    expect(error.code).toBe("SN_AUTH_FAILED");
    expect(error.detail).toContain("client credentials grant");

    snHandler = (_request, url) => (url.pathname === "/oauth_token.do" ? json({ token: "wrong shape" }) : json({ result: [] }));
    expect((await failure(get(oauth))).code).toBe("SN_AUTH_FAILED");

    snHandler = () => {
      throw new TypeError("fetch failed");
    };
    expect((await failure(get(oauth))).code).toBe("SN_UNREACHABLE");
  });

  it("spots sleeping developer instances", async () => {
    snHandler = () => new Response(null, { status: 302, headers: { location: "https://developer.servicenow.com/dev.do#!/home?wu=true" } });
    const redirected = await failure(get(basic));
    expect(redirected).toMatchObject({ code: "SN_HIBERNATING", detail: "sn.test redirected to developer.servicenow.com" });

    snHandler = () => new Response("<html>Your instance is hibernating</html>", { status: 200, headers: { "content-type": "text/html" } });
    expect((await failure(get(basic))).code).toBe("SN_HIBERNATING");
  });

  it("maps broken and oversized responses", async () => {
    snHandler = () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
    expect((await failure(get(basic))).code).toBe("SN_BAD_RESPONSE");

    snHandler = () => {
      throw new TypeError("fetch failed");
    };
    expect((await failure(get(basic))).code).toBe("SN_UNREACHABLE");
  });

  it("checks the host before sending credentials anywhere", async () => {
    configureHostResolver(async () => ["10.0.0.9"]);
    expect((await failure(get(basic))).code).toBe("SN_INVALID_URL");
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("never logs credentials", async () => {
    snHandler = (_request, url) => (url.pathname === "/oauth_token.do" ? json({ access_token: "issued-token-value" }) : json({ error: { message: "nope" } }, 403));
    await failure(get(oauth));
    await failure(get(basic));
    expect(capturedLogs.serialized()).not.toMatch(/secret-value|pw-value|issued-token-value/);
  });

  it.each([
    [401, "SN_AUTH_FAILED"],
    [403, "SN_PERMISSION_DENIED"],
    [404, "SN_NOT_FOUND"],
    [429, "SN_RATE_LIMITED"],
    [500, "SN_UNAVAILABLE"],
    [503, "SN_UNAVAILABLE"],
    [418, "SN_BAD_RESPONSE"],
  ])("maps HTTP %i to %s", (status, code) => {
    const response = { status, headers: new Headers(), json: () => ({ error: { message: "Detail from ServiceNow" } }) } as unknown as HttpResponse;
    const error = mapSnError(response, "sn.op");
    expect(error.code).toBe(code);
    expect(error.detail).toBe(`sn.op → HTTP ${status}: Detail from ServiceNow`);
  });

  it("turns 400 into a readable query error", () => {
    const response = { status: 400, headers: new Headers(), json: () => ({ error: { message: "Invalid query: foo" } }) } as unknown as HttpResponse;
    expect(mapSnError(response, "sn.op")).toMatchObject({ code: "SN_QUERY_INVALID", message: "ServiceNow rejected the query: Invalid query: foo" });
    const bare = { status: 400, headers: new Headers(), json: () => null } as unknown as HttpResponse;
    expect(mapSnError(bare, "sn.op").detail).toBe("sn.op → HTTP 400");
  });
});

describe("Genesys Cloud client", () => {
  function fakeAuth(kind: GcAuth["kind"] = "client"): GcAuth & { calls: Array<boolean | undefined> } {
    const calls: Array<boolean | undefined> = [];
    return {
      region: "mypurecloud.de",
      kind,
      calls,
      getToken: async (options) => {
        calls.push(options?.forceRefresh);
        return `token-${calls.length}`;
      },
    };
  }

  it("sends JSON with a bearer token and query parameters", async () => {
    let seen: { url: string; auth: string | null; type: string | null; body: string } | null = null;
    gcHandler = async (request) => {
      seen = { url: request.url, auth: request.headers.get("authorization"), type: request.headers.get("content-type"), body: await request.text() };
      return json({ id: "x" }, 200, { "inin-correlation-id": "corr-9" });
    };
    const result = await gcRequest<{ id: string }>(fakeAuth(), {
      operation: "gc.test",
      method: "POST",
      path: "/api/v2/knowledge/sources",
      query: { pageSize: 25, after: undefined },
      body: { name: "KB" },
    });
    expect(result).toEqual({ data: { id: "x" }, status: 200, correlationId: "corr-9" });
    expect(seen).toEqual({ url: "https://api.mypurecloud.de/api/v2/knowledge/sources?pageSize=25", auth: "Bearer token-1", type: "application/json", body: '{"name":"KB"}' });
  });

  it("refreshes the token once on 401", async () => {
    let calls = 0;
    gcHandler = () => (++calls === 1 ? json({}, 401) : json({ ok: true }));
    const auth = fakeAuth();
    await gcRequest(auth, { operation: "gc.test", method: "GET", path: "/api/v2/x" });
    expect(auth.calls).toEqual([false, true]);

    gcHandler = () => json({ message: "expired" }, 401);
    expect((await failure(gcRequest(fakeAuth(), { operation: "gc.test", method: "GET", path: "/api/v2/x" }))).code).toBe("GC_AUTH_FAILED");
    expect((await failure(gcRequest(fakeAuth("user"), { operation: "gc.test", method: "GET", path: "/api/v2/x" }))).code).toBe("UNAUTHENTICATED");
  });

  it("distinguishes a lost POST from an unreachable service", async () => {
    gcHandler = () => {
      throw new TypeError("socket hang up");
    };
    const post = await failure(gcRequest(fakeAuth(), { operation: "gc.test", method: "POST", path: "/api/v2/x", body: {} }));
    expect(post).toMatchObject({ code: "GC_OUTCOME_UNKNOWN", detail: "POST /api/v2/x: network after the request was sent" });
    const getError = await failure(gcRequest(fakeAuth(), { operation: "gc.test", method: "GET", path: "/api/v2/x" }));
    expect(getError).toMatchObject({ code: "GC_UNAVAILABLE", detail: "GET /api/v2/x: network" });
  });

  const options = { operation: "gc.test", method: "GET" as const, path: "/api/v2/knowledge/sources/s1" };
  const response = (status: number, body: unknown) => ({ status, correlationId: "corr-1", json: () => body }) as unknown as HttpResponse;

  it("names the missing permission on 403", () => {
    const error = mapGcError(
      response(403, { code: "missing.permissions", message: "Unable to perform the requested action. You are missing the following permission(s): knowledge:synchronization:add" }),
      options,
      "client",
    );
    expect(error.code).toBe("GC_PERMISSION_DENIED");
    expect(error.message).toBe("The Genesys Cloud OAuth client is missing permission: knowledge:synchronization:add.");
    expect(error.detail).toContain("(correlation corr-1)");
    expect(mapGcError(response(403, { message: "Forbidden" }), options, "client").message).not.toContain("missing permission");
  });

  it.each([
    [404, undefined, "NOT_FOUND"],
    [404, "GC_SOURCE_NOT_FOUND", "GC_SOURCE_NOT_FOUND"],
    [409, undefined, "CONFLICT"],
    [429, undefined, "GC_RATE_LIMITED"],
    [502, undefined, "GC_UNAVAILABLE"],
  ] as const)("maps HTTP %i (override %s) to %s", (status, override, code) => {
    expect(mapGcError(response(status, null), { ...options, notFound: override, conflict: override }, "client").code).toBe(code);
  });

  it("passes Genesys validation messages through", () => {
    const error = mapGcError(response(400, { code: "bad.request", message: "name must not be blank" }), options, "client");
    expect(error).toMatchObject({ code: "GC_REQUEST_REJECTED", message: "Genesys Cloud rejected the request: name must not be blank" });
    expect(error.detail).toBe("GET /api/v2/knowledge/sources/s1 → HTTP 400 bad.request: name must not be blank (correlation corr-1)");
  });
});

describe("Genesys Cloud OAuth", () => {
  const client = { region: "mypurecloud.de", clientId: "cc-client", clientSecret: "cc-secret-value" };

  it("builds a PKCE authorize URL on the region's login host", () => {
    const url = new URL(buildAuthorizeUrl({ region: "mypurecloud.de", clientId: "pkce", redirectUri: "https://app.example.com/api/auth/callback", codeChallenge: "ch", state: "st" }));
    expect(url.origin).toBe("https://login.mypurecloud.de");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "pkce",
      response_type: "code",
      redirect_uri: "https://app.example.com/api/auth/callback",
      code_challenge: "ch",
      code_challenge_method: "S256",
      state: "st",
    });
  });

  it("caches client credentials tokens until shortly before expiry", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-17T12:00:00Z"), toFake: ["Date"] });
    let issued = 0;
    const authorizations: Array<string | null> = [];
    gcHandler = async (request) => {
      authorizations.push(request.headers.get("authorization"));
      return json({ access_token: `cc-token-${++issued}`, expires_in: 600 });
    };
    expect(await getClientCredentialsToken(client)).toBe("cc-token-1");
    expect(await getClientCredentialsToken(client)).toBe("cc-token-1");
    vi.setSystemTime(Date.parse("2026-11-17T12:08:30Z"));
    expect(await getClientCredentialsToken(client)).toBe("cc-token-2");
    expect(await getClientCredentialsToken({ ...client, forceRefresh: true })).toBe("cc-token-3");
    expect(await getClientCredentialsToken({ ...client, clientSecret: "rotated-secret-value" })).toBe("cc-token-4");
    expect(authorizations[0]).toBe(`Basic ${Buffer.from("cc-client:cc-secret-value").toString("base64")}`);
  });

  it.each([
    [401, { error: "invalid_client" }, "GC_AUTH_FAILED", "(invalid_client)"],
    [400, { error: "unauthorized_client" }, "GC_AUTH_FAILED", "(unauthorized_client)"],
    [429, {}, "GC_RATE_LIMITED", "HTTP 429"],
    [503, {}, "GC_UNAVAILABLE", "HTTP 503"],
    [200, { token: "wrong shape" }, "GC_AUTH_FAILED", "unexpected token response shape"],
  ])("maps a token response of HTTP %i", async (status, body, code, detail) => {
    gcHandler = () => json(body, status);
    const error = await failure(getClientCredentialsToken(client));
    expect(error.code).toBe(code);
    expect(error.detail).toContain(detail);
  });

  it("reports an unreachable login service", async () => {
    gcHandler = () => {
      throw new TypeError("fetch failed");
    };
    expect(await failure(getClientCredentialsToken(client))).toMatchObject({ code: "GC_UNAVAILABLE", detail: "gc.oauth.clientCredentials: network" });
  });

  it("exchanges an authorization code with the PKCE verifier", async () => {
    gcHandler = async (request) => {
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      expect(form).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: "https://app.example.com/cb", client_id: "pkce", code_verifier: "verifier" });
      return json({ access_token: "user-token", refresh_token: "user-refresh", expires_in: 86_400 });
    };
    const tokens = await exchangeAuthorizationCode({ region: "mypurecloud.de", clientId: "pkce", code: "the-code", redirectUri: "https://app.example.com/cb", codeVerifier: "verifier" });
    expect(tokens).toMatchObject({ accessToken: "user-token", refreshToken: "user-refresh" });

    gcHandler = () => json({ error: "invalid_grant" }, 400);
    expect((await failure(exchangeAuthorizationCode({ region: "mypurecloud.de", clientId: "pkce", code: "used", redirectUri: "https://app.example.com/cb", codeVerifier: "v" }))).code).toBe(
      "GC_LOGIN_FAILED",
    );
  });

  it("never logs client secrets or tokens", async () => {
    gcHandler = () => json({ access_token: "cc-token-logged?" });
    await getClientCredentialsToken(client);
    expect(capturedLogs.serialized()).not.toMatch(/cc-secret-value|cc-token-logged/);
  });
});
