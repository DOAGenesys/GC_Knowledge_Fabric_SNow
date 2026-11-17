import { describe, expect, it, vi } from "vitest";
import { connectionBody } from "@/components/connections/connection-dialog";
import { runProgress } from "@/components/syncs/run-progress";
import { browserTimeZone, suggestLinkStyle } from "@/components/syncs/sync-fields";
import type { LinkStyle, RunPhase, RunStatus } from "@/lib/api-types";
import { AUDIENCE, AUTH_TYPES, defaultLinkStyle, firstName, greeting, LINK_STYLES, PHASE_LABEL, PHASE_STEPS, RUN_STATUS } from "@/lib/ui-text";
import { makeRun } from "./helpers/fixtures";

describe("runProgress", () => {
  it("measures uploads, counting failures and skips as done", () => {
    expect(runProgress(makeRun({ status: "running", phase: "uploading", plannedUploads: 10, uploaded: 3, failed: 1, skipped: 1 }))).toEqual({
      value: 0.5,
      label: "Uploading articles",
      detail: "5 of 10 articles",
    });
  });

  it("measures deletions", () => {
    expect(runProgress(makeRun({ status: "running", phase: "deleting", plannedDeletions: 4, deleted: 1 }))).toEqual({
      value: 0.25,
      label: "Removing retired articles",
      detail: "1 of 4 retired articles",
    });
  });

  it("is indeterminate while Genesys Cloud indexes", () => {
    expect(runProgress(makeRun({ status: "running", phase: "processing", gcIngestionStatus: "InProgress" }))).toMatchObject({ value: null, detail: "Genesys Cloud status: InProgress" });
    expect(runProgress(makeRun({ status: "running", phase: "processing", gcIngestionStatus: null })).detail).toBe("This usually takes a minute or two.");
  });

  it("summarizes changes while committing", () => {
    expect(runProgress(makeRun({ status: "running", phase: "committing", uploaded: 2, deleted: 1 })).detail).toBe("3 changes sent");
    expect(runProgress(makeRun({ status: "running", phase: "finalizing", uploaded: 0, deleted: 0 })).detail).toBeNull();
  });

  it("labels early phases and cancellations", () => {
    expect(runProgress(makeRun({ status: "queued", phase: "queued" }))).toEqual({ value: null, label: "Waiting to start", detail: null });
    expect(runProgress(makeRun({ status: "running", phase: "planning", cancelRequested: true })).label).toBe("Cancelling…");
    expect(runProgress(makeRun({ status: "running", phase: "uploading", plannedUploads: 0 })).value).toBeNull();
  });
});

describe("suggestLinkStyle", () => {
  it.each<[string, "csm" | "itsm", string[], { linkStyle: LinkStyle; linkCustom: string }]>([
    ["CSM portal for customer knowledge", "csm", ["csm"], { linkStyle: "csm", linkCustom: "" }],
    ["consumer portal before employee portals", "csm", ["esc", "csp"], { linkStyle: "csp", linkCustom: "" }],
    ["employee portals first for ITSM", "itsm", ["csm", "sp"], { linkStyle: "sp", linkCustom: "" }],
    ["Employee Center for ITSM", "itsm", ["sp", "esc"], { linkStyle: "esc", linkCustom: "" }],
    ["a custom portal suffix", "csm", ["Support"], { linkStyle: "custom", linkCustom: "support" }],
    ["the audience default without portals", "csm", [], { linkStyle: "csm", linkCustom: "" }],
    ["the ITSM default without portals", "itsm", [], { linkStyle: "esc", linkCustom: "" }],
    ["the default when the suffix is unusable", "itsm", ["bad suffix!"], { linkStyle: "esc", linkCustom: "" }],
  ])("picks %s", (_label, audience, portals, expected) => {
    expect(suggestLinkStyle(audience, portals)).toEqual(expected);
  });
});

describe("connectionBody", () => {
  const base = { name: "  Acme  ", instanceUrl: " acme ", username: " svc ", password: "", clientId: " cid ", clientSecret: "", apiKey: "" };

  it("trims fields and omits blank secrets so saved ones are kept", () => {
    expect(connectionBody({ ...base, authType: "basic" })).toEqual({ name: "Acme", instanceUrl: "acme", auth: { type: "basic", username: "svc", password: undefined } });
    expect(connectionBody({ ...base, authType: "oauth" })).toEqual({ name: "Acme", instanceUrl: "acme", auth: { type: "oauth", clientId: "cid", clientSecret: undefined } });
    expect(connectionBody({ ...base, authType: "apikey" })).toEqual({ name: "Acme", instanceUrl: "acme", auth: { type: "apikey", apiKey: undefined } });
  });

  it("sends secrets that were entered", () => {
    expect(connectionBody({ ...base, authType: "basic", password: "pw-not-real" }).auth).toEqual({ type: "basic", username: "svc", password: "pw-not-real" });
    expect(connectionBody({ ...base, authType: "apikey", apiKey: "key-not-real" }).auth).toEqual({ type: "apikey", apiKey: "key-not-real" });
  });
});

describe("ui text", () => {
  it("greets by time of day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 8, 0));
    expect(greeting()).toBe("Good morning");
    vi.setSystemTime(new Date(2026, 0, 1, 14, 0));
    expect(greeting()).toBe("Good afternoon");
    vi.setSystemTime(new Date(2026, 0, 1, 21, 0));
    expect(greeting()).toBe("Good evening");
    expect(greeting(new Date(2026, 0, 1, 3, 0))).toBe("Good evening");
  });

  it("extracts a first name", () => {
    expect(firstName("Jordan Example")).toBe("Jordan");
    expect(firstName("  Sam  ")).toBe("Sam");
  });

  it("covers every status, phase, link style and auth type", () => {
    const statuses: RunStatus[] = ["queued", "running", "succeeded", "partial", "failed", "cancelled", "noop"];
    const phases: RunPhase[] = ["queued", "planning", "uploading", "deleting", "committing", "processing", "finalizing", "done"];
    for (const status of statuses) expect(RUN_STATUS[status].label).toBeTruthy();
    for (const phase of phases) expect(PHASE_LABEL[phase]).toBeTruthy();
    expect(PHASE_STEPS.flatMap((step) => step.phases)).toEqual(phases.filter((phase) => phase !== "done"));
    expect(LINK_STYLES.map((style) => style.value).sort()).toEqual(["classic", "csm", "csp", "custom", "esc", "sp"]);
    expect(Object.keys(AUTH_TYPES).sort()).toEqual(["apikey", "basic", "oauth"]);
    expect(AUDIENCE.csm.short).toBe("CSM");
  });

  it("defaults links per audience", () => {
    expect(defaultLinkStyle("csm")).toBe("csm");
    expect(defaultLinkStyle("itsm")).toBe("esc");
  });

  it("detects the browser time zone", () => {
    expect(browserTimeZone()).toMatch(/\w/);
  });
});
