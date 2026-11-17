import { vi } from "vitest";

export interface ApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = Reply | ((call: ApiCall, params: Record<string, string>) => Reply | Promise<Reply>);

interface CompiledRoute {
  key: string;
  method: string;
  pattern: RegExp;
  names: string[];
  route: Route;
}

export function errorBody(code: string, message: string, extra: { title?: string; hint?: string; fields?: Array<{ path: string; message: string }>; requestId?: string } = {}) {
  return {
    error: {
      code,
      title: extra.title ?? code,
      message,
      ...(extra.hint ? { hint: extra.hint } : {}),
      ...(extra.fields ? { fields: extra.fields } : {}),
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
    },
  };
}

function compile(key: string, route: Route): CompiledRoute {
  const [method, path] = key.split(" ") as [string, string];
  const names: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_match, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { key, method, pattern: new RegExp(`^${source}$`), names, route };
}

/**
 * Stubs global fetch with a small router: keys are "METHOD /path/:param". Later `set` calls
 * take precedence. Unknown routes answer 404 and are listed in `unmatched`.
 */
export function mockApi(routes: Record<string, Route> = {}) {
  let compiled = Object.entries(routes).map(([key, route]) => compile(key, route));
  const calls: ApiCall[] = [];
  const unmatched: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost:3000");
    const method = (init.method ?? "GET").toUpperCase();
    if (url.pathname === "/api/client-log") return new Response(JSON.stringify({ ok: true }), { status: 202 });
    const call: ApiCall = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
    };
    calls.push(call);
    for (const entry of compiled) {
      if (entry.method !== method) continue;
      const match = entry.pattern.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(entry.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]));
      const reply = typeof entry.route === "function" ? await entry.route(call, params) : entry.route;
      const status = reply.status ?? 200;
      return new Response(reply.body === undefined || status === 204 ? null : JSON.stringify(reply.body), {
        status,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    }
    unmatched.push(`${method} ${url.pathname}`);
    return new Response(JSON.stringify(errorBody("NOT_FOUND", `No mock for ${method} ${url.pathname}`)), { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);

  return {
    calls,
    unmatched,
    fetch: fetchMock,
    set(key: string, route: Route) {
      compiled = [compile(key, route), ...compiled.filter((entry) => entry.key !== key)];
    },
    callsTo(method: string, path: string | RegExp): ApiCall[] {
      return calls.filter((call) => call.method === method && (typeof path === "string" ? call.path === path : path.test(call.path)));
    },
  };
}

export type MockApi = ReturnType<typeof mockApi>;
