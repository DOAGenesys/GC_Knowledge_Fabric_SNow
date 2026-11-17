import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NewSyncWizard } from "@/components/syncs/new-sync-wizard";
import { errorBody, mockApi, type Route } from "./helpers/api";
import { CONNECTION_ID, makeConnection, makeCredentials, makeKb, makeRun, makeSource, makeSync } from "./helpers/fixtures";
import { navigation } from "./helpers/navigation";
import { renderUi } from "./helpers/render";

const KBS = [makeKb(), makeKb({ id: "kb-2", title: "Billing", description: "Invoices and payments", portals: ["csp"], suggestedAudience: "csm", articleCount: 30 })];

function setup(extra: Record<string, Route> = {}) {
  const api = mockApi({
    "GET /api/connections": { body: { connections: [makeConnection()] } },
    "GET /api/genesys/credentials": { body: { credentials: makeCredentials() } },
    "GET /api/connections/:id/knowledge-bases": { body: { knowledgeBases: KBS } },
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

async function pickKnowledge(...titles: string[]) {
  for (const title of titles) fireEvent.click(await screen.findByRole("checkbox", { name: new RegExp(title) }));
}

describe("NewSyncWizard", () => {
  it("creates and runs a sync through the three steps with smart defaults", async () => {
    const api = setup();
    expect(await screen.findByRole("heading", { name: "New sync" })).toBeTruthy();
    expect(screen.getByText("Acme production").parentElement?.textContent).toBe("Reading from Acme production (acme.service-now.com)");
    expect(currentStep()).toContain("Knowledge");

    await screen.findByRole("checkbox", { name: /Customer Service/ });
    fireEvent.click(continueButton());
    expect(screen.getByText("Pick at least one knowledge base.")).toBeTruthy();

    await pickKnowledge("Customer Service");
    expect(screen.getByText("Suggested from the portals these knowledge bases are published on.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Customers \(CSM\)/ }) as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByText(/published articles will be synced/, undefined, { timeout: 3_000 })).toBeTruthy();

    fireEvent.click(continueButton());
    expect(currentStep()).toContain("Destination");
    expect((await screen.findByLabelText("New source name") as HTMLInputElement).value).toBe("ServiceNow - Customer Service");
    expect(await screen.findByText("1 File Upload source available.")).toBeTruthy();
    expect(screen.getByText("Customer Service Portal: https://acme.service-now.com/csm?id=kb_article_view&sysparm_article=KB0010001")).toBeTruthy();

    fireEvent.click(continueButton());
    expect(currentStep()).toContain("Schedule");
    expect((screen.getByLabelText("Sync name") as HTMLInputElement).value).toBe("Customer Service");
    const review = screen.getByText("Review").parentElement!;
    expect(within(review).getByText("Acme production")).toBeTruthy();
    expect(within(review).getByText("Customers (CSM)")).toBeTruthy();
    expect(within(review).getByText('New source "ServiceNow - Customer Service"')).toBeTruthy();
    expect(within(review).getByText("Customer Service Portal")).toBeTruthy();
    expect(within(review).getByText("Every hour")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create and run" })));
    expect(await screen.findByText("Sync created")).toBeTruthy();
    expect(screen.getByText("The first run has started.")).toBeTruthy();
    expect(api.callsTo("POST", "/api/syncs")[0]?.body).toEqual({
      name: "Customer Service",
      connectionId: CONNECTION_ID,
      audience: "csm",
      knowledgeBases: [{ id: "kb-1", title: "Customer Service" }],
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

  it("uses an existing source, a custom link and a manual schedule without running", async () => {
    const api = setup({ "POST /api/syncs": { body: { sync: makeSync({ id: "new-sync" }), run: null, runError: null } } });
    await pickKnowledge("Customer Service", "Billing");
    fireEvent.click(screen.getByRole("radio", { name: /Employees \(ITSM\)/ }));
    expect(screen.getByText("Labels the articles in Genesys Cloud.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Advanced filter" }));
    fireEvent.change(screen.getByLabelText(/ServiceNow encoded query/), { target: { value: " kb_category.label=Billing " } });
    fireEvent.click(continueButton());

    await screen.findByText("1 File Upload source available.");
    fireEvent.click(screen.getByRole("radio", { name: /Use an existing source/ }));
    expect((screen.getByLabelText("Source") as HTMLSelectElement).value).toBe("source-9");
    expect(screen.getByText("Legacy upload · 12 files")).toBeTruthy();
    expect(screen.getByText("Not listed because another sync writes to them: Taken (Other sync)")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Article links open in/), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Portal URL suffix"), { target: { value: "bad suffix!" } });
    fireEvent.click(continueButton());
    expect(screen.getByText("Use letters, numbers, - or _.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Portal URL suffix"), { target: { value: "help" } });
    fireEvent.click(continueButton());

    expect((screen.getByLabelText("Sync name") as HTMLInputElement).value).toBe("Customer Service + 1 more");
    fireEvent.change(screen.getByLabelText("Sync name"), { target: { value: "  KB mirror  " } });
    fireEvent.click(screen.getByRole("radio", { name: /Manual/ }));
    fireEvent.click(screen.getByLabelText(/Run the first sync now/));
    const review = screen.getByText("Review").parentElement!;
    expect(within(review).getByText("kb_category.label=Billing")).toBeTruthy();
    expect(within(review).getByText("Existing source")).toBeTruthy();
    expect(within(review).getByText("Manual only")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create sync" })));
    expect(await screen.findByText("It runs on the schedule you picked.")).toBeTruthy();
    expect(api.callsTo("POST", "/api/syncs")[0]?.body).toMatchObject({
      name: "KB mirror",
      audience: "itsm",
      knowledgeBases: [
        { id: "kb-1", title: "Customer Service" },
        { id: "kb-2", title: "Billing" },
      ],
      filterQuery: "kb_category.label=Billing",
      linkStyle: "custom",
      linkCustom: "help",
      schedule: { kind: "manual" },
      source: { mode: "existing", id: "source-9" },
      runNow: false,
    });
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
    fireEvent.change(screen.getByLabelText("New source name"), { target: { value: "ServiceNow - Customer Service 2" } });
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
    fireEvent.change(await screen.findByLabelText("New source name"), { target: { value: "   " } });
    fireEvent.click(continueButton());
    expect(screen.getByText("Name the new source.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New source name"), { target: { value: "Docs" } });
    fireEvent.click(continueButton());

    fireEvent.change(screen.getByLabelText("Sync name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: /Weekly/ }));
    const days = screen.getByRole("group", { name: "Days of the week" });
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(within(days).getByRole("button", { name: day }));
    fireEvent.click(screen.getByRole("button", { name: "Create and run" }));
    expect(screen.getByText("Give the sync a name.")).toBeTruthy();
    expect(screen.getByText("Pick at least one day.")).toBeTruthy();
    expect(api.callsTo("POST", "/api/syncs")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(currentStep()).toContain("Destination");
    expect((screen.getByLabelText("New source name") as HTMLInputElement).value).toBe("Docs");
  });

  it("asks for a ServiceNow connection first", async () => {
    setup({ "GET /api/connections": { body: { connections: [] } } });
    expect(await screen.findByText("Connect ServiceNow first")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Add a connection in a new tab" });
    expect(link.getAttribute("href")).toBe("/connections");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(continueButton()).toHaveProperty("disabled", true);
    expect(screen.getByRole("link", { name: "Cancel" }).getAttribute("href")).toBe("/");
  });

  it("asks for Genesys Cloud sync credentials before choosing a destination", async () => {
    const api = setup({ "GET /api/genesys/credentials": { body: { credentials: makeCredentials({ status: "missing", clientId: null, verifiedAt: null }) } } });
    await pickKnowledge("Customer Service");
    fireEvent.click(continueButton());
    expect(screen.getByText("Add Genesys Cloud sync credentials first")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Connections in a new tab" }).getAttribute("href")).toBe("/connections#genesys");
    expect(continueButton()).toHaveProperty("disabled", true);
    expect(api.callsTo("GET", "/api/genesys/sources")).toHaveLength(0);
  });

  it("disables existing sources when none is free and shows source errors", async () => {
    setup({ "GET /api/genesys/sources": { status: 502, body: errorBody("GC_UNAVAILABLE", "No answer.", { title: "Genesys Cloud is unavailable" }) } });
    await pickKnowledge("Customer Service");
    fireEvent.click(continueButton());
    expect(await screen.findByText("Genesys Cloud is unavailable")).toBeTruthy();
    expect(screen.getByText("No unused File Upload source.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Use an existing source/ }) as HTMLInputElement).disabled).toBe(true);
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
    expect(screen.queryByText("Audience")).toBeNull();
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

    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("checkbox", { name: /Knowledge 25/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Knowledge 25/ }));
    fireEvent.click(continueButton());
    expect(screen.getByText("Pick at most 25 knowledge bases.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/published articles will be synced/)).toBeTruthy(), { timeout: 3_000 });
  });
});
