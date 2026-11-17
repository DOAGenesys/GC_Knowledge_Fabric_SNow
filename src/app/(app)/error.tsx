"use client";

import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { clientLogger } from "@/lib/client-log";

const log = clientLogger("page");

function digestOf(error: unknown): string | undefined {
  return error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : undefined;
}

export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = digestOf(error);

  useEffect(() => {
    log.error("Page failed to render", { err: error, digest });
  }, [error, digest]);

  return (
    <EmptyState
      illustration="/brand/icon-gear.svg"
      title="This page ran into a problem"
      action={
        <Button variant="primary" onClick={() => retry()} icon={<RotateCcw className="size-4" aria-hidden />}>
          Try again
        </Button>
      }
    >
      <p>Your syncs keep running in the background. Try again, and if it keeps happening, share this reference with your administrator.</p>
      {digest ? <p className="mt-3 font-mono text-xs text-navy/45">Reference {digest}</p> : null}
    </EmptyState>
  );
}
