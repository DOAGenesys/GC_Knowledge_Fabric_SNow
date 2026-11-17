import { z } from "zod";
import { AppError, type ErrorCode } from "@/lib/errors";
import { loginHost } from "@/lib/regions";
import { sha256Hex } from "../crypto";
import { HttpError, httpRequest } from "../http";
import { scopedLogger } from "../log";

const log = scopedLogger("gc.oauth");

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});

export function buildAuthorizeUrl(params: {
  region: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(`https://${loginHost(params.region)}/oauth/authorize`);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.toString();
}

async function requestToken(
  region: string,
  body: URLSearchParams,
  operation: string,
  rejectedCode: ErrorCode,
  headers: Record<string, string> = {},
): Promise<TokenSet> {
  let response;
  try {
    response = await httpRequest({
      operation,
      method: "POST",
      url: `https://${loginHost(region)}/oauth/token`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
      body,
      timeoutMs: 15_000,
      idempotent: false,
      log,
    });
  } catch (error) {
    throw new AppError("GC_UNAVAILABLE", {
      detail: `${operation}: ${error instanceof HttpError ? error.kind : "request failed"}`,
      cause: error,
    });
  }

  if (response.status === 429) throw new AppError("GC_RATE_LIMITED", { detail: `${operation} → HTTP 429` });
  if (response.status >= 500) throw new AppError("GC_UNAVAILABLE", { detail: `${operation} → HTTP ${response.status}` });
  if (!response.ok) {
    const error = response.json<{ error?: unknown }>()?.error;
    throw new AppError(rejectedCode, {
      detail: `${operation} → HTTP ${response.status}${typeof error === "string" ? ` (${error.slice(0, 60)})` : ""}`,
    });
  }

  const parsed = tokenResponseSchema.safeParse(response.json());
  if (!parsed.success) {
    throw new AppError(rejectedCode, { detail: `${operation}: unexpected token response shape` });
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: Date.now() + (parsed.data.expires_in ?? 3600) * 1000,
  };
}

export function exchangeAuthorizationCode(params: {
  region: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenSet> {
  return requestToken(
    params.region,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    }),
    "gc.oauth.exchangeCode",
    "GC_LOGIN_FAILED",
  );
}

const clientTokenCache = new Map<string, TokenSet>();
const CLIENT_TOKEN_SKEW_MS = 120_000;

export async function getClientCredentialsToken(params: {
  region: string;
  clientId: string;
  clientSecret: string;
  forceRefresh?: boolean;
}): Promise<string> {
  const cacheKey = `${params.region}|${params.clientId}|${sha256Hex(params.clientSecret).slice(0, 16)}`;
  const cached = clientTokenCache.get(cacheKey);
  if (!params.forceRefresh && cached && cached.expiresAt - CLIENT_TOKEN_SKEW_MS > Date.now()) {
    return cached.accessToken;
  }
  const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`, "utf8").toString("base64");
  const token = await requestToken(
    params.region,
    new URLSearchParams({ grant_type: "client_credentials" }),
    "gc.oauth.clientCredentials",
    "GC_AUTH_FAILED",
    { Authorization: `Basic ${basic}` },
  );
  clientTokenCache.set(cacheKey, token);
  log.debug("Client credentials token issued", { clientId: params.clientId, region: params.region });
  return token.accessToken;
}

export function clearClientTokenCache(): void {
  clientTokenCache.clear();
}
