import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { capturedLogs } from "../helpers/logs";
import { harness, RetryableError } from "../helpers/workflow-harness";

const engine = vi.hoisted(() => ({
  prepareRun: vi.fn(),
  processBatch: vi.fn(),
  salvageRun: vi.fn(),
  commitRound: vi.fn(),
  pollRound: vi.fn(),
  finalizeRun: vi.fn(),
  failRun: vi.fn(),
}));

vi.mock("@/server/sync/engine", () => engine);

const steps = await import("@/workflows/steps");

beforeEach(() => {
  for (const fn of Object.values(engine)) fn.mockReset();
});

describe("workflow steps", () => {
  it("wraps each engine call and returns its value", async () => {
    const error = { code: "GC_SYNC_FAILED" as const, message: "x", retryable: false };
    engine.prepareRun.mockResolvedValue({ action: "continue", uploads: 1, deletions: 0 });
    engine.processBatch.mockResolvedValue({ done: true });
    engine.salvageRun.mockResolvedValue(true);
    engine.commitRound.mockResolvedValue({ action: "poll" });
    engine.pollRound.mockResolvedValue({ terminal: true, status: "Completed", ingestion: "Complete" });
    engine.finalizeRun.mockResolvedValue("succeeded");
    engine.failRun.mockResolvedValue("failed");

    expect(await steps.prepareRunStep("r1")).toEqual({ ok: true, value: { action: "continue", uploads: 1, deletions: 0 } });
    expect(await steps.processBatchStep("r1")).toEqual({ ok: true, value: { done: true } });
    expect(await steps.salvageRunStep("r1", error)).toEqual({ ok: true, value: true });
    expect(await steps.commitRoundStep("r1")).toEqual({ ok: true, value: { action: "poll" } });
    expect(await steps.pollRoundStep("r1")).toEqual({ ok: true, value: { terminal: true, status: "Completed", ingestion: "Complete" } });
    expect(await steps.finalizeRunStep("r1", true)).toEqual({ ok: true, value: "succeeded" });
    expect(await steps.failRunStep("r1", error)).toEqual({ ok: true, value: "failed" });

    expect(engine.salvageRun).toHaveBeenCalledWith("r1", error);
    expect(engine.finalizeRun).toHaveBeenCalledWith("r1", { pollTimedOut: true });
    expect(engine.failRun).toHaveBeenCalledWith("r1", error);
  });

  it("returns expected failures as data, with the error code intact", async () => {
    engine.prepareRun.mockRejectedValue(new AppError("GC_AUTH_FAILED", { detail: "token → HTTP 401" }));
    harness.step = { attempt: 1, maxAttempts: 3 };
    const result = await steps.prepareRunStep("r1");
    expect(result).toMatchObject({ ok: false, error: { code: "GC_AUTH_FAILED", detail: "token → HTTP 401", retryable: false } });
    expect(capturedLogs.withMessage("Step failed")[0]).toMatchObject({ level: "warn", runId: "r1", step: "prepare", code: "GC_AUTH_FAILED" });
  });

  it("asks the runtime to retry transient failures with a growing delay", async () => {
    engine.processBatch.mockRejectedValue(new AppError("GC_UNAVAILABLE"));
    harness.step = { attempt: 1, maxAttempts: 3 };
    await expect(steps.processBatchStep("r1")).rejects.toMatchObject({ retryAfter: 5000 });
    harness.step = { attempt: 2, maxAttempts: 3 };
    const error = await steps.processBatchStep("r1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetryableError);
    expect(error).toMatchObject({ retryAfter: 10_000 });
    expect(capturedLogs.withMessage("Step failed, retrying")).toHaveLength(2);
  });

  it("waits longer when rate limited", async () => {
    engine.pollRound.mockRejectedValue(new AppError("SN_RATE_LIMITED"));
    harness.step = { attempt: 1, maxAttempts: 3 };
    await expect(steps.pollRoundStep("r1")).rejects.toMatchObject({ retryAfter: 30_000 });
  });

  it("gives up on the last attempt", async () => {
    engine.commitRound.mockRejectedValue(new AppError("GC_UNAVAILABLE"));
    harness.step = { attempt: 3, maxAttempts: 3 };
    expect(await steps.commitRoundStep("r1")).toMatchObject({ ok: false, error: { code: "GC_UNAVAILABLE" } });
  });

  it("retries unexpected errors and reports them without their message", async () => {
    engine.finalizeRun.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'x')"));
    harness.step = { attempt: 1, maxAttempts: 2 };
    await expect(steps.finalizeRunStep("r1", false)).rejects.toBeInstanceOf(RetryableError);
    harness.step = { attempt: 2, maxAttempts: 2 };
    const result = await steps.finalizeRunStep("r1", false);
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "INTERNAL", detail: "TypeError" }) });
    expect(capturedLogs.withMessage("Step failed").at(-1)).toMatchObject({ err: { name: "TypeError" } });
  });
});
