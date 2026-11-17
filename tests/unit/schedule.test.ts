import { describe, expect, it } from "vitest";
import {
  computeNextRun,
  describeSchedule,
  isValidTimeZone,
  nextRunAfterFailure,
  parseSchedule,
  retryDelayMs,
  type Schedule,
  scheduleIsAutomatic,
  scheduleSchema,
  zonedTimeToUtc,
} from "@/lib/schedule";

const at = (iso: string) => new Date(iso);
const iso = (date: Date | null) => date?.toISOString() ?? null;
const MINUTE = 60_000;

describe("computeNextRun", () => {
  it("never schedules manual syncs", () => {
    expect(computeNextRun({ kind: "manual" }, at("2026-11-17T08:00:00Z"))).toBeNull();
  });

  it("adds the interval to the given time", () => {
    expect(iso(computeNextRun({ kind: "interval", minutes: 30 }, at("2026-11-17T08:00:00Z")))).toBe("2026-11-17T08:30:00.000Z");
  });

  it.each([
    ["later today", "09:00", "Europe/Madrid", "2026-11-17T07:00:00Z", "2026-11-17T08:00:00.000Z"],
    ["strictly after: exactly at the slot goes to tomorrow", "09:00", "Europe/Madrid", "2026-11-17T08:00:00Z", "2026-11-18T08:00:00.000Z"],
    ["across the spring-forward change", "09:00", "Europe/Madrid", "2026-03-28T09:00:00Z", "2026-03-29T07:00:00.000Z"],
    ["a time inside the DST gap moves forward", "02:30", "Europe/Madrid", "2026-03-28T12:00:00Z", "2026-03-29T01:30:00.000Z"],
    ["an ambiguous fall-back time resolves to its first occurrence", "02:30", "Europe/Madrid", "2026-10-24T12:00:00Z", "2026-10-25T00:30:00.000Z"],
    ["and runs only once that day", "02:30", "Europe/Madrid", "2026-10-25T00:30:00Z", "2026-10-26T01:30:00.000Z"],
    ["half-hour offsets", "06:15", "Asia/Kolkata", "2026-11-17T00:00:00Z", "2026-11-17T00:45:00.000Z"],
    ["UTC", "23:59", "UTC", "2026-12-31T23:59:30Z", "2027-01-01T23:59:00.000Z"],
  ])("daily: %s", (_label, time, tz, after, expected) => {
    expect(iso(computeNextRun({ kind: "daily", time, tz }, at(after)))).toBe(expected);
  });

  it.each([
    ["the next listed day this week", [1, 3], "2026-11-17T12:00:00Z", "2026-11-18T14:00:00.000Z"],
    ["wraps to next week", [1], "2026-11-17T12:00:00Z", "2026-11-23T14:00:00.000Z"],
    ["later the same day", [2], "2026-11-17T12:00:00Z", "2026-11-17T14:00:00.000Z"],
    ["a week later when today's slot has passed", [2], "2026-11-17T15:00:00Z", "2026-11-24T14:00:00.000Z"],
    ["across the fall-back change", [0], "2026-10-31T12:00:00Z", "2026-11-01T14:00:00.000Z"],
  ])("weekly in New York: %s", (_label, days, after, expected) => {
    expect(iso(computeNextRun({ kind: "weekly", days, time: "09:00", tz: "America/New_York" }, at(after)))).toBe(expected);
  });
});

describe("zonedTimeToUtc", () => {
  it("converts wall-clock times on both sides of a DST change", () => {
    expect(iso(zonedTimeToUtc(2026, 1, 15, 9, 0, "Europe/Madrid"))).toBe("2026-01-15T08:00:00.000Z");
    expect(iso(zonedTimeToUtc(2026, 7, 15, 9, 0, "Europe/Madrid"))).toBe("2026-07-15T07:00:00.000Z");
  });

  it("moves times skipped by spring-forward later, on either side of UTC", () => {
    expect(iso(zonedTimeToUtc(2026, 3, 8, 2, 30, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    expect(iso(zonedTimeToUtc(2026, 3, 29, 2, 30, "Europe/Madrid"))).toBe("2026-03-29T01:30:00.000Z");
  });

  it("resolves repeated fall-back times to the first occurrence", () => {
    expect(iso(zonedTimeToUtc(2026, 11, 1, 1, 30, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("failure backoff", () => {
  it.each([
    [0, 15],
    [1, 15],
    [2, 30],
    [3, 60],
    [4, 120],
    [5, 240],
    [6, 360],
    [7, 360],
    [5000, 360],
  ])("after %i consecutive failures waits %i minutes", (failures, minutes) => {
    expect(retryDelayMs(failures)).toBe(minutes * MINUTE);
  });

  const now = at("2026-11-17T07:50:00Z");

  it("slows short intervals down and lets long intervals recover sooner", () => {
    expect(iso(nextRunAfterFailure({ kind: "interval", minutes: 15 }, 3, now))).toBe("2026-11-17T08:50:00.000Z");
    expect(iso(nextRunAfterFailure({ kind: "interval", minutes: 720 }, 1, now))).toBe("2026-11-17T08:05:00.000Z");
  });

  it("never skips the regular daily slot", () => {
    const daily: Schedule = { kind: "daily", time: "09:00", tz: "Europe/Madrid" };
    expect(iso(nextRunAfterFailure(daily, 3, now))).toBe("2026-11-17T08:00:00.000Z");
    expect(iso(nextRunAfterFailure(daily, 1, at("2026-11-17T08:05:00Z")))).toBe("2026-11-17T08:20:00.000Z");
  });

  it("does nothing for manual syncs", () => {
    expect(nextRunAfterFailure({ kind: "manual" }, 4, now)).toBeNull();
  });
});

describe("scheduleSchema", () => {
  it.each([
    { kind: "manual" },
    { kind: "interval", minutes: 15 },
    { kind: "interval", minutes: 720 },
    { kind: "daily", time: "00:00", tz: "UTC" },
    { kind: "daily", time: "23:59", tz: "Europe/Madrid" },
    { kind: "weekly", days: [5, 1, 1], time: "08:30", tz: "America/New_York" },
  ])("accepts %j", (value) => {
    expect(scheduleSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    { kind: "interval", minutes: 5 },
    { kind: "interval", minutes: "15" },
    { kind: "daily", time: "9:00", tz: "UTC" },
    { kind: "daily", time: "24:00", tz: "UTC" },
    { kind: "daily", time: "09:00", tz: "Mars/Olympus_Mons" },
    { kind: "weekly", days: [], time: "09:00", tz: "UTC" },
    { kind: "weekly", days: [7], time: "09:00", tz: "UTC" },
    { kind: "hourly" },
    null,
  ])("rejects %j", (value) => {
    expect(scheduleSchema.safeParse(value).success).toBe(false);
  });

  it("dedupes and sorts weekly days", () => {
    expect(parseSchedule({ kind: "weekly", days: [5, 1, 3, 1], time: "08:30", tz: "UTC" })).toEqual({ kind: "weekly", days: [1, 3, 5], time: "08:30", tz: "UTC" });
  });

  it("validates time zones", () => {
    expect(isValidTimeZone("Europe/Madrid")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Not/A_Zone")).toBe(false);
    expect(isValidTimeZone("x".repeat(65))).toBe(false);
  });
});

describe("describeSchedule", () => {
  it.each<[Schedule, string]>([
    [{ kind: "manual" }, "Manual only"],
    [{ kind: "interval", minutes: 15 }, "Every 15 minutes"],
    [{ kind: "interval", minutes: 60 }, "Every hour"],
    [{ kind: "interval", minutes: 360 }, "Every 6 hours"],
    [{ kind: "daily", time: "09:00", tz: "Europe/Madrid" }, "Daily at 09:00"],
    [{ kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00", tz: "UTC" }, "Weekdays at 08:00"],
    [{ kind: "weekly", days: [0, 6], time: "10:00", tz: "UTC" }, "Weekends at 10:00"],
    [{ kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "07:00", tz: "UTC" }, "Daily at 07:00"],
    [{ kind: "weekly", days: [3, 1], time: "09:00", tz: "UTC" }, "Mon, Wed at 09:00"],
    [{ kind: "weekly", days: [0, 1], time: "09:00", tz: "UTC" }, "Mon, Sun at 09:00"],
  ])("%j reads as %s", (schedule, label) => {
    expect(describeSchedule(schedule)).toBe(label);
  });

  it("can append the time zone", () => {
    expect(describeSchedule({ kind: "daily", time: "09:00", tz: "Europe/Madrid" }, { withTimeZone: true })).toBe("Daily at 09:00 (Europe/Madrid)");
    expect(scheduleIsAutomatic({ kind: "manual" })).toBe(false);
    expect(scheduleIsAutomatic({ kind: "interval", minutes: 30 })).toBe(true);
  });
});
