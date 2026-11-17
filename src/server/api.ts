import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { ZodError, type z } from "zod";
import { AppError, type FieldIssue } from "@/lib/errors";
import { CSRF_HEADER, cookieNames, readSession, requestHost, type Session, verifyCsrf } from "./auth/session";
import { timingSafeEqualStrings } from "./crypto";
import { allowedOrgIds, requireEnv } from "./env";
import { type Logger, scopedLogger } from "./log";
import type { ActorContext } from "./services/actor";

const baseLog = scopedLogger("api");
const MAX_BODY_BYTES = 1024 * 1024;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type AuthMode = "session" | "cron" | "none";

export interface RouteOptions<TBody> {
  /** Stable name for logs, e.g. "syncs.create". */
  operation: string;
  auth?: AuthMode;
  body?: z.ZodType<TBody>;
}

export interface HandlerContext<TBody, TParams> {
  req: NextRequest;
  params: TParams;
  body: TBody;
  requestId: string;
  log: Logger;
  session: Session | null;
}

export interface SessionHandlerContext<TBody, TParams> extends HandlerContext<TBody, TParams> {
  session: Session;
  actor: ActorContext;
}

export function requestIdFor(req: NextRequest): string {
  const candidate = req.headers.get("x-request-id") ?? req.headers.get("x-vercel-id")?.split("::").pop() ?? "";
  return /^[\w:.-]{6,128}$/.test(candidate) ? candidate : randomUUID();
}

export function zodFields(error: ZodError): FieldIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

function errorResponse(error: unknown, requestId: string): { response: NextResponse; status: number; code: string; detail?: string } {
  let appError: AppError;
  if (error instanceof AppError) appError = error;
  else if (error instanceof ZodError) appError = new AppError("VALIDATION", { fields: zodFields(error) });
  else appError = new AppError("INTERNAL", { cause: error });
  const response = NextResponse.json(appError.toBody(requestId), { status: appError.status });
  return { response, status: appError.status, code: appError.code, detail: appError.detail };
}

async function parseBody<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new AppError("VALIDATION", { message: "The request is too large.", status: 413 });
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new AppError("VALIDATION", { message: "The request is too large.", status: 413 });
    raw = text ? JSON.parse(text) : {};
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("VALIDATION", { message: "The request body isn't valid JSON." });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", { fields: zodFields(parsed.error) });
  return parsed.data;
}

function authenticateCron(req: NextRequest): void {
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${requireEnv("CRON_SECRET")}`;
  if (!timingSafeEqualStrings(header, expected)) throw new AppError("UNAUTHENTICATED", { detail: "invalid cron authorization" });
}

function authenticateSession(req: NextRequest): Session {
  const names = cookieNames();
  const session = readSession(req.cookies.get(names.session)?.value);
  if (!session) throw new AppError("UNAUTHENTICATED");
  const allowed = allowedOrgIds();
  if (allowed && !allowed.has(session.orgId.toLowerCase())) throw new AppError("ORG_NOT_ALLOWED");
  if (MUTATING.has(req.method)) {
    const ok = verifyCsrf({
      cookieToken: req.cookies.get(names.csrf)?.value,
      headerToken: req.headers.get(CSRF_HEADER),
      origin: req.headers.get("origin"),
      host: requestHost(req.headers),
    });
    if (!ok) throw new AppError("CSRF_FAILED");
  }
  return session;
}

type RouteHandler<TParams> = (req: NextRequest, context: { params: Promise<TParams> }) => Promise<Response>;

function build<TBody, TParams>(
  options: RouteOptions<TBody>,
  handler: (ctx: HandlerContext<TBody, TParams>) => Promise<unknown>,
): RouteHandler<TParams> {
  return async (req, context) => {
    const started = performance.now();
    const requestId = requestIdFor(req);
    const debug = req.headers.get("x-kf-debug") === "1";
    const log = baseLog.child({ requestId, operation: options.operation }, debug ? { threshold: "debug" } : {});
    const path = req.nextUrl.pathname;
    let status = 200;
    let code: string | undefined;
    let detail: string | undefined;
    let response: Response;
    let session: Session | null = null;

    try {
      const auth = options.auth ?? "session";
      if (auth === "cron") authenticateCron(req);
      if (auth === "session") session = authenticateSession(req);
      const body = options.body ? await parseBody(req, options.body) : (undefined as TBody);
      const params = ((await context?.params) ?? {}) as TParams;
      const scopedLog = session ? log.child({ orgId: session.orgId, userId: session.userId }) : log;
      const result = await handler({ req, params, body, requestId, log: scopedLog, session });
      response = result instanceof Response ? result : NextResponse.json(result ?? { ok: true });
      status = response.status;
    } catch (error) {
      const mapped = errorResponse(error, requestId);
      response = mapped.response;
      status = mapped.status;
      code = mapped.code;
      detail = mapped.detail;
      if (status >= 500 && code === "INTERNAL") {
        log.error("Unhandled API error", { method: req.method, path, err: error });
      }
    }

    response.headers.set("x-request-id", requestId);
    response.headers.set("cache-control", "no-store");
    const fields = {
      method: req.method,
      path,
      status,
      durationMs: Math.round(performance.now() - started),
      ...(code ? { code } : {}),
      ...(detail ? { detail } : {}),
      ...(session ? { orgId: session.orgId } : {}),
    };
    if (status >= 500) log.warn("API request failed", fields);
    else if (status >= 400) log.info("API request rejected", { ...fields, dedupeKey: status === 401 ? `401:${path}` : undefined });
    else if (MUTATING.has(req.method)) log.info("API request", fields);
    else log.debug("API request", fields);
    return response;
  };
}

/** Route for signed-in users (CSRF-checked on writes). */
export function sessionRoute<TBody = undefined, TParams = Record<string, string>>(
  options: Omit<RouteOptions<TBody>, "auth">,
  handler: (ctx: SessionHandlerContext<TBody, TParams>) => Promise<unknown>,
): RouteHandler<TParams> {
  return build<TBody, TParams>({ ...options, auth: "session" }, (ctx) => {
    const session = ctx.session!;
    const actor: ActorContext = { orgId: session.orgId, userId: session.userId, userName: session.userName, log: ctx.log };
    return handler({ ...ctx, session, actor });
  });
}

export function publicRoute<TBody = undefined, TParams = Record<string, string>>(
  options: Omit<RouteOptions<TBody>, "auth">,
  handler: (ctx: HandlerContext<TBody, TParams>) => Promise<unknown>,
): RouteHandler<TParams> {
  return build<TBody, TParams>({ ...options, auth: "none" }, handler);
}

export function cronRoute(options: Omit<RouteOptions<undefined>, "auth" | "body">, handler: (ctx: HandlerContext<undefined, Record<string, string>>) => Promise<unknown>): RouteHandler<Record<string, string>> {
  return build<undefined, Record<string, string>>({ ...options, auth: "cron" }, handler);
}
