import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SyncDetail } from "@/components/syncs/sync-detail";
import type { ArticleDTO, RunDTO, SyncDTO } from "@/lib/api-types";
import { errorBody, mockApi, type Route } from "./helpers/api";
import { CONNECTION_ID, makeArticle, makeArticlePage, makeConnection, makeFilterOptions, makeKb, makeRun, makeSession, makeSync, minutesAhead, SYNC_ID } from "./helpers/fixtures";
import { navigation } from "./helpers/navigation";
import { renderUi } from "./helpers/render";

function setup(initial: SyncDTO, extra: Record<string, Route> = {}) {
  const state = { sync: initial };
  const api = mockApi({
    "GET /api/syncs/:id": () => ({ body: { sync: state.sync } }),
    "GET /api/syncs/:id/runs": () => ({ body: { runs: state.sync.lastRun ? [state.sync.lastRun] : [] } }),
    "GET /api/syncs/:id/articles": { body: makeArticlePage([makeArticle(1), makeArticle(2)]) },
    "GET /api/connections": { body: { connections: [makeConnection()] } },
    "GET /api/connections/:id/knowledge-bases": { body: { knowledgeBases: [makeKb(), makeKb({ id: "kb-2", title: "Billing", description: "", portals: [], suggestedAudience: null, articleCount: null })] } },
    "POST /api/connections/:id/preview": { body: { preview: { count: 44, sample: [] } } },
    "GET /api/connections/:id/filter-options": { body: { options: makeFilterOptions() } },
    "GET /api/syncs": () => ({ body: { syncs: [state.sync] } }),
    "GET /api/session": { body: makeSession() },
    ...extra,
  });
  renderUi(<SyncDetail id={initial.id} />);
  return { api, state };
}

const heading = () => screen.findByRole("heading", { level: 1 });

describe("SyncDetail header and status", () => {
  it("shows a healthy sync with its tiles and schedule", async () => {
    setup(makeSync());
    expect((await heading()).textContent).toBe("Customer Help");
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("CSM")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Full rebuild|Re-upload/ })).toBeNull();
    expect(screen.getByText("Acme production · Customer Service")).toBeTruthy();
    expect(screen.getByText("Every hour")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Automatic syncs/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Running on schedule")).toBeTruthy();
    expect(screen.getByRole("link", { name: "All syncs" }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("pauses and resumes automatic syncs", async () => {
    const { api, state } = setup(makeSync(), {
      "PATCH /api/syncs/:id": (call) => {
        state.sync = { ...state.sync, enabled: (call.body as { enabled: boolean }).enabled, nextRunAt: minutesAhead(10) };
        return { body: { sync: state.sync } };
      },
    });
    await heading();
    fireEvent.click(screen.getByRole("switch", { name: /Automatic syncs/ }));
    expect(await screen.findByText("Automatic syncs paused")).toBeTruthy();
    expect(api.callsTo("PATCH", `/api/syncs/${SYNC_ID}`)[0]?.body).toEqual({ enabled: false });
    expect(screen.getAllByText("Paused").length).toBe(2);
    expect(screen.getByText("Paused, manual only")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: /Automatic syncs/ }));
    expect(await screen.findByText("Automatic syncs resumed")).toBeTruthy();
  });

  it("explains when the schedule can't be changed", async () => {
    setup(makeSync(), { "PATCH /api/syncs/:id": { status: 500, body: errorBody("INTERNAL", "Something broke.", { title: "Unexpected error" }) } });
    await heading();
    fireEvent.click(screen.getByRole("switch", { name: /Automatic syncs/ }));
    expect(await screen.findByText("Unexpected error")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Automatic syncs/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows manual syncs without the automatic switch", async () => {
    setup(makeSync({ schedule: { kind: "manual" }, nextRunAt: null, articleCount: 0, lastSuccessAt: null }));
    await heading();
    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText("Manual only. Add a schedule in Settings.")).toBeTruthy();
    expect(screen.getByText("No successful run yet")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("starts an incremental sync", async () => {
    const { api } = setup(makeSync(), { "POST /api/syncs/:id/run": { body: { outcome: "up_to_date", run: null } } });
    await heading();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Already up to date")).toBeTruthy();
    expect(api.callsTo("POST", `/api/syncs/${SYNC_ID}/run`)[0]?.body).toEqual({ mode: "incremental" });
  });

  it("shows live progress and cancels the active run", async () => {
    const active = makeRun({ id: "run-live", status: "running", phase: "uploading", trigger: "manual", plannedUploads: 10, plannedDeletions: 0, uploaded: 4, requestedBy: "Jordan Example", finishedAt: null, durationMs: null });
    const { api, state } = setup(makeSync({ activeRun: active }), {
      "POST /api/syncs/:id/runs/:runId/cancel": () => {
        state.sync = { ...state.sync, activeRun: { ...active, cancelRequested: true } };
        return { status: 202, body: { ok: true } };
      },
    });
    await heading();
    expect(screen.getByText("Syncing")).toBeTruthy();
    expect(screen.getByText(/^Sync started .+ by Jordan Example$/)).toBeTruthy();
    expect(screen.getByText("10 articles to upload · 0 articles to remove")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Sync progress" }).querySelector("[aria-current='step']")?.textContent).toBe("Upload");
    expect(screen.getByText("4 of 10 articles")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync now" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("Cancelling")).toBeTruthy();
    expect(api.callsTo("POST", `/api/syncs/${SYNC_ID}/runs/run-live/cancel`)).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "Cancelling…" })).toHaveProperty("disabled", true);
  });

  it("reports a failed cancel request", async () => {
    const active = makeRun({ id: "run-live", status: "running", phase: "planning", plannedUploads: 0, plannedDeletions: 0, finishedAt: null, durationMs: null });
    setup(makeSync({ activeRun: active }), {
      "POST /api/syncs/:id/runs/:runId/cancel": { status: 409, body: errorBody("CONFLICT", "The run already finished.", { title: "Already finished" }) },
    });
    await heading();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("Already finished")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel run" })).toHaveProperty("disabled", false);
  });

  it("explains a deleted sync", async () => {
    mockApi({ "GET /api/syncs/:id": { status: 404, body: errorBody("NOT_FOUND", "Not found.") } });
    renderUi(<SyncDetail id={SYNC_ID} />);
    expect(await screen.findByText("This sync doesn't exist anymore")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to your syncs" }).getAttribute("href")).toBe("/");
  });

  it("retries after a load error", async () => {
    const api = mockApi({ "GET /api/syncs/:id": { status: 500, body: errorBody("INTERNAL", "Something broke.", { title: "Unexpected error" }) } });
    renderUi(<SyncDetail id={SYNC_ID} />);
    expect(await screen.findByText("Unexpected error")).toBeTruthy();
    api.set("GET /api/syncs/:id", { body: { sync: makeSync() } });
    api.set("GET /api/syncs/:id/runs", { body: { runs: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await heading()).textContent).toBe("Customer Help");
  });
});

describe("last run problems", () => {
  const failedRun = (code: string, title: string): RunDTO =>
    makeRun({ status: "failed", error: { code: code as never, title, message: `${title}, details.`, hint: "Here's how to fix it.", detail: null } });

  it("points ServiceNow failures to Connections and shows retry timing", async () => {
    setup(makeSync({ health: "error", consecutiveFailures: 3, lastRun: failedRun("SN_AUTH_FAILED", "ServiceNow rejected the credentials") }));
    await heading();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("ServiceNow rejected the credentials")).toBeTruthy();
    expect(within(alert).getByText("Here's how to fix it.")).toBeTruthy();
    expect(within(alert).getByText(/^Failed 3 times in a row\. Next automatic attempt .+\.$/)).toBeTruthy();
    expect(within(alert).getByRole("link", { name: "Open Connections" }).getAttribute("href")).toBe("/connections");
  });

  it("points Genesys Cloud credential failures to the credentials card", async () => {
    setup(makeSync({ health: "error", enabled: false, lastRun: failedRun("GC_AUTH_FAILED", "Sync credentials stopped working") }));
    await heading();
    expect(within(screen.getByRole("alert")).getByRole("link", { name: "Open Connections" }).getAttribute("href")).toBe("/connections#genesys");
  });

  it("opens the settings tab for filter problems", async () => {
    setup(makeSync({ health: "error", lastRun: failedRun("SN_QUERY_INVALID", "The filter isn't valid") }));
    await heading();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByLabelText("Sync name")).toBeTruthy();
  });

  it("falls back to a generic failure message", async () => {
    setup(makeSync({ health: "error", schedule: { kind: "manual" }, lastRun: makeRun({ status: "failed", error: null }) }));
    await heading();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("The last sync failed")).toBeTruthy();
    expect(within(alert).getByText("The run stopped before it finished.")).toBeTruthy();
  });

  it("lists failed articles from a partial run", async () => {
    const partial = makeRun({ status: "partial", uploaded: 3, failed: 2 });
    const failed: ArticleDTO[] = [makeArticle(1, { state: "error", lastError: "File too large" }), makeArticle(2, { state: "error", lastError: "Empty body" })];
    const { api } = setup(makeSync({ health: "warning", statusMessage: "2 articles couldn't be uploaded.", lastRun: partial }), {
      "GET /api/syncs/:id/articles": { body: makeArticlePage(failed, { counts: { synced: 42, error: 2, skipped: 0, pending_delete: 0 }, total: 2 }) },
    });
    await heading();
    const callout = screen.getByText("Some articles weren't synced").closest<HTMLElement>("[role='status']")!;
    expect(within(callout).getByText("2 articles couldn't be uploaded.")).toBeTruthy();

    fireEvent.click(within(callout).getByRole("button", { name: "View failed articles" }));
    expect(await screen.findByText("File too large")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Failed/ }).getAttribute("aria-pressed")).toBe("true");
    expect(api.callsTo("GET", `/api/syncs/${SYNC_ID}/articles`).at(-1)?.query.get("state")).toBe("error");
  });
});

describe("activity tab", () => {
  const runs: RunDTO[] = [
    makeRun({ id: "run-live", status: "running", phase: "committing", finishedAt: null, durationMs: null }),
    makeRun({
      id: "run-partial",
      status: "partial",
      uploaded: 5,
      deleted: 0,
      unchanged: 30,
      failed: 1,
      skipped: 1,
      note: "Genesys Cloud couldn't process 1 file.",
      error: { code: "GC_REQUEST_REJECTED", title: "Genesys Cloud rejected a file", message: "One file was rejected.", hint: "Check the file size.", detail: "HTTP 400 from upload" },
    }),
    makeRun({ id: "run-failed", trigger: "manual", mode: "full", status: "failed", requestedBy: "Jordan Example", error: { code: "SN_UNREACHABLE", title: "ServiceNow is unreachable", message: "The instance didn't answer in time.", hint: null, detail: null } }),
    makeRun({ id: "run-noop", status: "noop", note: "Nothing changed since the last run.", uploaded: 0, deleted: 0, unchanged: 0, gcSyncId: null, gcSyncStatus: null }),
    makeRun({ id: "run-cancelled", status: "cancelled", uploaded: 0, deleted: 0, unchanged: 0 }),
    makeRun({ id: "run-empty", status: "succeeded", uploaded: 0, deleted: 0, unchanged: 0 }),
  ];

  it("summarizes each run and expands details with articles that need attention", async () => {
    const { api } = setup(makeSync(), {
      "GET /api/syncs/:id/runs": { body: { runs } },
      "GET /api/syncs/:id/runs/:runId": {
        body: {
          run: runs[1],
          items: [
            { articleId: "a1", number: "KB0010001", title: "Refund policy", op: "upload", reason: "changed", status: "failed", error: "File too large" },
            { articleId: "a2", number: "", title: "Empty article", op: "upload", reason: "new", status: "skipped", error: null },
          ],
          itemCounts: { pending: 0, done: 5, unchanged: 30, failed: 1, skipped: 1 },
        },
      },
    });
    await heading();
    expect(await screen.findByText("In progress")).toBeTruthy();
    expect(screen.getByText("5 uploaded · 30 unchanged · 1 failed · 1 skipped")).toBeTruthy();
    expect(screen.getByText("The instance didn't answer in time.")).toBeTruthy();
    expect(screen.getByText("Manual · Full re-upload")).toBeTruthy();
    expect(screen.getByText("Nothing changed since the last run.")).toBeTruthy();
    expect(screen.getByText("Cancelled before any change")).toBeTruthy();
    expect(screen.getByText("No changes")).toBeTruthy();

    const partialRow = screen.getByRole("button", { name: /5 uploaded/ });
    expect(screen.queryByText("Genesys Cloud couldn't process 1 file.")).toBeNull();
    fireEvent.click(partialRow);
    expect(partialRow.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Genesys Cloud couldn't process 1 file.")).toBeTruthy();
    expect(screen.getByText("Genesys Cloud rejected a file")).toBeTruthy();
    expect(screen.getByText("Check the file size.")).toBeTruthy();
    expect(await screen.findByText("Refund policy")).toBeTruthy();
    expect(screen.getByText("File too large")).toBeTruthy();
    expect(screen.getByText("Empty article")).toBeTruthy();
    expect(api.callsTo("GET", `/api/syncs/${SYNC_ID}/runs/run-partial`)[0]?.query.get("status")).toBe("attention");

    const technical = screen.getByText("Technical details (for support)").closest("details")!;
    expect(technical.open).toBe(false);
    technical.open = true;
    expect(within(technical).getByText("GC_REQUEST_REJECTED")).toBeTruthy();
    expect(within(technical).getByText("Completed · ingestion Completed")).toBeTruthy();
    expect(within(technical).getByText("HTTP 400 from upload")).toBeTruthy();
    await act(async () => fireEvent.click(within(technical).getByRole("button", { name: "Copy synchronization ID" })));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("gc-sync-0001");

    fireEvent.click(screen.getByRole("button", { name: /Manual · Full re-upload/ }));
    expect(partialRow.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Jordan Example")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Manual · Full re-upload/ }));
    expect(screen.queryByText("Jordan Example")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Nothing changed since the last run/ }));
    expect(screen.getAllByText("Nothing changed since the last run.")).toHaveLength(1);
  });

  it("shows run detail errors and empty item lists", async () => {
    setup(makeSync(), {
      "GET /api/syncs/:id/runs": { body: { runs: [runs[1], makeRun({ id: "run-skip", status: "succeeded", skipped: 2, uploaded: 0, deleted: 0, unchanged: 0 })] } },
      "GET /api/syncs/:id/runs/:runId": (_call, params) =>
        params.runId === "run-partial" ? { status: 500, body: errorBody("INTERNAL", "Broken.", { title: "Couldn't load the run" }) } : { body: { run: runs[1], items: [], itemCounts: {} } },
    });
    await heading();
    fireEvent.click(await screen.findByRole("button", { name: /5 uploaded/ }));
    expect(await screen.findByText("Couldn't load the run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /2 skipped/ }));
    expect(await screen.findByText("No details recorded.")).toBeTruthy();
  });

  it("explains an empty history", async () => {
    setup(makeSync({ lastRun: null, health: "new" }));
    await heading();
    expect(await screen.findByText("No runs yet")).toBeTruthy();
  });

  it("retries when the history fails to load", async () => {
    const { api } = setup(makeSync(), { "GET /api/syncs/:id/runs": { status: 500, body: errorBody("INTERNAL", "Broken.", { title: "Couldn't load runs" }) } });
    await heading();
    expect(await screen.findByText("Couldn't load runs")).toBeTruthy();
    api.set("GET /api/syncs/:id/runs", { body: { runs: [makeRun()] } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("3 uploaded · 1 removed · 40 unchanged")).toBeTruthy();
  });
});

describe("articles tab", () => {
  const openArticles = async () => {
    await heading();
    fireEvent.click(screen.getByRole("tab", { name: /^Articles/ }));
  };

  const pagedArticles: Route = (call) => {
    const offset = Number(call.query.get("offset"));
    const search = call.query.get("search");
    const items = search ? [] : Array.from({ length: 50 }, (_, index) => makeArticle(offset + index + 1, index === 0 ? { state: "pending_delete", syncedAt: null } : {}));
    return { body: makeArticlePage(items, { total: search ? 0 : 120, counts: { synced: 110, error: 10, skipped: 0, pending_delete: 1 } }) };
  };

  it("stays on the chosen page until the search text really changes", async () => {
    setup(makeSync({ articleCount: 120 }), { "GET /api/syncs/:id/articles": pagedArticles });
    await openArticles();
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByText("51–100 of 120")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search articles"), { target: { value: "   " } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByText("51–100 of 120")).toBeTruthy();
  });

  it("filters, searches and pages through articles", async () => {
    const { api } = setup(makeSync({ articleCount: 120 }), { "GET /api/syncs/:id/articles": pagedArticles });
    await openArticles();
    expect(await screen.findByText("Article 1")).toBeTruthy();
    expect(screen.getByText("1–50 of 120")).toBeTruthy();
    expect(screen.getByText("Removing", { selector: "span" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Skipped/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Previous" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("51–100 of 120")).toBeTruthy();
    expect(screen.getByText("Article 51")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("101–120 of 120")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("51–100 of 120")).toBeTruthy();

    const lastQuery = () => api.callsTo("GET", `/api/syncs/${SYNC_ID}/articles`).at(-1)?.query;
    fireEvent.click(screen.getByRole("button", { name: /^Failed/ }));
    await waitFor(() => expect(lastQuery()?.get("state")).toBe("error"));
    expect(lastQuery()?.get("offset")).toBe("0");

    fireEvent.change(screen.getByLabelText("Search articles"), { target: { value: "  refund  " } });
    expect(await screen.findByText("No articles match.", undefined, { timeout: 3_000 })).toBeTruthy();
    expect(lastQuery()?.get("search")).toBe("refund");
  });

  it("explains when nothing has been synced", async () => {
    setup(makeSync({ articleCount: 0 }), { "GET /api/syncs/:id/articles": { body: makeArticlePage([]) } });
    await openArticles();
    expect(await screen.findByText("No articles synced yet")).toBeTruthy();
  });

  it("retries when articles fail to load", async () => {
    const { api } = setup(makeSync(), { "GET /api/syncs/:id/articles": { status: 500, body: errorBody("INTERNAL", "Broken.", { title: "Couldn't load articles" }) } });
    await openArticles();
    expect(await screen.findByText("Couldn't load articles")).toBeTruthy();
    api.set("GET /api/syncs/:id/articles", { body: makeArticlePage([makeArticle(7)]) });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Article 7")).toBeTruthy();
  });
});

describe("settings tab", () => {
  const openSettings = async () => {
    await heading();
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    await screen.findByRole("checkbox", { name: /Billing/ });
  };

  it("saves edited settings and tells the user what happens next", async () => {
    const { api, state } = setup(makeSync(), {
      "PUT /api/syncs/:id": (call) => {
        const body = call.body as { name: string; knowledgeBases: Array<{ id: string; title: string }> };
        state.sync = { ...state.sync, name: body.name, kbIds: body.knowledgeBases.map((kb) => kb.id), kbNames: body.knowledgeBases.map((kb) => kb.title) };
        return { body: { sync: state.sync } };
      },
    });
    await openSettings();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByText("Knowledge source in Genesys Cloud").nextElementSibling?.textContent).toBe("ServiceNow - Customer Help");

    fireEvent.change(screen.getByLabelText("Sync name"), { target: { value: "Customer Help EU " } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Billing/ }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings saved")).toBeTruthy();
    expect(screen.getByText("The next run re-checks every article against these settings.")).toBeTruthy();
    expect(api.callsTo("PUT", `/api/syncs/${SYNC_ID}`)[0]?.body).toEqual({
      name: "Customer Help EU",
      connectionId: CONNECTION_ID,
      audience: "csm",
      knowledgeBases: [
        { id: "kb-1", title: "Customer Service" },
        { id: "kb-2", title: "Billing" },
      ],
      filters: { categories: [], languages: [], articles: null },
      filterQuery: "",
      linkStyle: "csm",
      linkCustom: "",
      schedule: { kind: "interval", minutes: 60 },
      enabled: true,
    });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect((await heading()).textContent).toBe("Customer Help EU");
  });

  it("discards changes", async () => {
    setup(makeSync());
    await openSettings();
    fireEvent.change(screen.getByLabelText("Sync name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect((screen.getByLabelText("Sync name") as HTMLInputElement).value).toBe("Customer Help");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("edits the schedule without the re-check note", async () => {
    const { api, state } = setup(makeSync(), {
      "PUT /api/syncs/:id": (call) => {
        state.sync = { ...state.sync, schedule: (call.body as { schedule: SyncDTO["schedule"] }).schedule };
        return { body: { sync: state.sync } };
      },
    });
    await openSettings();
    fireEvent.click(screen.getByRole("radio", { name: /On certain days/ }));
    const days = screen.getByRole("group", { name: "Days of the week" });
    expect(within(days).getByRole("button", { name: "Mon" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(days).getByRole("button", { name: "Mon" }));
    fireEvent.click(within(days).getByRole("button", { name: "Sun" }));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "07:30" } });
    const zone = screen.getByLabelText("Time zone") as HTMLSelectElement;
    fireEvent.change(zone, { target: { value: "Europe/Madrid" } });
    expect(zone.selectedOptions[0]?.textContent).toMatch(/^Europe\/Madrid \(GMT\+0[12]:00\)$/);
    expect(screen.getByText("A run can start up to 15 minutes after the planned time.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings saved")).toBeTruthy();
    expect(screen.queryByText("The next run re-checks every article against these settings.")).toBeNull();
    expect((api.callsTo("PUT", `/api/syncs/${SYNC_ID}`)[0]?.body as { schedule: unknown }).schedule).toEqual({ kind: "weekly", days: [2, 3, 4, 5, 0], time: "07:30", tz: "Europe/Madrid" });
  });

  it("switches between schedule kinds", async () => {
    setup(makeSync());
    await openSettings();
    fireEvent.change(screen.getByLabelText("How often"), { target: { value: "15" } });
    expect((screen.getByLabelText("How often") as HTMLSelectElement).value).toBe("15");
    fireEvent.click(screen.getByRole("radio", { name: /Once a day/ }));
    expect(screen.queryByRole("group", { name: "Days of the week" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "" } });
    expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe("06:00");
    fireEvent.click(screen.getByRole("radio", { name: /Only by hand/ }));
    expect(screen.getByText("It only runs when someone clicks Sync now.")).toBeTruthy();
    expect(screen.queryByText("A run can start up to 15 minutes after the planned time.")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Several times a day/ }));
    expect((screen.getByLabelText("How often") as HTMLSelectElement).value).toBe("60");
  });

  it("shows field errors from the server next to each field", async () => {
    setup(makeSync(), {
      "PUT /api/syncs/:id": {
        status: 422,
        body: errorBody("VALIDATION", "Some fields need attention.", {
          fields: [
            { path: "name", message: "Another sync already uses this name." },
            { path: "schedule.days", message: "Pick at least one day." },
            { path: "knowledgeBases", message: "Pick at least one knowledge base." },
          ],
        }),
      },
    });
    await openSettings();
    fireEvent.change(screen.getByLabelText("Sync name"), { target: { value: "Duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Another sync already uses this name.")).toBeTruthy();
    expect(screen.getByLabelText("Sync name").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Pick at least one day.")).toBeTruthy();
    expect(screen.getByText("Pick at least one knowledge base.")).toBeTruthy();
    expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual([expect.stringContaining("Delete this sync")]);
  });

  it("shows other save errors above the form", async () => {
    setup(makeSync(), { "PUT /api/syncs/:id": { status: 409, body: errorBody("CONFLICT", "Someone else changed this sync.", { title: "The sync changed" }) } });
    await openSettings();
    fireEvent.change(screen.getByLabelText("Sync name"), { target: { value: "Other" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByText("The sync changed")).closest("[role='alert']")).not.toBeNull();
    expect(screen.getByText("Someone else changed this sync.")).toBeTruthy();
  });

  it("sets a custom portal for article links", async () => {
    const { api, state } = setup(makeSync(), {
      "PUT /api/syncs/:id": () => ({ body: { sync: state.sync } }),
    });
    await openSettings();
    expect(screen.getByText("Customer Service Portal", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("https://acme.service-now.com/csm?id=kb_article_view&sysparm_article=KB0010001")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const options = screen.getByRole("radiogroup", { name: "Where article links open" });
    expect(within(options).getAllByRole("radio")[0]?.closest("label")?.textContent).toMatch(/^Customer Service Portal\/csmPublished here/);
    fireEvent.click(within(options).getByRole("radio", { name: /Another portal/ }));
    fireEvent.change(screen.getByLabelText("Portal address"), { target: { value: " help " } });
    expect(screen.getByText("https://acme.service-now.com/help?id=kb_article_view&sysparm_article=KB0010001")).toBeTruthy();
    fireEvent.click(within(options).getByRole("radio", { name: /ServiceNow classic view/ }));
    expect(screen.getByText("https://acme.service-now.com/kb_view.do?sysparm_article=KB0010001")).toBeTruthy();
    expect(screen.queryByLabelText("Portal address")).toBeNull();
    fireEvent.click(within(options).getByRole("radio", { name: /Another portal/ }));
    expect((screen.getByLabelText("Portal address") as HTMLInputElement).value).toBe(" help ");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Help portal", { selector: "p" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^ITSM/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Settings saved");
    expect(api.callsTo("PUT", `/api/syncs/${SYNC_ID}`)[0]?.body).toMatchObject({ audience: "itsm", linkStyle: "custom", linkCustom: "help" });
  });

  it("opens the link options straight away when a saved portal address is missing", async () => {
    setup(makeSync({ linkStyle: "custom", linkCustom: "" }));
    await openSettings();
    expect(screen.getByRole("radiogroup", { name: "Where article links open" })).toBeTruthy();
    expect(screen.getByLabelText("Portal address")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toHaveProperty("disabled", true);
  });

  it("offers a real article to check the saved link with", async () => {
    setup(makeSync({ linkStyle: "custom", linkCustom: "support" }), {
      "POST /api/connections/:id/preview": { body: { preview: { count: 1, sample: [{ number: "KB0020002", title: "Refunds", kbName: "Customer Service", updatedAt: "2026-11-01 10:00:00" }] } } },
    });
    await openSettings();
    expect(screen.getByText("Support portal", { selector: "p" })).toBeTruthy();
    const link = await screen.findByRole("link", { name: /Open KB0020002 to check the link/ }, { timeout: 3_000 });
    expect(link.getAttribute("href")).toBe("https://acme.service-now.com/support?id=kb_article_view&sysparm_article=KB0020002");
  });

  it("edits saved categories and languages, including ones that no longer exist", async () => {
    const gone = { id: "f".repeat(32), label: "Old category", kbId: "kb-1" };
    const { api, state } = setup(makeSync({ filters: { categories: [gone], languages: [{ code: "it", label: "Italian" }], articles: null } }), {
      "PUT /api/syncs/:id": (call) => {
        state.sync = { ...state.sync, filters: (call.body as { filters: SyncDTO["filters"] }).filters };
        return { body: { sync: state.sync } };
      },
    });
    await openSettings();
    const row = (await screen.findByText("Categories", { selector: "span" })).parentElement!;
    expect(within(row).getByText("Old category")).toBeTruthy();
    expect(screen.getByText("Italian", { selector: "span" })).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Choose" }));
    const list = screen.getByRole("list", { name: "Categories" });
    const old = within(list).getByRole("checkbox", { name: /Old category/ });
    expect(old.closest("label")?.textContent).toContain("none right now");
    fireEvent.click(old);
    expect(within(row).getByText("All categories")).toBeTruthy();
    expect(within(list).queryByRole("checkbox", { name: /Old category/ })).toBeNull();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings saved")).toBeTruthy();
    expect(screen.getByText("The next run re-checks every article against these settings.")).toBeTruthy();
    expect((api.callsTo("PUT", `/api/syncs/${SYNC_ID}`)[0]?.body as { filters: unknown }).filters).toEqual({
      categories: [],
      languages: [{ code: "it", label: "Italian" }],
      articles: null,
    });
  });

  it("edits hand-picked articles and removes the ones that won't sync", async () => {
    const chosen = [
      { number: "KB0010001", title: "Reset your password", kbId: "kb-1" },
      { number: "KB0010002", title: "Retired article", kbId: "kb-1" },
    ];
    const { api, state } = setup(makeSync({ filters: { categories: [], languages: [], articles: chosen } }), {
      "POST /api/connections/:id/preview": (call) => {
        const { filters } = call.body as { filters: { articles: Array<{ number: string }> } };
        const missing = filters.articles.map((article) => article.number).filter((number) => number === "KB0010002");
        return { body: { preview: { count: filters.articles.length - missing.length, sample: [], missing } } };
      },
      "GET /api/connections/:id/articles": { body: { articles: [], more: false } },
      "PUT /api/syncs/:id": (call) => {
        const { filters } = call.body as { filters: SyncDTO["filters"] };
        if (filters.articles?.length === 0) {
          const fields = [{ path: "filters.articles", message: "Choose at least one article, or switch to all published articles." }];
          return { status: 400, body: errorBody("VALIDATION", "Some fields need attention.", { fields }) };
        }
        state.sync = { ...state.sync, filters };
        return { body: { sync: state.sync } };
      },
    });
    await openSettings();
    expect((screen.getByRole("radio", { name: /Only articles I choose/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(screen.getByRole("list", { name: "Chosen articles" })).getAllByRole("listitem")).toHaveLength(2);
    expect(await screen.findByText("1 chosen article won't be synced", undefined, { timeout: 3_000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings saved")).toBeTruthy();
    expect((api.callsTo("PUT", `/api/syncs/${SYNC_ID}`)[0]?.body as { filters: unknown }).filters).toEqual({ categories: [], languages: [], articles: [chosen[0]] });

    fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Choose at least one article, or switch to all published articles.")).toBeTruthy();
  });

  it("re-uploads every article after confirmation", async () => {
    const { api } = setup(makeSync(), { "POST /api/syncs/:id/run": { body: { outcome: "started", run: makeRun({ status: "queued", phase: "queued", mode: "full" }) } } });
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Re-upload all articles" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Re-upload every article?")).toBeTruthy();
    expect(within(dialog).getByText(/All 44 articles are sent to Genesys Cloud again/)).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Re-upload everything" })));
    expect(await screen.findByText("Full re-upload started")).toBeTruthy();
    expect(api.callsTo("POST", `/api/syncs/${SYNC_ID}/run`)[0]?.body).toEqual({ mode: "full" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the re-upload dialog open when the run can't start", async () => {
    setup(makeSync(), { "POST /api/syncs/:id/run": { status: 503, body: errorBody("GC_UNAVAILABLE", "Genesys Cloud is not responding.", { title: "Genesys Cloud is unavailable" }) } });
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Re-upload all articles" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Re-upload everything" })));
    expect(await screen.findByText("Genesys Cloud is unavailable")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("asks to save first, or to wait for the run, before re-uploading", async () => {
    setup(makeSync());
    await openSettings();
    fireEvent.change(screen.getByLabelText("Sync name"), { target: { value: "Renamed" } });
    expect(screen.getByRole("button", { name: "Re-upload all articles" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Save or discard your changes first.")).toBeTruthy();
  });

  it("previews the article count and validates the ServiceNow condition", async () => {
    const { api } = setup(makeSync(), {
      "POST /api/connections/:id/preview": (call) => {
        const { filterQuery } = call.body as { filterQuery: string };
        if (filterQuery === "bad^^") return { status: 422, body: errorBody("VALIDATION", "ServiceNow didn't accept the filter.") };
        if (filterQuery === "huge") return { body: { preview: { count: 25_000, sample: [] } } };
        if (filterQuery === "down") return { status: 502, body: errorBody("SN_UNREACHABLE", "No answer.", { title: "ServiceNow is unreachable" }) };
        return { body: { preview: { count: 1, sample: [{ number: "KB0010001", title: "Reset your password", kbName: "Customer Service", updatedAt: "2026-11-01 10:00:00" }] } } };
      },
    });
    await openSettings();
    expect(await screen.findByText(/published article will be synced/, undefined, { timeout: 3_000 })).toBeTruthy();
    expect(screen.getByText("Reset your password")).toBeTruthy();
    expect(api.callsTo("POST", `/api/connections/${CONNECTION_ID}/preview`)[0]?.body).toEqual({
      kbIds: ["kb-1"],
      filters: { categories: [], languages: [], articles: null },
      filterQuery: "",
    });

    expect(screen.queryByLabelText(/ServiceNow condition/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add a ServiceNow condition/ }));
    const filter = screen.getByLabelText(/ServiceNow condition/);
    fireEvent.change(filter, { target: { value: "bad^^" } });
    expect(await screen.findByText("ServiceNow didn't accept the filter.", undefined, { timeout: 3_000 })).toBeTruthy();

    fireEvent.change(filter, { target: { value: "huge" } });
    expect(await screen.findByText(/One sync can handle up to 20,000 articles/, undefined, { timeout: 3_000 })).toBeTruthy();

    fireEvent.change(filter, { target: { value: "down" } });
    expect(await screen.findByText("Couldn't count the articles.", undefined, { timeout: 3_000 })).toBeTruthy();
    expect(screen.getByText("ServiceNow is unreachable")).toBeTruthy();
  });

  it("shows a saved ServiceNow condition straight away and hides it on demand", async () => {
    setup(makeSync({ filterQuery: "workflow_state=published" }));
    await openSettings();
    const condition = screen.getByLabelText(/ServiceNow condition/) as HTMLTextAreaElement;
    expect(condition.value).toBe("workflow_state=published");
    const toggle = screen.getByRole("button", { name: /Add a ServiceNow condition/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByLabelText(/ServiceNow condition/)).toBeNull();
  });

  it("clears the knowledge bases when switching connections", async () => {
    const other = makeConnection({ id: "33333333-3333-4333-8333-333333333333", name: "Acme staging", instanceUrl: "https://acme-dev.service-now.com" });
    const { api } = setup(makeSync(), {
      "GET /api/connections": { body: { connections: [makeConnection(), other] } },
      "GET /api/connections/:id/knowledge-bases": (_call, params) => ({
        body: { knowledgeBases: params.id === other.id ? [makeKb({ id: "kb-9", title: "Staging KB" })] : [makeKb(), makeKb({ id: "kb-2", title: "Billing" })] },
      }),
    });
    await openSettings();
    fireEvent.change(screen.getByLabelText("ServiceNow connection"), { target: { value: other.id } });
    const staging = await screen.findByRole("checkbox", { name: /Staging KB/ });
    expect((staging as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/acme-dev\.service-now\.com\/csm/)).toBeTruthy();
    expect(api.callsTo("GET", `/api/connections/${other.id}/knowledge-bases`)).toHaveLength(1);
  });

  it("deletes the sync and returns to the dashboard", async () => {
    const { api } = setup(makeSync(), { "DELETE /api/syncs/:id": { status: 204 } });
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Delete sync" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText('Delete "Customer Help"?')).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete sync" })));
    expect(await screen.findByText("Sync deleted")).toBeTruthy();
    expect(screen.getByText('The knowledge source "ServiceNow - Customer Help" and its articles remain in Genesys Cloud.')).toBeTruthy();
    expect(api.callsTo("DELETE", `/api/syncs/${SYNC_ID}`)).toHaveLength(1);
    expect(navigation.router.push).toHaveBeenCalledWith("/");
  });

  it("keeps the delete dialog open when deletion fails", async () => {
    setup(makeSync(), { "DELETE /api/syncs/:id": { status: 409, body: errorBody("SYNC_ALREADY_RUNNING", "A run is in progress.", { title: "A sync is running" }) } });
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Delete sync" }));
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete sync" })));
    expect(await screen.findByText("A sync is running")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("blocks deletion while a run is active", async () => {
    setup(makeSync({ activeRun: makeRun({ status: "running", phase: "planning", finishedAt: null, durationMs: null }) }));
    await openSettings();
    expect(screen.getByRole("button", { name: "Delete sync" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Wait for the current run to finish, or cancel it, before deleting.")).toBeTruthy();
  });
});
