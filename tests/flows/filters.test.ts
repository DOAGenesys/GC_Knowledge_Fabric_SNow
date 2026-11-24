import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as filterOptions from "@/app/api/connections/[id]/filter-options/route";
import * as preview from "@/app/api/connections/[id]/preview/route";
import * as syncRoute from "@/app/api/syncs/[id]/route";
import * as syncs from "@/app/api/syncs/route";
import { type SignedInClient, signedInClient } from "../helpers/api";
import { useTestDatabase } from "../helpers/db";
import type { FakeCategory, FakeKb } from "../helpers/fake-servicenow";
import { createWorld, type World } from "../helpers/world";

useTestDatabase();
let world: World;
let browser: SignedInClient;

beforeEach(async () => {
  world = await createWorld();
  browser = signedInClient({ userId: "user-0001", userName: "Ada Admin", orgId: world.gc.orgId, orgName: "Acme Corp", region: "mypurecloud.de" });
});

afterEach(() => world.dispose());

interface Catalog {
  connectionId: string;
  kb: FakeKb;
  billing: FakeCategory;
  payments: FakeCategory;
}

/** Billing: 2 English articles. Billing / Payments: 1 Italian. 1 English article without a category. A draft that never counts. */
async function seedCatalog(): Promise<Catalog> {
  const connection = await world.setup();
  const kb = world.sn.addKb({ title: "Customer Help", portals: ["csp"] });
  const billing = world.sn.addCategory(kb, "Billing");
  const payments = world.sn.addCategory(kb, "Payments", billing);
  world.sn.addArticles(kb, 2, { categoryId: billing.sys_id });
  world.sn.addArticle(kb, { categoryId: payments.sys_id, language: "it" });
  world.sn.addArticle(kb, { categoryId: "" });
  world.sn.addArticle(kb, { categoryId: billing.sys_id, workflow_state: "draft" });
  return { connectionId: connection.id, kb, billing, payments };
}

function filterOptionsFor(connectionId: string, kbParam: string) {
  return browser.call(filterOptions.GET, `/api/connections/${connectionId}/filter-options?kb=${kbParam}`, { params: { id: connectionId } });
}

function syncBody(connectionId: string, kb: FakeKb, overrides: Record<string, unknown> = {}) {
  return {
    name: "Customer help center",
    connectionId,
    audience: "csm",
    knowledgeBases: [{ id: kb.sys_id, title: kb.title }],
    linkStyle: "csp",
    schedule: { kind: "interval", minutes: 60 },
    source: { mode: "new", name: "ServiceNow - Customer KB" },
    ...overrides,
  };
}

describe("friendly article filters", () => {
  it("offers the categories and languages that published articles use, with counts", async () => {
    const { connectionId, kb, billing, payments } = await seedCatalog();

    const response = await filterOptionsFor(connectionId, kb.sys_id);

    expect(response.status).toBe(200);
    expect(response.body.options).toEqual({
      categories: [
        { id: billing.sys_id, label: "Billing", path: "Billing", kbId: kb.sys_id, kbName: "Customer Help", count: 2 },
        { id: payments.sys_id, label: "Payments", path: "Billing / Payments", kbId: kb.sys_id, kbName: "Customer Help", count: 1 },
        { id: "", label: "Without a category", path: "Without a category", kbId: "", kbName: "", count: 1 },
      ],
      languages: [
        { code: "en", label: "English", count: 3 },
        { code: "it", label: "Italian", count: 1 },
      ],
    });
  });

  it("previews only the articles that match the chosen filters", async () => {
    const { connectionId, kb, billing, payments } = await seedCatalog();
    const billingChoice = { id: billing.sys_id, label: "Billing", kbId: kb.sys_id };
    const noCategory = { id: "", label: "", kbId: "" };
    const countFor = async (filters: unknown, filterQuery = "") => {
      const response = await browser.call(preview.POST, `/api/connections/${connectionId}/preview`, {
        method: "POST",
        params: { id: connectionId },
        body: { kbIds: [kb.sys_id], filters, filterQuery },
      });
      expect(response.status).toBe(200);
      return response.body.preview.count as number;
    };

    expect(await countFor({ categories: [], languages: [] })).toBe(4);
    expect(await countFor({ categories: [{ id: payments.sys_id, label: "Payments", kbId: kb.sys_id }] })).toBe(1);
    expect(await countFor({ categories: [billingChoice, noCategory] })).toBe(3);
    expect(await countFor({ categories: [noCategory] })).toBe(1);
    expect(await countFor({ languages: [{ code: "it", label: "Italian" }] })).toBe(1);
    expect(await countFor({ categories: [billingChoice], languages: [{ code: "it", label: "Italian" }] })).toBe(0);
    expect(await countFor({ languages: [{ code: "en", label: "English" }] }, "short_descriptionLIKEArticle")).toBe(3);
  });

  it("saves the filters on the sync, syncs only matching articles, and treats a filter change as a content change", async () => {
    const { connectionId, kb, billing } = await seedCatalog();
    const filters = { categories: [{ id: billing.sys_id, label: "Billing", kbId: kb.sys_id }], languages: [{ code: "en", label: "English" }] };

    let response = await browser.call(syncs.POST, "/api/syncs", { method: "POST", body: syncBody(connectionId, kb, { filters }) });
    expect(response.status).toBe(201);
    expect(response.body.sync.filters).toEqual({ ...filters, articles: null });
    const syncId: string = response.body.sync.id;
    await world.runWorkflows();

    response = await browser.call(syncRoute.GET, `/api/syncs/${syncId}`, { params: { id: syncId } });
    expect(response.body.sync).toMatchObject({ articleCount: 2, lastRun: { status: "succeeded", uploaded: 2 } });
    expect((await world.sync(syncId)).fingerprint).not.toBeNull();

    response = await browser.call(syncRoute.PUT, `/api/syncs/${syncId}`, {
      method: "PUT",
      params: { id: syncId },
      body: syncBody(connectionId, kb, { filters: { languages: [{ code: "it", label: "Italian" }] } }),
    });
    expect(response.status).toBe(200);
    expect(response.body.sync.filters).toEqual({ categories: [], languages: [{ code: "it", label: "Italian" }], articles: null });
    expect((await world.sync(syncId)).fingerprint).toBeNull();

    response = await browser.call(syncRoute.PATCH, `/api/syncs/${syncId}`, { method: "PATCH", params: { id: syncId }, body: { enabled: false } });
    expect(response.body.sync.filters).toEqual({ categories: [], languages: [{ code: "it", label: "Italian" }], articles: null });
  });

  it("rejects filter values that aren't ServiceNow ids or language codes", async () => {
    const { connectionId, kb } = await seedCatalog();

    const response = await browser.call(syncs.POST, "/api/syncs", {
      method: "POST",
      body: syncBody(connectionId, kb, { filters: { categories: [{ id: "Billing^NQactive=true", label: "Billing" }], languages: [{ code: "en'--" }] } }),
    });

    expect(response.status).toBe(400);
    expect(response.body.error.fields.map((field: { path: string }) => field.path)).toEqual(expect.arrayContaining(["filters.categories.0.id", "filters.languages.0.code"]));
  });

  it("still offers categories when the instance can't group by language, with plain labels when paths are hidden", async () => {
    const { connectionId, kb } = await seedCatalog();
    world.sn.languageField = false;
    world.sn.fail(/\/api\/now\/table\/kb_category$/, { status: 403, body: { error: { message: "Insufficient rights" } } });

    const response = await filterOptionsFor(connectionId, kb.sys_id);

    expect(response.status).toBe(200);
    expect(response.body.options.languages).toEqual([]);
    expect(response.body.options.categories.map((category: { path: string }) => category.path)).toEqual(["Billing", "Payments", "Without a category"]);
  });

  it("explains when ServiceNow refuses the counts and validates the knowledge base list", async () => {
    const { connectionId, kb } = await seedCatalog();

    expect((await filterOptionsFor(connectionId, "not-a-sys-id")).status).toBe(400);
    expect((await filterOptionsFor(connectionId, "")).status).toBe(400);

    world.sn.statsEnabled = false;
    const response = await filterOptionsFor(connectionId, kb.sys_id);
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("SN_PERMISSION_DENIED");
  });
});
