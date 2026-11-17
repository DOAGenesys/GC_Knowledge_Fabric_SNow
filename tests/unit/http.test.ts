import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backoffMs, configureRetryTiming, HttpError, httpRequest, parseRetryAfter } from "@/server/http";
import { capturedLogs } from "../helpers/logs";
import { type FakeHandler, installFetch, json } from "../helpers/fetch-router";

const HOST = "api.example-upstream.com";
const URL_BASE = `https://${HOST}`;

let handler: FakeHandler;
let fetchStub: ReturnType<typeof installFetch>;
let sleeps: number[];

beforeEach(() => {
  sleeps = [];
  configureRetryTiming({ baseMs: 100, capMs: 1000, maxRetryAfterMs: 30_000, sleep: async (ms) => void sleeps.push(ms) });
  fetchStub = installFetch([{ host: HOST, handle: (request, url) => handler(request, url) }]);
});

afterEach(() => {
  fetchStub.restore();
  configureRetryTiming(null);
});

function respondWith(...responses: Array<() => Response | Promise<Response>>): void {
  let index = 0;
  handler = () => {
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return next();
  };
}

describe("httpRequest", () => {
  it("returns status, body, timing and correlation ID", async () => {
    respondWith(() => json({ ok: true }, 200, { "inin-correlation-id": "corr-1" }));
    const response = await httpRequest({ operation: "test.get", method: "GET", url: `${URL_BASE}/x` });
    expect(response).toMatchObject({ status: 200, ok: true, attempts: 1, correlationId: "corr-1" });
    expect(response.json()).toEqual({ ok: true });
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("parses JSON lazily and tolerates bad JSON", async () => {
    respondWith(() => new Response("<html>", { status: 200 }));
    const response = await httpRequest({ operation: "test.get", method: "GET", url: `${URL_BASE}/x` });
    expect(response.json()).toBeNull();
    expect(response.bodyText).toBe("<html>");
  });

  it("retries idempotent requests on 5xx, then hands back the last response", async () => {
    respondWith(() => new Response("busy", { status: 503 }));
    const response = await httpRequest({ operation: "test.get", method: "GET", url: `${URL_BASE}/x` });
    expect(response.status).toBe(503);
    expect(response.attempts).toBe(4);
    expect(fetchStub.requests).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  it("recovers when a retry succeeds", async () => {
    respondWith(
      () => new Response("", { status: 502 }),
      () => json({ ok: true }),
    );
    const response = await httpRequest({ operation: "test.get", method: "GET", url: `${URL_BASE}/x` });
    expect(response).toMatchObject({ status: 200, attempts: 2 });
  });

  it("never retries a non-idempotent request on 5xx", async () => {
    respondWith(() => new Response("", { status: 500 }));
    const response = await httpRequest({ operation: "test.post", method: "POST", url: `${URL_BASE}/x`, body: "{}" });
    expect(response.status).toBe(500);
    expect(fetchStub.requests).toHaveLength(1);
  });

  it("retries 429 for any method and honours Retry-After", async () => {
    respondWith(
      () => new Response("", { status: 429, headers: { "retry-after": "2" } }),
      () => json({ ok: true }),
    );
    const response = await httpRequest({ operation: "test.post", method: "POST", url: `${URL_BASE}/x`, body: "{}" });
    expect(response.status).toBe(200);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up immediately when Retry-After is longer than it is willing to wait", async () => {
    respondWith(() => new Response("", { status: 429, headers: { "retry-after": "120" } }));
    const response = await httpRequest({ operation: "test.get", method: "GET", url: `${URL_BASE}/x` });
    expect(response.status).toBe(429);
    expect(sleeps).toEqual([]);
  });

  it("retries network failures on idempotent requests, then throws", async () => {
    handler = () => {
      throw new TypeError("fetch failed");
    };
    const error = await httpRequest({ operation: "test.get", method: "GET", url: `${URL_BASE}/x` }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ kind: "network", attempts: 4, ambiguous: false, operation: "test.get" });
  });

  it("marks a failed non-idempotent request as ambiguous and does not retry it", async () => {
    handler = () => {
      throw new TypeError("socket hang up");
    };
    const error = await httpRequest({ operation: "test.post", method: "POST", url: `${URL_BASE}/x`, body: "{}" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "network", attempts: 1, ambiguous: true });
    expect(fetchStub.requests).toHaveLength(1);
  });

  it("times out slow requests", async () => {
    const inFlight: Request[] = [];
    handler = (request) =>
      new Promise<Response>((_resolve, reject) => {
        inFlight.push(request);
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      });
    const error = await httpRequest({ operation: "test.slow", method: "GET", url: `${URL_BASE}/x`, timeoutMs: 30, maxAttempts: 1 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ kind: "timeout", message: "test.slow timed out" });
  });

  it("refuses oversized responses", async () => {
    respondWith(() => new Response("x".repeat(2048)));
    const error = await httpRequest({ operation: "test.big", method: "GET", url: `${URL_BASE}/x`, maxResponseBytes: 1024 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "too_large" });
  });

  it("does not follow redirects", async () => {
    respondWith(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example-upstream.com/" } }));
    const response = await httpRequest({ operation: "test.get", method: "GET", url: `${URL_BASE}/x` });
    expect(response.status).toBe(302);
    expect(fetchStub.requests).toHaveLength(1);
  });

  it("logs only host and path, never query strings or headers", async () => {
    respondWith(() => json({ ok: true }));
    await httpRequest({
      operation: "test.get",
      method: "GET",
      url: `${URL_BASE}/x?client_secret=hunter2-value`,
      headers: { Authorization: "Bearer hunter2-token-value" },
    });
    const text = JSON.stringify(capturedLogs.records);
    expect(text).toContain(HOST);
    expect(text).not.toContain("hunter2");
  });
});

describe("retry helpers", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");

  it.each([
    ["5", 5000],
    ["1.5", 1500],
    [" 0 ", 0],
    ["Tue, 17 Nov 2026 12:00:10 GMT", 10_000],
    ["Tue, 17 Nov 2026 11:00:00 GMT", 0],
    ["soon", null],
    [null, null],
  ])("parses Retry-After %j", (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });

  it("backs off exponentially with jitter and a cap", () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const ceiling = Math.min(1000, 100 * 2 ** (attempt - 1));
      const wait = backoffMs(attempt);
      expect(wait).toBeGreaterThanOrEqual(ceiling / 2);
      expect(wait).toBeLessThanOrEqual(ceiling);
    }
    expect(backoffMs(1, 50_000)).toBe(30_000);
    expect(backoffMs(1, 1200)).toBe(1200);
  });
});
