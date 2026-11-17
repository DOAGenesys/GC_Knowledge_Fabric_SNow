"use client";

import { useEffect } from "react";
import { clientLogger } from "@/lib/client-log";

const log = clientLogger("app");

/** Last-resort boundary: replaces the root layout, so it carries its own document and inline styles. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : undefined;

  useEffect(() => {
    log.error("Application crashed", { err: error, digest });
  }, [error, digest]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#F9F8F5", color: "#152550", fontFamily: "Roboto, Arial, sans-serif" }}>
        <title>Something went wrong · Knowledge Sync</title>
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Something went wrong</h1>
            <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.7 }}>The app hit an unexpected error. Your scheduled syncs are not affected.</p>
            {digest ? <p style={{ fontFamily: "monospace", fontSize: 12, opacity: 0.5 }}>Reference {digest}</p> : null}
            <button
              type="button"
              onClick={() => retry()}
              style={{ marginTop: 16, border: 0, borderRadius: 999, padding: "12px 24px", background: "#FF451A", color: "#fff", fontSize: 15, fontWeight: 500, cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
