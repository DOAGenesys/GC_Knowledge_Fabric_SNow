import { describe, expect, it } from "vitest";
import type { Schedule } from "@/lib/schedule";
import { computeSyncOutcome, outcomeFromRound, uploadBatchSize } from "@/server/sync/engine";

type RoundState = Parameters<typeof outcomeFromRound>[0];

function round(overrides: Partial<RoundState> = {}): RoundState {
  return { gcSyncId: "gc-1", gcStatus: "Completed", gcIngestion: "Complete", cancelRequested: false, errorCode: null, errorMessage: null, ...overrides };
}

describe("outcomeFromRound", () => {
  it.each<[string, Partial<RoundState>, boolean, string, string?]>([
    ["completed and ingested", {}, false, "committed"],
    ["completed and ingested, even if polling ran out", {}, true, "committed"],
    ["completed with no ingestion status", { gcIngestion: null }, false, "committed"],
    ["completed with Unknown ingestion", { gcIngestion: "Unknown" }, false, "committed"],
    ["completed, ingestion unknown and polling ran out", { gcIngestion: null }, true, "failed", "GC_OUTCOME_UNKNOWN"],
    ["ingestion failed", { gcIngestion: "Failed" }, false, "failed", "GC_INGESTION_FAILED"],
    ["ingestion stopped", { gcIngestion: "Stopped" }, false, "failed", "GC_INGESTION_FAILED"],
    ["round failed", { gcStatus: "Failed", gcIngestion: null }, false, "failed", "GC_SYNC_FAILED"],
    ["no round was created", { gcSyncId: null, gcStatus: null, gcIngestion: null }, false, "no_round"],
    ["cancel requested before completion", { cancelRequested: true, gcStatus: "InProgress" }, false, "cancelled"],
    ["cancel requested too late to matter", { cancelRequested: true }, false, "committed"],
    ["round cancelled by us", { gcStatus: "Cancelled", gcIngestion: null, cancelRequested: true }, false, "cancelled"],
    ["round cancelled after a failed commit", { gcStatus: "Cancelled", gcIngestion: null, errorCode: "GC_SYNC_FAILED" }, false, "failed", "GC_SYNC_FAILED"],
    ["round cancelled by someone else", { gcStatus: "Cancelled", gcIngestion: null }, false, "no_round"],
    ["still in progress when polling ran out", { gcStatus: "InProgress", gcIngestion: null }, true, "failed", "GC_OUTCOME_UNKNOWN"],
  ])("%s", (_label, overrides, pollTimedOut, kind, code) => {
    const outcome = outcomeFromRound(round(overrides), pollTimedOut);
    expect(outcome.kind).toBe(kind);
    if (code) expect(outcome.kind === "failed" ? outcome.error.code : null).toBe(code);
  });

  it("keeps the commit failure message when Genesys cancelled the round", () => {
    const outcome = outcomeFromRound(round({ gcStatus: "Cancelled", gcIngestion: null, errorCode: "GC_SYNC_FAILED", errorMessage: "Too many files." }), false);
    expect(outcome).toMatchObject({ kind: "failed", error: { code: "GC_SYNC_FAILED", message: "Too many files." } });
  });
});

describe("uploadBatchSize", () => {
  it.each([
    [0, 25],
    [100, 25],
    [2500, 25],
    [2501, 26],
    [10_000, 100],
    [15_000, 150],
    [1_000_000, 150],
  ])("%i planned uploads → batches of %i", (planned, size) => {
    expect(uploadBatchSize(planned)).toBe(size);
  });
});

describe("computeSyncOutcome", () => {
  const now = new Date("2026-11-17T07:50:00Z");
  const hourly: Schedule = { kind: "interval", minutes: 60 };
  const sync = { schedule: hourly, enabled: true, health: "healthy" as const, consecutiveFailures: 0 };
  const run = { failed: 0, gcFailed: 0, fingerprint: "fp", configHash: "cfg", totalArticles: 12, plannedUploads: 3, plannedDeletions: 0 };
  const error = { code: "GC_AUTH_FAILED" as const, message: "Genesys Cloud rejected the credentials.", retryable: false };

  it("resets failures and schedules the next regular run on success", () => {
    expect(computeSyncOutcome({ ...sync, consecutiveFailures: 3, health: "error" }, run, "succeeded", null, true, now)).toEqual({
      health: "healthy",
      statusMessage: null,
      consecutiveFailures: 0,
      nextRunAt: new Date("2026-11-17T08:50:00Z"),
      fingerprint: "fp",
      configHash: "cfg",
      articleCount: 12,
      succeeded: true,
    });
  });

  it("treats a no-op run as success", () => {
    expect(computeSyncOutcome(sync, { ...run, plannedUploads: 0, totalArticles: 12 }, "noop", null, false, now)).toMatchObject({ health: "healthy", succeeded: true, articleCount: 12 });
  });

  it("reports an empty selection as zero articles, but an unknown count as null", () => {
    expect(computeSyncOutcome(sync, { ...run, totalArticles: 0, plannedUploads: 0, plannedDeletions: 2 }, "succeeded", null, true, now).articleCount).toBe(0);
    expect(computeSyncOutcome(sync, { ...run, totalArticles: 0, plannedUploads: 0, plannedDeletions: 0 }, "noop", null, false, now).articleCount).toBeNull();
  });

  it("backs off and explains item failures on partial runs", () => {
    const outcome = computeSyncOutcome({ ...sync, consecutiveFailures: 1 }, { ...run, failed: 2 }, "partial", null, true, now);
    expect(outcome).toMatchObject({
      health: "warning",
      statusMessage: "2 articles couldn't be synced. They'll be retried automatically.",
      consecutiveFailures: 2,
      nextRunAt: new Date("2026-11-17T08:20:00Z"),
      configHash: "cfg",
      succeeded: true,
    });
  });

  it("does not back off when only Genesys Cloud processing failed", () => {
    const outcome = computeSyncOutcome({ ...sync, consecutiveFailures: 2 }, { ...run, gcFailed: 1 }, "partial", null, true, now);
    expect(outcome).toMatchObject({ statusMessage: "Genesys Cloud couldn't process 1 file.", consecutiveFailures: 0, nextRunAt: new Date("2026-11-17T08:50:00Z") });
  });

  it("forgets the fingerprint after an uncommitted partial run", () => {
    expect(computeSyncOutcome(sync, { ...run, failed: 1 }, "partial", null, false, now)).toMatchObject({ configHash: null, succeeded: false });
  });

  it("keeps health but clears the fingerprint when cancelled", () => {
    expect(computeSyncOutcome({ ...sync, health: "warning", consecutiveFailures: 1 }, run, "cancelled", null, false, now)).toMatchObject({
      health: "warning",
      statusMessage: "The last run was cancelled.",
      consecutiveFailures: 1,
      fingerprint: null,
      nextRunAt: new Date("2026-11-17T08:50:00Z"),
    });
  });

  it("records the failure and backs off", () => {
    expect(computeSyncOutcome({ ...sync, consecutiveFailures: 2 }, run, "failed", error, false, now)).toMatchObject({
      health: "error",
      statusMessage: error.message,
      consecutiveFailures: 3,
      nextRunAt: new Date("2026-11-17T08:50:00Z"),
      fingerprint: null,
    });
    expect(computeSyncOutcome(sync, run, "failed", null, false, now).statusMessage).toBe("The last run failed.");
  });

  it("never schedules a disabled or manual sync", () => {
    expect(computeSyncOutcome({ ...sync, enabled: false }, run, "succeeded", null, true, now).nextRunAt).toBeNull();
    expect(computeSyncOutcome({ ...sync, enabled: false }, run, "failed", error, false, now).nextRunAt).toBeNull();
    expect(computeSyncOutcome({ ...sync, schedule: { kind: "manual" } }, run, "succeeded", null, true, now).nextRunAt).toBeNull();
  });
});
