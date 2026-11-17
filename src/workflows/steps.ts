import { getStepMetadata, RetryableError } from "workflow";
import type { ErrorRecord } from "../lib/errors";

/**
 * Durable steps of a sync run. Engine modules are imported inside each step body so the
 * workflow sandbox bundle never includes database or Node.js code.
 *
 * Expected failures come back as `{ ok: false, error }` (with the app's error code intact);
 * transient ones are retried with a delay first.
 */
export type StepResult<T> = { ok: true; value: T } | { ok: false; error: ErrorRecord };

async function guarded<T>(step: string, runId: string, work: () => Promise<T>): Promise<StepResult<T>> {
  const { attempt, maxAttempts } = getStepMetadata();
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const [{ isAppError, toErrorRecord }, { scopedLogger }] = await Promise.all([import("../lib/errors"), import("../server/log")]);
    const record = toErrorRecord(error);
    const retryable = isAppError(error) ? error.retryable : true;
    const log = scopedLogger("sync.workflow", { runId, step });
    if (retryable && attempt < maxAttempts) {
      const rateLimited = record.code === "GC_RATE_LIMITED" || record.code === "SN_RATE_LIMITED";
      log.warn("Step failed, retrying", { attempt, maxAttempts, code: record.code, detail: record.detail, err: isAppError(error) ? undefined : error });
      throw new RetryableError(record.message, { retryAfter: rateLimited ? 30_000 : 5_000 * attempt });
    }
    log.warn("Step failed", { attempt, code: record.code, detail: record.detail, err: isAppError(error) ? undefined : error });
    return { ok: false, error: record };
  }
}

export async function prepareRunStep(runId: string) {
  "use step";
  const { prepareRun } = await import("../server/sync/engine");
  return guarded("prepare", runId, () => prepareRun(runId));
}

export async function processBatchStep(runId: string) {
  "use step";
  const { processBatch } = await import("../server/sync/engine");
  return guarded("batch", runId, () => processBatch(runId));
}

export async function salvageRunStep(runId: string, error: ErrorRecord) {
  "use step";
  const { salvageRun } = await import("../server/sync/engine");
  return guarded("salvage", runId, () => salvageRun(runId, error));
}

export async function commitRoundStep(runId: string) {
  "use step";
  const { commitRound } = await import("../server/sync/engine");
  return guarded("commit", runId, () => commitRound(runId));
}

export async function pollRoundStep(runId: string) {
  "use step";
  const { pollRound } = await import("../server/sync/engine");
  return guarded("poll", runId, () => pollRound(runId));
}

export async function finalizeRunStep(runId: string, pollTimedOut: boolean) {
  "use step";
  const { finalizeRun } = await import("../server/sync/engine");
  return guarded("finalize", runId, () => finalizeRun(runId, { pollTimedOut }));
}

export async function failRunStep(runId: string, error: ErrorRecord) {
  "use step";
  const { failRun } = await import("../server/sync/engine");
  return guarded("fail", runId, () => failRun(runId, error));
}
