import { z } from "zod";

/** Vercel Schedules on Hobby fire at most every 15 minutes, so that's the shortest interval offered. */
export const INTERVAL_OPTIONS = [15, 30, 60, 120, 360, 720] as const;
export type IntervalMinutes = (typeof INTERVAL_OPTIONS)[number];

export type Schedule =
  | { kind: "manual" }
  | { kind: "interval"; minutes: IntervalMinutes }
  | { kind: "daily"; time: string; tz: string }
  | { kind: "weekly"; days: number[]; time: string; tz: string };

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(tz, formatter);
  }
  return formatter;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const tzSchema = z.string().refine(isValidTimeZone, "Unknown time zone");

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({
    kind: z.literal("interval"),
    minutes: z.literal(INTERVAL_OPTIONS, "Pick one of the offered intervals"),
  }),
  z.object({ kind: z.literal("daily"), time: timeSchema, tz: tzSchema }),
  z.object({
    kind: z.literal("weekly"),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Pick at least one day")
      .max(7)
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    time: timeSchema,
    tz: tzSchema,
  }),
]);

export function parseSchedule(value: unknown): Schedule {
  return scheduleSchema.parse(value);
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(date: Date, tz: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(tz).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: (values.hour ?? 0) % 24,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function offsetMs(date: Date, tz: string): number {
  const parts = localParts(date, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const DAY_MS = 86_400_000;

/**
 * Converts a wall-clock time in `tz` to an instant. A time skipped by a DST change moves
 * forward by the size of the gap; a time that happens twice resolves to its first occurrence.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetBefore = offsetMs(new Date(guess - DAY_MS), tz);
  const offsetAfter = offsetMs(new Date(guess + DAY_MS), tz);
  const matches = [guess - offsetBefore, guess - offsetAfter].filter((instant) => {
    const parts = localParts(new Date(instant), tz);
    return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
  });
  return new Date(matches.length > 0 ? Math.min(...matches) : guess - offsetBefore);
}

function nextWallClock(days: ReadonlySet<number>, time: string, tz: string, after: Date): Date {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const start = localParts(after, tz);
  for (let offset = 0; offset <= 8; offset++) {
    const calendarDay = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    if (!days.has(calendarDay.getUTCDay())) continue;
    const candidate = zonedTimeToUtc(
      calendarDay.getUTCFullYear(),
      calendarDay.getUTCMonth() + 1,
      calendarDay.getUTCDate(),
      hour,
      minute,
      tz,
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("No matching day within the next week");
}

const ALL_DAYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6]);

/** Next time the schedule is due strictly after `after`, or null for manual schedules. */
export function computeNextRun(schedule: Schedule, after: Date): Date | null {
  switch (schedule.kind) {
    case "manual":
      return null;
    case "interval":
      return new Date(after.getTime() + schedule.minutes * 60_000);
    case "daily":
      return nextWallClock(ALL_DAYS, schedule.time, schedule.tz, after);
    case "weekly":
      return nextWallClock(new Set(schedule.days), schedule.time, schedule.tz, after);
  }
}

/** 15 min, 30 min, 1 h, 2 h, 4 h, then 6 h between attempts while a sync keeps failing. */
export function retryDelayMs(consecutiveFailures: number): number {
  const minutes = Math.min(15 * 2 ** Math.max(0, consecutiveFailures - 1), 360);
  return minutes * 60_000;
}

/**
 * When to try again after a failed run: after the backoff delay, so short intervals slow down
 * and long ones recover quickly. Daily and weekly schedules never skip their next regular slot.
 */
export function nextRunAfterFailure(schedule: Schedule, consecutiveFailures: number, now: Date): Date | null {
  if (schedule.kind === "manual") return null;
  const retry = now.getTime() + retryDelayMs(consecutiveFailures);
  if (schedule.kind === "interval") return new Date(retry);
  const regular = computeNextRun(schedule, now);
  return new Date(regular ? Math.min(retry, regular.getTime()) : retry);
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function intervalLabel(minutes: IntervalMinutes): string {
  if (minutes < 60) return `Every ${minutes} minutes`;
  if (minutes === 60) return "Every hour";
  return `Every ${minutes / 60} hours`;
}

function daysLabel(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "Daily";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  const mondayFirst = [1, 2, 3, 4, 5, 6, 0].filter((day) => set.has(day));
  return mondayFirst.map((day) => DAY_SHORT[day]).join(", ");
}

export function describeSchedule(schedule: Schedule, options: { withTimeZone?: boolean } = {}): string {
  switch (schedule.kind) {
    case "manual":
      return "Manual only";
    case "interval":
      return intervalLabel(schedule.minutes);
    case "daily":
      return `Daily at ${schedule.time}${options.withTimeZone ? ` (${schedule.tz})` : ""}`;
    case "weekly":
      return `${daysLabel(schedule.days)} at ${schedule.time}${options.withTimeZone ? ` (${schedule.tz})` : ""}`;
  }
}

export function scheduleIsAutomatic(schedule: Schedule): boolean {
  return schedule.kind !== "manual";
}
