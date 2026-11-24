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
  planning: "Checking for changes",
  uploading: "Uploading articles",
  deleting: "Removing articles that left ServiceNow",
  committing: "Publishing to Genesys Cloud",
  processing: "Genesys Cloud is making the articles searchable",
  finalizing: "Finishing up",
  done: "Done",
};

/** Steps shown in the live progress tracker, in order. */
export const PHASE_STEPS: ReadonlyArray<{ label: string; phases: RunPhase[] }> = [
  { label: "Check for changes", phases: ["queued", "planning"] },
  { label: "Upload", phases: ["uploading", "deleting"] },
  { label: "Publish", phases: ["committing"] },
  { label: "Make searchable", phases: ["processing", "finalizing"] },
];

export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: "Manual",
  schedule: "Scheduled",
  initial: "First sync",
};

export const AUDIENCE: Record<Audience, { label: string; short: string; description: string }> = {
  csm: { label: "Customers", short: "For customers", description: "Help articles for your customers, used by customer-facing bots and agents." },
  itsm: { label: "Employees", short: "For employees", description: "Internal articles for your staff, used by IT and HR help desks." },
};

export const LINK_STYLES: ReadonlyArray<{ value: LinkStyle; label: string; path: string; description: string }> = [
  { value: "csm", label: "Customer Service Portal", path: "/csm", description: "ServiceNow's portal for business customers." },
  { value: "csp", label: "Consumer Service Portal", path: "/csp", description: "ServiceNow's portal for consumers." },
  { value: "esc", label: "Employee Center", path: "/esc", description: "ServiceNow's portal for employees." },
  { value: "sp", label: "Service Portal", path: "/sp", description: "ServiceNow's standard self-service portal." },
  { value: "classic", label: "ServiceNow classic view", path: "/kb_view.do", description: "Opens the article inside ServiceNow, so readers need a ServiceNow login." },
  { value: "custom", label: "Another portal", path: "", description: "A portal with its own address, like /support." },
];

export function defaultLinkStyle(audience: Audience): LinkStyle {
  return audience === "csm" ? "csm" : "esc";
}

const PORTAL_NAMES: Record<string, string> = {
  csm: "Customer Service Portal",
  csp: "Consumer Service Portal",
  esc: "Employee Center",
  sp: "Service Portal",
  business_portal: "Business Portal",
  hrportal: "HR Portal",
  ess: "Employee Self-Service",
};

/** "business_portal" → "Business Portal", "support" → "Support portal". */
export function portalName(suffix: string): string {
  const known = PORTAL_NAMES[suffix.toLowerCase()];
  if (known) return known;
  const words = suffix.replace(/[_-]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)} portal` : "Portal";
}

export function linkStyleLabel(linkStyle: LinkStyle, linkCustom: string): string {
  if (linkStyle === "custom") return linkCustom ? portalName(linkCustom) : "Another portal";
  return LINK_STYLES.find((item) => item.value === linkStyle)?.label ?? linkStyle;
}

/** Same link the sync writes into each article. */
export function articleLink(instanceUrl: string, linkStyle: LinkStyle, linkCustom: string, articleNumber: string): string {
  if (linkStyle === "classic") return `${instanceUrl}/kb_view.do?sysparm_article=${articleNumber}`;
  return `${instanceUrl}/${linkStyle === "custom" ? linkCustom || "portal" : linkStyle}?id=kb_article_view&sysparm_article=${articleNumber}`;
}

/** The portal name from a pasted address ("https://acme.service-now.com/support?id=kb_home" → "support") or a typed name. */
export function portalSuffixFrom(text: string): string {
  const value = text.trim();
  if (!value) return "";
  const withScheme = /^https?:\/\//i.test(value) ? value : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(value) ? `https://${value}` : `https://portal.invalid/${value.replace(/^\/+/, "")}`;
  try {
    return new URL(withScheme).pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return value;
  }
}

export const ARTICLE_STATE: Record<ArticleState, { label: string; tone: Tone }> = {
  synced: { label: "Synced", tone: "success" },
  error: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "warning" },
  pending_delete: { label: "Removing", tone: "neutral" },
};

export const AUTH_TYPES: Record<SnAuthType, { label: string; description: string }> = {
  basic: { label: "Username and password", description: "A ServiceNow user set aside for this app. The simplest option." },
  oauth: { label: "OAuth client", description: "A client ID and secret from ServiceNow's Application Registry." },
  apikey: { label: "API key", description: "A ServiceNow REST API key (Washington DC release or later)." },
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

/** Text to paste into a request to the Genesys Cloud admin. */
export function gcAdminRequest(): string {
  const required = GC_PERMISSIONS.filter((permission) => !permission.optional).map((permission) => `   - ${permission.name}`);
  const optional = GC_PERMISSIONS.filter((permission) => permission.optional).map((permission) => permission.name);
  return [
    "Hi! I'm setting up the ServiceNow knowledge sync for our Genesys Cloud organization. Could you create an OAuth client for it?",
    "",
    "1. Admin > Roles / Permissions: create a role (for example \"Knowledge sync\") with these permissions:",
    ...required,
    `   Optional, to show file counts: ${optional.join(", ")}`,
    "2. Admin > Integrations > OAuth: add a client with the \"Client Credentials\" grant type and give it that role in the home division.",
    "3. Send me the client ID and client secret through a secure channel.",
    "",
    "Thanks!",
  ].join("\n");
}

export const SN_REQUIREMENTS: ReadonlyArray<{ name: string; detail: string }> = [
  { name: "Can read the knowledge bases", detail: "Give the user the knowledge role, and make sure each knowledge base's \"Can read\" settings include it." },
  { name: "Can use the REST API", detail: "Only if your instance restricts REST API access: also give it the snc_platform_rest_api_access role." },
  { name: "Optional: Knowledge API", detail: "If the Knowledge Management API plugin (sn_km_api) is active, articles built from templates keep their full content." },
];

/** Text to paste into a request to the ServiceNow admin. */
export const SN_ADMIN_REQUEST = [
  "Hi! I'm connecting our ServiceNow knowledge bases to Genesys Cloud so bots and agents can use the articles.",
  "Could you create a ServiceNow user for this integration (read-only is enough) and send me its username and password?",
  "",
  "The user needs:",
  "- The knowledge role, with read access to these knowledge bases: <list the knowledge bases>",
  "- The snc_platform_rest_api_access role, if our instance restricts REST API access",
  "- The \"Web service access only\" option, so it can't sign in to the ServiceNow UI",
  "",
  "If you prefer an OAuth client (client credentials) or a REST API key instead, that works too.",
  "Thanks!",
].join("\n");

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
