import { randomToken, signPayload, timingSafeEqualStrings, verifyPayload } from "../crypto";
import { isProduction } from "../env";

/**
 * Cookies:
 *  - session: signed (HMAC) identity, httpOnly, 12 h;
 *  - csrf: random token readable by the page, echoed in the x-csrf-token header (double submit);
 *  - oauth: encrypted PKCE state for the 10-minute sign-in round trip.
 * In production the names carry the __Host- prefix (Secure, Path=/, no Domain).
 */

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const OAUTH_TTL_SECONDS = 10 * 60;
export const CSRF_HEADER = "x-csrf-token";

export interface Session {
  userId: string;
  userName: string;
  orgId: string;
  orgName: string;
  region: string;
  issuedAt: number;
}

export interface OAuthState {
  state: string;
  verifier: string;
  region: string;
  clientId: string;
  returnTo: string;
  createdAt: number;
}

export function cookieNames(): { session: string; csrf: string; oauth: string } {
  const prefix = isProduction() ? "__Host-" : "";
  return { session: `${prefix}kf_session`, csrf: `${prefix}kf_csrf`, oauth: `${prefix}kf_oauth` };
}

export interface CookieSpec {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict";
  path: string;
  maxAge: number;
}

function spec(name: string, value: string, maxAge: number, httpOnly: boolean): CookieSpec {
  return { name, value, httpOnly, secure: isProduction(), sameSite: "lax", path: "/", maxAge };
}

export function sessionCookies(session: Omit<Session, "issuedAt">, nowMs = Date.now()): CookieSpec[] {
  const names = cookieNames();
  const value = signPayload<Session>({ ...session, issuedAt: nowMs }, SESSION_TTL_SECONDS, nowMs);
  return [spec(names.session, value, SESSION_TTL_SECONDS, true), spec(names.csrf, randomToken(24), SESSION_TTL_SECONDS, false)];
}

export function clearedSessionCookies(): CookieSpec[] {
  const names = cookieNames();
  return [spec(names.session, "", 0, true), spec(names.csrf, "", 0, false), clearedOAuthCookie()];
}

export function clearedOAuthCookie(): CookieSpec {
  return spec(cookieNames().oauth, "", 0, true);
}

/** True when the Origin header is absent (same-origin navigation) or matches the request host. */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const SESSION_FIELDS = ["userId", "userName", "orgId", "orgName", "region"] as const;

export function readSession(token: string | undefined, nowMs = Date.now()): Session | null {
  const session = verifyPayload<Session>(token, nowMs);
  if (!session || typeof session !== "object") return null;
  for (const field of SESSION_FIELDS) if (typeof session[field] !== "string" || !session[field]) return null;
  return session;
}

/** Double-submit check plus an Origin check for state-changing requests. */
export function verifyCsrf(params: { cookieToken: string | undefined; headerToken: string | null; origin: string | null; host: string | null }): boolean {
  if (!params.cookieToken || !params.headerToken) return false;
  if (!timingSafeEqualStrings(params.cookieToken, params.headerToken)) return false;
  return isSameOrigin(params.origin, params.host);
}

export function requestHost(headers: Headers): string | null {
  return headers.get("x-forwarded-host") ?? headers.get("host");
}

/** Only same-site relative paths are allowed after sign-in (no open redirects). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.startsWith("/api/")) return "/";
  try {
    const url = new URL(value, "https://placeholder.invalid");
    return url.origin === "https://placeholder.invalid" ? `${url.pathname}${url.search}` : "/";
  } catch {
    return "/";
  }
}
