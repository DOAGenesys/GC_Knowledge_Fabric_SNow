import { NextRequest } from "next/server";
import { CSRF_HEADER, cookieNames, type Session, sessionCookies } from "@/server/auth/session";

export const ORIGIN = "http://localhost:3000";

type RouteHandler = (req: NextRequest, context: { params: Promise<any> }) => Promise<Response>;

export interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

export interface ApiResult<T = Record<string, any>> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
  location: string | null;
  setCookies: string[];
}

/** Invokes a Next.js route handler the way the framework does, with a real NextRequest. */
export async function callRoute<T = Record<string, any>>(handler: RouteHandler, path: string, options: CallOptions = {}): Promise<ApiResult<T>> {
  const headers = new Headers({ host: new URL(ORIGIN).host, ...options.headers });
  if (options.cookies && Object.keys(options.cookies).length > 0) {
    headers.set(
      "cookie",
      Object.entries(options.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    );
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  const request = new NextRequest(new URL(path, ORIGIN), { method: options.method ?? "GET", headers, body });
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, headers: response.headers, body: parsed as T, text, location: response.headers.get("location"), setCookies: response.headers.getSetCookie() };
}

export interface SignedInClient {
  cookies: Record<string, string>;
  csrfToken: string;
  call<T = Record<string, any>>(handler: RouteHandler, path: string, options?: CallOptions & { csrf?: boolean }): Promise<ApiResult<T>>;
}

/** A browser that signed in: carries the session + CSRF cookies and echoes the CSRF header on writes. */
export function signedInClient(session: Omit<Session, "issuedAt">, nowMs?: number): SignedInClient {
  const names = cookieNames();
  const cookies = Object.fromEntries(sessionCookies(session, nowMs).map((spec) => [spec.name, spec.value]));
  const csrfToken = cookies[names.csrf]!;
  return {
    cookies,
    csrfToken,
    call(handler, path, options = {}) {
      const writes = (options.method ?? "GET") !== "GET";
      const csrfHeaders: Record<string, string> = writes && options.csrf !== false ? { [CSRF_HEADER]: csrfToken, origin: ORIGIN } : {};
      return callRoute(handler, path, { ...options, headers: { ...csrfHeaders, ...options.headers }, cookies: { ...cookies, ...options.cookies } });
    },
  };
}

/** Parses `name=value` pairs out of Set-Cookie headers. */
export function cookieJar(setCookies: string[]): Record<string, { value: string; attributes: string }> {
  const jar: Record<string, { value: string; attributes: string }> = {};
  for (const header of setCookies) {
    const [pair = "", ...attributes] = header.split(";");
    const index = pair.indexOf("=");
    jar[pair.slice(0, index).trim()] = { value: decodeURIComponent(pair.slice(index + 1).trim()), attributes: attributes.join(";").trim() };
  }
  return jar;
}
