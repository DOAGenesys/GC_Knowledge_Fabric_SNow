import { sleep } from "workflow";
import { commitRoundStep, failRunStep, finalizeRunStep, pollRoundStep, prepareRunStep, processBatchStep, salvageRunStep } from "./steps";

const MAX_BATCHES = 1000;
const POLL_BUDGET_SECONDS = 45 * 60;
const MAX_POLL_FAILURES = 3;

/**
 * One sync run: plan → upload/delete in batches → submit the round → wait for Genesys Cloud
 * to process it → record the outcome. Every failure path ends in `failRunStep`, so a run is
 * never left open.
 */
export async function syncRunWorkflow(runId: string): Promise<string | null> {
  "use workflow";

  const fail = async (error: Parameters<typeof failRunStep>[1]) => {
    const closed = await failRunStep(runId, error);
    return closed.ok ? closed.value : "failed";
  };

  try {
    const prepared = await prepareRunStep(runId);
    if (!prepared.ok) return await fail(prepared.error);
    if (prepared.value.action === "stop") return null;

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const result = await processBatchStep(runId);
      const error = result.ok ? result.value.fatal : result.error;
      if (error) {
        const salvaged = await salvageRunStep(runId, error);
        if (salvaged.ok && salvaged.value) continue;
        return await fail(error);
      }
      if (result.ok && result.value.done) break;
    }

    const commit = await commitRoundStep(runId);
    if (!commit.ok) return await fail(commit.error);
    if (commit.value.action === "fail") return await fail(commit.value.error);

    let pollTimedOut = false;
    if (commit.value.action === "poll") {
      pollTimedOut = true;
      let waited = 0;
      let delay = 10;
      let failures = 0;
      while (waited < POLL_BUDGET_SECONDS) {
        await sleep(`${delay}s`);
        waited += delay;
        const poll = await pollRoundStep(runId);
        if (poll.ok) {
          failures = 0;
          if (poll.value.terminal) {
            pollTimedOut = false;
            break;
          }
        } else if (!poll.error.retryable) {
          return await fail(poll.error);
        } else if (++failures >= MAX_POLL_FAILURES) {
          break;
        }
        delay = Math.min(60, Math.round(delay * 1.5));
      }
    }

    const finalized = await finalizeRunStep(runId, pollTimedOut);
    return finalized.ok ? finalized.value : await fail(finalized.error);
  } catch {
    return await fail({
      code: "INTERNAL",
      message: "The sync stopped unexpectedly.",
      detail: "workflow orchestration error",
      retryable: false,
    });
  }
}
