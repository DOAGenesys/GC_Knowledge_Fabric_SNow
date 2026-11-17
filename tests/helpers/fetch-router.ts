import { vi } from "vitest";

export type FakeHandler = (request: Request, url: URL) => Response | Promise<Response>;

export interface FakeRoute {
  host: string | RegExp;
  handle: FakeHandler;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
}

/**
 * Replaces global fetch with a router over fake services. Unknown hosts fail like a DNS
 * error, so a test can never reach the real internet.
 */
export function installFetch(routes: FakeRoute[]): { requests: RecordedRequest[]; restore: () => void } {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, url, headers: request.headers });
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const route = routes.find((candidate) => (typeof candidate.host === "string" ? candidate.host === url.host : candidate.host.test(url.host)));
    if (!route) throw new TypeError(`fetch failed (no fake for ${url.host})`);
    return route.handle(request, url);
  });
  globalThis.fetch = fake as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json;charset=UTF-8", ...headers } });
}
