import { redactString, redactValue, serializeError } from "@/lib/redact";

/**
 * Structured logger. On Vercel every record is one JSON line (searchable in the Logs tab
 * and log drains); locally it prints a compact human-readable line.
 *
 * Volume rules that keep logs useful instead of noisy:
 *  - successful polling/GET traffic and per-item detail log at `debug`;
 *  - state changes, run summaries and failures log at `info`/`warn`/`error`;
 *  - records with a `dedupeKey` are emitted at most once per minute per key, with a
 *    `suppressed` count on the next emission.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const RANK: Record<LogLevel | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_KEYS = 500;

export interface LogRecord extends LogFields {
  level: LogLevel;
  time: string;
  msg: string;
}

type Sink = (record: LogRecord) => void;

function resolveThreshold(): LogLevel | "silent" {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  if (configured && configured in RANK) return configured as LogLevel | "silent";
  if (process.env.NODE_ENV === "test") return "silent";
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function usePrettyOutput(): boolean {
  if (process.env.LOG_FORMAT === "json") return false;
  if (process.env.LOG_FORMAT === "pretty") return true;
  return !process.env.VERCEL && process.env.NODE_ENV !== "production";
}

const dedupeState = new Map<string, { lastEmitted: number; suppressed: number }>();
let customSink: Sink | null = null;

/** Test hook: capture records instead of printing them. Pass null to restore console output. */
export function setLogSink(sink: Sink | null): void {
  customSink = sink;
  dedupeState.clear();
}

function consoleSink(record: LogRecord): void {
  const method = record.level === "error" ? console.error : record.level === "warn" ? console.warn : console.log;
  if (!usePrettyOutput()) {
    method(JSON.stringify(record));
    return;
  }
  const { level, time, msg, scope, ...rest } = record;
  const clock = time.slice(11, 23);
  const pairs = Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  method(`${clock} ${level.toUpperCase().padEnd(5)} ${scope ? `[${String(scope)}] ` : ""}${msg}${pairs ? `  ${pairs}` : ""}`);
}

function shouldEmitDeduped(key: string, now: number): { emit: boolean; suppressed: number } {
  const state = dedupeState.get(key);
  if (!state) {
    if (dedupeState.size >= DEDUPE_MAX_KEYS) {
      const oldest = dedupeState.keys().next().value;
      if (oldest !== undefined) dedupeState.delete(oldest);
    }
    dedupeState.set(key, { lastEmitted: now, suppressed: 0 });
    return { emit: true, suppressed: 0 };
  }
  if (now - state.lastEmitted < DEDUPE_WINDOW_MS) {
    state.suppressed += 1;
    return { emit: false, suppressed: 0 };
  }
  const suppressed = state.suppressed;
  state.lastEmitted = now;
  state.suppressed = 0;
  return { emit: true, suppressed };
}

export class Logger {
  private readonly bindings: LogFields;
  private readonly threshold: LogLevel | "silent" | null;

  constructor(bindings: LogFields = {}, threshold: LogLevel | "silent" | null = null) {
    this.bindings = bindings;
    this.threshold = threshold;
  }

  /** New logger with extra context fields (requestId, syncId, runId...). */
  child(bindings: LogFields, options: { threshold?: LogLevel } = {}): Logger {
    return new Logger({ ...this.bindings, ...bindings }, options.threshold ?? this.threshold);
  }

  isEnabled(level: LogLevel): boolean {
    const threshold = this.threshold ?? resolveThreshold();
    return RANK[level] >= RANK[threshold];
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit("debug", msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.emit("info", msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.emit("warn", msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.emit("error", msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (!this.isEnabled(level)) return;
    const { dedupeKey, err, ...rest } = fields;
    let suppressed = 0;
    if (typeof dedupeKey === "string") {
      const decision = shouldEmitDeduped(`${level}:${dedupeKey}`, Date.now());
      if (!decision.emit) return;
      suppressed = decision.suppressed;
    }
    const merged = redactValue({ ...this.bindings, ...rest }) as LogFields;
    const time = new Date().toISOString();
    const safeMsg = redactString(msg);
    const record: LogRecord = { level, time, msg: safeMsg, ...merged };
    Object.assign(record, { level, time, msg: safeMsg });
    if (err !== undefined) record.err = serializeError(err, { stack: level === "error" });
    if (suppressed > 0) record.suppressed = suppressed;
    try {
      (customSink ?? consoleSink)(record);
    } catch {
      // Logging must never break the request.
    }
  }
}

export const logger = new Logger({ service: "kf-snow" });

export function scopedLogger(scope: string, bindings: LogFields = {}): Logger {
  return logger.child({ scope, ...bindings });
}

/** Runs `fn`, logging its duration at debug on success and at warn on failure. */
export async function timed<T>(log: Logger, msg: string, fn: () => Promise<T>, fields: LogFields = {}): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    log.debug(msg, { ...fields, durationMs: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    log.warn(`${msg} failed`, { ...fields, durationMs: Math.round(performance.now() - started), err: error });
    throw error;
  }
}
