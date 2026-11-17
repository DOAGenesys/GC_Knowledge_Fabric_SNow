import { neon } from "@neondatabase/serverless";
import { requireEnv } from "../env";
import { scopedLogger } from "../log";
import { SCHEMA_LOCK_ID, SCHEMA_STATEMENTS } from "./schema";

export interface Statement {
  text: string;
  params?: unknown[];
}

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs the statements atomically (non-interactive transaction). */
  transaction(statements: Statement[]): Promise<unknown[][]>;
}

const log = scopedLogger("db");
const OVERRIDE = Symbol.for("kf.db.override");
const SLOW_QUERY_MS = 1500;

type GlobalWithDb = typeof globalThis & { [OVERRIDE]?: Db };

let neonDb: Db | null = null;
let schemaReady: Promise<void> | null = null;

function summarize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

function createNeonDb(url: string): Db {
  const sql = neon(url);
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const started = performance.now();
      const rows = (await sql.query(text, params)) as T[];
      const durationMs = Math.round(performance.now() - started);
      if (durationMs > SLOW_QUERY_MS) {
        log.warn("Slow database query", { query: summarize(text), durationMs, rows: rows.length, dedupeKey: `slow:${summarize(text)}` });
      }
      return rows;
    },
    async transaction(statements: Statement[]) {
      const started = performance.now();
      const results = (await sql.transaction(statements.map((statement) => sql.query(statement.text, statement.params ?? [])))) as unknown[][];
      const durationMs = Math.round(performance.now() - started);
      if (durationMs > SLOW_QUERY_MS) {
        log.warn("Slow database transaction", { statements: statements.length, first: summarize(statements[0]?.text ?? ""), durationMs });
      }
      return results;
    },
  };
}

function rawDb(): Db {
  const override = (globalThis as GlobalWithDb)[OVERRIDE];
  if (override) return override;
  neonDb ??= createNeonDb(requireEnv("DATABASE_URL"));
  return neonDb;
}

/** Test hook: route every query to another database (e.g. in-memory PGlite). */
export function setDbOverride(db: Db | null): void {
  const target = globalThis as GlobalWithDb;
  if (db) target[OVERRIDE] = db;
  else delete target[OVERRIDE];
  schemaReady = null;
}

async function applySchema(db: Db): Promise<void> {
  const started = performance.now();
  await db.transaction([{ text: `SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_ID})` }, ...SCHEMA_STATEMENTS.map((text) => ({ text }))]);
  log.debug("Database schema ready", { durationMs: Math.round(performance.now() - started) });
}

/** The database, with the schema guaranteed to exist. */
export async function db(): Promise<Db> {
  const database = rawDb();
  schemaReady ??= applySchema(database).catch((error: unknown) => {
    schemaReady = null;
    throw error;
  });
  await schemaReady;
  return database;
}

export async function pingDb(): Promise<boolean> {
  try {
    const database = await db();
    await database.query("SELECT 1");
    return true;
  } catch (error) {
    log.error("Database unreachable", { err: error, dedupeKey: "db.ping" });
    return false;
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code !== "23505") return false;
  if (!constraint) return true;
  return candidate.constraint === constraint || (typeof candidate.message === "string" && candidate.message.includes(constraint));
}

export function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503";
}

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toInt(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      return toStringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

export function toJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}
