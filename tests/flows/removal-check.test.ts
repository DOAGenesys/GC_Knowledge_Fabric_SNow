import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as impactRoute from "@/app/api/syncs/[id]/impact/route";
import * as runRoute from "@/app/api/syncs/[id]/run/route";
import * as syncRoute from "@/app/api/syncs/[id]/route";
import * as syncs from "@/app/api/syncs/route";
import { runTick } from "@/server/sync/scheduler";
import { type SignedInClient, signedInClient } from "../helpers/api";
import { useTestDatabase } from "../helpers/db";
import type { FakeArticle, FakeKb } from "../helpers/fake-servicenow";
import { harness } from "../helpers/workflow-harness";
import { createWorld, type World } from "../helpers/world";

useTestDatabase();
let world: World;
let browser: SignedInClient;
let connectionId: string;
let kb: FakeKb;

beforeEach(async () => {
  world = await createWorld();
  browser = signedInClient({ userId: "user-0001", userName: "Ada Admin", orgId: world.gc.orgId, orgName: "Acme Corp", region: "mypurecloud.de" });
  connectionId = (await world.setup()).id;
  kb = world.sn.addKb({ title: "Customer Help", portals: ["csp"] });
});

afterEach(() => world.dispose());

const choice = (article: FakeArticle) => ({ number: article.number, title: article.short_description, kbId: article.kb });
const label = (article: FakeArticle) => ({ number: article.number, title: article.short_description });

function syncBody(filters: unknown, filterQuery = "") {
  return {
    name: "Hand-picked articles",
    connectionId,
    audience: "csm",
    knowledgeBases: [{ id: kb.sys_id, title: kb.title }],
    filters,
    filterQuery,
    linkStyle: "csp",
    schedule: { kind: "interval", minutes: 60 },
    source: { mode: "new", name: "ServiceNow - Hand-picked" },
  };
}

async function syncedWith(articles: FakeArticle[]): Promise<{ syncId: string; files: () => number }> {
  const response = await browser.call(syncs.POST, "/api/syncs", { method: "POST", body: syncBody({ articles: articles.map(choice) }) });
  expect(response.status).toBe(201);
  await world.runWorkflows();
  const source = world.gc.sources.get(response.body.sync.source.id)!;
  return { syncId: response.body.sync.id, files: () => source.files.size };
}

function impactOf(syncId: string, body: unknown) {
  return browser.call(impactRoute.POST, `/api/syncs/${syncId}/impact`, { method: "POST", params: { id: syncId }, body });
}

function syncNow(syncId: string, body: unknown) {
  return browser.call(runRoute.POST, `/api/syncs/${syncId}/run`, { method: "POST", params: { id: syncId }, body });
}

describe("checking which articles a change would remove", () => {
  it("warns when a new list replaces the old one, and not when it adds to it", async () => {
    const all = world.sn.addArticles(kb, 4);
    const { syncId } = await syncedWith(all.slice(0, 2));

    let response = await impactOf(syncId, { filters: { categories: [], languages: [], articles: all.slice(2).map(choice) } });
    expect(response.status).toBe(200);
    expect(response.body.impact).toEqual({ removals: 2, sample: all.slice(0, 2).map(label), additions: 2, keep: all.slice(0, 2).map(choice) });

    response = await impactOf(syncId, { filters: { categories: [], languages: [], articles: all.map(choice) } });
    expect(response.body.impact).toEqual({ removals: 0, sample: [], additions: 2 });
  });

  it("offers to keep only the removed articles that can still be synced", async () => {
    const [first, retired, third, fourth] = world.sn.addArticles(kb, 4);
    const { syncId } = await syncedWith([first!, retired!, third!]);
    world.sn.updateArticle(retired!.sys_id, { workflow_state: "retired" });
    const picked = (articles: FakeArticle[]) => ({ categories: [], languages: [], articles: articles.map(choice) });

    let response = await impactOf(syncId, { filters: picked([fourth!]) });
    expect(response.body.impact).toMatchObject({ removals: 3, additions: 1, keep: [choice(first!), choice(third!)] });

    response = await impactOf(syncId, { filters: picked([fourth!, first!, third!]) });
    expect(response.body.impact).toEqual({ removals: 1, sample: [label(retired!)], additions: 1, keep: [] });

    response = await impactOf(syncId, { filters: picked([first!, third!]), filterQuery: `number=${third!.number}` });
    expect(response.body.impact).toMatchObject({ removals: 2, keep: [] });
  });

  it("checks a new ServiceNow condition and shows the first five of many removals in order", async () => {
    const vpn = world.sn.addArticle(kb, { short_description: "VPN setup" });
    const others = world.sn.addArticles(kb, 7);
    const response = await browser.call(syncs.POST, "/api/syncs", { method: "POST", body: { ...syncBody({ categories: [], languages: [], articles: null }), source: { mode: "new", name: "All" } } });
    const syncId: string = response.body.sync.id;
    await world.runWorkflows();

    const checked = await impactOf(syncId, { filterQuery: "short_descriptionLIKEvpn" });

    expect(checked.body.impact.removals).toBe(7);
    expect(checked.body.impact.sample).toEqual(others.slice(0, 5).map(label));
    expect(checked.body.impact.additions).toBe(0);
    expect(checked.body.impact.sample).not.toContainEqual(label(vpn));
  });

  it("uses the saved settings when none are given, and counts what a full re-upload would drop", async () => {
    const all = world.sn.addArticles(kb, 3);
    const { syncId } = await syncedWith(all);
    world.sn.updateArticle(all[1]!.sys_id, { workflow_state: "retired" });

    expect((await impactOf(syncId, {})).body.impact).toEqual({ removals: 1, sample: [label(all[1]!)], additions: 0, keep: [] });
    expect((await impactOf(syncId, { mode: "full" })).body.impact).toEqual({ removals: 1, sample: [label(all[1]!)], additions: 0, keep: [] });
  });

  it("matches the safety stop: a normal run that finds no articles removes nothing, a full re-upload would", async () => {
    const all = world.sn.addArticles(kb, 2);
    const { syncId } = await syncedWith(all);
    for (const article of all) world.sn.updateArticle(article.sys_id, { workflow_state: "retired" });

    expect((await impactOf(syncId, {})).body.impact).toEqual({ removals: 0, sample: [], additions: 0 });
    expect((await impactOf(syncId, { mode: "full" })).body.impact.removals).toBe(2);
    expect((await impactOf(syncId, { filters: { categories: [], languages: [], articles: [] } })).body.impact.removals).toBe(0);
  });

  it("validates the settings it checks", async () => {
    const { syncId } = await syncedWith(world.sn.addArticles(kb, 1));

    let response = await impactOf(syncId, { filterQuery: "short_descriptionLIKEvpn^NQactive=true" });
    expect(response.status).toBe(400);
    expect(response.body.error.fields[0].path).toBe("filterQuery");

    response = await impactOf(syncId, { knowledgeBases: [] });
    expect(response.body.error.fields).toEqual([{ path: "knowledgeBases", message: "Pick at least one knowledge base" }]);

    response = await impactOf(syncId, { connectionId: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b" });
    expect(response.status).toBe(404);
  });
});

describe("Sync now", () => {
  it("asks before a run that removes articles, then runs once that's allowed", async () => {
    const all = world.sn.addArticles(kb, 4);
    const { syncId, files } = await syncedWith(all.slice(0, 2));
    await browser.call(syncRoute.PUT, `/api/syncs/${syncId}`, { method: "PUT", params: { id: syncId }, body: syncBody({ articles: all.slice(2).map(choice) }) });
    const startedBefore = harness.runs.length;

    let response = await syncNow(syncId, {});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ outcome: "confirm_removals", run: null, impact: { removals: 2, sample: all.slice(0, 2).map(label), additions: 2 } });
    expect(harness.runs.length).toBe(startedBefore);
    expect(files()).toBe(2);

    response = await syncNow(syncId, { allowRemovals: true });
    expect(response.body.outcome).toBe("started");
    await world.runWorkflows();
    expect(await world.run(response.body.run.id)).toMatchObject({ status: "succeeded", uploaded: 2, deleted: 2 });
    expect(files()).toBe(2);
  });

  it("starts straight away when nothing would be removed", async () => {
    const all = world.sn.addArticles(kb, 3);
    const { syncId } = await syncedWith(all.slice(0, 2));
    await browser.call(syncRoute.PUT, `/api/syncs/${syncId}`, { method: "PUT", params: { id: syncId }, body: syncBody({ articles: all.map(choice) }) });

    const response = await syncNow(syncId, {});

    expect(response.body.outcome).toBe("started");
  });

  it("doesn't ask before a full re-upload, or on a schedule", async () => {
    const all = world.sn.addArticles(kb, 3);
    const { syncId, files } = await syncedWith(all);
    world.sn.updateArticle(all[0]!.sys_id, { workflow_state: "retired" });

    expect((await syncNow(syncId, { mode: "full" })).body.outcome).toBe("started");
    await world.runWorkflows();
    expect(files()).toBe(2);

    world.sn.updateArticle(all[1]!.sys_id, { workflow_state: "retired" });
    await world.makeDue(syncId);
    expect(await runTick()).toMatchObject({ started: 1 });
    await world.runWorkflows();
    expect(files()).toBe(1);
  });
});
