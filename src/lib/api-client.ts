import { clientLogger, isDebugEnabled } from "./client-log";
import type { ApiErrorBody, ErrorCode, FieldIssue } from "./errors";

const log = clientLogger("api");
const CSRF_COOKIES = ["__Host-kf_csrf", "kf_csrf"];

export type ApiErrorCode = ErrorCode | "NETWORK";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly title: string;
  readonly hint: string | null;
  readonly fields: FieldIssue[];
  readonly requestId: string | null;

  constructor(init: { status: number; code: ApiErrorCode; title: string; message: string; hint?: string | null; fields?: FieldIssue[]; requestId?: string | null }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.hint = init.hint ?? null;
    this.fields = init.fields ?? [];
    this.requestId = init.requestId ?? null;
  }

  /** Message for one form field ("auth.password"), if the server flagged it. */
  fieldError(path: string): string | undefined {
    return this.fields.find((field) => field.path === path)?.message;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const separator = part.indexOf("=");
    const name = part.slice(0, separator).trim();
    if (CSRF_COOKIES.includes(name)) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

let redirecting = false;

function redirectToLogin(): void {
  if (typeof window === "undefined" || redirecting || window.location.pathname === "/login") return;
  redirecting = true;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/** JSON request to the app's own API. Throws ApiError with the server's code, message and hint. */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const token = readCsrfToken();
    if (token) headers["x-csrf-token"] = token;
  }
  if (isDebugEnabled()) headers["x-kf-debug"] = "1";
  const route = path.split("?")[0] ?? path;
  const started = performance.now();

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    log.warn(`${method} ${route} could not reach the server`, { err: error });
    throw new ApiError({
      status: 0,
      code: "NETWORK",
      title: "Connection problem",
      message: "We couldn't reach the server. Check your connection and try again.",
    });
  }

  const requestId = response.headers.get("x-request-id");
  const durationMs = Math.round(performance.now() - started);
  const text = await response.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (response.ok) {
    log.debug(`${method} ${route} → ${response.status}`, { durationMs, requestId });
    return data as T;
  }

  const body = (data as Partial<ApiErrorBody> | null)?.error;
  const error = new ApiError({
    status: response.status,
    code: body?.code ?? "INTERNAL",
    title: body?.title ?? "Something went wrong",
    message: body?.message ?? `The server answered with HTTP ${response.status}.`,
    hint: body?.hint ?? null,
    fields: body?.fields ?? [],
    requestId: body?.requestId ?? requestId,
  });

  const fields = { status: response.status, code: error.code, durationMs, requestId: error.requestId };
  if (response.status === 401) {
    log.info("Session expired, redirecting to sign-in", fields);
    redirectToLogin();
  } else if (response.status >= 500) {
    log.error(`${method} ${route} failed: ${error.code}`, fields);
  } else {
    log.info(`${method} ${route} rejected: ${error.code}`, fields);
  }
  throw error;
}

export const swrFetcher = <T>(path: string): Promise<T> => apiFetch<T>(path);
