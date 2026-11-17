import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { scopedLogger } = await import("./server/log");
    scopedLogger("boot").info("Server instance started", {
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
      region: process.env.VERCEL_REGION ?? "local",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    });
  }
}

/** Errors Next.js catches while rendering pages or running route handlers. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { scopedLogger } = await import("./server/log");
  scopedLogger("next").error("Request error", {
    err: error,
    digest: typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : undefined,
    method: request.method,
    path: request.path.split("?")[0],
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
