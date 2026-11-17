import { randomBytes } from "node:crypto";
import { vi } from "vitest";

// Throwaway keys for this process: everything the live test stores lives in an in-memory database.
process.env.APP_SESSION_SECRET = randomBytes(32).toString("base64url");
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
process.env.LOG_LEVEL = "silent";
delete process.env.APP_ALLOWED_ORG_IDS;
delete process.env.DATABASE_URL;

vi.mock("workflow", async () => {
  const { workflowMock } = await import("../helpers/workflow-harness");
  const toMs = (duration: string | number) => {
    if (typeof duration === "number") return duration;
    const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(duration.trim());
    if (!match) return 10_000;
    const value = Number(match[1]);
    return match[2] === "m" ? value * 60_000 : match[2] === "ms" ? value : value * 1_000;
  };
  // Genesys Cloud needs real time to process a round, so sleeps wait (capped to keep runs short).
  return { ...workflowMock, sleep: (duration: string | number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(toMs(duration), 20_000))) };
});
vi.mock("workflow/api", async () => (await import("../helpers/workflow-harness")).workflowApiMock);
vi.mock("workflow/errors", async () => ({ WorkflowRunNotFoundError: (await import("../helpers/workflow-harness")).WorkflowRunNotFoundError }));
