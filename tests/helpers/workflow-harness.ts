/**
 * In-process stand-in for the Workflow DevKit runtime used by unit and flow tests.
 * `start()` records workflow runs; tests execute them with `harness.runAll()`, which calls
 * the real workflow function (steps run inline, `sleep()` returns immediately).
 */

type WorkflowFn = (...args: never[]) => Promise<unknown>;
type RunState = "pending" | "running" | "completed" | "failed" | "cancelled";

interface RecordedRun {
  runId: string;
  fn: WorkflowFn;
  args: unknown[];
  status: RunState;
  result?: unknown;
  error?: unknown;
  cancelReason?: string;
}

export class WorkflowRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Workflow run ${runId} not found`);
    this.name = "WorkflowRunNotFoundError";
  }

  static is(error: unknown): error is WorkflowRunNotFoundError {
    return error instanceof WorkflowRunNotFoundError;
  }
}

export class RetryableError extends Error {
  readonly retryAfter?: number | string | Date;
  constructor(message: string, options: { retryAfter?: number | string | Date } = {}) {
    super(message);
    this.name = "RetryableError";
    this.retryAfter = options.retryAfter;
  }
}

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

let counter = 0;

export const harness = {
  runs: [] as RecordedRun[],
  /** When set, the next start() call rejects with this error. */
  startError: null as Error | null,
  /** Overrides what getRun(id).status reports (an Error makes it reject). */
  statusOverrides: new Map<string, RunState | Error>(),
  step: { attempt: 1, maxAttempts: 1 },
  sleeps: [] as string[],

  reset(): void {
    this.runs = [];
    this.startError = null;
    this.statusOverrides.clear();
    this.step = { attempt: 1, maxAttempts: 1 };
    this.sleeps = [];
  },

  pending(): RecordedRun[] {
    return this.runs.filter((run) => run.status === "pending");
  },

  /** Executes every pending workflow run (including runs started while executing). */
  async runAll(): Promise<RecordedRun[]> {
    const executed: RecordedRun[] = [];
    for (let next = this.pending()[0]; next; next = this.pending()[0]) {
      next.status = "running";
      try {
        next.result = await next.fn(...(next.args as never[]));
        next.status = "completed";
      } catch (error) {
        next.error = error;
        next.status = "failed";
      }
      executed.push(next);
    }
    return executed;
  },
};

export const workflowApiMock = {
  async start(fn: WorkflowFn, args: unknown[] = []) {
    if (harness.startError) {
      const error = harness.startError;
      harness.startError = null;
      throw error;
    }
    const runId = `wrun_test_${++counter}`;
    harness.runs.push({ runId, fn, args, status: "pending" });
    return { runId };
  },

  getRun(runId: string) {
    const find = () => harness.runs.find((run) => run.runId === runId);
    return {
      runId,
      get status(): Promise<RunState> {
        const override = harness.statusOverrides.get(runId);
        if (override instanceof Error) return Promise.reject(override);
        if (override) return Promise.resolve(override);
        const run = find();
        return run ? Promise.resolve(run.status) : Promise.reject(new WorkflowRunNotFoundError(runId));
      },
      get exists(): Promise<boolean> {
        return Promise.resolve(Boolean(find()));
      },
      async cancel(options: { cancelReason?: string } = {}) {
        const run = find();
        if (!run) throw new WorkflowRunNotFoundError(runId);
        if (run.status === "pending" || run.status === "running") {
          run.status = "cancelled";
          run.cancelReason = options.cancelReason;
        }
      },
      async wakeUp() {
        return { stoppedCount: 0 };
      },
    };
  },
};

export const workflowMock = {
  getStepMetadata() {
    return { attempt: harness.step.attempt, maxAttempts: harness.step.maxAttempts, stepId: "step_test" };
  },
  async sleep(duration: string | number) {
    harness.sleeps.push(String(duration));
  },
  RetryableError,
  FatalError,
};
