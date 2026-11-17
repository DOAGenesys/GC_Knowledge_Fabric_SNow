"use client";

import { ArrowRight, CirclePause, Clock, Database, FileText, RefreshCw } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { SyncDTO } from "@/lib/api-types";
import { formatNumber, formatRelative } from "@/lib/format";
import { describeSchedule, scheduleIsAutomatic } from "@/lib/schedule";
import { AUDIENCE, HEALTH, RUN_STATUS } from "@/lib/ui-text";
import { Chip, StatusBadge } from "../ui/badge";
import { Button } from "../ui/button";
import { RunProgressInline } from "./run-progress";

export function FlowLine({ from, to }: { from: string; to: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[13px] text-navy/70">
      <span className="flex min-w-0 items-center gap-1.5">
        <Database className="size-3.5 shrink-0 text-navy/45" aria-hidden />
        <span className="truncate">{from}</span>
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-brand" aria-label="syncs to" />
      <span className="flex min-w-0 items-center gap-1.5">
        <Image src="/brand/genesys-cloud-mark.svg" alt="" width={16} height={10} className="shrink-0" unoptimized />
        <span className="truncate">{to}</span>
      </span>
    </div>
  );
}

export function SyncCard({ sync, onSyncNow, syncing }: { sync: SyncDTO; onSyncNow: (sync: SyncDTO) => void; syncing: boolean }) {
  const health = HEALTH[sync.health];
  const automatic = scheduleIsAutomatic(sync.schedule);
  const lastRun = sync.lastRun;

  return (
    <article className="group relative flex flex-col rounded-2xl bg-white p-5 shadow-card ring-1 ring-navy/[0.06] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-raised">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight text-navy">
            <Link href={`/syncs/${sync.id}`} className="outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-azure">
              {sync.name}
            </Link>
          </h3>
          <p className="mt-0.5 truncate text-[13px] text-navy/55" title={sync.kbNames.join(", ")}>
            {sync.kbNames.join(", ")}
          </p>
        </div>
        {sync.activeRun ? <StatusBadge tone="active">Syncing</StatusBadge> : <StatusBadge tone={health.tone}>{health.label}</StatusBadge>}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Chip>{AUDIENCE[sync.audience].short}</Chip>
        <FlowLine from={sync.connection.name} to={sync.source.name} />
      </div>

      <div className="mt-4 min-h-[52px]">
        {sync.activeRun ? (
          <RunProgressInline run={sync.activeRun} />
        ) : sync.health !== "healthy" && sync.statusMessage ? (
          <p className={sync.health === "error" ? "line-clamp-2 text-[13px] text-danger" : "line-clamp-2 text-[13px] text-amber-ink"}>{sync.statusMessage}</p>
        ) : lastRun ? (
          <p className="text-[13px] text-navy/60">
            Last run <span className="font-medium text-navy">{RUN_STATUS[lastRun.status].label.toLowerCase()}</span> {formatRelative(lastRun.finishedAt ?? lastRun.startedAt)}
            {lastRun.uploaded + lastRun.deleted > 0 ? ` · ${formatNumber(lastRun.uploaded + lastRun.deleted)} changes` : ""}
          </p>
        ) : (
          <p className="text-[13px] text-navy/55">Waiting for the first run.</p>
        )}
      </div>

      <div className="mt-auto flex items-center gap-x-4 gap-y-1 border-t border-navy/[0.06] pt-3.5 text-[13px] text-navy/60">
        <span className="flex items-center gap-1.5">
          <FileText className="size-3.5" aria-hidden />
          {formatNumber(sync.articleCount)}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {!sync.enabled ? <CirclePause className="size-3.5 text-amber-ink" aria-hidden /> : <Clock className="size-3.5" aria-hidden />}
          <span className="truncate">
            {!sync.enabled ? "Paused" : automatic && sync.nextRunAt ? `Next ${formatRelative(sync.nextRunAt)}` : describeSchedule(sync.schedule)}
          </span>
        </span>
        <Button
          size="sm"
          variant="subtle"
          className="relative z-10 ml-auto"
          onClick={() => onSyncNow(sync)}
          loading={syncing}
          disabled={Boolean(sync.activeRun)}
          icon={<RefreshCw className="size-3.5" aria-hidden />}
        >
          Sync now
        </Button>
      </div>
    </article>
  );
}
