import { redactString, redactValue, serializeError } from "./redact";

/**
 * Browser logger. Console output is quiet by default in production (warnings and errors only);
 * `kfDebug(true)` in the console (or localStorage "kf:debug" = "1") turns on verbose logs and
 * asks the server to log those requests at debug level too.
 *
 * Warnings and errors are also sent to /api/client-log (batched, deduplicated, capped) so they
 * appear in Vercel logs next to the server records with the same request IDs.
 */

export type ClientLogLevel = "debug" | "info" | "warn" | "error";
export type ClientLogFields = Record<string, unknown>;

const RANK: Record<ClientLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEBUG_FLAG = "kf:debug";
const REPORT_ENDPOINT = "/api/client-log";
const DEDUPE_WINDOW_MS = 60_000;
const FLUSH_DELAY_MS = 2_000;
const MAX_BATCH = 10;
const MAX_REPORTS_PER_PAGE = 50;

const BADGE_STYLE = "background:#FF451A;color:#fff;border-radius:3px;padding:1px 5px;font-weight:700";
const LEVEL_STYLE: Record<ClientLogLevel, string> = {
  debug: "color:#2243A2",
  info: "color:#152550",
  warn: "color:#8A5F00;font-weight:600",
  error: "color:#C9301C;font-weight:600",
};

interface ReportEntry {
  level: "warn" | "error";
  scope: string;
  message: string;
  name?: string;
  stack?: string;
  path?: string;
  requestId?: string;
  count: number;
}

const recent = new Map<string, { at: number; entry: ReportEntry | null }>();
let queue: ReportEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let reportsSent = 0;
let pagehideBound = false;

function inBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function isDebugEnabled(): boolean {
  if (!inBrowser()) return false;
  try {
    return window.localStorage.getItem(DEBUG_FLAG) === "1";
  } catch {
    return false;
  }
}

export function setDebug(enabled: boolean): void {
  if (!inBrowser()) return;
  try {
    if (enabled) window.localStorage.setItem(DEBUG_FLAG, "1");
    else window.localStorage.removeItem(DEBUG_FLAG);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); verbose logs just stay off.
  }
}

function threshold(): ClientLogLevel {
  if (isDebugEnabled()) return "debug";
  return process.env.NODE_ENV === "production" ? "warn" : "info";
}

export function flushClientLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!inBrowser() || queue.length === 0) return;
  const batch = queue.slice(0, MAX_BATCH);
  queue = queue.slice(MAX_BATCH);
  for (const entry of batch) {
    const seen = recent.get(`${entry.level}|${entry.scope}|${entry.message}`);
    if (seen?.entry === entry) seen.entry = null;
  }
  reportsSent += batch.length;
  void fetch(REPORT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: batch }),
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => undefined);
  if (queue.length > 0) scheduleFlush();
}

function scheduleFlush(): void {
  if (!flushTimer) flushTimer = setTimeout(flushClientLogs, FLUSH_DELAY_MS);
  if (!pagehideBound) {
    pagehideBound = true;
    window.addEventListener("pagehide", flushClientLogs);
  }
}

function report(level: "warn" | "error", scope: string, message: string, fields: ClientLogFields): void {
  if (!inBrowser() || reportsSent + queue.length >= MAX_REPORTS_PER_PAGE) return;
  const key = `${level}|${scope}|${message}`;
  const now = Date.now();
  const seen = recent.get(key);
  if (seen && now - seen.at < DEDUPE_WINDOW_MS) {
    if (seen.entry) seen.entry.count += 1;
    return;
  }
  const error = fields.err === undefined ? null : serializeError(fields.err, { stack: true });
  const entry: ReportEntry = {
    level,
    scope: scope.slice(0, 40),
    message: message.slice(0, 500),
    ...(error ? { name: error.name.slice(0, 100), ...(error.stack ? { stack: error.stack.slice(0, 4000) } : {}) } : {}),
    path: window.location.pathname.slice(0, 300),
    ...(typeof fields.requestId === "string" ? { requestId: fields.requestId.slice(0, 128) } : {}),
    count: 1,
  };
  if (recent.size > 200) recent.clear();
  recent.set(key, { at: now, entry });
  queue.push(entry);
  scheduleFlush();
}

export interface ClientLogger {
  debug(message: string, fields?: ClientLogFields): void;
  info(message: string, fields?: ClientLogFields): void;
  warn(message: string, fields?: ClientLogFields): void;
  error(message: string, fields?: ClientLogFields): void;
}

function emit(level: ClientLogLevel, scope: string, rawMessage: string, fields: ClientLogFields = {}): void {
  const message = redactString(rawMessage);
  if (RANK[level] >= RANK[threshold()] && typeof console !== "undefined") {
    const { err, ...rest } = fields;
    const details = redactValue(rest) as ClientLogFields;
    const args: unknown[] = [`%cKF%c ${scope} · ${message}`, BADGE_STYLE, LEVEL_STYLE[level]];
    if (Object.keys(details).length > 0) args.push(details);
    if (err !== undefined) args.push(serializeError(err, { stack: true }));
    const method = level === "error" ? console.error : level === "warn" ? console.warn : level === "info" ? console.info : console.debug;
    method(...args);
  }
  if (level === "warn" || level === "error") report(level, scope, message, fields);
}

export function clientLogger(scope: string): ClientLogger {
  return {
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
  };
}

/** Test hook. */
export function resetClientLogState(): void {
  recent.clear();
  queue = [];
  reportsSent = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}
