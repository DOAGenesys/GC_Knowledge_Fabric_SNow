"use client";

import { ArrowLeft, Ban, RefreshCw, RotateCcw, Wrench } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { ArticleState, SyncDTO } from "@/lib/api-types";
import { formatDateTime, formatNumber, formatRelative, plural } from "@/lib/format";
import { useSync } from "@/lib/hooks";
import { describeSchedule, scheduleIsAutomatic } from "@/lib/schedule";
import { AUDIENCE, HEALTH } from "@/lib/ui-text";
import { Chip, StatusBadge } from "../ui/badge";
import { Button, ButtonLink } from "../ui/button";
import { Callout, ErrorCallout } from "../ui/callout";
import { ConfirmDialog } from "../ui/dialog";
import { EmptyState, Skeleton } from "../ui/feedback";
import { Switch } from "../ui/field";
import { TabPanel, Tabs } from "../ui/tabs";
import { useToast } from "../ui/toast";
import { ActivityTab } from "./activity-tab";
import { ArticlesTab } from "./articles-tab";
import { RunStepper } from "./run-progress";
import { SettingsTab } from "./settings-tab";
import { FlowLine } from "./sync-card";
import { useCancelRun, useRefreshSync, useSyncNow } from "./use-sync-actions";

type TabId = "activity" | "articles" | "settings";

const CONNECTION_FIXES = new Set(["GC_AUTH_FAILED", "GC_PERMISSION_DENIED", "GC_CREDENTIALS_MISSING", "GC_ORG_MISMATCH", "GC_KNOWLEDGE_ACCESS_DENIED"]);
const SETTINGS_FIXES = new Set(["SN_QUERY_INVALID", "SN_TOO_MANY_ARTICLES"]);

function LastRunProblem({ sync, onShowFailed, onOpenSettings }: { sync: SyncDTO; onShowFailed: () => void; onOpenSettings: () => void }) {
  const run = sync.lastRun;
  if (sync.activeRun || !run || (run.status !== "failed" && run.status !== "partial")) return null;
  const retrying = sync.enabled && scheduleIsAutomatic(sync.schedule) && sync.nextRunAt;
  const code = run.error?.code ?? "";
  let action: React.ReactNode = null;
  if (SETTINGS_FIXES.has(code)) {
    action = (
      <Button size="sm" onClick={onOpenSettings}>
        Open settings
      </Button>
    );
  } else if (code.startsWith("SN_") || CONNECTION_FIXES.has(code)) {
    action = (
      <ButtonLink size="sm" href={code.startsWith("SN_") ? "/connections" : "/connections#genesys"}>
        Open Connections
      </ButtonLink>
    );
  } else if (run.status === "partial" && run.failed > 0) {
    action = (
      <Button size="sm" onClick={onShowFailed}>
        View failed articles
      </Button>
    );
  }

  if (run.status === "partial") {
    return (
      <Callout tone="warning" title={run.error?.title ?? "Some articles weren't synced"} action={action}>
        <p>{run.error?.message ?? sync.statusMessage ?? run.note ?? `${plural(run.failed, "article")} couldn't be uploaded.`}</p>
        <p className="text-navy/60">Everything else is up to date. The next run tries the failed articles again.</p>
      </Callout>
    );
  }
  return (
    <Callout tone="danger" title={run.error?.title ?? "The last sync failed"} action={action}>
      <p>{run.error?.message ?? sync.statusMessage ?? "The run stopped before it finished."}</p>
      {run.error?.hint ? <p className="text-navy/70">{run.error.hint}</p> : null}
      {sync.consecutiveFailures > 1 || retrying ? (
        <p className="text-navy/55">
          {sync.consecutiveFailures > 1 ? `Failed ${sync.consecutiveFailures} times in a row. ` : ""}
          {retrying ? `Next automatic attempt ${formatRelative(sync.nextRunAt)}.` : ""}
        </p>
      ) : null}
    </Callout>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl bg-white px-5 py-4 shadow-card ring-1 ring-navy/[0.06]">
      <p className="text-[12px] font-medium tracking-wide text-navy/55 uppercase">{label}</p>
      <p className="mt-1.5 truncate text-xl font-semibold tracking-tight text-navy first-letter:uppercase">{value}</p>
      {note ? <p className="truncate text-[13px] text-navy/50">{note}</p> : null}
    </div>
  );
}

export function SyncDetail({ id }: { id: string }) {
  const { data, error, isLoading, mutate } = useSync(id);
  const { syncNow, pending } = useSyncNow();
  const cancelRun = useCancelRun();
  const refresh = useRefreshSync();
  const toast = useToast();
  const [tab, setTab] = useState<TabId>("activity");
  const [articleFilter, setArticleFilter] = useState<ArticleState | "all">("all");
  const [confirmFull, setConfirmFull] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const sync = data?.sync;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-10 w-80" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (!sync) {
    if (isApiError(error) && error.status === 404) {
      return (
        <EmptyState illustration="/brand/icon-search.svg" title="This sync doesn't exist anymore" action={<ButtonLink href="/">Back to your syncs</ButtonLink>}>
          It may have been deleted by someone in your organization.
        </EmptyState>
      );
    }
    return (
      <ErrorCallout
        error={error}
        action={
          <Button size="sm" onClick={() => mutate()} icon={<RotateCcw className="size-3.5" aria-hidden />}>
            Try again
          </Button>
        }
      />
    );
  }

  const health = HEALTH[sync.health];
  const automatic = scheduleIsAutomatic(sync.schedule);

  async function toggleEnabled(enabled: boolean) {
    if (!sync) return;
    setToggling(true);
    try {
      const result = await apiFetch<{ sync: SyncDTO }>(`/api/syncs/${sync.id}`, { method: "PATCH", body: { enabled } });
      await mutate({ sync: result.sync }, { revalidate: false });
      await refresh(sync.id);
      toast.success(enabled ? "Automatic syncs resumed" : "Automatic syncs paused", enabled ? `Next run ${formatRelative(result.sync.nextRunAt)}.` : "You can still sync manually.");
    } catch (caught) {
      toast.error(caught, "Couldn't change the schedule");
    } finally {
      setToggling(false);
    }
  }

  async function cancel() {
    if (!sync?.activeRun) return;
    setCancelling(true);
    try {
      await cancelRun(sync.activeRun);
    } catch {
      // Reported by useCancelRun.
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-navy/60 hover:text-navy">
        <ArrowLeft className="size-4" aria-hidden /> All syncs
      </Link>

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[28px] leading-tight font-medium tracking-tight text-navy">{sync.name}</h1>
            {sync.activeRun ? <StatusBadge tone="active">Syncing</StatusBadge> : <StatusBadge tone={health.tone}>{health.label}</StatusBadge>}
            {!sync.enabled && automatic ? <StatusBadge tone="warning">Paused</StatusBadge> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Chip>{AUDIENCE[sync.audience].label}</Chip>
            <FlowLine from={`${sync.connection.name} · ${sync.kbNames.join(", ")}`} to={sync.source.name} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {sync.activeRun ? (
            <Button onClick={cancel} loading={cancelling} disabled={sync.activeRun.cancelRequested} icon={<Ban className="size-4" aria-hidden />}>
              {sync.activeRun.cancelRequested ? "Cancelling…" : "Cancel run"}
            </Button>
          ) : (
            <Button onClick={() => setConfirmFull(true)} icon={<Wrench className="size-4" aria-hidden />}>
              Full rebuild
            </Button>
          )}
          <Button variant="primary" onClick={() => void syncNow(sync)} loading={pending === sync.id} disabled={Boolean(sync.activeRun)} icon={<RefreshCw className="size-4" aria-hidden />}>
            Sync now
          </Button>
        </div>
      </div>

      <LastRunProblem
        sync={sync}
        onShowFailed={() => {
          setArticleFilter("error");
          setTab("articles");
        }}
        onOpenSettings={() => setTab("settings")}
      />

      {sync.activeRun ? (
        <section className="animate-fade-in rounded-2xl bg-white p-6 shadow-card ring-1 ring-azure/20" aria-live="polite">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2 text-[13px] text-navy/55">
            <span>
              {sync.activeRun.mode === "full" ? "Full rebuild" : "Sync"} started {formatRelative(sync.activeRun.startedAt)}
              {sync.activeRun.requestedBy ? ` by ${sync.activeRun.requestedBy}` : ""}
            </span>
            {sync.activeRun.plannedUploads + sync.activeRun.plannedDeletions > 0 ? (
              <span>
                {plural(sync.activeRun.plannedUploads, "upload")} · {plural(sync.activeRun.plannedDeletions, "removal")} planned
              </span>
            ) : null}
          </div>
          <RunStepper run={sync.activeRun} />
        </section>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Articles in Genesys Cloud" value={formatNumber(sync.articleCount)} note={sync.source.name} />
        <Tile label="Last successful sync" value={formatRelative(sync.lastSuccessAt)} note={sync.lastSuccessAt ? formatDateTime(sync.lastSuccessAt) : "No successful run yet"} />
        <Tile
          label="Next run"
          value={!automatic ? "Manual" : !sync.enabled ? "Paused" : sync.nextRunAt ? formatRelative(sync.nextRunAt) : "—"}
          note={describeSchedule(sync.schedule, { withTimeZone: true })}
        />
        <div className="flex flex-col justify-center rounded-2xl bg-white px-5 py-4 shadow-card ring-1 ring-navy/[0.06]">
          {automatic ? (
            <Switch checked={sync.enabled} onChange={toggleEnabled} disabled={toggling} label="Automatic syncs" description={sync.enabled ? "Running on schedule" : "Paused, manual only"} />
          ) : (
            <>
              <p className="text-[12px] font-medium tracking-wide text-navy/55 uppercase">Schedule</p>
              <p className="mt-1.5 text-sm text-navy/70">Manual only. Add a schedule in Settings.</p>
            </>
          )}
        </div>
      </div>

      <div>
        <Tabs<TabId>
          label="Sync sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "activity", label: "Activity" },
            { id: "articles", label: "Articles", count: sync.articleCount || null },
            { id: "settings", label: "Settings" },
          ]}
        />
        <TabPanel id={tab}>
          {tab === "activity" ? <ActivityTab sync={sync} /> : null}
          {tab === "articles" ? <ArticlesTab key={articleFilter} sync={sync} initialState={articleFilter} /> : null}
          {tab === "settings" ? <SettingsTab key={sync.id} sync={sync} /> : null}
        </TabPanel>
      </div>

      <ConfirmDialog
        open={confirmFull}
        onClose={() => setConfirmFull(false)}
        onConfirm={async () => {
          const result = await syncNow(sync, "full");
          if (!result) throw new Error("not started");
        }}
        title="Run a full rebuild?"
        confirmLabel="Start full rebuild"
      >
        <p>Every article is uploaded again and Genesys Cloud replaces the whole source in one go. Use it after changing article templates, or if the source was edited by hand.</p>
        <p>Regular syncs only send what changed, so you rarely need this.</p>
      </ConfirmDialog>
    </div>
  );
}
