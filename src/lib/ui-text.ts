import type { ArticleState, Audience, LinkStyle, RunPhase, RunStatus, RunTrigger, SnAuthType, SyncHealth } from "./api-types";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "active";

export const HEALTH: Record<SyncHealth, { label: string; tone: Tone }> = {
  new: { label: "Not run yet", tone: "neutral" },
  healthy: { label: "Healthy", tone: "success" },
  warning: { label: "Needs attention", tone: "warning" },
  error: { label: "Failing", tone: "danger" },
};

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "active" },
  running: { label: "Running", tone: "active" },
  succeeded: { label: "Succeeded", tone: "success" },
  partial: { label: "Partly synced", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  noop: { label: "Up to date", tone: "success" },
};

export const PHASE_LABEL: Record<RunPhase, string> = {
  queued: "Waiting to start",
  planning: "Comparing articles",
  uploading: "Uploading articles",
  deleting: "Removing retired articles",
  committing: "Handing over to Genesys Cloud",
  processing: "Genesys Cloud is indexing",
  finalizing: "Finishing up",
  done: "Done",
};

/** Steps shown in the live progress tracker, in order. */
export const PHASE_STEPS: ReadonlyArray<{ label: string; phases: RunPhase[] }> = [
  { label: "Compare", phases: ["queued", "planning"] },
  { label: "Upload", phases: ["uploading", "deleting"] },
  { label: "Commit", phases: ["committing"] },
  { label: "Index", phases: ["processing", "finalizing"] },
];

export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: "Manual",
  schedule: "Scheduled",
  initial: "First sync",
};

export const AUDIENCE: Record<Audience, { label: string; short: string; description: string }> = {
  csm: { label: "Customers (CSM)", short: "CSM", description: "Customer Service Management articles for customer-facing bots and agents." },
  itsm: { label: "Employees (ITSM)", short: "ITSM", description: "IT Service Management articles for employee help desks." },
};

export const LINK_STYLES: ReadonlyArray<{ value: LinkStyle; label: string; path: string }> = [
  { value: "csm", label: "Customer Service Portal", path: "/csm" },
  { value: "csp", label: "Consumer Service Portal", path: "/csp" },
  { value: "esc", label: "Employee Center", path: "/esc" },
  { value: "sp", label: "Service Portal", path: "/sp" },
  { value: "classic", label: "Classic UI", path: "/kb_view.do" },
  { value: "custom", label: "Another portal", path: "/<suffix>" },
];

export function defaultLinkStyle(audience: Audience): LinkStyle {
  return audience === "csm" ? "csm" : "esc";
}

export const ARTICLE_STATE: Record<ArticleState, { label: string; tone: Tone }> = {
  synced: { label: "Synced", tone: "success" },
  error: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "warning" },
  pending_delete: { label: "Removing", tone: "neutral" },
};

export const AUTH_TYPES: Record<SnAuthType, { label: string; description: string }> = {
  basic: { label: "Username & password", description: "A ServiceNow integration user with basic authentication." },
  oauth: { label: "OAuth client", description: "An OAuth application registry entry using the client credentials grant." },
  apikey: { label: "API key", description: "A REST API key (Washington DC release and later)." },
};

export const GC_PERMISSIONS: ReadonlyArray<{ name: string; optional?: boolean }> = [
  { name: "knowledge:source:view" },
  { name: "knowledge:source:add" },
  { name: "knowledge:synchronization:add" },
  { name: "knowledge:synchronization:view" },
  { name: "knowledge:synchronization:edit" },
  { name: "knowledge:synchronization:upload" },
  { name: "knowledge:synchronization:deleteFile" },
  { name: "knowledge:sourceFileCount:view", optional: true },
];

export const SN_REQUIREMENTS: ReadonlyArray<{ name: string; detail: string }> = [
  { name: "knowledge", detail: "Role that can read the knowledge bases and their articles." },
  { name: "snc_platform_rest_api_access", detail: "Role needed only when your instance enforces REST API access ACLs." },
  { name: "Knowledge API (sn_km_api)", detail: "Optional plugin. Lets template-based articles sync with their full body." },
];

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
