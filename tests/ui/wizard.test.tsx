import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NewSyncWizard } from "@/components/syncs/new-sync-wizard";
import { type ApiCall, errorBody, mockApi, type Route } from "./helpers/api";
import { CATEGORY, CONNECTION_ID, makeConnection, makeCredentials, makeFilterOptions, makeKb, makeRun, makeSource, makeSync } from "./helpers/fixtures";
import { navigation } from "./helpers/navigation";
import { renderUi } from "./helpers/render";

const KBS = [makeKb(), makeKb({ id: "kb-2", title: "Billing", description: "Invoices and payments", portals: ["csp"], suggestedAudience: "csm", articleCount: 30 })];

function setup(extra: Record<string, Route> = {}) {
  const api = mockApi({
    "GET /api/connections": { body: { connections: [makeConnection()] } },
    "GET /api/genesys/credentials": { body: { credentials: makeCredentials() } },
    "GET /api/connections/:id/knowledge-bases": { body: { knowledgeBases: KBS } },
    "GET /api/connections/:id/filter-options": { body: { options: makeFilterOptions() } },
    "POST /api/connections/:id/preview": { body: { preview: { count: 120, sample: [] } } },
    "GET /api/genesys/sources": { body: { sources: [makeSource(), makeSource({ id: "source-used", name: "Taken", usedBy: { syncId: "sync-x", syncName: "Other sync" } })] } },
    "POST /api/syncs": { body: { sync: makeSync({ id: "new-sync" }), run: makeRun({ status: "queued", phase: "queued" }), runError: null } },
    ...extra,
  });
  renderUi(<NewSyncWizard />);
  return api;
}

const continueButton = () => screen.getByRole("button", { name: "Continue" });
const currentStep = () => screen.getByRole("list", { name: "Steps" }).querySelector("[aria-current='step']")?.textContent;
const summary = () => screen.getByText("Summary").parentElement!;

async function pickKnowledge(...titles: string[]) {
  for (const title of titles) fireEvent.click(await screen.findByRole("checkbox", { name: new RegExp(title) }));
}

/** Opens the "Categories" or "Languages" checklist and returns it. */
async function openChecklist(title: "Categories" | "Languages") {
  const row = (await screen.findByText(title, { selector: "span" })).parentElement!;
  fireEvent.click(within(row).getByRole("button", { name: "Choose" }));
  return screen.getByRole("list", { name: title });
}

const lastPreviewBody = (api: { callsTo: (method: string, path: string | RegExp) => ApiCall[] }) => api.callsTo("POST", /\/preview$/).at(-1)?.body as Record<string, unknown>;

describe("NewSyncWizard", () => {
  it("creates and runs a sync through the three steps with smart defaults", async () => {
    const api = setup();
    expect(await screen.findByRole("heading", { name: "New sync" })).toBeTruthy();
    expect(screen.getByText("Acme production").parentElement?.textContent).toBe("Reading from Acme production (acme.service-now.com)");
    expect(currentStep()).toContain("Articles");

    await screen.findByRole("checkbox", { name: /Customer Service/ });
    expect(screen.getAllByText("For customers").length).toBeGreaterThan(0);
    fireEvent.click(continueButton());
    expect(screen.getByText("Pick at least one knowledge base.")).toBeTruthy();

    await pickKnowledge("Customer Service");
    expect(screen.getByText("We picked this from where these knowledge bases are published. Change it if it's wrong.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /^Customers/ }) as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByText(/published articles will be synced/, undefined, { timeout: 3_000 })).toBeTruthy();
    expect(await screen.findByText("Narrow it down")).toBeTruthy();
    expect(screen.getByText("All categories")).toBeTruthy();
    expect(screen.getByText("All languages")).toBeTruthy();

    fireEvent.click(continueButton());
    expect(currentStep()).toContain("Destination");
    expect(((await screen.findByLabelText("Name in Genesys Cloud")) as HTMLInputElement).value).toBe("ServiceNow - Customer Service");
    expect(await screen.findByText("1 knowledge source you can use.")).toBeTruthy();
    expect(screen.getByText("https://acme.service-now.com/csm?id=kb_article_view&sysparm_article=KB0010001")).toBeTruthy();
    expect(screen.getByText("Published here")).toBeTruthy();
    expect(screen.queryByText(/to check the link/)).toBeNull();

    fireEvent.click(continueButton());
    expect(currentStep()).toContain("Schedule");
    expect((screen.getByLabelText("Sync name") as HTMLInputElement).value).toBe("Customer Service");
    expect(within(summary()).getByText("Acme production")).toBeTruthy();
    expect(within(summary()).getByText("Customers")).toBeTruthy();
    expect(within(summary()).queryByText("Only")).toBeNull();
    expect(within(summary()).getByText('New knowledge source "ServiceNow - Customer Service"')).toBeTruthy();
    expect(within(summary()).getByText("Customer Service Portal")).toBeTruthy();
    expect(within(summary()).getByText("Every hour")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create and run" })));
    expect(await screen.findByText("Sync created")).toBeTruthy();
    expect(screen.getByText("The first run has started.")).toBeTruthy();
    expect(api.callsTo("POST", "/api/syncs")[0]?.body).toEqual({
      name: "Customer Service",
      connectionId: CONNECTION_ID,
      audience: "csm",
      knowledgeBases: [{ id: "kb-1", title: "Customer Service" }],
      filters: { categories: [], languages: [], articles: null },
      filterQuery: "",
      linkStyle: "csm",
      linkCustom: "",
      schedule: { kind: "interval", minutes: 60 },
      enabled: true,
      source: { mode: "new", name: "ServiceNow - Customer Service" },
      runNow: true,
    });
    expect(navigation.router.push).toHaveBeenCalledWith("/syncs/new-sync");
  });

  it("narrows by category and language, adds a ServiceNow condition, and uses an existing source with another portal", async () => {
    const api = setup({ "POST /api/syncs": { body: { sync: makeSync({ id: "new-sync" }), run: null, runError: null } } });
    await pickKnowledge("Customer Service", "Billing");
    fireEvent.click(screen.getByRole("radio", { name: /^Employees/ }));
    expect(screen.getByText("Used to label the articles in Genesys Cloud and to suggest where links open.")).toBeTruthy();

    const categories = await openChecklist("Categories");
    expect(within(categories).getAllByRole("checkbox")).toHaveLength(4);
    expect(within(categories).getAllByText("Customer Service")).toHaveLength(2);
    fireEvent.click(within(categories).getByRole("checkbox", { name: /^Billing\s*Customer Service/ }));
    expect((within(categories).getByRole("checkbox", { name: /Payments/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Billing, Billing / Payments")).toBeTruthy();
    const languages = await openChecklist("Languages");
    fireEvent.click(within(languages).getByRole("checkbox", { name: /Italian/ }));

    fireEvent.click(screen.getByRole("button", { name: /Add a ServiceNow condition/ }));
    fireEvent.change(screen.getByLabelText(/ServiceNow condition/), { target: { value: " short_descriptionLIKEvpn " } });
    await waitFor(
      () =>
        expect(lastPreviewBody(api)).toEqual({
          kbIds: ["kb-1", "kb-2"],
          filters: {
            categories: [
              { id: CATEGORY.billing, label: "Billing", kbId: "kb-1" },
              { id: CATEGORY.payments, label: "Billing / Payments", kbId: "kb-1" },
            ],
            languages: [{ code: "it", label: "Italian" }],
            articles: null,
          },
          filterQuery: "short_descriptionLIKEvpn",
        }),
      { timeout: 3_000 },
    );
    fireEvent.click(continueButton());

    await screen.findByText("1 knowledge source you can use.");
    fireEvent.click(screen.getByRole("radio", { name: /Add to an existing one/ }));
    expect((screen.getByLabelText("Knowledge source") as HTMLSelectElement).value).toBe("source-9");
    expect(screen.getByText("Legacy upload · 12 files")).toBeTruthy();
    expect(screen.getByText("Already used by another sync: Taken (used by Other sync)")).toBeTruthy();

    expect(screen.getByText("Customer Service Portal", { selector: "p" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const options = screen.getByRole("radiogroup", { name: "Where article links open" });
    expect(within(options).getAllByText("Published here")).toHaveLength(2);
    fireEvent.click(within(options).getByRole("radio", { name: /Another portal/ }));
    fireEvent.change(screen.getByLabelText("Portal address"), { target: { value: "bad suffix!" } });
    expect(screen.getByRole("button", { name: "Done" })).toHaveProperty("disabled", true);
    fireEvent.click(continueButton());
    expect(screen.getByText("Enter the portal's address, like https://acme.service-now.com/support.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Portal address"), { target: { value: "https://acme.service-now.com/help?id=kb_home" } });
    expect(screen.getByText("https://acme.service-now.com/help?id=kb_article_view&sysparm_article=KB0010001")).toBeTruthy();
    fireEvent.click(continueButton());

    expect((screen.getByLabelText("Sync name") as HTMLInputElement).value).toBe("Customer Service + 1 more");
    fireEvent.change(screen.getByLabelText("Sync name"), { target: { value: "  KB mirror  " } });
    fireEvent.click(screen.getByRole("radio", { name: /Only by hand/ }));
    expect(screen.getByText("It only runs when someone clicks Sync now.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Run the first sync now/));
    expect(within(summary()).getByText("Billing, Billing / Payments · Italian · a ServiceNow condition")).toBeTruthy();
    expect(within(summary()).getByText("Legacy upload")).toBeTruthy();
    expect(within(summary()).getByText("Help portal")).toBeTruthy();
    expect(within(summary()).getByText("Manual only")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create sync" })));
    expect(await screen.findByText("It runs on the schedule you picked.")).toBeTruthy();
    expect(api.callsTo("POST", "/api/syncs")[0]?.body).toMatchObject({
      name: "KB mirror",
      audience: "itsm",
      knowledgeBases: [
        { id: "kb-1", title: "Customer Service" },
        { id: "kb-2", title: "Billing" },
      ],
      filters: {
        categories: [
          { id: CATEGORY.billing, label: "Billing", kbId: "kb-1" },
          { id: CATEGORY.payments, label: "Billing / Payments", kbId: "kb-1" },
        ],
        languages: [{ code: "it", label: "Italian" }],
      },
      filterQuery: "short_descriptionLIKEvpn",
      linkStyle: "custom",
      linkCustom: "help",
      schedule: { kind: "manual" },
      source: { mode: "existing", id: "source-9" },
      runNow: false,
    });
  });

  it("keeps category choices tidy when knowledge bases change, and clears them", async () => {
    setup();
    await pickKnowledge("Customer Service", "Billing");
    const categories = await openChecklist("Categories");
    fireEvent.click(within(categories).getByRole("checkbox", { name: /Returns/ }));
    fireEvent.click(within(categories).getByRole("checkbox", { name: /Without a category/ }));
    fireEvent.click(within(categories).getByRole("checkbox", { name: /Payments/ }));
    expect(screen.getByText("Returns, Without a category, Billing / Payments")).toBeTruthy();
    fireEvent.click(within(categories).getByRole("checkbox", { name: /Payments/ }));
    expect(screen.getByText("Returns, Without a category")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /^Billing\s*30 articles/ }));
    const row = screen.getByText("Categories", { selector: "span" }).parentElement!;
    expect(within(row).getByText("Without a category")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear categories" }));
    expect(screen.getByText("All categories")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("list", { name: "Categories" })).toBeNull();
  });

  it("searches long category lists and unpicks languages", async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: String(index).padStart(32, "a"),
      label: index === 7 ? "Refunds" : `Topic ${index}`,
      path: index === 7 ? "Refunds" : `Topic ${index}`,
      kbId: "kb-1",
      kbName: "Customer Service",
      count: 10,
    }));
    setup({ "GET /api/connections/:id/filter-options": { body: { options: makeFilterOptions({ categories: many }) } } });
    await pickKnowledge("Customer Service");
    const categories = await openChecklist("Categories");
    const search = screen.getByLabelText("Search categories");
    fireEvent.change(search, { target: { value: "refu" } });
    expect(within(categories).getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText('Nothing matches "zzz".')).toBeTruthy();

    const languages = await openChecklist("Languages");
    fireEvent.click(within(languages).getByRole("checkbox", { name: /English/ }));
    fireEvent.click(within(languages).getByRole("checkbox", { name: /Italian/ }));
    expect(screen.getByText("English, Italian")).toBeTruthy();
    fireEvent.click(within(languages).getByRole("checkbox", { name: /English/ }));
    const row = screen.getByText("Languages", { selector: "span" }).parentElement!;
    expect(within(row).getByText("Italian")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Clear languages" }));
    expect(within(row).getByText("All languages")).toBeTruthy();
  });

  it("explains when nothing matches and clears every filter in one click", async () => {
    const api = setup({
      "POST /api/connections/:id/preview": (call) => {
        const body = call.body as { filters: { languages: unknown[] }; filterQuery: string };
        return { body: { preview: { count: body.filters.languages.length || body.filterQuery ? 0 : 120, sample: [] } } };
      },
    });
    await pickKnowledge("Customer Service");
    const languages = await openChecklist("Languages");
    fireEvent.click(within(languages).getByRole("checkbox", { name: /Italian/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add a ServiceNow condition/ }));
    fireEvent.change(screen.getByLabelText(/ServiceNow condition/), { target: { value: "active=false" } });

    expect(await screen.findByText("No articles match", undefined, { timeout: 3_000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(await screen.findByText("120", undefined, { timeout: 3_000 })).toBeTruthy();
    expect(screen.getByText("All languages")).toBeTruthy();
    expect((screen.getByLabelText(/ServiceNow condition/) as HTMLTextAreaElement).value).toBe("");
    expect(lastPreviewBody(api)).toMatchObject({ filters: { categories: [], languages: [], articles: null }, filterQuery: "" });
  });

  it("says when the knowledge bases have no published articles", async () => {
    setup({ "POST /api/connections/:id/preview": { body: { preview: { count: 0, sample: [] } } } });
    await pickKnowledge("Customer Service");
    expect(await screen.findByText("No published articles yet", undefined, { timeout: 3_000 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();
  });

  it("only offers filters that can narrow something down and survives when they can't load", async () => {
    const api = setup({
      "GET /api/connections/:id/filter-options": {
        body: { options: makeFilterOptions({ categories: [{ id: CATEGORY.billing, label: "Billing", path: "Billing", kbId: "kb-1", kbName: "Customer Service", count: 120 }], languages: [] }) },
      },
    });
    await pickKnowledge("Customer Service");
    await screen.findByText(/published articles will be synced/, undefined, { timeout: 3_000 });
    expect(screen.queryByText("Narrow it down")).toBeNull();
    expect(screen.getByRole("button", { name: /Add a ServiceNow condition/ })).toBeTruthy();

    api.set("GET /api/connections/:id/filter-options", { status: 502, body: errorBody("SN_PERMISSION_DENIED", "ServiceNow refused the request.") });
    await pickKnowledge("Billing");
    expect(await screen.findByText(/Categories and languages couldn't be loaded.*ServiceNow refused the request\./)).toBeTruthy();
  });

  it("offers a real article to check the link with", async () => {
    setup({
      "POST /api/connections/:id/preview": { body: { preview: { count: 1, sample: [{ number: "KB0012345", title: "Reset your password", kbName: "Customer Service", updatedAt: "2026-11-20 10:00:00" }] } } },
    });
    await pickKnowledge("Customer Service");
    expect(await screen.findByText("Reset your password", undefined, { timeout: 3_000 })).toBeTruthy();
    fireEvent.click(continueButton());
    const link = await screen.findByRole("link", { name: /Open KB0012345 to check the link/ });
    expect(link.getAttribute("href")).toBe("https://acme.service-now.com/csm?id=kb_article_view&sysparm_article=KB0012345");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("jumps back to the step a server-side field error belongs to", async () => {
    let attempts = 0;
    const api = setup({
      "POST /api/syncs": () => {
        attempts += 1;
        return attempts === 1
          ? { status: 422, body: errorBody("VALIDATION", "Some fields need attention.", { fields: [{ path: "source.name", message: "A source with this name already exists." }] }) }
          : { body: { sync: makeSync({ id: "new-sync" }), run: null, runError: "Genesys Cloud is not responding." } };
      },
    });
    await pickKnowledge("Customer Service");
    fireEvent.click(continueButton());
    fireEvent.click(continueButton());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create and run" })));

    expect(await screen.findByText("A source with this name already exists.")).toBeTruthy();
    expect(currentStep()).toContain("Destination");
    fireEvent.change(screen.getByLabelText("Name in Genesys Cloud"), { target: { value: "ServiceNow - Customer Service 2" } });
    fireEvent.click(continueButton());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create and run" })));

    expect(await screen.findByText("Sync created, but the first run didn't start")).toBeTruthy();
    expect(screen.getByText("Genesys Cloud is not responding.")).toBeTruthy();
    expect((api.callsTo("POST", "/api/syncs")[1]?.body as { source: unknown }).source).toEqual({ mode: "new", name: "ServiceNow - Customer Service 2" });
    expect(navigation.router.push).toHaveBeenCalledWith("/syncs/new-sync");
  });

  it("keeps the user on the last step after a general error", async () => {
    setup({ "POST /api/syncs": { status: 503, body: errorBody("GC_UNAVAILABLE", "Genesys Cloud is not responding.", { title: "Genesys Cloud is unavailable" }) } });
    await pickKnowledge("Customer Service");
    fireEvent.click(continueButton());
    fireEvent.click(continueButton());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create and run" })));
    expect((await screen.findByText("Genesys Cloud is unavailable")).closest("[role='alert']")).not.toBeNull();
    expect(currentStep()).toContain("Schedule");
    expect(screen.getByRole("button", { name: "Create and run" })).toHaveProperty("disabled", false);
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("validates the name, weekly days and the new source name locally", async () => {
    const api = setup();
    await pickKnowledge("Customer Service");
    fireEvent.click(continueButton());
    fireEvent.change(await screen.findByLabelText("Name in Genesys Cloud"), { target: { value: "   " } });
    fireEvent.click(continueButton());
    expect(screen.getByText("Give the knowledge source a name.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name in Genesys Cloud"), { target: { value: "Docs" } });
    fireEvent.click(continueButton());

    fireEvent.change(screen.getByLabelText("Sync name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: /On certain days/ }));
    const days = screen.getByRole("group", { name: "Days of the week" });
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(within(days).getByRole("button", { name: day }));
    fireEvent.click(screen.getByRole("button", { name: "Create and run" }));
    expect(screen.getByText("Give the sync a name.")).toBeTruthy();
    expect(screen.getByText("Pick at least one day.")).toBeTruthy();
    expect(api.callsTo("POST", "/api/syncs")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(currentStep()).toContain("Destination");
    expect((screen.getByLabelText("Name in Genesys Cloud") as HTMLInputElement).value).toBe("Docs");
  });

  it("asks for a ServiceNow connection first", async () => {
    setup({ "GET /api/connections": { body: { connections: [] } } });
    expect(await screen.findByText("Connect ServiceNow first")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Connections in a new tab" });
    expect(link.getAttribute("href")).toBe("/connections");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(continueButton()).toHaveProperty("disabled", true);
    expect(screen.getByRole("link", { name: "Cancel" }).getAttribute("href")).toBe("/");
  });

  it("asks for Genesys Cloud access before choosing a destination", async () => {
    const api = setup({ "GET /api/genesys/credentials": { body: { credentials: makeCredentials({ status: "missing", clientId: null, verifiedAt: null }) } } });
    await pickKnowledge("Customer Service");
    fireEvent.click(continueButton());
    expect(screen.getByText("Connect Genesys Cloud first")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Connections in a new tab" }).getAttribute("href")).toBe("/connections#genesys");
    expect(continueButton()).toHaveProperty("disabled", true);
    expect(api.callsTo("GET", "/api/genesys/sources")).toHaveLength(0);
  });

  it("disables existing sources when none is free and shows source errors", async () => {
    setup({ "GET /api/genesys/sources": { status: 502, body: errorBody("GC_UNAVAILABLE", "No answer.", { title: "Genesys Cloud is unavailable" }) } });
    await pickKnowledge("Customer Service");
    fireEvent.click(continueButton());
    expect((await screen.findAllByText("Genesys Cloud is unavailable")).length).toBeGreaterThan(0);
    expect(screen.getByText("None available. Only File upload sources that no other sync uses can be picked.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Add to an existing one/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it("prefers a working connection and resets knowledge bases when switching", async () => {
    const broken = makeConnection({ status: "error", name: "Acme broken" });
    const working = makeConnection({ id: "33333333-3333-4333-8333-333333333333", name: "Acme working", instanceUrl: "https://acme-ok.service-now.com" });
    const api = setup({
      "GET /api/connections": { body: { connections: [broken, working] } },
      "GET /api/connections/:id/knowledge-bases": (_call, params) => ({ body: { knowledgeBases: params.id === working.id ? KBS : [makeKb({ id: "kb-7", title: "Broken KB" })] } }),
    });
    const select = (await screen.findByLabelText("ServiceNow connection")) as HTMLSelectElement;
    expect(select.value).toBe(working.id);
    await pickKnowledge("Customer Service");
    fireEvent.change(select, { target: { value: broken.id } });
    expect(await screen.findByRole("checkbox", { name: /Broken KB/ })).toHaveProperty("checked", false);
    expect(screen.queryByText("Who reads these articles?")).toBeNull();
    expect(api.callsTo("GET", `/api/connections/${broken.id}/knowledge-bases`)).toHaveLength(1);
  });
});

describe("KnowledgeBasePicker states", () => {
  it("retries after an error and explains an empty list", async () => {
    const api = setup({ "GET /api/connections/:id/knowledge-bases": { status: 403, body: errorBody("SN_PERMISSION_DENIED", "No access.", { title: "ServiceNow denied access" }) } });
    expect(await screen.findByText("ServiceNow denied access")).toBeTruthy();
    api.set("GET /api/connections/:id/knowledge-bases", { body: { knowledgeBases: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No knowledge bases visible")).toBeTruthy();
    api.set("GET /api/connections/:id/knowledge-bases", { body: { knowledgeBases: KBS } });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("checkbox", { name: /Billing/ })).toBeTruthy();
  });

  it("searches long lists and caps the selection at 25", async () => {
    const many = Array.from({ length: 26 }, (_, index) => makeKb({ id: `kb-${index}`, title: `Knowledge ${String(index).padStart(2, "0")}`, description: index === 3 ? "Payroll answers" : "", portals: [], suggestedAudience: null }));
    setup({ "GET /api/connections/:id/knowledge-bases": { body: { knowledgeBases: many } } });
    const search = await screen.findByLabelText("Search knowledge bases");
    expect(search.getAttribute("placeholder")).toBe("Search 26 knowledge bases");
    fireEvent.change(search, { target: { value: "payroll" } });
    expect(within(screen.getByRole("list", { name: "Knowledge bases" })).getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText('No knowledge base matches "zzz".')).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });

    for (const checkbox of within(screen.getByRole("list", { name: "Knowledge bases" })).getAllByRole("checkbox")) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("checkbox", { name: /Knowledge 25/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Knowledge 25/ }));
    fireEvent.click(continueButton());
    expect(screen.getByText("Pick at most 25 knowledge bases.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/published articles will be synced/)).toBeTruthy(), { timeout: 3_000 });
  });
});
