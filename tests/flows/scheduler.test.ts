import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RUN_MINUTES, runTick, runWatchdog, STALE_RUN_MINUTES } from "@/server/sync/scheduler";
import { useTestDatabase } from "../helpers/db";
import { capturedLogs } from "../helpers/logs";
import { harness } from "../helpers/workflow-harness";
import { createWorld, type World } from "../helpers/world";

const database = useTestDatabase();
let world: World;

beforeEach(async () => {
  world = await createWorld();
  await world.setup();
});

afterEach(() => world.dispose());

const minutesUntil = (iso: string | null) => (iso ? (Date.parse(iso) - Date.now()) / 60_000 : null);

async function syncedSync(name = "Customer help center") {
  const kb = world.sn.addKb({ title: `${name} KB` });
  const articles = world.sn.addArticles(kb, 2);
  const { sync } = await world.createSync({ kbs: [kb], name });
  await world.runWorkflows();
  return { kb, articles, sync };
}

async function ageRun(runId: string, fields: { heartbeatMinutes?: number; createdMinutes?: number; workflowRunId?: string | null }) {
  if (fields.heartbeatMinutes !== undefined) {
    await database.query("UPDATE sync_runs SET heartbeat_at = now() - make_interval(mins => $2) WHERE id = $1", [runId, fields.heartbeatMinutes]);
  }
  if (fields.createdMinutes !== undefined) {
    await database.query("UPDATE sync_runs SET created_at = now() - make_interval(mins => $2) WHERE id = $1", [runId, fields.createdMinutes]);
  }
  if (fields.workflowRunId !== undefined) {
    await database.query("UPDATE sync_runs SET workflow_run_id = $2 WHERE id = $1", [runId, fields.workflowRunId]);
  }
}

describe("scheduler tick", () => {
  it("checks only enabled syncs that are due", async () => {
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 2);
    const due = (await world.createSync({ kbs: [kb], name: "Due", runNow: false })).sync;
    const later = (await world.createSync({ kbs: [kb], name: "Later", runNow: false })).sync;
    const paused = (await world.createSync({ kbs: [kb], name: "Paused", runNow: false, enabled: false })).sync;
    await world.makeDue(due.id);
    await world.makeDue(paused.id);

    const summary = await runTick();

    expect(summary).toMatchObject({ checked: 1, started: 1, upToDate: 0, failed: 0, recovered: 0 });
    await world.runWorkflows();
    expect((await world.runsOf(due.id)).map((run) => [run.trigger, run.status])).toEqual([["schedule", "succeeded"]]);
    expect(await world.runsOf(later.id)).toHaveLength(0);
    expect(await world.runsOf(paused.id)).toHaveLength(0);
    expect(capturedLogs.withMessage("Scheduler tick")).toHaveLength(1);
  });

  it("costs a single ServiceNow call when nothing changed and records no run", async () => {
    const { sync } = await syncedSync();
    await world.makeDue(sync.id);
    const listCalls = world.sn.callsTo(/\/api\/now\/table\/kb_knowledge$/);
    const gcCalls = world.gc.callsTo("POST", /./);

    const summary = await runTick();

    expect(summary).toMatchObject({ checked: 1, upToDate: 1, started: 0 });
    expect(world.sn.callsTo(/\/api\/now\/table\/kb_knowledge$/)).toBe(listCalls + 1);
    expect(world.gc.callsTo("POST", /./)).toBe(gcCalls);
    expect(await world.runsOf(sync.id)).toHaveLength(1);
    const row = await world.sync(sync.id);
    expect(minutesUntil(row.nextRunAt)).toBeGreaterThan(59);
    expect(row.lastCheckedAt).not.toBeNull();
  });

  it("starts a run for a due sync with changes", async () => {
    const { articles, sync } = await syncedSync();
    world.sn.updateArticle(articles[1]!.sys_id, { text: "<p>Updated</p>" });
    await world.makeDue(sync.id);

    expect(await runTick()).toMatchObject({ started: 1 });
    await world.runWorkflows();

    const runs = await world.runsOf(sync.id);
    expect(runs.at(-1)).toMatchObject({ trigger: "schedule", status: "succeeded", uploaded: 1 });
  });

  it("never starts the same sync twice when ticks overlap", async () => {
    const { articles, sync } = await syncedSync();
    world.sn.updateArticle(articles[0]!.sys_id, { text: "<p>Updated</p>" });
    await world.makeDue(sync.id);

    const [first, second] = await Promise.all([runTick(), runTick()]);

    expect(first.started + second.started).toBe(1);
    expect(first.checked + second.checked).toBe(1);
    expect(harness.pending()).toHaveLength(1);
  });

  it("skips syncs with an active run", async () => {
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 2);
    const { sync } = await world.createSync({ kbs: [kb] });
    await world.makeDue(sync.id);

    expect(await runTick()).toMatchObject({ checked: 0 });
  });

  it("backs off while a sync keeps failing and recovers afterwards", async () => {
    const { sync } = await syncedSync();
    const auth = world.sn.auth;
    if (auth.type !== "basic") throw new Error("expected basic auth");
    const original = auth.password;
    auth.password = "changed-by-admin";

    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await world.makeDue(sync.id);
      expect(await runTick()).toMatchObject({ checked: 1, failed: 1 });
      delays.push(Math.round(minutesUntil((await world.sync(sync.id)).nextRunAt)!));
    }
    expect(delays).toEqual([15, 30, 60]);
    expect(await world.sync(sync.id)).toMatchObject({ health: "error", consecutiveFailures: 3 });
    expect(capturedLogs.withMessage("Sync check failed")).toHaveLength(1);

    auth.password = original;
    await world.makeDue(sync.id);
    expect(await runTick()).toMatchObject({ upToDate: 1 });
    const recovered = await world.sync(sync.id);
    expect(minutesUntil(recovered.nextRunAt)).toBeGreaterThan(59);
  });

  it("keeps going through a mixed batch", async () => {
    const healthy = await syncedSync("Healthy");
    const broken = await syncedSync("Broken");
    await database.query(`UPDATE syncs SET kb_ids = '["00000000000000000000000000000000"]'::jsonb WHERE id = $1`, [broken.sync.id]);
    world.sn.fail(/\/api\/now\/table\/kb_knowledge$/, { status: 500 }, 10, (url) => (url.searchParams.get("sysparm_query") ?? "").includes("00000000000000000000000000000000"));
    await world.makeDue(healthy.sync.id);
    await world.makeDue(broken.sync.id);

    const summary = await runTick();

    expect(summary).toMatchObject({ checked: 2, upToDate: 1, failed: 1 });
  });
});

describe("watchdog", () => {
  async function queuedRun() {
    const kb = world.sn.addKb({ title: "KB" });
    world.sn.addArticles(kb, 2);
    const created = await world.createSync({ kbs: [kb] });
    return { sync: created.sync, run: await world.run(created.run!.id) };
  }

  it("leaves healthy runs alone", async () => {
    const { run } = await queuedRun();
    await ageRun(run.id, { heartbeatMinutes: STALE_RUN_MINUTES - 5 });

    expect(await runWatchdog()).toBe(0);
    expect((await world.run(run.id)).status).toBe("queued");
  });

  it("closes a run whose workflow never started", async () => {
    const { sync, run } = await queuedRun();
    await ageRun(run.id, { heartbeatMinutes: STALE_RUN_MINUTES + 5, workflowRunId: null });

    expect(await runWatchdog()).toBe(1);

    expect(await world.run(run.id)).toMatchObject({ status: "failed", errorCode: "WORKFLOW_START_FAILED" });
    expect((await world.sync(sync.id)).health).toBe("error");
    expect(capturedLogs.withMessage("Recovered a stuck run")).toHaveLength(1);
  });

  it("closes a run whose workflow disappeared", async () => {
    const { run } = await queuedRun();
    await ageRun(run.id, { heartbeatMinutes: STALE_RUN_MINUTES + 5, workflowRunId: "wrun_gone" });

    expect(await runWatchdog()).toBe(1);
    expect(await world.run(run.id)).toMatchObject({ status: "failed", errorCode: "WORKFLOW_LOST" });
  });

  it("closes a run whose workflow already ended without finishing it", async () => {
    const { run } = await queuedRun();
    harness.statusOverrides.set(run.workflowRunId!, "failed");
    await ageRun(run.id, { heartbeatMinutes: STALE_RUN_MINUTES + 5 });

    expect(await runWatchdog()).toBe(1);
    expect(await world.run(run.id)).toMatchObject({ status: "failed", errorCode: "WORKFLOW_LOST" });
  });

  it("waits for a slow but alive workflow", async () => {
    const { run } = await queuedRun();
    harness.statusOverrides.set(run.workflowRunId!, "running");
    await ageRun(run.id, { heartbeatMinutes: STALE_RUN_MINUTES + 5, createdMinutes: 60 });

    expect(await runWatchdog()).toBe(0);
    expect((await world.run(run.id)).status).toBe("queued");
  });

  it("cancels a workflow that ran past the maximum run time", async () => {
    const { run } = await queuedRun();
    await ageRun(run.id, { heartbeatMinutes: STALE_RUN_MINUTES + 5, createdMinutes: MAX_RUN_MINUTES + 10 });

    expect(await runWatchdog()).toBe(1);

    expect(await world.run(run.id)).toMatchObject({ status: "failed", errorCode: "WORKFLOW_LOST" });
    expect(harness.runs[0]).toMatchObject({ status: "cancelled", cancelReason: "Exceeded the maximum run time" });
  });

  it("does nothing when the workflow status can't be read", async () => {
    const { run } = await queuedRun();
    harness.statusOverrides.set(run.workflowRunId!, new Error("workflow API unavailable"));
    await ageRun(run.id, { heartbeatMinutes: STALE_RUN_MINUTES + 5 });

    expect(await runWatchdog()).toBe(0);
    expect((await world.run(run.id)).status).toBe("queued");
    expect(capturedLogs.withMessage("Couldn't read workflow status")).toHaveLength(1);
  });

  it("runs as part of every tick", async () => {
    const { run } = await queuedRun();
    await ageRun(run.id, { heartbeatMinutes: STALE_RUN_MINUTES + 5, workflowRunId: null });

    expect(await runTick()).toMatchObject({ recovered: 1 });
  });
});
