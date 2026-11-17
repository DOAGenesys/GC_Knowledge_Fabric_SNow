import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { requestRunCancel } from "@/server/repo/runs";
import { getGcCredentialsStatus } from "@/server/services/genesys";
import { cancelSyncRun, runSyncNow } from "@/server/services/syncs";
import { commitRound, pollRound, prepareRun, processBatch } from "@/server/sync/engine";
import { useTestDatabase } from "../helpers/db";
import { capturedLogs } from "../helpers/logs";
import { harness } from "../helpers/workflow-harness";
import { createWorld, GC_CLIENT, type World } from "../helpers/world";

const database = useTestDatabase();
let world: World;

beforeEach(async () => {
  world = await createWorld();
});

afterEach(() => world.dispose());

async function syncedWorld(articleCount = 3) {
  await world.setup();
  const kb = world.sn.addKb({ title: "Customer Help" });
  const articles = world.sn.addArticles(kb, articleCount);
  const created = await world.createSync({ kbs: [kb] });
  await world.runWorkflows();
  return { kb, articles, sync: created.sync, source: world.gc.sources.get(created.sync.source.id)! };
}

async function syncNow(syncId: string, mode: "incremental" | "full" = "incremental") {
  const result = await runSyncNow(world.actor, syncId, mode);
  await world.runWorkflows();
  return world.run(result.run!.id);
}

describe("item-level failures", () => {
  it("finishes as partial, keeps the good uploads and retries the failed article next time", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "Customer Help" });
    const articles = world.sn.addArticles(kb, 4);
    world.gc.rejectUploads.set(articles[2]!.number, { status: 400, message: "Document could not be accepted" });

    const { sync, run } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();

    const finished = await world.run(run!.id);
    expect(finished).toMatchObject({ status: "partial", uploaded: 3, failed: 1 });
    const source = world.gc.sources.get(sync.source.id)!;
    expect(source.files.size).toBe(3);

    let row = await world.sync(sync.id);
    expect(row).toMatchObject({ health: "warning", consecutiveFailures: 1, statusMessage: "1 article couldn't be synced. They'll be retried automatically." });
    const failed = (await world.manifest(sync.id)).find((entry) => entry.article_id === articles[2]!.sys_id)!;
    expect(failed).toMatchObject({ state: "error", error_code: "GC_REQUEST_REJECTED" });

    world.gc.rejectUploads.clear();
    const retry = await syncNow(sync.id);
    expect(retry).toMatchObject({ status: "succeeded", plannedUploads: 1, uploaded: 1 });
    expect(source.files.size).toBe(4);
    row = await world.sync(sync.id);
    expect(row).toMatchObject({ health: "healthy", consecutiveFailures: 0, statusMessage: null });
  });

  it("skips empty articles without failing the run and doesn't retry them forever", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "Customer Help" });
    world.sn.addArticle(kb);
    const empty = world.sn.addArticle(kb, { text: "", rendered: "" });

    const { sync, run } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();

    expect(await world.run(run!.id)).toMatchObject({ status: "succeeded", uploaded: 1, skipped: 1 });
    expect((await world.manifest(sync.id)).find((entry) => entry.article_id === empty.sys_id)).toMatchObject({ state: "skipped", error_code: "EMPTY" });
    expect((await runSyncNow(world.actor, sync.id, "incremental")).outcome).toBe("up_to_date");
  });

  it("renders template articles through the Knowledge Management API", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "Customer Help" });
    const templated = world.sn.addArticle(kb, { text: "", rendered: "<h2>Steps</h2><ol><li>Open settings</li></ol>" });

    const { sync } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();

    const file = [...world.gc.sources.get(sync.source.id)!.files.values()][0]!;
    expect(file.fileName.startsWith(templated.number)).toBe(true);
    expect(file.text).toContain("## Steps");
    expect(file.text).toContain("1. Open settings");
  });

  it("falls back to the wiki text when the Knowledge Management API isn't available", async () => {
    await world.setup();
    world.sn.kmApiEnabled = false;
    const kb = world.sn.addKb({ title: "Customer Help" });
    world.sn.addArticle(kb, { article_type: "wiki", text: "", wiki: "Restart the router.\n\nThen wait two minutes." });

    const { sync } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();

    const file = [...world.gc.sources.get(sync.source.id)!.files.values()][0]!;
    expect(file.text).toContain("Restart the router.\n\nThen wait two minutes.");
  });

  it("rides out Genesys Cloud rate limiting transparently", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "Customer Help" });
    world.sn.addArticles(kb, 2);
    world.gc.fail(/\/uploads$/, 429, { times: 2 });

    const { run } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();

    expect(await world.run(run!.id)).toMatchObject({ status: "succeeded", uploaded: 2 });
    expect(capturedLogs.withMessage("Retrying gc.uploadTicket after HTTP 429").length).toBe(1);
  });
});

describe("run-level failures", () => {
  it("stops on rejected Genesys Cloud credentials, flags them and backs off", async () => {
    const { articles, sync } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>changed</p>" });
    world.gc.clients.get(GC_CLIENT.id)!.secret = "rotated-elsewhere";
    world.gc.revokeTokens();

    const run = await syncNow(sync.id);

    expect(run).toMatchObject({ status: "failed", errorCode: "GC_AUTH_FAILED", uploaded: 0, skipped: 1 });
    const row = await world.sync(sync.id);
    expect(row).toMatchObject({ health: "error", consecutiveFailures: 1, statusMessage: "Genesys Cloud didn't accept the OAuth client credentials." });
    expect(row.fingerprint).toBeNull();
    const retryInMinutes = (Date.parse(row.nextRunAt!) - Date.now()) / 60_000;
    expect(retryInMinutes).toBeGreaterThan(14);
    expect(retryInMinutes).toBeLessThanOrEqual(15);
    expect((await getGcCredentialsStatus(world.actor.orgId)).status).toBe("error");
    expect(capturedLogs.withMessage("Run failed")).toHaveLength(1);
  });

  it("refuses to empty the source when ServiceNow suddenly returns no articles", async () => {
    const { articles, sync, source } = await syncedWorld();
    for (const article of articles) world.sn.updateArticle(article.sys_id, { workflow_state: "retired" });

    const run = await syncNow(sync.id);

    expect(run).toMatchObject({ status: "failed", errorCode: "SN_NO_ARTICLES", deleted: 0 });
    expect(source.files.size).toBe(3);
    expect((await world.manifest(sync.id)).map((entry) => entry.state)).toEqual(["synced", "synced", "synced"]);
    expect(await world.sync(sync.id)).toMatchObject({ health: "error", articleCount: 3 });

    for (const article of articles) world.sn.updateArticle(article.sys_id, { workflow_state: "published" });
    expect(await syncNow(sync.id)).toMatchObject({ status: "succeeded", deleted: 0 });
    expect(source.files.size).toBe(3);
  });

  it("still lets a full rebuild run when ServiceNow returns no articles, without touching the source", async () => {
    const { articles, sync, source } = await syncedWorld();
    for (const article of articles) world.sn.updateArticle(article.sys_id, { workflow_state: "retired" });

    const run = await syncNow(sync.id, "full");

    expect(run.errorCode).toBeNull();
    expect(source.files.size).toBe(3);
  });

  it("names the missing permission and cancels the open round", async () => {
    const { articles, sync } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>changed</p>" });
    world.gc.clients.get(GC_CLIENT.id)!.permissions.delete("knowledge:synchronization:upload");

    const run = await syncNow(sync.id);

    expect(run).toMatchObject({ status: "failed", errorCode: "GC_PERMISSION_DENIED", gcStatus: "Cancelled" });
    expect(run.errorMessage).toBe("The Genesys Cloud OAuth client is missing permission: knowledge:synchronization:upload.");
    expect(world.gc.roundsFor(sync.source.id).at(-1)!.status).toBe("Cancelled");
  });

  it("leaves the source untouched when a full rebuild can't upload every article", async () => {
    const { articles, sync, source } = await syncedWorld();
    const before = new Map(source.files);
    world.gc.rejectUploads.set(articles[1]!.number, { status: 400, message: "Rejected" });

    const run = await syncNow(sync.id, "full");

    expect(run).toMatchObject({ status: "failed", mode: "full", errorCode: "GC_SYNC_FAILED", failed: 1 });
    expect(run.errorMessage).toMatch(/full rebuild was stopped because 1 article couldn't be uploaded/);
    expect(world.gc.roundsFor(sync.source.id).at(-1)!.status).toBe("Cancelled");
    expect(source.files).toEqual(before);
    expect(await world.manifest(sync.id)).toHaveLength(3);
  });

  it("fails when Genesys Cloud can't process the files, and tries again on the next check", async () => {
    const { articles, sync } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>changed</p>" });
    world.gc.completion = { status: "Completed", ingestion: "Failed", polls: 0, failedItems: 0 };

    const run = await syncNow(sync.id);

    expect(run).toMatchObject({ status: "failed", errorCode: "GC_INGESTION_FAILED", gcIngestion: "Failed" });
    expect((await world.sync(sync.id)).health).toBe("error");

    world.gc.completion = { status: "Completed", ingestion: "Complete", polls: 0, failedItems: 0 };
    const next = await runSyncNow(world.actor, sync.id, "incremental");
    expect(next.outcome).toBe("started");
    await world.runWorkflows();
    expect(await world.run(next.run!.id)).toMatchObject({ status: "succeeded", uploaded: 1 });
  });

  it("reports files Genesys Cloud couldn't process as a partial success", async () => {
    const { articles, sync } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>changed</p>" });
    world.gc.completion = { status: "Completed", ingestion: "Complete", polls: 2, failedItems: 1 };

    const run = await syncNow(sync.id);

    expect(run).toMatchObject({ status: "partial", gcFailed: 1, note: "Genesys Cloud couldn't process 1 file." });
    expect((await world.sync(sync.id)).health).toBe("warning");
    expect(harness.sleeps.length).toBeGreaterThanOrEqual(3);
  });

  it("gives up waiting after the polling budget and records an unknown outcome", async () => {
    const { articles, sync } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>changed</p>" });
    world.gc.completion = { status: "Completed", ingestion: "Complete", polls: 10_000, failedItems: 0 };

    const run = await syncNow(sync.id);

    expect(run).toMatchObject({ status: "failed", errorCode: "GC_OUTCOME_UNKNOWN", gcStatus: "PostProcessing" });
    const totalSeconds = harness.sleeps.reduce((sum, value) => sum + Number.parseInt(value, 10), 0);
    expect(totalSeconds).toBeGreaterThanOrEqual(45 * 60);
    expect(totalSeconds).toBeLessThan(47 * 60);
  });

  it("recovers from a round left open by an earlier, crashed run", async () => {
    const { articles, sync } = await syncedWorld();
    const firstRun = (await world.runsOf(sync.id))[0]!;
    const orphan = world.gc.openRound(sync.source.id);
    await database.query("UPDATE sync_runs SET gc_sync_id = $2 WHERE id = $1", [firstRun.id, orphan.id]);
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>changed</p>" });

    const run = await syncNow(sync.id);

    expect(run).toMatchObject({ status: "succeeded", uploaded: 1 });
    expect(orphan.status).toBe("Cancelled");
    expect(capturedLogs.withMessage("Cancelled leftover Genesys Cloud synchronizations")).toHaveLength(1);
  });

  it("doesn't touch a round another tool opened, and retries later", async () => {
    const { articles, sync } = await syncedWorld();
    const foreign = world.gc.openRound(sync.source.id);
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>changed</p>" });

    const run = await syncNow(sync.id);

    expect(run).toMatchObject({ status: "failed", errorCode: "GC_SOURCE_BUSY" });
    expect(foreign.status).toBe("InProgress");
    expect((await world.sync(sync.id)).statusMessage).toBe("Another synchronization is still running on this knowledge source.");
  });

  it("adopts the round when the start request's response is lost", async () => {
    const { articles, sync } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>changed</p>" });
    world.gc.fail(/\/synchronizations$/, 0, { method: "POST", afterHandling: true });

    const run = await syncNow(sync.id);

    expect(run).toMatchObject({ status: "succeeded", uploaded: 1 });
    expect(world.gc.roundsFor(sync.source.id)).toHaveLength(2);
    expect(capturedLogs.withMessage("Adopted synchronization after an ambiguous start")).toHaveLength(1);
  });

  it("waits for a queued round before uploading", async () => {
    await world.setup();
    world.gc.queuedPolls = 2;
    const kb = world.sn.addKb({ title: "Customer Help" });
    world.sn.addArticles(kb, 2);

    const { run } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();

    expect(await world.run(run!.id)).toMatchObject({ status: "succeeded", uploaded: 2 });
  });

  it("re-sends the completion when Genesys Cloud doesn't act on it", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "Customer Help" });
    world.sn.addArticles(kb, 2);
    world.gc.ignoreCompletions = 1;
    const { run } = await world.createSync({ kbs: [kb] });

    expect(await prepareRun(run!.id)).toMatchObject({ action: "continue", uploads: 2 });
    expect(await processBatch(run!.id)).toMatchObject({ done: true, processed: 2 });
    expect(await commitRound(run!.id)).toEqual({ action: "poll" });
    expect(await pollRound(run!.id)).toMatchObject({ terminal: false, status: "InProgress" });

    const later = await pollRound(run!.id, new Date(Date.now() + 2 * 60_000));
    expect(later.status).toBe("InProgress");
    expect(await pollRound(run!.id)).toMatchObject({ terminal: true, status: "Completed", ingestion: "Complete" });
    expect(capturedLogs.withMessage("Re-sent synchronization completion")).toHaveLength(1);
  });
});

describe("ServiceNow problems", () => {
  it("keeps what was uploaded when ServiceNow fails part-way through, and retries the rest", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "Customer Help" });
    const articles = world.sn.addArticles(kb, 60);
    const poison = articles[30]!.sys_id;
    world.sn.fail(/\/api\/now\/table\/kb_knowledge$/, { status: 503 }, 4, (url) => (url.searchParams.get("sysparm_query") ?? "").includes(poison));

    const { sync, run } = await world.createSync({ kbs: [kb] });
    await world.runWorkflows();

    const finished = await world.run(run!.id);
    expect(finished).toMatchObject({ status: "partial", uploaded: 25, failed: 35, gcStatus: "Completed" });
    expect(finished.note).toBe("ServiceNow stopped responding part-way through, so 35 articles will be retried on the next run.");
    expect(world.gc.sources.get(sync.source.id)!.files.size).toBe(25);

    const retry = await syncNow(sync.id);
    expect(retry).toMatchObject({ status: "succeeded", uploaded: 35 });
    expect(world.gc.sources.get(sync.source.id)!.files.size).toBe(60);
    expect((await world.sync(sync.id)).health).toBe("healthy");
  });

  it("records a failed check when ServiceNow rejects the credentials", async () => {
    const { sync } = await syncedWorld();
    if (world.sn.auth.type === "basic") world.sn.auth.password = "changed-by-admin";

    await expect(runSyncNow(world.actor, sync.id, "incremental")).rejects.toMatchObject({ code: "SN_AUTH_FAILED" });

    const runs = await world.runsOf(sync.id);
    expect(runs.at(-1)).toMatchObject({ status: "failed", trigger: "manual", errorCode: "SN_AUTH_FAILED" });
    expect(await world.sync(sync.id)).toMatchObject({ health: "error", consecutiveFailures: 1 });
  });

  it("explains a hibernating developer instance", async () => {
    const { sync } = await syncedWorld();
    world.sn.hibernating = true;

    const error = await runSyncNow(world.actor, sync.id, "incremental").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("SN_HIBERNATING");
    expect((error as AppError).hint).toMatch(/developer\.servicenow\.com/);
  });
});

describe("cancellation and concurrency", () => {
  it("cancels a run that hasn't started yet immediately", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 2);
    const { sync, run } = await world.createSync({ kbs: [kb] });

    const cancelled = await cancelSyncRun(world.actor, sync.id, run!.id);

    expect(cancelled).toMatchObject({ status: "cancelled", error: { code: "RUN_CANCELLED" } });
    expect(harness.runs[0]!.status).toBe("cancelled");
    await world.runWorkflows();
    expect(world.gc.roundsFor(sync.source.id)).toHaveLength(0);
    expect((await world.sync(sync.id)).statusMessage).toBe("The last run was cancelled.");
  });

  it("stops a running run between batches and discards its round", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 60);
    const { sync, run } = await world.createSync({ kbs: [kb] });

    await prepareRun(run!.id);
    await processBatch(run!.id);
    await requestRunCancel(run!.id);
    await world.runWorkflows();

    const finished = await world.run(run!.id);
    expect(finished).toMatchObject({ status: "cancelled", uploaded: 25, skipped: 35, gcStatus: "Cancelled" });
    expect(world.gc.sources.get(sync.source.id)!.files.size).toBe(0);
    expect(await world.manifest(sync.id)).toHaveLength(0);
  });

  it("refuses to cancel once Genesys Cloud is processing", async () => {
    await world.setup();
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 2);
    world.gc.completion = { status: "Completed", ingestion: "Complete", polls: 5, failedItems: 0 };
    const { sync, run } = await world.createSync({ kbs: [kb] });
    await prepareRun(run!.id);
    await processBatch(run!.id);
    await commitRound(run!.id);

    await expect(cancelSyncRun(world.actor, sync.id, run!.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("never runs the same sync twice at once", async () => {
    const { articles, sync } = await syncedWorld();
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>changed</p>" });

    const [first, second] = await Promise.all([runSyncNow(world.actor, sync.id, "full"), runSyncNow(world.actor, sync.id, "full")]);

    expect([first.outcome, second.outcome].sort()).toEqual(["already_running", "started"]);
    expect(first.run!.id).toBe(second.run!.id);
  });

  it("closes the run cleanly when the workflow can't be started", async () => {
    const { sync } = await syncedWorld();
    harness.startError = new Error("workflow backend unavailable");

    await expect(runSyncNow(world.actor, sync.id, "full")).rejects.toMatchObject({ code: "WORKFLOW_START_FAILED" });

    const last = (await world.runsOf(sync.id)).at(-1)!;
    expect(last).toMatchObject({ status: "failed", errorCode: "WORKFLOW_START_FAILED" });
    expect((await world.sync(sync.id)).health).toBe("error");
    expect(capturedLogs.withMessage("Couldn't start the sync workflow")).toHaveLength(1);
  });
});
