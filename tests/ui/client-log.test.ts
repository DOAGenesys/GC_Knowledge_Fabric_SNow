import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientLogger, flushClientLogs, isDebugEnabled, setDebug } from "@/lib/client-log";
import { blockStorage } from "./helpers/storage";

interface SentEntry {
  level: string;
  scope: string;
  message: string;
  name?: string;
  stack?: string;
  path?: string;
  requestId?: string;
  count: number;
}

let sent: SentEntry[][];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sent = [];
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push((JSON.parse(String(init.body)) as { entries: SentEntry[] }).entries);
    return new Response(null, { status: 202 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("console output", () => {
  it("shows info and above outside production, debug only with verbose logging", () => {
    const log = clientLogger("test");
    log.debug("hidden");
    log.info("shown");
    expect(console.debug).not.toHaveBeenCalled();
    expect(vi.mocked(console.info).mock.calls[0]?.[0]).toBe("%cKF%c test · shown");

    setDebug(true);
    expect(isDebugEnabled()).toBe(true);
    log.debug("now visible", { durationMs: 5 });
    expect(vi.mocked(console.debug).mock.calls[0]?.[3]).toEqual({ durationMs: 5 });

    setDebug(false);
    expect(isDebugEnabled()).toBe(false);
  });

  it("shows only warnings and errors in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = clientLogger("prod");
    log.info("quiet");
    log.warn("loud");
    expect(console.info).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toBe("%cKF%c prod · loud");
  });

  it("redacts secrets in messages and fields", () => {
    const log = clientLogger("auth");
    log.warn("Login failed password=hunter2 Bearer abcdefghijkl", { token: "abc", attempt: 2 });
    const [message, , , details] = vi.mocked(console.warn).mock.calls[0] ?? [];
    expect(message).not.toMatch(/hunter2|abcdefghijkl/);
    expect(message).toContain("password=[REDACTED]");
    expect(details).toEqual({ token: "[REDACTED]", attempt: 2 });
  });

  it("appends a serialized error with its stack", () => {
    const log = clientLogger("app");
    log.error("Crashed", { err: new TypeError("bad input") });
    const args = vi.mocked(console.error).mock.calls[0] ?? [];
    expect(args.at(-1)).toMatchObject({ name: "TypeError", message: "bad input" });
  });

  it("keeps working when storage is blocked", () => {
    blockStorage();
    expect(() => setDebug(true)).not.toThrow();
    expect(() => setDebug(false)).not.toThrow();
    expect(isDebugEnabled()).toBe(false);
    clientLogger("blocked").info("still logs");
    expect(console.info).toHaveBeenCalled();
  });
});

describe("server reports", () => {
  it("batches warnings and errors, deduplicating repeats", () => {
    vi.useFakeTimers();
    const log = clientLogger("api");
    log.error("Request failed", { err: new Error("boom"), requestId: "req-1" });
    log.error("Request failed");
    log.warn("Slow page");
    log.info("not reported");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/client-log");
    expect(init).toMatchObject({ method: "POST", keepalive: true, credentials: "same-origin" });
    expect(sent[0]).toEqual([
      expect.objectContaining({ level: "error", scope: "api", message: "Request failed", name: "Error", requestId: "req-1", path: "/", count: 2 }),
      expect.objectContaining({ level: "warn", message: "Slow page", count: 1 }),
    ]);
  });

  it("reports the same message again after the dedupe window", () => {
    vi.useFakeTimers();
    const log = clientLogger("api");
    log.warn("Flaky");
    vi.advanceTimersByTime(2_000);
    log.warn("Flaky");
    vi.advanceTimersByTime(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    log.warn("Flaky");
    vi.advanceTimersByTime(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends at most 50 reports per page, 10 per request", () => {
    vi.useFakeTimers();
    const log = clientLogger("loop");
    for (let index = 0; index < 70; index++) log.error(`Failure ${index}`);
    vi.advanceTimersByTime(30_000);
    expect(sent.every((batch) => batch.length <= 10)).toBe(true);
    expect(sent.flat()).toHaveLength(50);
  });

  it("flushes immediately when the page is hidden", () => {
    clientLogger("nav").warn("Leaving with errors");
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    flushClientLogs();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a failing report endpoint", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    clientLogger("net").error("Unreachable");
    expect(() => flushClientLogs()).not.toThrow();
    await Promise.resolve();
  });
});
