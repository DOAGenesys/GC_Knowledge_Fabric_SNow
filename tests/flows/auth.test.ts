import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as callback from "@/app/api/auth/callback/route";
import * as login from "@/app/api/auth/login/route";
import * as sessionInfo from "@/app/api/session/route";
import { cookieNames } from "@/server/auth/session";
import { getOrg } from "@/server/repo/orgs";
import { callRoute, cookieJar, ORIGIN } from "../helpers/api";
import { useTestDatabase } from "../helpers/db";
import { capturedLogs } from "../helpers/logs";
import { createWorld, type World } from "../helpers/world";

useTestDatabase();
let world: World;

const PKCE_CLIENT_ID = "6a8f2c1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const names = () => cookieNames();

beforeEach(async () => {
  world = await createWorld();
});

afterEach(() => {
  world.dispose();
  delete process.env.APP_ALLOWED_ORG_IDS;
});

async function beginSignIn(query: Record<string, string> = {}) {
  const params = new URLSearchParams({ region: "mypurecloud.de", clientId: PKCE_CLIENT_ID, ...query });
  const response = await callRoute(login.GET, `/api/auth/login?${params}`);
  const oauthCookie = cookieJar(response.setCookies)[names().oauth]?.value;
  return { response, oauthCookie, authorize: response.location ? new URL(response.location) : null };
}

/** Plays the Genesys Cloud side: the user signs in and is sent back with an authorization code. */
function consent(authorize: URL, userId = "user-0001"): string {
  return world.gc.issueAuthorizationCode({
    clientId: authorize.searchParams.get("client_id")!,
    challenge: authorize.searchParams.get("code_challenge")!,
    redirectUri: authorize.searchParams.get("redirect_uri")!,
    userId,
  });
}

async function finishSignIn(code: string, state: string, oauthCookie: string | undefined) {
  return callRoute(callback.GET, `/api/auth/callback?${new URLSearchParams({ code, state })}`, { cookies: oauthCookie ? { [names().oauth]: oauthCookie } : {} });
}

describe("Login with Genesys Cloud", () => {
  it("signs a user in with PKCE and lands them where they started", async () => {
    const { response, oauthCookie, authorize } = await beginSignIn({ returnTo: "/syncs/abc?tab=runs" });

    expect(response.status).toBe(303);
    expect(authorize!.origin).toBe("https://login.mypurecloud.de");
    expect(authorize!.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(authorize!.searchParams)).toMatchObject({
      response_type: "code",
      client_id: PKCE_CLIENT_ID,
      redirect_uri: `${ORIGIN}/api/auth/callback`,
      code_challenge_method: "S256",
    });
    expect(oauthCookie).toBeTruthy();
    expect(cookieJar(response.setCookies)[names().oauth]!.attributes).toMatch(/HttpOnly/i);

    const code = consent(authorize!);
    const done = await finishSignIn(code, authorize!.searchParams.get("state")!, oauthCookie);

    expect(done.status).toBe(303);
    expect(done.location).toBe(`${ORIGIN}/syncs/abc?tab=runs`);
    const jar = cookieJar(done.setCookies);
    expect(jar[names().session]!.value).toBeTruthy();
    expect(jar[names().session]!.attributes).toMatch(/HttpOnly/i);
    expect(jar[names().csrf]!.value).toBeTruthy();
    expect(jar[names().oauth]!.value).toBe("");

    const me = await callRoute(sessionInfo.GET, "/api/session", { cookies: { [names().session]: jar[names().session]!.value } });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user: { id: "user-0001", name: "Ada Admin" }, org: { id: world.gc.orgId, name: "Acme Corp", region: "mypurecloud.de" } });
    expect(await getOrg(world.gc.orgId)).toMatchObject({ name: "Acme Corp", region: "mypurecloud.de" });
    expect(capturedLogs.withMessage("User signed in")).toHaveLength(1);
  });

  it("never redirects outside the app after sign-in", async () => {
    const { oauthCookie, authorize } = await beginSignIn({ returnTo: "//evil.example/steal" });
    const done = await finishSignIn(consent(authorize!), authorize!.searchParams.get("state")!, oauthCookie);

    expect(done.location).toBe(`${ORIGIN}/`);
  });

  it("rejects an unknown region or client ID before leaving the app", async () => {
    const badRegion = await beginSignIn({ region: "login.evil.example" });
    expect(badRegion.response.location).toBe(`${ORIGIN}/login?error=VALIDATION`);
    expect(badRegion.oauthCookie).toBeUndefined();

    const badClient = await beginSignIn({ clientId: "not-a-client-id" });
    expect(badClient.response.location).toBe(`${ORIGIN}/login?error=VALIDATION`);
  });

  it("rejects a callback whose state doesn't match", async () => {
    const { oauthCookie, authorize } = await beginSignIn();

    const done = await finishSignIn(consent(authorize!), "forged-state", oauthCookie);

    expect(done.location).toBe(`${ORIGIN}/login?error=GC_LOGIN_FAILED`);
    expect(cookieJar(done.setCookies)[names().session]).toBeUndefined();
  });

  it("rejects a callback from another browser or after the sign-in expired", async () => {
    const { oauthCookie, authorize } = await beginSignIn();
    const code = consent(authorize!);
    const state = authorize!.searchParams.get("state")!;

    expect((await finishSignIn(code, state, undefined)).location).toBe(`${ORIGIN}/login?error=GC_LOGIN_FAILED`);

    vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ["Date"] });
    expect((await finishSignIn(code, state, oauthCookie)).location).toBe(`${ORIGIN}/login?error=GC_LOGIN_FAILED`);
  });

  it("reports a sign-in the user declined at Genesys Cloud", async () => {
    const response = await callRoute(callback.GET, "/api/auth/callback?error=access_denied&error_description=User%20denied");

    expect(response.location).toBe(`${ORIGIN}/login?error=GC_LOGIN_FAILED`);
    expect(capturedLogs.withMessage("Sign-in was not completed")[0]).toMatchObject({ reason: "access_denied" });
  });

  it("blocks organizations outside the allowlist", async () => {
    process.env.APP_ALLOWED_ORG_IDS = "11111111-2222-3333-4444-555555555555, 22222222-3333-4444-5555-666666666666";
    const { oauthCookie, authorize } = await beginSignIn();

    const done = await finishSignIn(consent(authorize!), authorize!.searchParams.get("state")!, oauthCookie);

    expect(done.location).toBe(`${ORIGIN}/login?error=ORG_NOT_ALLOWED`);
  });

  it("lets allowlisted organizations in regardless of ID casing", async () => {
    process.env.APP_ALLOWED_ORG_IDS = world.gc.orgId.toUpperCase();
    const { oauthCookie, authorize } = await beginSignIn();

    const done = await finishSignIn(consent(authorize!), authorize!.searchParams.get("state")!, oauthCookie);

    expect(done.location).toBe(`${ORIGIN}/`);
  });

  it("explains when the user can't view knowledge sources", async () => {
    world.gc.addUser("user-0002", "Sam Agent", []);
    const { oauthCookie, authorize } = await beginSignIn();

    const done = await finishSignIn(consent(authorize!, "user-0002"), authorize!.searchParams.get("state")!, oauthCookie);

    expect(done.location).toBe(`${ORIGIN}/login?error=GC_KNOWLEDGE_ACCESS_DENIED`);
  });

  it("fails cleanly when the authorization code was already used", async () => {
    const { oauthCookie, authorize } = await beginSignIn();
    const code = consent(authorize!);
    const state = authorize!.searchParams.get("state")!;
    await finishSignIn(code, state, oauthCookie);

    const replay = await finishSignIn(code, state, oauthCookie);

    expect(replay.location).toBe(`${ORIGIN}/login?error=GC_LOGIN_FAILED`);
  });
});
