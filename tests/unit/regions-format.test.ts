import { describe, expect, it } from "vitest";
import { formatDateTime, formatDuration, formatNumber, formatRelative, plural, truncate } from "@/lib/format";
import { apiHost, appsHost, GENESYS_REGIONS, loginHost, normalizeRegion, regionLabel } from "@/lib/regions";

describe("normalizeRegion", () => {
  it.each([
    ["mypurecloud.de", "mypurecloud.de"],
    ["api.mypurecloud.de", "mypurecloud.de"],
    ["login.mypurecloud.ie", "mypurecloud.ie"],
    ["https://apps.usw2.pure.cloud/directory/#/admin", "usw2.pure.cloud"],
    ["  MyPureCloud.com ", "mypurecloud.com"],
    ["mypurecloud.com.au.", "mypurecloud.com.au"],
    ["mypurecloud.de:443", "mypurecloud.de"],
    ["https://login.euw2.pure.cloud/oauth/authorize?client_id=x", "euw2.pure.cloud"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeRegion(input)).toBe(expected);
  });

  it.each(["evil.example", "mypurecloud.de.evil.example", "evil.example/mypurecloud.de", "login.evil.example", "", "   ", null, undefined])(
    "rejects %s",
    (input) => {
      expect(normalizeRegion(input)).toBeNull();
    },
  );

  it("knows every region once and derives its hosts", () => {
    const hosts = GENESYS_REGIONS.map((region) => region.host);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(apiHost("mypurecloud.de")).toBe("api.mypurecloud.de");
    expect(loginHost("mypurecloud.de")).toBe("login.mypurecloud.de");
    expect(appsHost("mypurecloud.de")).toBe("apps.mypurecloud.de");
    expect(regionLabel("mypurecloud.de")).toBe("Europe (Frankfurt)");
    expect(regionLabel("unknown.example")).toBe("unknown.example");
  });
});

describe("format helpers", () => {
  it("pluralizes with thousands separators", () => {
    expect(plural(1, "article")).toBe("1 article");
    expect(plural(0, "article")).toBe("0 articles");
    expect(plural(1234, "entry", "entries")).toBe("1,234 entries");
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it.each([
    [-1, "—"],
    [Number.NaN, "—"],
    [250, "250 ms"],
    [1499, "1s"],
    [59_400, "59s"],
    [60_000, "1m"],
    [95_000, "1m 35s"],
    [3_600_000, "1h"],
    [5_400_000, "1h 30m"],
  ])("formats a duration of %s ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("describes relative times", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(formatRelative(null, now)).toBe("never");
    expect(formatRelative("garbage", now)).toBe("—");
    expect(formatRelative(new Date(now.getTime() - 10_000), now)).toBe("just now");
    expect(formatRelative(new Date(now.getTime() + 10_000), now)).toBe("in a moment");
    expect(formatRelative(new Date(now.getTime() - 5 * 60_000), now)).toBe("5 minutes ago");
    expect(formatRelative(new Date(now.getTime() + 2 * 3600_000), now)).toBe("in 2 hours");
    expect(formatRelative("2026-11-16T12:00:00Z", now)).toBe("yesterday");
    expect(formatRelative(new Date(now.getTime() - 3 * 7 * 24 * 3600_000), now)).toBe("3 weeks ago");
  });

  it("formats absolute dates in a given time zone", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("nope")).toBe("—");
    expect(formatDateTime("2026-11-17T08:00:00Z", "UTC")).toMatch(/17 Nov 2026.*08:00/);
    expect(formatDateTime("2026-11-17T08:00:00Z", "Europe/Madrid")).toMatch(/17 Nov 2026.*09:00/);
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a long sentence", 6)).toBe("a lon…");
  });
});
