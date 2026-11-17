import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, isApiError, swrFetcher } from "@/lib/api-client";
import { setDebug } from "@/lib/client-log";
import { errorBody, mockApi } from "./helpers/api";

describe("apiFetch", () => {
  beforeEach(() => {
    document.cookie = "kf_csrf=csrf-123; path=/";
  });

  it("returns JSON for successful GETs without a CSRF header", async () => {
    const api = mockApi({ "GET /api/syncs": { body: { syncs: [] } } });
    await expect(apiFetch("/api/syncs")).resolves.toEqual({ syncs: [] });
    const [, init] = api.fetch.mock.calls[0] as [string, RequestInit];
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(api.calls[0]?.headers.get("accept")).toBe("application/json");
    expect(api.calls[0]?.headers.has("x-csrf-token")).toBe(false);
  });

  it("sends JSON bodies with the CSRF token on writes", async () => {
    const api = mockApi({ "POST /api/syncs/:id/run": { body: { outcome: "started", run: null } } });
    await apiFetch("/api/syncs/abc/run", { method: "POST", body: { mode: "full" } });
    expect(api.calls[0]?.body).toEqual({ mode: "full" });
    expect(api.calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(api.calls[0]?.headers.get("x-csrf-token")).toBe("csrf-123");
  });

  it("asks the server for debug logs when verbose logging is on", async () => {
    const api = mockApi({ "GET /api/session": { body: {} } });
    setDebug(true);
    await apiFetch("/api/session");
    expect(api.calls[0]?.headers.get("x-kf-debug")).toBe("1");
    expect(console.debug).toHaveBeenCalled();
  });

  it("returns null for empty responses", async () => {
    mockApi({ "DELETE /api/syncs/:id": { status: 204 } });
    await expect(apiFetch("/api/syncs/abc", { method: "DELETE" })).resolves.toBeNull();
  });

  it("maps error bodies to ApiError with field messages", async () => {
    mockApi({
      "POST /api/connections": {
        status: 422,
        body: errorBody("VALIDATION", "Some fields need attention.", { title: "Check the form", hint: "Fix the highlighted fields.", fields: [{ path: "name", message: "Required" }], requestId: "req-42" }),
      },
    });
    const error = await apiFetch("/api/connections", { method: "POST", body: {} }).catch((caught: unknown) => caught);
    expect(isApiError(error)).toBe(true);
    const apiError = error as ApiError;
    expect(apiError).toMatchObject({ status: 422, code: "VALIDATION", title: "Check the form", message: "Some fields need attention.", hint: "Fix the highlighted fields.", requestId: "req-42" });
    expect(apiError.fieldError("name")).toBe("Required");
    expect(apiError.fieldError("other")).toBeUndefined();
    expect(vi.mocked(console.info).mock.calls.some((call) => String(call[0]).includes("rejected: VALIDATION"))).toBe(true);
  });

  it("handles non-JSON server errors and reads the request ID header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "x-request-id": "req-hdr" } })),
    );
    const error = (await apiFetch("/api/syncs").catch((caught: unknown) => caught)) as ApiError;
    expect(error).toMatchObject({ status: 502, code: "INTERNAL", title: "Something went wrong", message: "The server answered with HTTP 502.", requestId: "req-hdr", hint: null });
    expect(vi.mocked(console.error).mock.calls.some((call) => String(call[0]).includes("GET /api/syncs failed: INTERNAL"))).toBe(true);
  });

  it("turns network failures into a NETWORK error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const error = (await apiFetch("/api/syncs").catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: "NETWORK", title: "Connection problem" });
  });

  it("rethrows aborts untouched", async () => {
    const controller = new AbortController();
    const abort = new DOMException("Aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abort;
      }),
    );
    controller.abort();
    await expect(apiFetch("/api/syncs", { signal: controller.signal })).rejects.toBe(abort);
  });

  it("swrFetcher delegates to apiFetch", async () => {
    mockApi({ "GET /api/connections": { body: { connections: [] } } });
    await expect(swrFetcher("/api/connections")).resolves.toEqual({ connections: [] });
  });
});

describe("expired sessions", () => {
  it("redirects to sign-in once, keeping the current page", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/api-client");
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/syncs/abc?tab=articles");
    mockApi({ "GET /api/syncs": { status: 401, body: errorBody("UNAUTHENTICATED", "Please sign in.") } });

    await expect(fresh.apiFetch("/api/syncs")).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    await expect(fresh.apiFetch("/api/syncs")).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent("/syncs/abc?tab=articles")}`);
  });

  it("does not redirect while already on the sign-in page", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/api-client");
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/login");
    mockApi({ "GET /api/session": { status: 401, body: errorBody("UNAUTHENTICATED", "Please sign in.") } });
    await expect(fresh.apiFetch("/api/session")).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });
});
