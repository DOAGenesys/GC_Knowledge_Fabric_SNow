/**
 * Genesys Cloud regions. Sign-in only ever talks to hosts in this list: accepting an
 * arbitrary host would let a crafted login link point the token exchange at a server
 * that could impersonate any organization.
 */
export interface GenesysRegion {
  host: string;
  label: string;
  area: "Americas" | "EMEA" | "Asia Pacific";
}

export const GENESYS_REGIONS: readonly GenesysRegion[] = [
  { host: "mypurecloud.com", label: "US East (Virginia)", area: "Americas" },
  { host: "use2.us-gov-pure.cloud", label: "US East 2 (FedRAMP)", area: "Americas" },
  { host: "usw2.pure.cloud", label: "US West (Oregon)", area: "Americas" },
  { host: "cac1.pure.cloud", label: "Canada (Central)", area: "Americas" },
  { host: "sae1.pure.cloud", label: "South America (São Paulo)", area: "Americas" },
  { host: "mypurecloud.ie", label: "Europe (Dublin)", area: "EMEA" },
  { host: "euw2.pure.cloud", label: "Europe (London)", area: "EMEA" },
  { host: "mypurecloud.de", label: "Europe (Frankfurt)", area: "EMEA" },
  { host: "euc2.pure.cloud", label: "Europe (Zurich)", area: "EMEA" },
  { host: "mec1.pure.cloud", label: "Middle East (UAE)", area: "EMEA" },
  { host: "aps1.pure.cloud", label: "Asia Pacific (Mumbai)", area: "Asia Pacific" },
  { host: "apne2.pure.cloud", label: "Asia Pacific (Seoul)", area: "Asia Pacific" },
  { host: "mypurecloud.jp", label: "Asia Pacific (Tokyo)", area: "Asia Pacific" },
  { host: "apne3.pure.cloud", label: "Asia Pacific (Osaka)", area: "Asia Pacific" },
  { host: "mypurecloud.com.au", label: "Asia Pacific (Sydney)", area: "Asia Pacific" },
] as const;

const KNOWN_HOSTS = new Set(GENESYS_REGIONS.map((region) => region.host));

/**
 * Accepts "mypurecloud.de", "api.mypurecloud.de", "login.mypurecloud.de",
 * "https://apps.mypurecloud.de/directory" and similar. Returns the bare region host
 * ("mypurecloud.de") or null when it isn't a known Genesys Cloud region.
 */
export function normalizeRegion(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/, 1)[0] ?? "";
  value = value.replace(/:\d+$/, "").replace(/\.$/, "");
  value = value.replace(/^(api|login|apps)\./, "");
  return KNOWN_HOSTS.has(value) ? value : null;
}

export function apiHost(region: string): string {
  return `api.${region}`;
}

export function loginHost(region: string): string {
  return `login.${region}`;
}

export function appsHost(region: string): string {
  return `apps.${region}`;
}

export function regionLabel(region: string): string {
  return GENESYS_REGIONS.find((item) => item.host === region)?.label ?? region;
}
