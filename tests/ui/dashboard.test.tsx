import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dashboard } from "@/components/dashboard";
import { errorBody, mockApi } from "./helpers/api";
import { makeRun, makeSession, makeSync, minutesAhead } from "./helpers/fixtures";
import { renderUi } from "./helpers/render";

const healthy = makeSync();
const running = makeSync({
  id: "sync-running",
  name: "IT Service Desk",
  audience: "itsm",
  activeRun: makeRun({ id: "run-active", syncId: "sync-running", status: "running", phase: "uploading", plannedUploads: 10, uploaded: 4, finishedAt: null, durationMs: null }),
});
const failing = makeSync({ id: "sync-failing", name: "HR Policies", health: "error", statusMessage: "ServiceNow didn't accept the connection's credentials." });
const partial = makeSync({ id: "sync-partial", name: "Partner FAQ", health: "warning", statusMessage: "2 articles couldn't be uploaded.", schedule: { kind: "manual" }, nextRunAt: null });
const paused = makeSync({ id: "sync-paused", name: "Paused sync", enabled: false, lastRun: null, health: "new" });

describe("Dashboard", () => {
  it("summarizes syncs, flags the ones that need attention and greets the user", async () => {
    mockApi({
      "GET /api/session": { body: makeSession({ syncs: 5 }) },
      "GET /api/syncs": { body: { syncs: [healthy, running, failing, partial, paused] } },
    });
    renderUi(<Dashboard />);

    expect(await screen.findByText("Customer Help")).toBeTruthy();
    expect(await screen.findByText(/, Jordan$/)).toBeTruthy();

    const banner = screen.getByRole("alert");
    expect(within(banner).getByText("2 syncs need your attention")).toBeTruthy();
    expect(within(banner).getByRole("link", { name: "HR Policies" }).getAttribute("href")).toBe("/syncs/sync-failing");
    expect(within(banner).getByText(/2 articles couldn't be uploaded/)).toBeTruthy();

    expect(screen.getByText("220")).toBeTruthy();
    expect(screen.getByText("2/5")).toBeTruthy();
    expect(screen.getByText("3 need a look")).toBeTruthy();
    expect(screen.getByText("Running now")).toBeTruthy();

    expect(screen.getByText("Syncing")).toBeTruthy();
    expect(screen.getByText("4 of 10 articles")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("Waiting for the first run.")).toBeTruthy();
    expect(screen.getByText("Manual only")).toBeTruthy();
    expect(screen.queryByText("Get set up in three steps")).toBeNull();
  });

  it("shows the next scheduled run when nothing is running", async () => {
    mockApi({
      "GET /api/session": { body: makeSession() },
      "GET /api/syncs": { body: { syncs: [makeSync({ nextRunAt: minutesAhead(90) })] } },
    });
    renderUi(<Dashboard />);
    expect(await screen.findByText("Next scheduled run")).toBeTruthy();
    expect(screen.getByText("All good")).toBeTruthy();
  });

  it("starts a sync from a card and refreshes the list", async () => {
    const api = mockApi({
      "GET /api/session": { body: makeSession() },
      "GET /api/syncs": { body: { syncs: [healthy] } },
      "POST /api/syncs/:id/run": { body: { outcome: "started", run: makeRun({ status: "queued", phase: "queued" }) } },
    });
    renderUi(<Dashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    expect(await screen.findByText("Sync started")).toBeTruthy();
    const [call] = api.callsTo("POST", `/api/syncs/${healthy.id}/run`);
    expect(call?.body).toEqual({ mode: "incremental" });
    expect(call?.headers.get("x-csrf-token")).toBe("test-csrf-token");
    await waitFor(() => expect(api.callsTo("GET", "/api/syncs").length).toBeGreaterThan(1));
  });

  it("asks before a sync from a card removes articles", async () => {
    const impact = { removals: 2, sample: [{ number: "KB0010001", title: "Reset your password" }, { number: "KB0010002", title: "Change your plan" }], additions: 0 };
    const api = mockApi({
      "GET /api/session": { body: makeSession() },
      "GET /api/syncs": { body: { syncs: [healthy] } },
      "POST /api/syncs/:id/run": (call) =>
        (call.body as { allowRemovals?: boolean }).allowRemovals
          ? { body: { outcome: "started", run: makeRun({ status: "queued", phase: "queued" }) } }
          : { body: { outcome: "confirm_removals", run: null, impact } },
    });
    renderUi(<Dashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove 2 articles from Genesys Cloud?")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Sync and remove them" })));
    expect(await screen.findByText("Sync started")).toBeTruthy();
    expect(api.callsTo("POST", `/api/syncs/${healthy.id}/run`).at(-1)?.body).toEqual({ mode: "incremental", allowRemovals: true });
  });

  it.each([
    ["up_to_date", "Already up to date"],
    ["already_running", "A sync is already running"],
  ])("explains the %s outcome", async (outcome, message) => {
    mockApi({
      "GET /api/session": { body: makeSession() },
      "GET /api/syncs": { body: { syncs: [healthy] } },
      "POST /api/syncs/:id/run": { body: { outcome, run: null } },
    });
    renderUi(<Dashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("shows why a sync couldn't start", async () => {
    mockApi({
      "GET /api/session": { body: makeSession() },
      "GET /api/syncs": { body: { syncs: [healthy] } },
      "POST /api/syncs/:id/run": { status: 409, body: errorBody("GC_CREDENTIALS_MISSING", "Syncs don't have access to Genesys Cloud yet.", { title: "Genesys Cloud access missing" }) },
    });
    renderUi(<Dashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Genesys Cloud access missing")).toBeTruthy();
  });

  it("guides a new organization through setup", async () => {
    mockApi({
      "GET /api/session": { body: makeSession({ connections: 1, gcCredentials: "error", syncs: 0 }) },
      "GET /api/syncs": { body: { syncs: [] } },
    });
    renderUi(<Dashboard />);
    expect(await screen.findByText("Get set up in three steps")).toBeTruthy();
    expect(screen.getByText("1 of 3 done")).toBeTruthy();
    expect(screen.getByText("Give syncs access to Genesys Cloud")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Fix access/ }).getAttribute("href")).toBe("/connections#genesys");
    expect(screen.getByRole("link", { name: /Create a sync/ }).getAttribute("href")).toBe("/syncs/new");
    expect(screen.queryByText("Everything's connected")).toBeNull();
  });

  it("invites the first sync once everything is connected", async () => {
    mockApi({
      "GET /api/session": { body: makeSession({ connections: 1, gcCredentials: "ok", syncs: 0 }) },
      "GET /api/syncs": { body: { syncs: [] } },
    });
    renderUi(<Dashboard />);
    expect(await screen.findByText("Everything's connected")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create your first sync" }).getAttribute("href")).toBe("/syncs/new");
  });

  it("offers a retry when the list fails to load", async () => {
    const api = mockApi({
      "GET /api/session": { body: makeSession() },
      "GET /api/syncs": { status: 503, body: errorBody("INTERNAL", "Something went wrong on our side.", { title: "Unexpected error" }) },
    });
    renderUi(<Dashboard />);
    expect(await screen.findByText("Unexpected error")).toBeTruthy();
    api.set("GET /api/syncs", { body: { syncs: [healthy] } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Customer Help")).toBeTruthy();
  });
});
