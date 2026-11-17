import { type NextRequest, NextResponse } from "next/server";
import { cookieNames, readSession } from "@/server/auth/session";

/**
 * Runs before every page and API request:
 *  - per-request nonce Content-Security-Policy (Next.js applies the nonce to its scripts);
 *  - request ID propagated to route handlers and returned to the browser;
 *  - pages require a session (API routes answer 401 themselves).
 */

const PUBLIC_PAGES = new Set(["/login"]);

function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function hasSession(req: NextRequest): boolean {
  try {
    return readSession(req.cookies.get(cookieNames().session)?.value) !== null;
  } catch {
    return false;
  }
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const isApi = path.startsWith("/api/");

  if (!isApi) {
    const signedIn = hasSession(req);
    if (!signedIn && !PUBLIC_PAGES.has(path)) {
      const login = new URL("/login", req.url);
      if (path !== "/") login.searchParams.set("returnTo", `${path}${req.nextUrl.search}`);
      return NextResponse.redirect(login);
    }
    if (signedIn && path === "/login" && !req.nextUrl.searchParams.has("error")) {
      return NextResponse.redirect(new URL("/", req.url));
    }
  }

  const requestId = req.headers.get("x-vercel-id")?.split("::").pop() || crypto.randomUUID();
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);

  let csp: string | null = null;
  if (!isApi) {
    const nonce = btoa(crypto.randomUUID());
    csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
  }

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  if (csp) response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg|brand/|\\.well-known/workflow/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
