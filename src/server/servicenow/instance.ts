import dns from "node:dns/promises";
import net from "node:net";
import { AppError } from "@/lib/errors";

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".test", ".invalid", ".example", ".intranet", ".corp"];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalizes what people paste ("acme", "acme.service-now.com", "https://acme.service-now.com/now/nav/ui")
 * to "https://<host>". Only public HTTPS hosts on the default port are accepted.
 */
export function normalizeInstanceUrl(input: string): string {
  let value = input.trim();
  if (!value) throw new AppError("SN_INVALID_URL", { detail: "empty instance URL" });
  if (/^[a-z0-9-]+$/i.test(value)) value = `${value}.service-now.com`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("SN_INVALID_URL", { detail: "unparseable instance URL" });
  }
  if (url.protocol !== "https:") throw new AppError("SN_INVALID_URL", { message: "The instance URL must use https://.", detail: "non-https scheme" });
  if (url.username || url.password) throw new AppError("SN_INVALID_URL", { message: "Remove credentials from the instance URL.", detail: "credentials in URL" });
  if (url.port && url.port !== "443") throw new AppError("SN_INVALID_URL", { detail: "non-default port" });

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  assertAcceptableHostname(host);
  return `https://${host}`;
}

export function assertAcceptableHostname(host: string): void {
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) {
    throw new AppError("SN_INVALID_URL", { message: "Use the instance's host name, not an IP address.", detail: "IP literal host" });
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new AppError("SN_INVALID_URL", { detail: "non-public host name" });
  }
  const labels = host.split(".");
  if (labels.length < 2 || host.length > 253 || !labels.every((label) => LABEL.test(label)) || !/^[a-z]{2,}$/.test(labels.at(-1) ?? "")) {
    throw new AppError("SN_INVALID_URL", { detail: "malformed host name" });
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
];

/** Eight 16-bit groups of a valid IPv6 address (zone ID dropped, embedded IPv4 expanded). */
function ipv6Groups(ip: string): number[] {
  let value = ip.toLowerCase().split("%", 1)[0] ?? "";
  const embedded = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embedded) {
    const number = ipv4ToInt(embedded);
    value = `${value.slice(0, -embedded.length)}${(number >>> 16).toString(16)}:${(number & 0xffff).toString(16)}`;
  }
  const [head = "", tail] = value.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - headParts.length - tailParts.length).fill("0");
  return [...headParts, ...zeros, ...tailParts].map((part) => Number.parseInt(part, 16));
}

function ipv4From(high: number, low: number): string {
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isPrivateV6(groups: number[]): boolean {
  const [a = 0, b = 0, c = 0, , , f = 0, g = 0, h = 0] = groups;
  const allZeroUntil = (end: number) => groups.slice(0, end).every((group) => group === 0);
  if (allZeroUntil(8)) return true;
  if (allZeroUntil(7) && h === 1) return true;
  if (allZeroUntil(5) && f === 0xffff) return isPrivateAddress(ipv4From(g, h));
  if (allZeroUntil(6)) return true;
  if (a === 0x64 && b === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return isPrivateAddress(ipv4From(g, h));
  if (a === 0x2002) return isPrivateAddress(ipv4From(b, c));
  if ((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00) return true;
  if (a === 0x2001 && b === 0x0db8) return true;
  return a === 0x0100 && groups.slice(1, 4).every((group) => group === 0);
}

/** True for loopback, private, link-local, shared, documentation and multicast ranges (and anything unparseable). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const value = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip.split("%", 1)[0] ?? "")) return isPrivateV6(ipv6Groups(ip));
  return true;
}

type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

let resolver: Resolver = defaultResolver;
const verifiedHosts = new Map<string, number>();
const VERIFIED_TTL_MS = 10 * 60_000;

/** Test hook: replace DNS resolution. Pass null to restore the real resolver. */
export function configureHostResolver(custom: Resolver | null): void {
  resolver = custom ?? defaultResolver;
  verifiedHosts.clear();
}

/** Rejects hosts that resolve to private, loopback or link-local addresses (SSRF guard). */
export async function assertPublicHost(host: string): Promise<void> {
  const cachedUntil = verifiedHosts.get(host);
  if (cachedUntil && cachedUntil > Date.now()) return;
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new AppError("SN_UNREACHABLE", { message: "We couldn't find that ServiceNow instance.", detail: "DNS lookup failed" });
  }
  if (addresses.length === 0) throw new AppError("SN_UNREACHABLE", { detail: "DNS returned no addresses" });
  if (addresses.some(isPrivateAddress)) {
    throw new AppError("SN_INVALID_URL", { detail: "host resolves to a non-public address" });
  }
  verifiedHosts.set(host, Date.now() + VERIFIED_TTL_MS);
}
