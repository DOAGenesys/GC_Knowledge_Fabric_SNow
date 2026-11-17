import { cronRoute } from "@/server/api";
import { runTick } from "@/server/sync/scheduler";

export const maxDuration = 60;

/** Vercel Schedule target (every 15 minutes). Duplicate deliveries are harmless: claiming is atomic. */
export const GET = cronRoute({ operation: "cron.tick" }, async ({ req, log }) => {
  const executionId = req.headers.get("ce-id")?.slice(0, 100) ?? null;
  const summary = await runTick({ logger: log.child({ executionId }) });
  return { ok: true, ...summary };
});
