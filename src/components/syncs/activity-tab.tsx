"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { RunDTO, SyncDTO } from "@/lib/api-types";
import { formatDateTime, formatDuration, formatNumber, formatRelative } from "@/lib/format";
import { useRunDetail, useRuns } from "@/lib/hooks";
import { RUN_STATUS, TRIGGER_LABEL } from "@/lib/ui-text";
import { StatusBadge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorCallout } from "../ui/callout";
import { cn } from "../ui/cn";
import { CopyButton } from "../ui/copy-button";
import { EmptyState, Skeleton } from "../ui/feedback";

function runSummary(run: RunDTO): string {
  if (run.status === "noop") return run.note ?? "Nothing changed in ServiceNow.";
  if (run.status === "queued" || run.status === "running") return "In progress";
  const parts = [
    run.uploaded ? `${formatNumber(run.uploaded)} uploaded` : null,
    run.deleted ? `${formatNumber(run.deleted)} removed` : null,
    run.unchanged ? `${formatNumber(run.unchanged)} unchanged` : null,
    run.failed ? `${formatNumber(run.failed)} failed` : null,
    run.skipped ? `${formatNumber(run.skipped)} skipped` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : run.status === "cancelled" ? "Cancelled before any change" : "No changes";
}

function RunDetails({ run }: { run: RunDTO }) {
  const live = run.status === "queued" || run.status === "running";
  const needsItems = run.failed + run.skipped > 0;
  const detail = useRunDetail(run.syncId, needsItems ? run.id : null, live, "attention");
  const items = detail.data?.items ?? [];

  return (
    <div className="space-y-4 border-t border-navy/[0.06] bg-nimbus/50 px-5 py-4">
      {run.note && run.status !== "noop" ? <p className="text-sm text-navy/75">{run.note}</p> : null}
      {run.error ? (
        <div className="rounded-xl bg-white p-4 ring-1 ring-danger/15">
          <p className="text-sm font-semibold text-danger">{run.error.title}</p>
          <p className="mt-1 text-sm text-navy/75">{run.error.message}</p>
          {run.error.hint ? <p className="mt-1 text-sm text-navy/60">{run.error.hint}</p> : null}
        </div>
      ) : null}

      {needsItems ? (
        <div>
          <p className="mb-2 text-xs font-medium tracking-wide text-navy/50 uppercase">Articles that need attention</p>
          {detail.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : detail.error ? (
            <ErrorCallout error={detail.error} />
          ) : (
            <ul className="divide-y divide-navy/[0.06] rounded-xl bg-white ring-1 ring-navy/[0.06]">
              {items.map((item) => (
                <li key={`${item.articleId}-${item.op}`} className="px-4 py-2.5 text-[13px]">
                  <div className="flex items-center gap-3">
                    <span className="w-24 shrink-0 font-mono text-[12px] text-navy/50">{item.number || "—"}</span>
                    <span className="min-w-0 flex-1 truncate text-navy">{item.title}</span>
                    <StatusBadge tone={item.status === "failed" ? "danger" : "warning"} size="sm">
                      {item.status === "failed" ? "Failed" : "Skipped"}
                    </StatusBadge>
                  </div>
                  {item.error ? <p className="mt-1 pl-27 text-navy/60">{item.error}</p> : null}
                </li>
              ))}
              {items.length === 0 ? <li className="px-4 py-3 text-[13px] text-navy/55">No details recorded.</li> : null}
            </ul>
          )}
          <p className="mt-2 text-xs text-navy/50">Failed articles are retried automatically on the next run.</p>
        </div>
      ) : null}

      <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-navy/50">Started</dt>
          <dd className="text-navy">{formatDateTime(run.startedAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-navy/50">Finished</dt>
          <dd className="text-navy">{formatDateTime(run.finishedAt)}</dd>
        </div>
        {run.requestedBy ? (
          <div className="flex gap-2">
            <dt className="text-navy/50">Started by</dt>
            <dd className="text-navy">{run.requestedBy}</dd>
          </div>
        ) : null}
      </dl>

      {run.error?.detail || run.gcSyncId || run.gcSyncStatus ? (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-xs font-medium text-navy/50 hover:text-navy/70">Technical details (for support)</summary>
          <dl className="mt-2 space-y-1.5">
            {run.error ? (
              <div className="flex gap-2">
                <dt className="text-navy/50">Error code</dt>
                <dd className="font-mono text-[12px] text-navy">{run.error.code}</dd>
              </div>
            ) : null}
            {run.gcSyncId ? (
              <div className="flex items-center gap-2">
                <dt className="text-navy/50">Genesys Cloud synchronization</dt>
                <dd className="flex min-w-0 items-center gap-1 font-mono text-[12px] text-navy">
                  <span className="truncate">{run.gcSyncId}</span>
                  <CopyButton value={run.gcSyncId} label="Copy synchronization ID" size="xs" />
                </dd>
              </div>
            ) : null}
            {run.gcSyncStatus ? (
              <div className="flex gap-2">
                <dt className="text-navy/50">Genesys Cloud status</dt>
                <dd className="text-navy">
                  {run.gcSyncStatus}
                  {run.gcIngestionStatus ? ` · ingestion ${run.gcIngestionStatus}` : ""}
                </dd>
              </div>
            ) : null}
          </dl>
          {run.error?.detail ? <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-3 font-mono text-[11px] whitespace-pre-wrap text-navy/70">{run.error.detail}</pre> : null}
        </details>
      ) : null}
    </div>
  );
}

export function ActivityTab({ sync }: { sync: SyncDTO }) {
  const runs = useRuns(sync.id, Boolean(sync.activeRun));
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = runs.data?.runs ?? [];

  if (runs.isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-[68px] w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (runs.error && !runs.data) {
    return (
      <ErrorCallout
        error={runs.error}
        action={
          <Button size="sm" onClick={() => runs.mutate()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (list.length === 0) {
    return (
      <EmptyState illustration="/brand/icon-clock.svg" title="No runs yet">
        Click Sync now to run it, or wait for the schedule.
      </EmptyState>
    );
  }

  return (
    <ul className="space-y-2">
      {list.map((run) => {
        const status = RUN_STATUS[run.status];
        const open = expanded === run.id;
        return (
          <li key={run.id} className="overflow-hidden rounded-xl bg-white ring-1 ring-navy/[0.07]">
            <button
              type="button"
              onClick={() => setExpanded(open ? null : run.id)}
              aria-expanded={open}
              className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-nimbus/60"
            >
              <StatusBadge tone={status.tone} className="w-[118px] justify-center">
                {status.label}
              </StatusBadge>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-navy">
                  {TRIGGER_LABEL[run.trigger]}
                  {run.mode === "full" ? " · Full re-upload" : ""}
                </span>
                <span className="block truncate text-[13px] text-navy/55">{run.error && run.status === "failed" ? run.error.message : runSummary(run)}</span>
              </span>
              <span className="hidden shrink-0 text-right text-[13px] sm:block">
                <span className="block text-navy/70" title={formatDateTime(run.startedAt)}>
                  {formatRelative(run.startedAt)}
                </span>
                <span className="block text-navy/45">{run.durationMs !== null ? formatDuration(run.durationMs) : "…"}</span>
              </span>
              <ChevronDown className={cn("size-4 shrink-0 text-navy/40 transition-transform", open && "rotate-180")} aria-hidden />
            </button>
            {open ? <RunDetails run={run} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
