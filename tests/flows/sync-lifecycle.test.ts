import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listKnowledgeBases } from "@/server/servicenow/knowledge";
import { requireConnection, resolveConnection } from "@/server/services/connections";
import { runSyncNow, updateSync } from "@/server/services/syncs";
import { useTestDatabase } from "../helpers/db";
import { harness } from "../helpers/workflow-harness";
import { createWorld, type World } from "../helpers/world";

const database = useTestDatabase();
let world: World;

beforeEach(async () => {
  world = await createWorld();
});

afterEach(() => world.dispose());

function fileNameOf(article: { number: string; short_description: string }): string {
  return `${article.number}_${article.short_description.replace(/[^A-Za-z0-9]+/g, "-")}.md`;
}

describe("initial sync", () => {
  it("uploads every published, current article as Markdown and commits the round", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "Customer Help", portals: ["csp"] });
    const [first, second] = world.sn.addArticles(kb, 2);
    world.sn.addArticle(kb, { workflow_state: "draft" });
    world.sn.addArticle(kb, { valid_to: "2020-01-01" });
    world.sn.addArticle(kb, { valid_to: "2099-12-31", short_description: "Valid until 2099" });

    const { sync, run, runError } = await world.createSync({ kbs: [kb] });
    expect(runError).toBeNull();
    expect(run?.status).toBe("queued");
    expect(harness.runs).toHaveLength(1);

    await world.runWorkflows();

    const finished = await world.run(run!.id);
    expect(finished).toMatchObject({ status: "succeeded", phase: "done", uploaded: 3, failed: 0, skipped: 0, totalArticles: 3, gcStatus: "Completed" });
    expect(finished.workflowRunId).toBe(harness.runs[0]!.runId);

    const source = world.gc.sources.get(sync.source.id)!;
    expect(source.name).toBe("ServiceNow - Customer KB");
    expect([...source.files.keys()].sort()).toEqual([fileNameOf(first!), fileNameOf(second!), expect.stringMatching(/_Valid-until-2099\.md$/)].sort());

    const file = source.files.get(fileNameOf(first!))!;
    expect(file.contentType).toBe("text/markdown");
    expect(file.text).toContain(`# ${first!.short_description}`);
    expect(file.text).toContain("**Knowledge base:** Customer Help");
    expect(file.text).toContain("**Audience:** Customers (Customer Service Management)");
    expect(file.text).toContain(`Source: [${first!.number}](https://acme.service-now.com/csp?id=kb_article_view&sysparm_article=${first!.number})`);
    expect(file.metadata.originUri).toBe(`https://acme.service-now.com/csp?id=kb_article_view&sysparm_article=${first!.number}`);
    expect(file.metadata.tags).toEqual(expect.arrayContaining([{ name: "servicenow" }, { name: "csm" }, { name: "customer-help" }, { name: "general" }]));

    const round = world.gc.roundsFor(sync.source.id)[0]!;
    expect(round.type).toBe("Incremental");

    const row = await world.sync(sync.id);
    expect(row).toMatchObject({ health: "healthy", consecutiveFailures: 0, articleCount: 3, statusMessage: null });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.lastSuccessAt).not.toBeNull();
    expect(Date.parse(row.nextRunAt!)).toBeGreaterThan(Date.now());

    const manifest = await world.manifest(sync.id);
    expect(manifest.map((entry) => entry.state)).toEqual(["synced", "synced", "synced"]);
    expect(manifest.every((entry) => entry.content_hash && entry.sn_updated_at)).toBe(true);
  });

  it("can attach to an existing File Upload source and leaves foreign files alone", async () => {
    await world.setup();
    const existing = world.gc.addSource("Existing source");
    existing.files.set("manual-upload.md", { fileName: "manual-upload.md", text: "# Manual", contentType: "text/markdown", md5: "x", metadata: {} });
    const kb = world.sn.addKb({ title: "IT Help" });
    world.sn.addArticles(kb, 3);

    const { sync } = await world.createSync({ kbs: [kb], audience: "itsm", linkStyle: "esc", source: { mode: "existing", id: existing.id } });
    await world.runWorkflows();

    expect(sync.source).toEqual({ id: existing.id, name: "Existing source" });
    expect(existing.files.size).toBe(4);
    expect(existing.files.has("manual-upload.md")).toBe(true);
  });

  it("reads reference fields that arrive as {value} objects", async () => {
    const connection = await world.setup();
    world.sn.referenceStyle = "wrapped";
    const kb = world.sn.addKb({ title: "IT Help", portals: ["esc"] });
    world.sn.addArticles(kb, 2);

    const row = await requireConnection(world.actor, connection.id);
    const [listed] = await listKnowledgeBases(resolveConnection(row));
    expect(listed).toMatchObject({ id: kb.sys_id, articleCount: 2, portals: ["esc"], suggestedAudience: "itsm" });

    const { sync, run } = await world.createSync({ kbs: [kb], audience: "itsm", linkStyle: "esc" });
    await world.runWorkflows();
    expect(await world.run(run!.id)).toMatchObject({ status: "succeeded", uploaded: 2, failed: 0, skipped: 0 });
    const file = [...world.gc.sources.get(sync.source.id)!.files.values()][0]!;
    expect(file.text).toContain("**Knowledge base:** IT Help");
  });

  it("creates the sync without running when runNow is false", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 2);
    const { sync, run } = await world.createSync({ kbs: [kb], runNow: false });
    expect(run).toBeNull();
    expect(harness.runs).toHaveLength(0);
    expect((await world.sync(sync.id)).health).toBe("new");
  });
});

describe("incremental runs", () => {
  async function syncedWorld(articleCount = 3) {
    await world.setup();
    const kb = world.sn.addKb({ title: "Customer Help" });
    const articles = world.sn.addArticles(kb, articleCount);
    const created = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();
    return { kb, articles, sync: created.sync, source: world.gc.sources.get(created.sync.source.id)! };
  }

  it("reports 'up to date' for Sync now without starting a workflow, and records a no-op run", async () => {
    const { sync } = await syncedWorld();
    const startedBefore = harness.runs.length;

    const result = await runSyncNow(world.actor, sync.id, "incremental");

    expect(result.outcome).toBe("up_to_date");
    expect(result.run).toMatchObject({ status: "noop", trigger: "manual", note: "Everything was already up to date." });
    expect(harness.runs.length).toBe(startedBefore);
    expect(world.gc.roundsFor(sync.source.id)).toHaveLength(1);
  });

  it("uploads only the article that changed", async () => {
    const { articles, sync, source } = await syncedWorld();
    const edited = world.sn.updateArticle(articles[1]!.sys_id, { text: "<p>New troubleshooting steps.</p>" });

    const result = await runSyncNow(world.actor, sync.id, "incremental");
    expect(result.outcome).toBe("started");
    await world.runWorkflows();

    const run = await world.run(result.run!.id);
    expect(run).toMatchObject({ status: "succeeded", plannedUploads: 1, uploaded: 1, unchanged: 2, deleted: 0 });
    expect(source.files.get(fileNameOf(edited))!.text).toContain("New troubleshooting steps.");
    expect(world.gc.roundsFor(sync.source.id)).toHaveLength(2);
  });

  it("skips the upload when only the update stamp moved (content hash unchanged)", async () => {
    const { articles, sync } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, {});

    const result = await runSyncNow(world.actor, sync.id, "incremental");
    await world.runWorkflows();

    const run = await world.run(result.run!.id);
    expect(run).toMatchObject({ status: "succeeded", plannedUploads: 1, uploaded: 0, unchanged: 3 });
    expect(world.gc.roundsFor(sync.source.id)).toHaveLength(1);
    const manifest = await world.manifest(sync.id);
    expect(manifest.find((entry) => entry.article_id === articles[0]!.sys_id)!.sn_updated_at).toBe(world.sn.articles.get(articles[0]!.sys_id)!.sys_updated_on);

    expect((await runSyncNow(world.actor, sync.id, "incremental")).outcome).toBe("up_to_date");
  });

  it("deletes files for articles that were retired or unpublished", async () => {
    const { articles, sync, source } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, { workflow_state: "retired" });

    const result = await runSyncNow(world.actor, sync.id, "incremental");
    await world.runWorkflows();

    expect(await world.run(result.run!.id)).toMatchObject({ status: "succeeded", plannedDeletions: 1, deleted: 1, uploaded: 0 });
    expect(source.files.has(fileNameOf(articles[0]!))).toBe(false);
    expect(source.files.size).toBe(2);
    expect((await world.manifest(sync.id)).map((entry) => entry.article_id)).not.toContain(articles[0]!.sys_id);
  });

  it("keeps file names stable when a title changes", async () => {
    const { articles, sync, source } = await syncedWorld();
    const originalName = fileNameOf(articles[0]!);
    world.sn.updateArticle(articles[0]!.sys_id, { short_description: "Completely new title" });

    await runSyncNow(world.actor, sync.id, "incremental");
    await world.runWorkflows();

    expect(source.files.has(originalName)).toBe(true);
    expect(source.files.get(originalName)!.text).toContain("# Completely new title");
    expect(source.files.size).toBe(3);
  });

  it("re-uploads everything once when settings that shape documents change", async () => {
    const { sync, source } = await syncedWorld();
    await updateSync(world.actor, sync.id, {
      name: sync.name,
      connectionId: sync.connection.id,
      audience: "csm",
      knowledgeBases: sync.kbIds.map((id, index) => ({ id, title: sync.kbNames[index]! })),
      filters: sync.filters,
      filterQuery: "",
      linkStyle: "classic",
      linkCustom: "",
      schedule: sync.schedule,
      enabled: true,
    });

    const result = await runSyncNow(world.actor, sync.id, "incremental");
    expect(result.outcome).toBe("started");
    await world.runWorkflows();

    const run = await world.run(result.run!.id);
    expect(run).toMatchObject({ status: "succeeded", uploaded: 3, note: "Settings changed, so every article is refreshed once." });
    for (const file of source.files.values()) expect(file.text).toContain("/kb_view.do?sysparm_article=");
  });

  it("removes articles that fall outside a new filter", async () => {
    const { articles, sync, source } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, { category: "Billing" });
    await updateSync(world.actor, sync.id, {
      name: sync.name,
      connectionId: sync.connection.id,
      audience: "csm",
      knowledgeBases: sync.kbIds.map((id, index) => ({ id, title: sync.kbNames[index]! })),
      filters: sync.filters,
      filterQuery: "kb_category.label=Billing",
      linkStyle: "csp",
      linkCustom: "",
      schedule: sync.schedule,
      enabled: true,
    });

    const result = await runSyncNow(world.actor, sync.id, "incremental");
    await world.runWorkflows();

    expect(await world.run(result.run!.id)).toMatchObject({ status: "succeeded", deleted: 2, uploaded: 1 });
    expect([...source.files.keys()]).toEqual([fileNameOf(articles[0]!)]);
  });

  it("rebuilds the source with a Full synchronization on request", async () => {
    const { articles, sync, source } = await syncedWorld();
    source.files.set("stray-file.md", { fileName: "stray-file.md", text: "stray", contentType: "text/markdown", md5: "x", metadata: {} });
    world.sn.updateArticle(articles[2]!.sys_id, { workflow_state: "retired" });

    const result = await runSyncNow(world.actor, sync.id, "full");
    expect(result.outcome).toBe("started");
    await world.runWorkflows();

    const run = await world.run(result.run!.id);
    expect(run).toMatchObject({ status: "succeeded", mode: "full", uploaded: 2, deleted: 0 });
    expect(world.gc.roundsFor(sync.source.id).at(-1)!.type).toBe("Full");
    expect([...source.files.keys()].sort()).toEqual([fileNameOf(articles[0]!), fileNameOf(articles[1]!)].sort());
    expect(await world.manifest(sync.id)).toHaveLength(2);
  });

  it("handles large knowledge bases across many pages and batches", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "Big KB" });
    world.sn.addArticles(kb, 2_150);
    const { sync, run } = await world.createSync({ kbs: [kb] });

    await world.runWorkflows();

    expect(await world.run(run!.id)).toMatchObject({ status: "succeeded", uploaded: 2_150, totalArticles: 2_150 });
    expect(world.gc.sources.get(sync.source.id)!.files.size).toBe(2_150);
    expect(world.sn.callsTo("/api/now/table/kb_knowledge")).toBeGreaterThanOrEqual(3);
    const rows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM sync_items WHERE sync_id = $1 AND state = 'synced'", [sync.id]);
    expect(rows[0]!.count).toBe(2_150);
  }, 120_000);
});
