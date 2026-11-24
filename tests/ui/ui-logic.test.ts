import { describe, expect, it, vi } from "vitest";
import { connectionBody, suggestedConnectionName } from "@/components/connections/connection-dialog";
import { runProgress } from "@/components/syncs/run-progress";
import { browserTimeZone, gmtOffset, suggestLinkStyle } from "@/components/syncs/sync-fields";
import type { LinkStyle, RunPhase, RunStatus } from "@/lib/api-types";
import {
  articleLink,
  AUDIENCE,
  AUTH_TYPES,
  defaultLinkStyle,
  firstName,
  gcAdminRequest,
  GC_PERMISSIONS,
  greeting,
  LINK_STYLES,
  linkStyleLabel,
  PHASE_LABEL,
  PHASE_STEPS,
  portalName,
  portalSuffixFrom,
  RUN_STATUS,
} from "@/lib/ui-text";
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
      label: "Removing articles that left ServiceNow",
      detail: "1 of 4 articles removed",
    });
  });

  it("is indeterminate while Genesys Cloud makes the articles searchable", () => {
    expect(runProgress(makeRun({ status: "running", phase: "processing", gcIngestionStatus: "InProgress" }))).toMatchObject({
      value: null,
      label: "Genesys Cloud is making the articles searchable",
      detail: "This usually takes a minute or two.",
    });
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

  it("names the connection after the instance when the name is left blank", () => {
    expect(connectionBody({ ...base, name: " ", authType: "basic" }).name).toBe("Acme ServiceNow");
    expect(suggestedConnectionName("https://acme-dev.service-now.com/now/nav/ui")).toBe("Acme-dev ServiceNow");
    expect(suggestedConnectionName("kb.example.com")).toBe("kb.example.com");
    expect(suggestedConnectionName("")).toBe("");
    expect(suggestedConnectionName("http://[bad")).toBe("");
  });
});

describe("links and portals", () => {
  it("builds the same article links the sync writes", () => {
    expect(articleLink("https://acme.service-now.com", "csm", "", "KB001")).toBe("https://acme.service-now.com/csm?id=kb_article_view&sysparm_article=KB001");
    expect(articleLink("https://acme.service-now.com", "custom", "support", "KB001")).toBe("https://acme.service-now.com/support?id=kb_article_view&sysparm_article=KB001");
    expect(articleLink("https://acme.service-now.com", "classic", "", "KB001")).toBe("https://acme.service-now.com/kb_view.do?sysparm_article=KB001");
  });

  it("gives portals friendly names", () => {
    expect(portalName("business_portal")).toBe("Business Portal");
    expect(portalName("ESC")).toBe("Employee Center");
    expect(portalName("help-center")).toBe("Help center portal");
    expect(portalName("")).toBe("Portal");
    expect(linkStyleLabel("custom", "support")).toBe("Support portal");
    expect(linkStyleLabel("custom", "")).toBe("Another portal");
    expect(linkStyleLabel("classic", "")).toBe("ServiceNow classic view");
  });

  it.each([
    ["https://acme.service-now.com/support?id=kb_home", "support"],
    ["acme.service-now.com/help/en", "help"],
    ["/support", "support"],
    ["support", "support"],
    ["acme.service-now.com", ""],
    ["  ", ""],
  ])("reads the portal from %j", (input, expected) => {
    expect(portalSuffixFrom(input)).toBe(expected);
  });

  it("shows time zones with their offset", () => {
    expect(gmtOffset("UTC", new Date("2026-01-15T12:00:00Z"))).toBe("GMT+00:00");
    expect(gmtOffset("Europe/Madrid", new Date("2026-01-15T12:00:00Z"))).toBe("GMT+01:00");
    expect(gmtOffset("Not/AZone")).toBe("");
  });

  it("writes an admin request that lists every required permission", () => {
    const request = gcAdminRequest();
    for (const permission of GC_PERMISSIONS.filter((item) => !item.optional)) expect(request).toContain(permission.name);
    expect(request).toContain("Client Credentials");
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
    expect(AUDIENCE.itsm.label).toBe("ITSM (IT Service Management)");
  });

  it("defaults links per audience", () => {
    expect(defaultLinkStyle("csm")).toBe("csm");
    expect(defaultLinkStyle("itsm")).toBe("esc");
  });

  it("detects the browser time zone", () => {
    expect(browserTimeZone()).toMatch(/\w/);
  });
});
