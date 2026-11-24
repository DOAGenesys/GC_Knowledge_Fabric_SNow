import type { ConnectionDTO } from "@/lib/api-types";
import { clearClientTokenCache } from "@/server/genesys/oauth";
import { configureRetryTiming } from "@/server/http";
import { scopedLogger } from "@/server/log";
import { upsertOrg } from "@/server/repo/orgs";
import { getRunById, type RunRow } from "@/server/repo/runs";
import { getSyncById } from "@/server/repo/syncs";
import { clearSnTokenCache } from "@/server/servicenow/client";
import { configureHostResolver } from "@/server/servicenow/instance";
import type { ActorContext } from "@/server/services/actor";
import { createConnection } from "@/server/services/connections";
import { saveGcCredentials } from "@/server/services/genesys";
import { createSync, createSyncSchema } from "@/server/services/syncs";
import { configureEngineTiming } from "@/server/sync/engine";
import { db } from "@/server/db";
import { FakeGenesys } from "./fake-genesys";
import { type FakeKb, type FakeSnAuth, FakeServiceNow } from "./fake-servicenow";
import { installFetch } from "./fetch-router";
import { harness } from "./workflow-harness";

export const GC_CLIENT = { id: "cc-client-0001", secret: "fake-gc-client-secret-0001" };

export interface SyncOptions {
  kbs: FakeKb[];
  name?: string;
  audience?: "csm" | "itsm";
  filters?: unknown;
  filterQuery?: string;
  linkStyle?: "classic" | "sp" | "esc" | "csm" | "csp" | "custom";
  linkCustom?: string;
  schedule?: unknown;
  source?: { mode: "existing"; id: string } | { mode: "new"; name: string };
  runNow?: boolean;
  enabled?: boolean;
}

export type World = Awaited<ReturnType<typeof createWorld>>;

export async function createWorld(options: { snAuth?: FakeSnAuth } = {}) {
  const sn = new FakeServiceNow({ auth: options.snAuth });
  const gc = new FakeGenesys();
  gc.addClient(GC_CLIENT.id, GC_CLIENT.secret);
  gc.addUser("user-0001", "Ada Admin");
  const network = installFetch([
    { host: sn.host, handle: sn.handle },
    { host: gc.loginHost, handle: gc.handleLogin },
    { host: gc.apiHost, handle: gc.handleApi },
    { host: gc.s3Host, handle: gc.handleS3 },
  ]);
  configureHostResolver(async () => ["52.84.10.20"]);
  configureRetryTiming({ sleep: async () => undefined, baseMs: 1, capMs: 2 });
  configureEngineTiming({ roundPollDelayMs: 0 });
  clearClientTokenCache();
  clearSnTokenCache();
  await upsertOrg({ id: gc.orgId, name: gc.orgName, region: gc.region });

  const actor: ActorContext = { orgId: gc.orgId, userId: "user-0001", userName: "Ada Admin", log: scopedLogger("test") };
  let connection: ConnectionDTO | null = null;

  const world = {
    sn,
    gc,
    actor,
    network,

    snAuthInput() {
      const auth = sn.auth;
      if (auth.type === "basic") return { type: "basic" as const, username: auth.username, password: auth.password };
      if (auth.type === "oauth") return { type: "oauth" as const, clientId: auth.clientId, clientSecret: auth.clientSecret };
      return { type: "apikey" as const, apiKey: auth.apiKey };
    },

    async connect(): Promise<ConnectionDTO> {
      connection = await createConnection(actor, { name: "Acme ServiceNow", instanceUrl: "acme", auth: world.snAuthInput() });
      return connection;
    },

    async saveGcCredentials() {
      return saveGcCredentials(actor, { clientId: GC_CLIENT.id, clientSecret: GC_CLIENT.secret });
    },

    /** Connection + Genesys credentials, the usual starting point. */
    async setup(): Promise<ConnectionDTO> {
      const created = await world.connect();
      await world.saveGcCredentials();
      return created;
    },

    async createSync(syncOptions: SyncOptions) {
      if (!connection) throw new Error("call world.setup() first");
      const input = createSyncSchema.parse({
        name: syncOptions.name ?? "Customer help center",
        connectionId: connection.id,
        audience: syncOptions.audience ?? "csm",
        knowledgeBases: syncOptions.kbs.map((kb) => ({ id: kb.sys_id, title: kb.title })),
        filters: syncOptions.filters,
        filterQuery: syncOptions.filterQuery ?? "",
        linkStyle: syncOptions.linkStyle ?? "csp",
        linkCustom: syncOptions.linkCustom ?? "",
        schedule: syncOptions.schedule ?? { kind: "interval", minutes: 60 },
        enabled: syncOptions.enabled ?? true,
        source: syncOptions.source ?? { mode: "new", name: "ServiceNow - Customer KB" },
        runNow: syncOptions.runNow ?? true,
      });
      return createSync(actor, input);
    },

    /** Executes pending workflow runs to completion. */
    async runWorkflows() {
      return harness.runAll();
    },

    async sync(id: string) {
      const row = await getSyncById(id);
      if (!row) throw new Error(`sync ${id} not found`);
      return row;
    },

    async run(id: string): Promise<RunRow> {
      const row = await getRunById(id);
      if (!row) throw new Error(`run ${id} not found`);
      return row;
    },

    async runsOf(syncId: string): Promise<RunRow[]> {
      const database = await db();
      const rows = await database.query("SELECT id FROM sync_runs WHERE sync_id = $1 ORDER BY created_at", [syncId]);
      return Promise.all(rows.map((row) => world.run(String(row.id))));
    },

    async manifest(syncId: string) {
      const database = await db();
      return database.query<{ article_id: string; file_name: string; state: string; error_code: string | null; content_hash: string | null; sn_updated_at: string | null }>(
        "SELECT article_id, file_name, state, error_code, content_hash, sn_updated_at FROM sync_items WHERE sync_id = $1 ORDER BY file_name",
        [syncId],
      );
    },

    /** Moves the sync's next run into the past so the scheduler picks it up. */
    async makeDue(syncId: string) {
      const database = await db();
      await database.query("UPDATE syncs SET next_run_at = now() - interval '1 minute' WHERE id = $1", [syncId]);
    },

    dispose() {
      network.restore();
      configureHostResolver(null);
      configureRetryTiming(null);
      configureEngineTiming(null);
    },
  };
  return world;
}
