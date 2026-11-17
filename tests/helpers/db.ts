import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { type Db, db as getDb, setDbOverride } from "@/server/db";

const TABLES = ["run_items", "sync_items", "sync_runs", "syncs", "sn_connections", "orgs"];

export interface TestDatabase {
  pg: PGlite;
  db: Db;
  /** Raw query helper for assertions. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export function createPgliteDb(pg: PGlite): Db {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
    async transaction(statements) {
      return pg.transaction(async (tx) => {
        const results: unknown[][] = [];
        for (const statement of statements) results.push((await tx.query(statement.text, statement.params ?? [])).rows);
        return results;
      });
    },
  };
}

/**
 * One in-memory Postgres (PGlite) per test file, emptied before every test.
 * The app's own schema bootstrap runs against it, so DDL is exercised too.
 */
export function useTestDatabase(): TestDatabase {
  const holder = {} as TestDatabase;

  beforeAll(async () => {
    const pg = await PGlite.create();
    const database = createPgliteDb(pg);
    setDbOverride(database);
    await getDb();
    holder.pg = pg;
    holder.db = database;
    holder.query = database.query.bind(database);
  });

  beforeEach(async () => {
    await holder.pg.exec(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
  });

  afterAll(async () => {
    setDbOverride(null);
    await holder.pg?.close();
  });

  return holder;
}
