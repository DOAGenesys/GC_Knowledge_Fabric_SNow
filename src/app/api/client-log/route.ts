import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute } from "@/server/api";
import { cookieNames, isSameOrigin, readSession, requestHost } from "@/server/auth/session";
import { scopedLogger } from "@/server/log";

const entrySchema = z.object({
  level: z.enum(["warn", "error"]),
  scope: z.string().max(40).default("app"),
  message: z.string().max(500),
  name: z.string().max(100).optional(),
  stack: z.string().max(4000).optional(),
  path: z.string().max(300).optional(),
  requestId: z.string().max(128).optional(),
  count: z.number().int().min(1).max(1000).optional(),
});

const bodySchema = z.object({ entries: z.array(entrySchema).min(1).max(10) });

const browserLog = scopedLogger("browser");
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const buckets = new Map<string, { start: number; count: number }>();

function allow(key: string, entries: number, now = Date.now()): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start > WINDOW_MS) {
    if (buckets.size > 2000) buckets.clear();
    buckets.set(key, { start: now, count: entries });
    return entries <= MAX_PER_WINDOW;
  }
  bucket.count += entries;
  return bucket.count <= MAX_PER_WINDOW;
}

/** Receives browser warnings/errors so they show up in Vercel logs next to server records. */
export const POST = publicRoute({ operation: "client.log", body: bodySchema }, async ({ req, body }) => {
  if (!isSameOrigin(req.headers.get("origin"), requestHost(req.headers))) return NextResponse.json({ ok: false }, { status: 403 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!allow(ip, body.entries.length)) return NextResponse.json({ ok: true, dropped: true }, { status: 202 });

  let session = null;
  try {
    session = readSession(req.cookies.get(cookieNames().session)?.value);
  } catch {
    session = null;
  }
  const userAgent = req.headers.get("user-agent")?.slice(0, 160);
  for (const entry of body.entries) {
    const fields = {
      browserScope: entry.scope,
      path: entry.path?.split("?")[0],
      errorName: entry.name,
      stack: entry.stack,
      browserRequestId: entry.requestId,
      repeated: entry.count,
      userAgent,
      orgId: session?.orgId,
      userId: session?.userId,
      dedupeKey: `browser:${entry.level}:${entry.message.slice(0, 120)}`,
    };
    if (entry.level === "error") browserLog.error(entry.message, fields);
    else browserLog.warn(entry.message, fields);
  }
  return NextResponse.json({ ok: true }, { status: 202 });
});
