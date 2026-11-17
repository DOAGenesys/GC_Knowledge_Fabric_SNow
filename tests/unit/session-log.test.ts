import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearedSessionCookies,
  cookieNames,
  isSameOrigin,
  readSession,
  requestHost,
  safeReturnTo,
  SESSION_TTL_SECONDS,
  sessionCookies,
  verifyCsrf,
} from "@/server/auth/session";
import { signPayload } from "@/server/crypto";
import { logger, scopedLogger, setLogSink, timed } from "@/server/log";
import { capturedLogs } from "../helpers/logs";

const SESSION = { userId: "u1", userName: "Ada", orgId: "o1", orgName: "Acme", region: "mypurecloud.de" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("safeReturnTo", () => {
  it.each([
    ["/syncs/1?tab=runs", "/syncs/1?tab=runs"],
    ["/", "/"],
    ["/connections#top", "/connections"],
  ])("keeps %s", (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });

  it.each(["//evil.example", "/\\evil.example", "https://evil.example/", "/\t/evil.example", "/api/auth/logout", "syncs", "", null, undefined])(
    "replaces %j with /",
    (input) => {
      expect(safeReturnTo(input)).toBe("/");
    },
  );
});

describe("origin and CSRF checks", () => {
  it("compares the Origin header with the request host", () => {
    expect(isSameOrigin(null, "app.example.com")).toBe(true);
    expect(isSameOrigin("https://app.example.com", "app.example.com")).toBe(true);
    expect(isSameOrigin("https://evil.example", "app.example.com")).toBe(false);
    expect(isSameOrigin("http://localhost:3001", "localhost:3000")).toBe(false);
    expect(isSameOrigin("not a url", "app.example.com")).toBe(false);
  });

  it("requires matching double-submit tokens and a same-origin request", () => {
    const base = { cookieToken: "tok-123", headerToken: "tok-123", origin: "https://app.example.com", host: "app.example.com" };
    expect(verifyCsrf(base)).toBe(true);
    expect(verifyCsrf({ ...base, headerToken: null })).toBe(false);
    expect(verifyCsrf({ ...base, cookieToken: undefined })).toBe(false);
    expect(verifyCsrf({ ...base, headerToken: "tok-124" })).toBe(false);
    expect(verifyCsrf({ ...base, origin: "https://evil.example" })).toBe(false);
  });

  it("prefers the forwarded host", () => {
    expect(requestHost(new Headers({ host: "internal:3000", "x-forwarded-host": "app.example.com" }))).toBe("app.example.com");
    expect(requestHost(new Headers({ host: "localhost:3000" }))).toBe("localhost:3000");
  });
});

describe("session cookies", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");

  it("issues a signed httpOnly session and a readable CSRF token", () => {
    const [session, csrf] = sessionCookies(SESSION, now);
    expect(session).toMatchObject({ name: "kf_session", httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_SECONDS, secure: false });
    expect(csrf).toMatchObject({ name: "kf_csrf", httpOnly: false });
    expect(csrf!.value.length).toBeGreaterThanOrEqual(32);
    expect(readSession(session!.value, now + 1000)).toEqual({ ...SESSION, issuedAt: now });
  });

  it("expires after the TTL", () => {
    const [session] = sessionCookies(SESSION, now);
    expect(readSession(session!.value, now + SESSION_TTL_SECONDS * 1000)).toBeNull();
  });

  it("rejects payloads that are signed but incomplete", () => {
    expect(readSession(signPayload({ userId: "u1" }, 60, now), now)).toBeNull();
    expect(readSession(signPayload("just a string", 60, now), now)).toBeNull();
    expect(readSession("garbage", now)).toBeNull();
  });

  it("uses __Host- cookies with Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(cookieNames()).toEqual({ session: "__Host-kf_session", csrf: "__Host-kf_csrf", oauth: "__Host-kf_oauth" });
    for (const cookie of sessionCookies(SESSION, now)) expect(cookie.secure).toBe(true);
  });

  it("clears every cookie on sign-out", () => {
    const cleared = clearedSessionCookies();
    expect(cleared.map((cookie) => cookie.name)).toEqual(["kf_session", "kf_csrf", "kf_oauth"]);
    for (const cookie of cleared) expect(cookie).toMatchObject({ value: "", maxAge: 0 });
  });
});

describe("logger", () => {
  it("binds service, scope and context fields", () => {
    scopedLogger("sync", { syncId: "s1" }).child({ runId: "r1" }).info("Run started", { articles: 3 });
    expect(capturedLogs.records).toEqual([
      expect.objectContaining({ level: "info", msg: "Run started", service: "kf-snow", scope: "sync", syncId: "s1", runId: "r1", articles: 3 }),
    ]);
    expect(capturedLogs.records[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("cannot be tricked into changing the level or message", () => {
    logger.warn("Real message", { level: "debug", msg: "fake", time: "yesterday" });
    expect(capturedLogs.records[0]).toMatchObject({ level: "warn", msg: "Real message" });
    expect(capturedLogs.records[0]!.time).not.toBe("yesterday");
  });

  it("respects LOG_LEVEL and per-logger thresholds", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    logger.info("hidden");
    logger.warn("shown");
    logger.child({}, { threshold: "debug" }).debug("forced");
    expect(capturedLogs.records.map((record) => record.msg)).toEqual(["shown", "forced"]);

    vi.stubEnv("LOG_LEVEL", "silent");
    logger.error("nothing");
    expect(capturedLogs.records).toHaveLength(2);
  });

  it("defaults to info in production and silence under test", () => {
    vi.stubEnv("LOG_LEVEL", "");
    expect(logger.isEnabled("error")).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(logger.isEnabled("debug")).toBe(false);
    expect(logger.isEnabled("info")).toBe(true);
  });

  it("emits a dedupe key once per minute and reports what it suppressed", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-17T12:00:00Z"), toFake: ["Date"] });
    for (let index = 0; index < 5; index += 1) logger.warn("ServiceNow throttled", { dedupeKey: "sn:429" });
    logger.error("Different level", { dedupeKey: "sn:429" });
    expect(capturedLogs.records).toHaveLength(2);

    vi.setSystemTime(Date.parse("2026-11-17T12:01:01Z"));
    logger.warn("ServiceNow throttled", { dedupeKey: "sn:429" });
    expect(capturedLogs.records.at(-1)).toMatchObject({ msg: "ServiceNow throttled", suppressed: 4 });
    expect(capturedLogs.records.at(-1)).not.toHaveProperty("dedupeKey");
  });

  it("redacts messages and fields", () => {
    logger.info("Calling with Bearer abcdefghijkl", { password: "pw", nested: { clientSecret: "cs", ok: 1 }, url: "https://x.example/?code=abc" });
    const text = capturedLogs.serialized();
    expect(text).not.toMatch(/abcdefghijkl|"pw"|"cs"|code=abc/);
    expect(capturedLogs.records[0]).toMatchObject({ nested: { ok: 1 } });
  });

  it("includes stacks only for errors", () => {
    logger.warn("soft", { err: new Error("w") });
    logger.error("hard", { err: new Error("e") });
    const [warn, error] = capturedLogs.records as unknown as Array<{ err: { stack?: string } }>;
    expect(warn!.err.stack).toBeUndefined();
    expect(error!.err.stack).toContain("Error: e");
  });

  it("never throws when the sink fails", () => {
    setLogSink(() => {
      throw new Error("disk full");
    });
    expect(() => logger.error("still fine")).not.toThrow();
  });

  it("prints JSON lines on Vercel and readable lines locally", () => {
    setLogSink(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      vi.stubEnv("LOG_FORMAT", "json");
      logger.info("json line", { a: 1 });
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ level: "info", msg: "json line", a: 1 });

      vi.stubEnv("LOG_FORMAT", "pretty");
      scopedLogger("sync").warn("pretty line", { syncId: "s1", empty: undefined });
      expect(String(warn.mock.calls[0]![0])).toMatch(/WARN {2}\[sync\] pretty line {2}service=kf-snow syncId=s1$/);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("times operations", async () => {
    const log = scopedLogger("t");
    await expect(timed(log, "fast op", async () => 42, { syncId: "s1" })).resolves.toBe(42);
    await expect(timed(log, "bad op", async () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
    expect(capturedLogs.records[0]).toMatchObject({ level: "debug", msg: "fast op", syncId: "s1", durationMs: expect.any(Number) });
    expect(capturedLogs.records[1]).toMatchObject({ level: "warn", msg: "bad op failed", err: { message: "nope" } });
  });
});
