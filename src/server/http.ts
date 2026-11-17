import { type Logger, scopedLogger } from "./log";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpRequestOptions {
  /** Stable operation name used in logs, e.g. "gc.startSync". */
  operation: string;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | URLSearchParams;
  timeoutMs?: number;
  /** Safe to send twice. Defaults to true for GET/PUT/DELETE. */
  idempotent?: boolean;
  maxAttempts?: number;
  maxResponseBytes?: number;
  log?: Logger;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  bodyText: string;
  attempts: number;
  durationMs: number;
  /** Genesys Cloud correlation ID, handy for support tickets. */
  correlationId: string | null;
  json<T = unknown>(): T | null;
}

export type HttpErrorKind = "timeout" | "network" | "too_large";

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  /** True when a non-idempotent request may have reached the server before failing. */
  readonly ambiguous: boolean;
  readonly operation: string;
  readonly attempts: number;

  constructor(kind: HttpErrorKind, operation: string, attempts: number, ambiguous: boolean, cause?: unknown) {
    super(
      kind === "timeout"
        ? `${operation} timed out`
        : kind === "too_large"
          ? `${operation} response exceeded the size limit`
          : `${operation} failed to connect`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "HttpError";
    this.kind = kind;
    this.operation = operation;
    this.attempts = attempts;
    this.ambiguous = ambiguous;
  }
}

const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);

interface RetryTiming {
  baseMs: number;
  capMs: number;
  maxRetryAfterMs: number;
  sleep: (ms: number) => Promise<void>;
}

const defaultTiming: RetryTiming = {
  baseMs: 400,
  capMs: 8000,
  maxRetryAfterMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let timing: RetryTiming = { ...defaultTiming };

/** Test hook: shrink or stub retry delays. */
export function configureRetryTiming(overrides: Partial<RetryTiming> | null): void {
  timing = overrides ? { ...timing, ...overrides } : { ...defaultTiming };
}

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

export function backoffMs(attempt: number, retryAfterMs: number | null = null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, timing.maxRetryAfterMs);
  const ceiling = Math.min(timing.capMs, timing.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

function describeUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    return { host: "invalid-url", path: "" };
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function readBody(response: Response, maxBytes: number, operation: string, attempts: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError("too_large", operation, attempts, false);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const log = options.log ?? scopedLogger("http");
  const idempotent = options.idempotent ?? (options.method === "GET" || options.method === "PUT" || options.method === "DELETE");
  const maxAttempts = Math.max(1, options.maxAttempts ?? (idempotent ? 4 : 3));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxResponseBytes ?? 20 * 1024 * 1024;
  const { host, path } = describeUrl(options.url);
  const started = performance.now();

  for (let attempt = 1; ; attempt++) {
    const attemptStarted = performance.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new DOMException(`${options.operation} timed out`, "TimeoutError")), timeoutMs);
    let response: Response;
    try {
      response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body as BodyInit | undefined,
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(deadline);
      const kind: HttpErrorKind = isTimeout(error) ? "timeout" : "network";
      if (idempotent && attempt < maxAttempts) {
        const wait = backoffMs(attempt);
        log.warn(`Retrying ${options.operation} after ${kind}`, {
          operation: options.operation,
          host,
          attempt,
          maxAttempts,
          waitMs: wait,
          dedupeKey: `${options.operation}:${kind}`,
        });
        await timing.sleep(wait);
        continue;
      }
      log.warn(`${options.operation} ${kind}`, {
        operation: options.operation,
        method: options.method,
        host,
        path,
        attempt,
        durationMs: Math.round(performance.now() - attemptStarted),
        ambiguous: !idempotent,
        err: error,
      });
      throw new HttpError(kind, options.operation, attempt, !idempotent, error);
    }

    const status = response.status;
    const retryable = status === 429 || (idempotent && RETRYABLE_STATUS.has(status));
    if (retryable && attempt < maxAttempts) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (retryAfter === null || retryAfter <= timing.maxRetryAfterMs) {
        clearTimeout(deadline);
        const wait = backoffMs(attempt, retryAfter);
        await response.body?.cancel().catch(() => undefined);
        log.warn(`Retrying ${options.operation} after HTTP ${status}`, {
          operation: options.operation,
          host,
          status,
          attempt,
          maxAttempts,
          waitMs: wait,
          correlationId: response.headers.get("inin-correlation-id") ?? undefined,
          dedupeKey: `${options.operation}:${status}`,
        });
        await timing.sleep(wait);
        continue;
      }
    }

    let bodyText: string;
    try {
      bodyText = await readBody(response, maxBytes, options.operation, attempt);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const kind: HttpErrorKind = isTimeout(error) ? "timeout" : "network";
      throw new HttpError(kind, options.operation, attempt, !idempotent, error);
    } finally {
      clearTimeout(deadline);
    }

    const durationMs = Math.round(performance.now() - started);
    const correlationId = response.headers.get("inin-correlation-id");
    log.debug(`${options.operation} → ${status}`, {
      operation: options.operation,
      method: options.method,
      host,
      path,
      status,
      attempt,
      durationMs,
      ...(correlationId ? { correlationId } : {}),
    });

    let parsed: { done: boolean; value: unknown } = { done: false, value: null };
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: response.headers,
      bodyText,
      attempts: attempt,
      durationMs,
      correlationId,
      json<T>() {
        if (!parsed.done) {
          try {
            parsed = { done: true, value: bodyText ? JSON.parse(bodyText) : null };
          } catch {
            parsed = { done: true, value: null };
          }
        }
        return parsed.value as T | null;
      },
    };
  }
}
