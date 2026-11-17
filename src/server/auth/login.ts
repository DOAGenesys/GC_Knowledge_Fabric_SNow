import { z } from "zod";
import { AppError } from "@/lib/errors";
import { normalizeRegion } from "@/lib/regions";
import { createPkceVerifier, decryptCookie, encryptCookie, pkceChallenge, randomToken, timingSafeEqualStrings } from "../crypto";
import { allowedOrgIds, isProduction } from "../env";
import type { GcAuth } from "../genesys/client";
import { canViewKnowledgeSources, getCurrentUser, getOrganization } from "../genesys/identity";
import { buildAuthorizeUrl, exchangeAuthorizationCode } from "../genesys/oauth";
import type { Logger } from "../log";
import { upsertOrg } from "../repo/orgs";
import { type CookieSpec, cookieNames, OAUTH_TTL_SECONDS, type OAuthState, type Session, safeReturnTo } from "./session";

export const loginQuerySchema = z.object({
  region: z.string().trim().min(1).max(100),
  clientId: z.string().trim().uuid(),
  returnTo: z.string().max(500).optional(),
});

export function callbackUrl(origin: string): string {
  return `${origin}/api/auth/callback`;
}

export function beginLogin(params: { region: string; clientId: string; returnTo?: string; origin: string }): { redirectUrl: string; cookie: CookieSpec } {
  const region = normalizeRegion(params.region);
  if (!region) {
    throw new AppError("VALIDATION", { message: "Pick a valid Genesys Cloud region.", fields: [{ path: "region", message: "Unknown region" }] });
  }
  const verifier = createPkceVerifier();
  const state = randomToken(24);
  const names = cookieNames();
  const pending: OAuthState = { state, verifier, region, clientId: params.clientId, returnTo: safeReturnTo(params.returnTo), createdAt: Date.now() };
  return {
    redirectUrl: buildAuthorizeUrl({ region, clientId: params.clientId, redirectUri: callbackUrl(params.origin), codeChallenge: pkceChallenge(verifier), state }),
    cookie: {
      name: names.oauth,
      value: encryptCookie(pending, names.oauth),
      httpOnly: true,
      secure: isProduction(),
      sameSite: "lax",
      path: "/",
      maxAge: OAUTH_TTL_SECONDS,
    },
  };
}

export async function completeLogin(params: {
  code: string;
  state: string;
  oauthCookie: string | undefined;
  origin: string;
  log: Logger;
}): Promise<{ session: Omit<Session, "issuedAt">; returnTo: string }> {
  const names = cookieNames();
  const pending = decryptCookie<OAuthState>(params.oauthCookie, names.oauth);
  if (!pending || Date.now() - pending.createdAt > OAUTH_TTL_SECONDS * 1000) {
    throw new AppError("GC_LOGIN_FAILED", { message: "The sign-in took too long or was started in another browser.", hint: "Please sign in again.", detail: "missing or expired sign-in state" });
  }
  if (!timingSafeEqualStrings(pending.state, params.state)) {
    throw new AppError("GC_LOGIN_FAILED", { hint: "Please sign in again.", detail: "state mismatch" });
  }

  const tokens = await exchangeAuthorizationCode({
    region: pending.region,
    clientId: pending.clientId,
    code: params.code,
    redirectUri: callbackUrl(params.origin),
    codeVerifier: pending.verifier,
  });
  const auth: GcAuth = { region: pending.region, kind: "user", getToken: async () => tokens.accessToken };
  const [user, org] = await Promise.all([getCurrentUser(auth, params.log), getOrganization(auth, params.log)]);

  const allowed = allowedOrgIds();
  if (allowed && !allowed.has(org.id.toLowerCase())) throw new AppError("ORG_NOT_ALLOWED", { detail: `org ${org.id} not in allowlist` });
  if (!(await canViewKnowledgeSources(auth, params.log))) throw new AppError("GC_KNOWLEDGE_ACCESS_DENIED");

  await upsertOrg({ id: org.id, name: org.name, region: pending.region });
  params.log.info("User signed in", { userId: user.id, orgId: org.id, region: pending.region });
  return {
    session: { userId: user.id, userName: user.name, orgId: org.id, orgName: org.name, region: pending.region },
    returnTo: pending.returnTo,
  };
}
