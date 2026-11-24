"use client";

import { ArrowRight, Check, Plus, RotateCcw } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import threads from "@/assets/threads.webp";
import type { SessionInfo, SyncDTO } from "@/lib/api-types";
import { formatNumber, formatRelative, plural } from "@/lib/format";
import { useSessionInfo, useSyncs } from "@/lib/hooks";
import { scheduleIsAutomatic } from "@/lib/schedule";
import { firstName, greeting } from "@/lib/ui-text";
import { Button, ButtonLink } from "./ui/button";
import { Callout, ErrorCallout } from "./ui/callout";
import { SectionTitle } from "./ui/card";
import { cn } from "./ui/cn";
import { EmptyState, Skeleton } from "./ui/feedback";
import { SyncCard } from "./syncs/sync-card";
import { useSyncNow } from "./syncs/use-sync-actions";

function Hero({ session }: { session: SessionInfo | undefined }) {
  return (
    <section className="relative overflow-hidden rounded-3xl bg-white px-6 py-8 shadow-card ring-1 ring-navy/[0.06] sm:px-10 sm:py-10">
      <div aria-hidden className="bg-gen-gradient pointer-events-none absolute -top-28 -right-20 hidden size-[380px] rounded-full md:block" />
      <Image
        src={threads}
        alt=""
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 hidden w-[34%] max-w-[420px] md:block"
        sizes="(min-width: 768px) 34vw, 0px"
        priority
      />
      <div className="relative max-w-xl">
        {session ? (
          <p className="text-sm font-medium text-navy/55">
            {greeting()}, {firstName(session.user.name)}
          </p>
        ) : (
          <Skeleton className="h-4 w-40" />
        )}
        <h1 className="mt-2 text-[28px] leading-tight font-medium tracking-tight text-navy sm:text-[34px]">Your knowledge, in sync.</h1>
        <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-navy/65">
          ServiceNow articles flow into Genesys Cloud Knowledge on your schedule, ready for bots, Copilot and agents.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/syncs/new" variant="primary" size="lg" icon={<Plus className="size-4" aria-hidden />}>
            New sync
          </ButtonLink>
          <ButtonLink href="/connections" variant="secondary" size="lg">
            Connections
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

function SetupChecklist({ setup }: { setup: SessionInfo["setup"] }) {
  const steps = [
    {
      done: setup.connections > 0,
      title: "Connect ServiceNow",
      text: "Enter your ServiceNow address and a user that can read your knowledge bases.",
      href: "/connections",
      action: "Connect ServiceNow",
    },
    {
      done: setup.gcCredentials === "ok",
      failed: setup.gcCredentials === "error",
      title: "Give syncs access to Genesys Cloud",
      text: "A Genesys Cloud admin creates an OAuth client once, so syncs can run on their own.",
      href: "/connections#genesys",
      action: setup.gcCredentials === "error" ? "Fix access" : "Set up access",
    },
    {
      done: setup.syncs > 0,
      title: "Create your first sync",
      text: "Pick the knowledge bases, where the articles go and how often to update them.",
      href: "/syncs/new",
      action: "Create a sync",
    },
  ];
  const completed = steps.filter((step) => step.done).length;
  if (completed === steps.length) return null;
  const nextIndex = steps.findIndex((step) => !step.done);

  return (
    <section className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-navy/[0.06]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Get set up in three steps</h2>
          <p className="mt-0.5 text-sm text-navy/60">About five minutes. You only do this once per organization.</p>
        </div>
        <p className="text-sm font-medium text-navy/55">
          {completed} of {steps.length} done
        </p>
      </div>
      <ol className="mt-5 grid gap-3 md:grid-cols-3">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={cn(
              "flex flex-col rounded-xl p-4 ring-1 ring-inset",
              step.done ? "bg-patina-soft/60 ring-patina/20" : index === nextIndex ? "bg-white ring-azure/40" : "bg-nimbus ring-navy/[0.06]",
            )}
          >
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  "grid size-7 place-items-center rounded-full text-[13px] font-semibold",
                  step.done ? "bg-patina text-white" : step.failed ? "bg-danger text-white" : index === nextIndex ? "bg-azure text-white" : "bg-navy/10 text-navy/60",
                )}
              >
                {step.done ? <Check className="size-4" aria-label="Done" /> : index + 1}
              </span>
              <h3 className="text-sm font-semibold text-navy">{step.title}</h3>
            </div>
            <p className="mt-2 flex-1 text-[13px] leading-relaxed text-navy/60">{step.text}</p>
            {!step.done ? (
              <Link href={step.href} className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-azure hover:underline">
                {step.action} <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Stats({ syncs }: { syncs: SyncDTO[] }) {
  const articles = syncs.reduce((sum, sync) => sum + sync.articleCount, 0);
  const healthy = syncs.filter((sync) => sync.health === "healthy").length;
  const automatic = syncs.filter((sync) => sync.enabled && scheduleIsAutomatic(sync.schedule));
  const next = automatic
    .map((sync) => sync.nextRunAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const running = syncs.filter((sync) => sync.activeRun).length;
  const tiles = [
    { label: "Articles in Genesys Cloud", value: formatNumber(articles), note: `across ${plural(syncs.length, "sync")}` },
    { label: "Healthy syncs", value: `${healthy}/${syncs.length}`, note: healthy === syncs.length ? "All good" : `${syncs.length - healthy} need a look` },
    { label: "Automatic", value: String(automatic.length), note: automatic.length ? "on a schedule" : "all manual" },
    { label: running ? "Running now" : "Next scheduled run", value: running ? String(running) : next ? formatRelative(next) : "—", note: running ? plural(running, "sync") : next ? "automatically" : "nothing scheduled" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-2xl bg-white px-5 py-4 shadow-card ring-1 ring-navy/[0.06]">
          <p className="text-[12px] font-medium tracking-wide text-navy/55 uppercase">{tile.label}</p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight text-navy first-letter:uppercase">{tile.value}</p>
          <p className="text-[13px] text-navy/50">{tile.note}</p>
        </div>
      ))}
    </div>
  );
}

function AttentionBanner({ syncs }: { syncs: SyncDTO[] }) {
  const failing = syncs.filter((sync) => sync.health === "error");
  if (syncs.length === 0) return null;
  return (
    <Callout tone={failing.length ? "danger" : "warning"} title={`${plural(syncs.length, "sync")} ${syncs.length === 1 ? "needs" : "need"} your attention`}>
      <ul className="space-y-1">
        {syncs.slice(0, 4).map((sync) => (
          <li key={sync.id}>
            <Link href={`/syncs/${sync.id}`} className="font-medium text-navy underline-offset-2 hover:underline">
              {sync.name}
            </Link>
            {sync.statusMessage ? <span className="text-navy/65"> · {sync.statusMessage}</span> : null}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

export function Dashboard() {
  const session = useSessionInfo();
  const syncsQuery = useSyncs();
  const { syncNow, pending, removalDialog } = useSyncNow();
  const syncs = syncsQuery.data?.syncs ?? [];
  const attention = syncs.filter((sync) => !sync.activeRun && (sync.health === "error" || sync.health === "warning"));
  const setup = session.data?.setup;

  return (
    <div className="space-y-8">
      <Hero session={session.data} />
      {setup ? <SetupChecklist setup={{ ...setup, syncs: syncsQuery.data ? syncs.length : setup.syncs }} /> : null}

      {syncsQuery.error && !syncsQuery.data ? (
        <ErrorCallout
          error={syncsQuery.error}
          action={
            <Button size="sm" onClick={() => syncsQuery.mutate()} icon={<RotateCcw className="size-3.5" aria-hidden />}>
              Try again
            </Button>
          }
        />
      ) : null}

      {syncsQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-[232px] rounded-2xl" />
          ))}
        </div>
      ) : syncs.length > 0 ? (
        <>
          <AttentionBanner syncs={attention} />
          <Stats syncs={syncs} />
          <section>
            <SectionTitle>Syncs</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {syncs.map((sync) => (
                <SyncCard key={sync.id} sync={sync} onSyncNow={(item) => void syncNow(item)} syncing={pending === sync.id} />
              ))}
            </div>
            {removalDialog}
          </section>
        </>
      ) : syncsQuery.data && setup && setup.connections > 0 && setup.gcCredentials === "ok" ? (
        <div className="rounded-2xl bg-white shadow-card ring-1 ring-navy/[0.06]">
          <EmptyState illustration="/brand/icon-linked.svg" title="Everything's connected" action={<ButtonLink href="/syncs/new">Create your first sync</ButtonLink>}>
            Create a sync to start sending ServiceNow articles to a Genesys Cloud knowledge source.
          </EmptyState>
        </div>
      ) : null}
    </div>
  );
}
