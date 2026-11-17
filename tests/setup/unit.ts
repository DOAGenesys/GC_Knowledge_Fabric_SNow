import { afterEach, beforeEach, vi } from "vitest";

// Fake, test-only values. Real secrets never appear in tests.
process.env.APP_SESSION_SECRET = "test-session-secret-not-real-0123456789abcdef";
process.env.APP_ENCRYPTION_KEY = "test-encryption-key-not-real-0123456789abcdef";
process.env.CRON_SECRET = "test-cron-secret-not-real-0123";
process.env.LOG_LEVEL = "debug";
delete process.env.APP_ALLOWED_ORG_IDS;
delete process.env.DATABASE_URL;

vi.mock("workflow", async () => (await import("../helpers/workflow-harness")).workflowMock);
vi.mock("workflow/api", async () => (await import("../helpers/workflow-harness")).workflowApiMock);
vi.mock("workflow/errors", async () => ({ WorkflowRunNotFoundError: (await import("../helpers/workflow-harness")).WorkflowRunNotFoundError }));

const { setLogSink } = await import("@/server/log");
const { capturedLogs } = await import("../helpers/logs");
const { harness } = await import("../helpers/workflow-harness");

setLogSink((record) => capturedLogs.push(record));

beforeEach(() => {
  capturedLogs.clear();
  setLogSink((record) => capturedLogs.push(record));
  harness.reset();
});

afterEach(() => {
  vi.useRealTimers();
});
