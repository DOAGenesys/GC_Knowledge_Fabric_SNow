import { Check } from "lucide-react";
import type { RunDTO } from "@/lib/api-types";
import { plural } from "@/lib/format";
import { PHASE_LABEL, PHASE_STEPS } from "@/lib/ui-text";
import { cn } from "../ui/cn";
import { ProgressBar } from "../ui/feedback";

export interface RunProgress {
  /** 0..1, or null while the current step has no measurable progress. */
  value: number | null;
  label: string;
  detail: string | null;
}

export function runProgress(run: RunDTO): RunProgress {
  const label = run.cancelRequested ? "Cancelling…" : PHASE_LABEL[run.phase];
  if (run.phase === "uploading" && run.plannedUploads > 0) {
    const done = run.uploaded + run.failed + run.skipped;
    return { value: done / run.plannedUploads, label, detail: `${done} of ${plural(run.plannedUploads, "article")}` };
  }
  if (run.phase === "deleting" && run.plannedDeletions > 0) {
    return { value: run.deleted / run.plannedDeletions, label, detail: `${run.deleted} of ${plural(run.plannedDeletions, "retired article")}` };
  }
  if (run.phase === "processing") {
    return { value: null, label, detail: run.gcIngestionStatus ? `Genesys Cloud status: ${run.gcIngestionStatus}` : "This usually takes a minute or two." };
  }
  if (run.phase === "committing" || run.phase === "finalizing") {
    const changes = run.uploaded + run.deleted;
    return { value: null, label, detail: changes ? `${plural(changes, "change")} sent` : null };
  }
  return { value: null, label, detail: null };
}

export function RunProgressInline({ run, className }: { run: RunDTO; className?: string }) {
  const progress = runProgress(run);
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-azure">{progress.label}</span>
        {progress.detail ? <span className="truncate text-navy/55">{progress.detail}</span> : null}
      </div>
      <ProgressBar value={progress.value} active label={progress.label} />
    </div>
  );
}

/** Four-step tracker for the sync detail page. */
export function RunStepper({ run }: { run: RunDTO }) {
  const currentIndex = Math.max(
    0,
    PHASE_STEPS.findIndex((step) => step.phases.includes(run.phase)),
  );
  const progress = runProgress(run);
  return (
    <div>
      <ol className="grid grid-cols-4 gap-2" aria-label="Sync progress">
        {PHASE_STEPS.map((step, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
          return (
            <li key={step.label} className="flex flex-col gap-2" aria-current={state === "current" ? "step" : undefined}>
              <div className={cn("h-1.5 rounded-full", state === "done" ? "bg-patina" : state === "current" ? "progress-active bg-azure" : "bg-navy/10")} />
              <div className="flex items-center gap-1.5 text-[13px]">
                {state === "done" ? (
                  <Check className="size-3.5 text-patina-ink" aria-hidden />
                ) : (
                  <span className={cn("size-1.5 rounded-full", state === "current" ? "animate-soft-pulse bg-azure" : "bg-navy/25")} aria-hidden />
                )}
                <span className={cn("font-medium", state === "upcoming" ? "text-navy/40" : "text-navy")}>{step.label}</span>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="mt-5 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-base font-semibold text-navy">{progress.label}</p>
          {progress.detail ? <p className="text-sm text-navy/60">{progress.detail}</p> : null}
        </div>
        {progress.value !== null ? <ProgressBar value={progress.value} active label={progress.label} /> : null}
      </div>
    </div>
  );
}
