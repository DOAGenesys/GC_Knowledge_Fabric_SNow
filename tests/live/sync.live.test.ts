import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KnowledgeBaseDTO } from "@/lib/api-types";
import { errorSpec, isAppError } from "@/lib/errors";
import { normalizeRegion } from "@/lib/regions";
import { db, setDbOverride } from "@/server/db";
import { createClientAuth } from "@/server/genesys/client";
import { getOrganization } from "@/server/genesys/identity";
import { scopedLogger } from "@/server/log";
import { upsertOrg } from "@/server/repo/orgs";
import { getRunById, type RunRow } from "@/server/repo/runs";
import type { SnConnection } from "@/server/servicenow/client";
import { listKnowledgeBases, previewArticles } from "@/server/servicenow/knowledge";
import type { ActorContext } from "@/server/services/actor";
import { type ConnectionInput, createConnection, requireConnection, resolveConnection } from "@/server/services/connections";
import { createSource, listSources, saveGcCredentials } from "@/server/services/genesys";
import { createSync, createSyncSchema, runSyncNow, updateSync, updateSyncSchema } from "@/server/services/syncs";
import { createPgliteDb } from "../helpers/db";
import { harness } from "../helpers/workflow-harness";

/*
 * Opt-in smoke test against a real ServiceNow instance and a Genesys Cloud test org:
 *
 *   op run --env-file=live.env.tpl -- npm run test:live
 *
 * It syncs a few published articles into a dedicated File Upload source (created when missing),
 * then checks the change detection and a removal. Nothing is printed except pass/fail per step.
 */

const env = process.env;

const SN_AUTH_VARS = {
  basic: ["LIVE_SN_USERNAME", "LIVE_SN_PASSWORD"],
  oauth: ["LIVE_SN_CLIENT_ID", "LIVE_SN_CLIENT_SECRET"],
  apikey: ["LIVE_SN_API_KEY"],
} as const;

type SnAuthType = keyof typeof SN_AUTH_VARS;

const authType = (env.LIVE_SN_AUTH_TYPE?.trim() || "basic") as SnAuthType;
const missing = ["LIVE_SN_INSTANCE", "LIVE_GC_REGION", "LIVE_GC_CLIENT_ID", "LIVE_GC_CLIENT_SECRET", ...(SN_AUTH_VARS[authType] ?? [])].filter(
  (name) => !env[name]?.trim(),
);
if (!(authType in SN_AUTH_VARS)) missing.push("LIVE_SN_AUTH_TYPE (basic, oauth or apikey)");

const sourceName = env.LIVE_GC_SOURCE_NAME?.trim() || "Knowledge Sync live test";
const articleLimit = Math.min(Math.max(Math.trunc(Number(env.LIVE_SN_ARTICLES)) || 3, 1), 5);

function snAuth(): ConnectionInput["auth"] {
  if (authType === "oauth") return { type: "oauth", clientId: env.LIVE_SN_CLIENT_ID!, clientSecret: env.LIVE_SN_CLIENT_SECRET! };
  if (authType === "apikey") return { type: "apikey", apiKey: env.LIVE_SN_API_KEY! };
  return { type: "basic", username: env.LIVE_SN_USERNAME!, password: env.LIVE_SN_PASSWORD! };
}

/** Reduces any failure to an error code: messages and error properties could echo instance data. */
async function guarded(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (error instanceof Error && error.name === "AssertionError") throw error;
    const reason = isAppError(error) ? `${error.code} (${errorSpec(error.code).title})` : error instanceof Error ? error.name : "unknown error";
    throw new Error(`Step failed: ${reason}`);
  }
}

function outcomeOf(run: RunRow | null) {
  return { status: run?.status ?? "missing", errorCode: run?.errorCode ?? null };
}

const title = missing.length > 0 ? `live smoke test (skipped, set ${missing.join(", ")})` : "live smoke test";

describe.skipIf(missing.length > 0)(title, () => {
  let pg: PGlite | null = null;
  let actor: ActorContext;
  let sn: SnConnection;
  let connectionId = "";
  let kb: KnowledgeBaseDTO | undefined;
  let numbers: string[] = [];
  let sourceId = "";
  let syncId = "";

  const syncFields = (filterQuery: string) => ({
    name: "Live smoke test",
    connectionId,
    audience: kb!.suggestedAudience ?? "csm",
    knowledgeBases: [{ id: kb!.id, title: kb!.title.slice(0, 200) }],
    filterQuery,
    linkStyle: "classic" as const,
    schedule: { kind: "manual" },
  });

  async function finishedRun(runId: string | undefined): Promise<RunRow | null> {
    await harness.runAll();
    return runId ? getRunById(runId) : null;
  }

  beforeAll(() =>
    guarded(async () => {
      pg = await PGlite.create();
      setDbOverride(createPgliteDb(pg));
      await db();

      const region = normalizeRegion(env.LIVE_GC_REGION);
      if (!region) throw new Error("LIVE_GC_REGION isn't a Genesys Cloud region such as mypurecloud.ie");
      const auth = createClientAuth({ region, clientId: env.LIVE_GC_CLIENT_ID!, clientSecret: env.LIVE_GC_CLIENT_SECRET! });
      const org = await getOrganization(auth);
      await upsertOrg({ id: org.id, name: org.name, region });
      actor = { orgId: org.id, userId: "live-smoke-test", userName: "Live smoke test", log: scopedLogger("live") };
    }),
  );

  afterAll(async () => {
    setDbOverride(null);
    await pg?.close();
  });

  it("connects to ServiceNow and finds a knowledge base", () =>
    guarded(async () => {
      const connection = await createConnection(actor, { name: "Live smoke test", instanceUrl: env.LIVE_SN_INSTANCE!, auth: snAuth() });
      expect(connection.status).toBe("ok");
      connectionId = connection.id;
      sn = resolveConnection(await requireConnection(actor, connectionId));

      const knowledgeBases = await listKnowledgeBases(sn, actor.log);
      const wanted = env.LIVE_SN_KB_ID?.trim();
      kb = wanted
        ? knowledgeBases.find((item) => item.id === wanted)
        : (knowledgeBases.find((item) => (item.articleCount ?? 0) > 0) ?? knowledgeBases[0]);
      expect(Boolean(kb), wanted ? "LIVE_SN_KB_ID isn't readable with these credentials" : "no readable knowledge base").toBe(true);
    }));

  it("previews published articles", () =>
    guarded(async () => {
      const preview = await previewArticles(sn, { kbIds: [kb!.id], filter: "" }, actor.log);
      expect(preview.count, "the knowledge base has no published articles").toBeGreaterThan(0);
      numbers = preview.sample.slice(0, articleLimit).map((item) => item.number);
      expect(numbers.length).toBeGreaterThan(0);
    }));

  it("verifies the Genesys Cloud credentials and picks the test source", () =>
    guarded(async () => {
      const saved = await saveGcCredentials(actor, { clientId: env.LIVE_GC_CLIENT_ID!, clientSecret: env.LIVE_GC_CLIENT_SECRET! });
      expect(saved.status).toBe("ok");
      const existing = (await listSources(actor)).find((source) => source.name === sourceName);
      sourceId = existing?.id ?? (await createSource(actor, sourceName)).id;
      expect(sourceId).not.toBe("");
    }));

  it("uploads the articles with a full rebuild", () =>
    guarded(async () => {
      const created = await createSync(
        actor,
        createSyncSchema.parse({ ...syncFields(`numberIN${numbers.join(",")}`), source: { mode: "existing", id: sourceId }, runNow: false }),
      );
      syncId = created.sync.id;

      const started = await runSyncNow(actor, syncId, "full");
      expect(started.outcome).toBe("started");
      const run = await finishedRun(started.run?.id);
      expect(outcomeOf(run)).toEqual({ status: "succeeded", errorCode: null });
      expect(run!.failed).toBe(0);
      expect(run!.uploaded).toBeGreaterThan(0);
      expect(run!.uploaded + run!.skipped).toBe(numbers.length);
    }));

  it("finds nothing to do right after", () =>
    guarded(async () => {
      const result = await runSyncNow(actor, syncId, "incremental");
      expect(result.outcome).toBe("up_to_date");
    }));

  it("removes an article that leaves the sync's scope", async (context) => {
    if (numbers.length < 2) context.skip();
    await guarded(async () => {
      await updateSync(actor, syncId, updateSyncSchema.parse(syncFields(`numberIN${numbers.slice(1).join(",")}`)));
      const started = await runSyncNow(actor, syncId, "incremental");
      expect(started.outcome).toBe("started");
      const run = await finishedRun(started.run?.id);
      expect(outcomeOf(run)).toEqual({ status: "succeeded", errorCode: null });
      expect(run!.deleted).toBe(1);
    });
  });
});
