import { randomUUID } from "node:crypto";
import { getRun, start } from "workflow/api";
import type { RunMode, RunTrigger } from "@/lib/api-types";
import { AppError, toErrorRecord } from "@/lib/errors";
import { syncRunWorkflow } from "@/workflows/sync-run";
import { scopedLogger } from "../log";
import { createRun, getActiveRun, getRunById, isRunFinished, requestRunCancel, type RunRow, updateRun } from "../repo/runs";
import type { SyncRow } from "../repo/syncs";
import { finishRun } from "./engine";

const log = scopedLogger("sync.runner");

export interface StartRunResult {
  outcome: "started" | "already_running";
  run: RunRow;
}

/** Creates a run row and hands it to a durable workflow. At most one active run per sync. */
export async function startRun(params: { sync: SyncRow; trigger: RunTrigger; mode: RunMode; requestedBy: string | null }): Promise<StartRunResult> {
  const { sync } = params;
  const run = await createRun({
    id: randomUUID(),
    syncId: sync.id,
    orgId: sync.orgId,
    trigger: params.trigger,
    mode: params.mode,
    requestedBy: params.requestedBy,
  });
  if (!run) {
    const active = await getActiveRun(sync.id);
    if (active) return { outcome: "already_running", run: active };
    throw new AppError("SYNC_ALREADY_RUNNING", { detail: "active run finished while starting a new one" });
  }

  try {
    const handle = await start(syncRunWorkflow, [run.id]);
    const updated = await updateRun(run.id, { workflowRunId: handle.runId }, { onlyActive: true });
    log.info("Run started", { runId: run.id, syncId: sync.id, orgId: sync.orgId, trigger: params.trigger, mode: params.mode, workflowRunId: handle.runId });
    return { outcome: "started", run: updated ?? run };
  } catch (error) {
    log.error("Couldn't start the sync workflow", { runId: run.id, syncId: sync.id, err: error });
    const failure = new AppError("WORKFLOW_START_FAILED", { detail: error instanceof Error ? error.name : "start failed", cause: error });
    await finishRun(run.id, { kind: "failed", error: toErrorRecord(failure) });
    throw failure;
  }
}

/**
 * Cooperative cancellation: the workflow notices the flag between batches. A run that no
 * workflow has picked up yet is closed immediately.
 */
export async function cancelRun(run: RunRow, requestedBy: string): Promise<RunRow> {
  if (isRunFinished(run)) return run;
  if (run.completionRequestedAt || run.phase === "processing" || run.phase === "finalizing") {
    throw new AppError("CONFLICT", {
      message: "Genesys Cloud is already processing this run, so it can't be cancelled anymore.",
      hint: "It usually finishes within a few minutes.",
    });
  }
  await requestRunCancel(run.id);
  log.info("Run cancellation requested", { runId: run.id, syncId: run.syncId, requestedBy, phase: run.phase });

  if (run.phase === "queued") {
    if (run.workflowRunId) {
      try {
        await getRun(run.workflowRunId).cancel({ cancelReason: `Cancelled by ${requestedBy}` });
      } catch (error) {
        log.debug("Workflow cancel skipped", { runId: run.id, err: error });
      }
    }
    await finishRun(run.id, { kind: "cancelled" });
  }
  return (await getRunById(run.id)) ?? run;
}
