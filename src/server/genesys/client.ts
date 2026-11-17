import { AppError, type ErrorCode } from "@/lib/errors";
import { apiHost } from "@/lib/regions";
import { HttpError, type HttpMethod, type HttpResponse, httpRequest } from "../http";
import { type Logger, scopedLogger } from "../log";
import { getClientCredentialsToken } from "./oauth";

/** Supplies bearer tokens for one Genesys Cloud organization. */
export interface GcAuth {
  region: string;
  kind: "user" | "client";
  getToken(options?: { forceRefresh?: boolean }): Promise<string>;
}

export function createClientAuth(params: { region: string; clientId: string; clientSecret: string }): GcAuth {
  return {
    region: params.region,
    kind: "client",
    getToken: (options) => getClientCredentialsToken({ ...params, forceRefresh: options?.forceRefresh }),
  };
}

export interface GcRequestOptions {
  operation: string;
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotent?: boolean;
  timeoutMs?: number;
  /** Error code for HTTP 404 (default NOT_FOUND). */
  notFound?: ErrorCode;
  /** Error code for HTTP 409 (default CONFLICT). */
  conflict?: ErrorCode;
  log?: Logger;
}

export interface GcResult<T> {
  data: T;
  status: number;
  correlationId: string | null;
}

const defaultLog = scopedLogger("gc.api");

function buildUrl(region: string, path: string, query?: GcRequestOptions["query"]): string {
  const url = new URL(`https://${apiHost(region)}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const MISSING_PERMISSION = /missing the following permission\(s\):?\s*([a-z0-9:_,\s]+)/i;

export function mapGcError(response: Pick<HttpResponse, "status" | "correlationId" | "json">, options: GcRequestOptions, authKind: GcAuth["kind"]): AppError {
  const body = response.json<{ message?: unknown; code?: unknown }>();
  const gcMessage = typeof body?.message === "string" ? body.message.slice(0, 300) : undefined;
  const gcCode = typeof body?.code === "string" ? body.code.slice(0, 80) : undefined;
  const detail = [
    `${options.method} ${options.path} → HTTP ${response.status}`,
    gcCode ? ` ${gcCode}` : "",
    gcMessage ? `: ${gcMessage}` : "",
    response.correlationId ? ` (correlation ${response.correlationId})` : "",
  ].join("");
  const status = response.status;

  if (status === 401) return new AppError(authKind === "user" ? "UNAUTHENTICATED" : "GC_AUTH_FAILED", { detail });
  if (status === 403) {
    const missing = gcMessage?.match(MISSING_PERMISSION)?.[1]?.trim();
    return new AppError("GC_PERMISSION_DENIED", {
      detail,
      ...(missing ? { message: `The Genesys Cloud OAuth client is missing permission: ${missing}.` } : {}),
    });
  }
  if (status === 404) return new AppError(options.notFound ?? "NOT_FOUND", { detail });
  if (status === 409) return new AppError(options.conflict ?? "CONFLICT", { detail });
  if (status === 429) return new AppError("GC_RATE_LIMITED", { detail });
  if (status >= 500) return new AppError("GC_UNAVAILABLE", { detail });
  return new AppError("GC_REQUEST_REJECTED", {
    detail,
    ...(gcMessage ? { message: `Genesys Cloud rejected the request: ${gcMessage}` } : {}),
  });
}

export async function gcRequest<T>(auth: GcAuth, options: GcRequestOptions): Promise<GcResult<T>> {
  const log = options.log ?? defaultLog;
  const url = buildUrl(auth.region, options.path, options.query);
  for (let authAttempt = 0; ; authAttempt++) {
    const token = await auth.getToken({ forceRefresh: authAttempt > 0 });
    let response: HttpResponse;
    try {
      response = await httpRequest({
        operation: options.operation,
        method: options.method,
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        idempotent: options.idempotent,
        timeoutMs: options.timeoutMs,
        log,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        throw new AppError(error.ambiguous ? "GC_OUTCOME_UNKNOWN" : "GC_UNAVAILABLE", {
          detail: `${options.method} ${options.path}: ${error.kind}${error.ambiguous ? " after the request was sent" : ""}`,
          cause: error,
        });
      }
      throw error;
    }

    if (response.status === 401 && authAttempt === 0) {
      log.debug("Access token rejected, refreshing once", { operation: options.operation, authKind: auth.kind });
      continue;
    }
    if (!response.ok) throw mapGcError(response, options, auth.kind);
    return { data: response.json<T>() as T, status: response.status, correlationId: response.correlationId };
  }
}
