import { clientLogger, isDebugEnabled, setDebug } from "./lib/client-log";

const log = clientLogger("app");

const IGNORED_ERRORS = [/ResizeObserver loop/i, /^Script error\.?$/i];

try {
  window.addEventListener("error", (event) => {
    const message = event.message || "Uncaught error";
    if (IGNORED_ERRORS.some((pattern) => pattern.test(message))) return;
    if (/^(chrome|moz|safari)-extension:/.test(event.filename ?? "")) return;
    log.error(message, { err: event.error, source: (event.filename ?? "").split("?")[0] });
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (event.reason instanceof DOMException && event.reason.name === "AbortError") return;
    log.error("Unhandled promise rejection", { err: event.reason });
  });

  Object.assign(window, {
    kfDebug(enabled = true) {
      setDebug(enabled);
      return enabled ? "Verbose logging is on: API calls are logged here and on the server. Reload the page." : "Verbose logging is off.";
    },
  });

  if (isDebugEnabled()) log.info("Verbose logging is on (run kfDebug(false) to turn it off)", { version: process.env.NEXT_PUBLIC_APP_VERSION });
} catch {
  // Instrumentation must never break the app.
}

export function onRouterTransitionStart(url: string, navigationType: "push" | "replace" | "traverse"): void {
  log.debug("Navigate", { to: url.split("?")[0], navigationType });
}
