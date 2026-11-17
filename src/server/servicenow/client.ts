import { z } from "zod";
import { AppError } from "@/lib/errors";
import { sha256Hex } from "../crypto";
import { HttpError, type HttpResponse, httpRequest } from "../http";
import { type Logger, scopedLogger } from "../log";
import { assertPublicHost } from "./instance";

export type SnCredentials =
  | { type: "basic"; username: string; password: string }
  | { type: "oauth"; clientId: string; clientSecret: string }
  | { type: "apikey"; apiKey: string };

export interface SnConnection {
  id: string;
  instanceUrl: string;
  credentials: SnCredentials;
}

const defaultLog = scopedLogger("sn.api");
const oauthCache = new Map<string, { token: string; expiresAt: number }>();

const oauthResponseSchema = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().positive().optional() });

function oauthCacheKey(connection: SnConnection): string {
  const credentials = connection.credentials as Extract<SnCredentials, { type: "oauth" }>;
  return `${connection.instanceUrl}|${credentials.clientId}|${sha256Hex(credentials.clientSecret).slice(0, 16)}`;
}

async function getOAuthToken(connection: SnConnection, forceRefresh: boolean, log: Logger): Promise<string> {
  const credentials = connection.credentials as Extract<SnCredentials, { type: "oauth" }>;
  const key = oauthCacheKey(connection);
  const cached = oauthCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  let response: HttpResponse;
  try {
    response = await httpRequest({
      operation: "sn.oauthToken",
      method: "POST",
      url: `${connection.instanceUrl}/oauth_token.do`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
      idempotent: false,
      timeoutMs: 20_000,
      log,
    });
  } catch (error) {
    throw new AppError("SN_UNREACHABLE", { detail: `sn.oauthToken: ${error instanceof HttpError ? error.kind : "failed"}`, cause: error });
  }
  if (response.status === 400 || response.status === 401) {
    throw new AppError("SN_AUTH_FAILED", {
      hint:
        "Check the OAuth client ID and secret. The instance must allow the client credentials grant (system property glide.oauth.inbound.client.credential.grant_type.enabled set to true), and the OAuth client needs an OAuth Application User.",
      detail: `sn.oauthToken → HTTP ${response.status}. Check the OAuth client and that the client credentials grant is enabled on the instance.`,
    });
  }
  if (!response.ok) throw mapSnError(response, "sn.oauthToken");
  const parsed = oauthResponseSchema.safeParse(response.json());
  if (!parsed.success) throw new AppError("SN_AUTH_FAILED", { detail: "sn.oauthToken: unexpected token response" });
  const token = parsed.data.access_token;
  oauthCache.set(key, { token, expiresAt: Date.now() + (parsed.data.expires_in ?? 1800) * 1000 });
  return token;
}

async function authHeaders(connection: SnConnection, forceRefresh: boolean, log: Logger): Promise<Record<string, string>> {
  const credentials = connection.credentials;
  switch (credentials.type) {
    case "basic":
      return { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}` };
    case "apikey":
      return { "x-sn-apikey": credentials.apiKey };
    case "oauth":
      return { Authorization: `Bearer ${await getOAuthToken(connection, forceRefresh, log)}` };
  }
}

const API_KEY_REJECTED_HINT =
  "Check that the API key is active and that a REST API access policy applies its authentication profile to the Table API. API keys only work on APIs covered by such a policy.";

export function mapSnError(response: Pick<HttpResponse, "status" | "json" | "headers">, operation: string, authType?: SnCredentials["type"]): AppError {
  const body = response.json<{ error?: { message?: unknown; detail?: unknown } }>();
  const message = typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : undefined;
  const detail = `${operation} → HTTP ${response.status}${message ? `: ${message}` : ""}`;
  const status = response.status;
  if (status === 401) return new AppError("SN_AUTH_FAILED", { detail, ...(authType === "apikey" ? { hint: API_KEY_REJECTED_HINT } : {}) });
  if (status === 403) return new AppError("SN_PERMISSION_DENIED", { detail });
  if (status === 404) return new AppError("SN_NOT_FOUND", { detail });
  if (status === 429) return new AppError("SN_RATE_LIMITED", { detail });
  if (status === 400) return new AppError("SN_QUERY_INVALID", { detail, ...(message ? { message: `ServiceNow rejected the query: ${message}` } : {}) });
  if (status >= 500) return new AppError("SN_UNAVAILABLE", { detail });
  return new AppError("SN_BAD_RESPONSE", { detail });
}

export interface SnRequestOptions {
  operation: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  log?: Logger;
}

export interface SnResult<T> {
  data: T;
  headers: Headers;
}

export function buildSnUrl(instanceUrl: string, path: string, query?: SnRequestOptions["query"]): string {
  const url = new URL(path, `${instanceUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** GET against the ServiceNow REST API with auth, SSRF guard and error mapping. */
export async function snGet<T>(connection: SnConnection, options: SnRequestOptions): Promise<SnResult<T>> {
  const log = options.log ?? defaultLog;
  await assertPublicHost(new URL(connection.instanceUrl).hostname);
  const url = buildSnUrl(connection.instanceUrl, options.path, options.query);

  for (let authAttempt = 0; ; authAttempt++) {
    const headers = { Accept: "application/json", ...(await authHeaders(connection, authAttempt > 0, log)) };
    let response: HttpResponse;
    try {
      response = await httpRequest({ operation: options.operation, method: "GET", url, headers, timeoutMs: options.timeoutMs ?? 30_000, log });
    } catch (error) {
      if (error instanceof HttpError) {
        throw new AppError(error.kind === "too_large" ? "SN_BAD_RESPONSE" : "SN_UNREACHABLE", {
          detail: `${options.operation}: ${error.kind}`,
          cause: error,
        });
      }
      throw error;
    }

    if (response.status === 401 && connection.credentials.type === "oauth" && authAttempt === 0) {
      log.debug("ServiceNow token rejected, requesting a new one", { operation: options.operation });
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      let target = "another page";
      try {
        if (location) target = new URL(location, connection.instanceUrl).host;
      } catch {
        // keep the generic description
      }
      throw new AppError("SN_HIBERNATING", { detail: `${options.operation} redirected to ${target}` });
    }
    if (!response.ok) throw mapSnError(response, options.operation, connection.credentials.type);

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.includes("json")) {
      throw new AppError("SN_HIBERNATING", { detail: `${options.operation} returned ${contentType || "no content type"} instead of JSON` });
    }
    const data = response.json<T>();
    if (data === null) throw new AppError("SN_BAD_RESPONSE", { detail: `${options.operation}: invalid JSON` });
    return { data, headers: response.headers };
  }
}

export function clearSnTokenCache(): void {
  oauthCache.clear();
}
