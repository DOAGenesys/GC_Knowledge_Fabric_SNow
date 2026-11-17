import { beforeAll, describe, expect, it, vi } from "vitest";
import { isDebugEnabled, setDebug } from "@/lib/client-log";

let onRouterTransitionStart: (url: string, type: "push" | "replace" | "traverse") => void;

beforeAll(async () => {
  ({ onRouterTransitionStart } = await import("@/instrumentation-client"));
});

const errorCalls = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0]));

describe("global error hooks", () => {
  it("logs uncaught errors with their source file", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "Boom", error: new Error("Boom"), filename: "http://localhost:3000/_next/static/chunk.js?v=1" }));
    expect(errorCalls()).toContain("%cKF%c app · Boom");
    const details = vi.mocked(console.error).mock.calls[0]?.[3];
    expect(details).toEqual({ source: "http://localhost:3000/_next/static/chunk.js" });
  });

  it("ignores browser noise and extension errors", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Extension broke", filename: "chrome-extension://abc/content.js" }));
    expect(errorCalls()).toEqual([]);
  });

  it("logs unhandled rejections except aborts", () => {
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new DOMException("Aborted", "AbortError") }));
    expect(errorCalls()).toEqual([]);
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("lost promise") }));
    expect(errorCalls()).toContain("%cKF%c app · Unhandled promise rejection");
  });
});

describe("debug helpers", () => {
  it("kfDebug toggles verbose logging", () => {
    const kfDebug = (window as unknown as { kfDebug: (enabled?: boolean) => string }).kfDebug;
    expect(kfDebug()).toMatch(/Verbose logging is on/);
    expect(isDebugEnabled()).toBe(true);
    expect(kfDebug(false)).toBe("Verbose logging is off.");
    expect(isDebugEnabled()).toBe(false);
  });

  it("logs navigations only in verbose mode", () => {
    onRouterTransitionStart("/syncs/abc?tab=1", "push");
    expect(console.debug).not.toHaveBeenCalled();
    setDebug(true);
    onRouterTransitionStart("/syncs/abc?tab=1", "push");
    expect(vi.mocked(console.debug).mock.calls[0]?.[3]).toEqual({ to: "/syncs/abc", navigationType: "push" });
  });
});
