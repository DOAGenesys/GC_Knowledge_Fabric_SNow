import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as search from "@/app/api/connections/[id]/articles/route";
import * as lookup from "@/app/api/connections/[id]/articles/lookup/route";
import * as preview from "@/app/api/connections/[id]/preview/route";
import * as syncRoute from "@/app/api/syncs/[id]/route";
import * as syncs from "@/app/api/syncs/route";
import { runSyncNow } from "@/server/services/syncs";
import { type SignedInClient, signedInClient } from "../helpers/api";
import { useTestDatabase } from "../helpers/db";
import type { FakeArticle, FakeKb } from "../helpers/fake-servicenow";
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
const fileNameOf = (article: FakeArticle) => `${article.number}_${article.short_description.replace(/[^A-Za-z0-9]+/g, "-")}.md`;

function syncBody(filters: unknown) {
  return {
    name: "Hand-picked articles",
    connectionId,
    audience: "csm",
    knowledgeBases: [{ id: kb.sys_id, title: kb.title }],
    filters,
    linkStyle: "csp",
    schedule: { kind: "interval", minutes: 60 },
    source: { mode: "new", name: "ServiceNow - Hand-picked" },
  };
}

function previewOf(filters: unknown, filterQuery = "") {
  return browser.call(preview.POST, `/api/connections/${connectionId}/preview`, { method: "POST", params: { id: connectionId }, body: { kbIds: [kb.sys_id], filters, filterQuery } });
}

function searchFor(query: string) {
  return browser.call(search.GET, `/api/connections/${connectionId}/articles?${query}`, { params: { id: connectionId } });
}

function lookUp(body: unknown) {
  return browser.call(lookup.POST, `/api/connections/${connectionId}/articles/lookup`, { method: "POST", params: { id: connectionId }, body });
}

function articleQueriesSince(start: number): string[] {
  return world.sn.calls
    .slice(start)
    .filter((call) => call.path === "/api/now/table/kb_knowledge")
    .map((call) => call.query.get("sysparm_query") ?? "");
}

describe("syncing hand-picked articles", () => {
  it("previews exactly the chosen articles and lists the ones that won't be synced", async () => {
    const [first, second] = world.sn.addArticles(kb, 2);
    world.sn.addArticles(kb, 3);
    const draft = world.sn.addArticle(kb, { workflow_state: "draft" });
    const elsewhere = world.sn.addArticle(world.sn.addKb({ title: "Internal" }));

    const response = await previewOf({ articles: [choice(first!), choice(second!), choice(draft), choice(elsewhere), { number: "KB9999999" }] });

    expect(response.status).toBe(200);
    expect(response.body.preview).toEqual({
      count: 2,
      sample: [second!, first!].map((article) => ({ number: article.number, title: article.short_description, kbName: "Customer Help", updatedAt: article.sys_updated_on })),
      missing: [draft.number, elsewhere.number, "KB9999999"],
    });
  });

  it("splits a long list into short requests, however many articles are chosen", async () => {
    const many = world.sn.addArticles(kb, 250);
    const start = world.sn.calls.length;

    const response = await previewOf({ articles: many.map(choice) });

    expect(response.status).toBe(200);
    expect(response.body.preview).toMatchObject({ count: 250, missing: [] });
    const queries = articleQueriesSince(start);
    expect(queries).toHaveLength(3);
    expect(Math.max(...queries.map((query) => query.length))).toBeLessThan(2_000);
  });

  it("applies the ServiceNow condition on top of the chosen articles", async () => {
    const [vpn, other] = [world.sn.addArticle(kb, { short_description: "VPN setup" }), world.sn.addArticle(kb)];

    const response = await previewOf({ articles: [choice(vpn), choice(other)] }, "short_descriptionLIKEvpn");

    expect(response.body.preview).toMatchObject({ count: 1, missing: [other.number] });
  });

  it("syncs only the chosen articles and adds more later without removing the first ones", async () => {
    const all = world.sn.addArticles(kb, 6);

    let response = await browser.call(syncs.POST, "/api/syncs", { method: "POST", body: syncBody({ articles: all.slice(0, 2).map(choice) }) });
    expect(response.status).toBe(201);
    expect(response.body.sync.filters).toEqual({ categories: [], languages: [], articles: all.slice(0, 2).map(choice) });
    const syncId: string = response.body.sync.id;
    await world.runWorkflows();
    const source = world.gc.sources.get(response.body.sync.source.id)!;
    expect([...source.files.keys()].sort()).toEqual(all.slice(0, 2).map(fileNameOf).sort());

    response = await browser.call(syncRoute.PUT, `/api/syncs/${syncId}`, { method: "PUT", params: { id: syncId }, body: syncBody({ articles: all.slice(0, 4).map(choice) }) });
    expect(response.status).toBe(200);
    const second = await runSyncNow(world.actor, syncId, "incremental");
    await world.runWorkflows();
    expect(await world.run(second.run!.id)).toMatchObject({ status: "succeeded", uploaded: 2, unchanged: 2, deleted: 0 });
    expect([...source.files.keys()].sort()).toEqual(all.slice(0, 4).map(fileNameOf).sort());

    response = await browser.call(syncRoute.PUT, `/api/syncs/${syncId}`, { method: "PUT", params: { id: syncId }, body: syncBody({ articles: all.slice(1, 4).map(choice) }) });
    expect((await runSyncNow(world.actor, syncId, "incremental")).outcome).toBe("confirm_removals");
    const third = await runSyncNow(world.actor, syncId, "incremental", { allowRemovals: true });
    await world.runWorkflows();
    expect(await world.run(third.run!.id)).toMatchObject({ status: "succeeded", uploaded: 0, deleted: 1 });
    expect(source.files.has(fileNameOf(all[0]!))).toBe(false);
    expect(source.files.size).toBe(3);
  });

  it("won't save a sync without chosen articles, or with both kinds of choice", async () => {
    const [article] = world.sn.addArticles(kb, 1);
    const billing = world.sn.addCategory(kb, "Billing");

    let response = await browser.call(syncs.POST, "/api/syncs", { method: "POST", body: syncBody({ articles: [] }) });
    expect(response.status).toBe(400);
    expect(response.body.error.fields).toEqual([{ path: "filters.articles", message: "Choose at least one article, or switch to all published articles." }]);

    response = await browser.call(syncs.POST, "/api/syncs", { method: "POST", body: syncBody({ categories: [{ id: billing.sys_id }], articles: [choice(article!)] }) });
    expect(response.status).toBe(400);
    expect(response.body.error.fields).toEqual([{ path: "filters.articles", message: "Choose articles, or narrow down by category and language, not both." }]);
  });
});

describe("finding articles to choose", () => {
  it("searches published articles by title or number, newest first", async () => {
    const billing = world.sn.addCategory(kb, "Billing");
    const reset = world.sn.addArticle(kb, { short_description: "Reset your password", categoryId: billing.sys_id });
    world.sn.addArticle(kb, { short_description: "Password rules (draft)", workflow_state: "draft" });
    const generated = world.sn.addArticles(kb, 25);
    const newest = generated.at(-1)!;

    let response = await searchFor(`kb=${kb.sys_id}&q=password`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      articles: [{ number: reset.number, title: "Reset your password", kbId: kb.sys_id, kbName: "Customer Help", category: "Billing", updatedAt: reset.sys_updated_on }],
      more: false,
    });

    response = await searchFor(`kb=${kb.sys_id}&q=${newest.number.toLowerCase()}`);
    expect(response.body.articles.map((article: { number: string }) => article.number)).toEqual([newest.number]);

    response = await searchFor(`kb=${kb.sys_id}&q=Article`);
    expect(response.body.articles).toHaveLength(20);
    expect(response.body.more).toBe(true);

    response = await searchFor(`kb=${kb.sys_id}`);
    expect(response.body.articles[0].number).toBe(newest.number);
    expect(response.body.more).toBe(true);
  });

  it("treats the search text as plain text", async () => {
    world.sn.addArticles(kb, 2);
    const start = world.sn.calls.length;

    const response = await searchFor(`kb=${kb.sys_id}&q=${encodeURIComponent("x^NQactive=false\n")}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ articles: [], more: false });
    expect(articleQueriesSince(start)[0]).not.toContain("^NQ");
  });

  it("validates the search", async () => {
    expect((await searchFor("q=password")).status).toBe(400);
    expect((await searchFor(`kb=${kb.sys_id}&q=${"x".repeat(101)}`)).body.error.fields).toEqual([{ path: "q", message: "Keep the search under 100 characters" }]);
  });

  it("looks up pasted article numbers and sys_ids, and says which weren't found", async () => {
    const [first, second] = world.sn.addArticles(kb, 2);
    const draft = world.sn.addArticle(kb, { workflow_state: "draft" });

    const response = await lookUp({ kbIds: [kb.sys_id], refs: [first!.number.toLowerCase(), second!.sys_id.toUpperCase(), first!.number, draft.number, "KB9999999"] });

    expect(response.status).toBe(200);
    expect(response.body.found.map((article: { number: string }) => article.number)).toEqual([first!.number, second!.number]);
    expect(response.body.found[0]).toEqual({ number: first!.number, title: first!.short_description, kbId: kb.sys_id, kbName: "Customer Help", category: "General", updatedAt: first!.sys_updated_on });
    expect(response.body.notFound).toEqual([draft.number, "KB9999999"]);
  });

  it("validates pasted lists", async () => {
    expect((await lookUp({ kbIds: [kb.sys_id], refs: [] })).body.error.fields).toEqual([{ path: "refs", message: "Paste at least one article number" }]);
    expect((await lookUp({ kbIds: [kb.sys_id], refs: ["KB1,KB2"] })).body.error.fields).toEqual([{ path: "refs.0", message: "Not an article number" }]);
    expect((await lookUp({ kbIds: [], refs: ["KB0010001"] })).status).toBe(400);
  });
});
