"use client";

import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { Audience, LinkStyle, RunDTO, SyncDTO } from "@/lib/api-types";
import { describeFilters, filtersForKbs, noFilters, type SyncFilters } from "@/lib/filters";
import { truncate } from "@/lib/format";
import { useConnections, useGcCredentials, useGcSources, useKnowledgeBases } from "@/lib/hooks";
import { describeSchedule, type Schedule } from "@/lib/schedule";
import { AUDIENCE, linkStyleLabel } from "@/lib/ui-text";
import { Button, ButtonLink } from "../ui/button";
import { Callout, ErrorCallout } from "../ui/callout";
import { Card } from "../ui/card";
import { cn } from "../ui/cn";
import { Skeleton } from "../ui/feedback";
import { Checkbox, Field, Input, Select } from "../ui/field";
import { useToast } from "../ui/toast";
import {
  ArticlePreview,
  AudiencePicker,
  KnowledgeBasePicker,
  LinkStylePicker,
  SchedulePicker,
  type SelectedKb,
  type SourceChoice,
  SourcePicker,
  suggestLinkStyle,
} from "./sync-fields";

const STEPS = [
  { title: "Articles", description: "What to sync" },
  { title: "Destination", description: "Where they go" },
  { title: "Schedule", description: "When it runs" },
] as const;

const FIELD_STEP: Array<[RegExp, number]> = [
  [/^(connectionId|knowledgeBases|filters|filterQuery|audience)/, 0],
  [/^(source|linkStyle|linkCustom)/, 1],
  [/^(name|schedule|enabled)/, 2],
];

function stepForField(path: string): number {
  return FIELD_STEP.find(([pattern]) => pattern.test(path))?.[1] ?? 2;
}

function defaultSyncName(kbs: SelectedKb[]): string {
  if (kbs.length === 0) return "";
  return truncate(kbs.length === 1 ? kbs[0]!.title : `${kbs[0]!.title} + ${kbs.length - 1} more`, 100);
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-4" aria-label="Steps">
      {STEPS.map((item, index) => {
        const state = index < step ? "done" : index === step ? "current" : "upcoming";
        return (
          <li key={item.title} className="flex flex-1 items-center gap-3" aria-current={state === "current" ? "step" : undefined}>
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold transition-colors",
                state === "done" ? "bg-patina text-white" : state === "current" ? "bg-navy text-white" : "bg-white text-navy/45 ring-1 ring-navy/15",
              )}
            >
              {state === "done" ? <Check className="size-4" aria-label="Done" /> : index + 1}
            </span>
            <span className="hidden min-w-0 sm:block">
              <span className={cn("block text-sm font-semibold", state === "upcoming" ? "text-navy/45" : "text-navy")}>{item.title}</span>
              <span className="block text-xs text-navy/50">{item.description}</span>
            </span>
            {index < STEPS.length - 1 ? <span className={cn("h-px flex-1", index < step ? "bg-patina" : "bg-navy/12")} aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 py-2.5 text-sm">
      <dt className="w-28 shrink-0 text-navy/50">{label}</dt>
      <dd className="min-w-0 flex-1 text-navy">{children}</dd>
    </div>
  );
}

function SectionHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-navy">{title}</h2>
      {children ? <p className="text-sm text-navy/55">{children}</p> : null}
    </div>
  );
}

export function NewSyncWizard() {
  const router = useRouter();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const connections = useConnections();
  const credentials = useGcCredentials();

  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState(0);
  const [connectionChoice, setConnectionChoice] = useState<string | null>(null);
  const [kbs, setKbs] = useState<SelectedKb[]>([]);
  const [audienceOverride, setAudienceOverride] = useState<Audience | null>(null);
  const [filters, setFilters] = useState<SyncFilters>(noFilters);
  const [filterQuery, setFilterQuery] = useState("");
  const [sampleArticle, setSampleArticle] = useState<string | null>(null);
  const [sourceOverride, setSourceOverride] = useState<SourceChoice | null>(null);
  const [linkOverride, setLinkOverride] = useState<{ linkStyle: LinkStyle; linkCustom: string } | null>(null);
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<Schedule>({ kind: "interval", minutes: 60 });
  const [runNow, setRunNow] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  useEffect(() => setMounted(true), []);

  const connectionList = connections.data?.connections ?? [];
  const connectionId = connectionChoice ?? connectionList.find((item) => item.status === "ok")?.id ?? connectionList[0]?.id ?? null;
  const connection = connectionList.find((item) => item.id === connectionId) ?? null;
  const knowledgeBases = useKnowledgeBases(connectionId).data?.knowledgeBases ?? [];
  const pickedDetails = knowledgeBases.filter((kb) => kbs.some((item) => item.id === kb.id));
  const portals = useMemo(() => [...new Set(pickedDetails.flatMap((kb) => kb.portals))], [pickedDetails]);

  const suggestedAudience = useMemo(() => {
    const suggestions = new Set(pickedDetails.map((kb) => kb.suggestedAudience).filter(Boolean));
    return suggestions.size === 1 ? ([...suggestions][0] as Audience) : null;
  }, [pickedDetails]);
  const audience = audienceOverride ?? suggestedAudience ?? "csm";
  const link = linkOverride ?? suggestLinkStyle(audience, portals);
  const source: SourceChoice = sourceOverride ?? { mode: "new", name: truncate(`ServiceNow - ${kbs.map((kb) => kb.title).join(", ")}`, 100) };
  const name = nameOverride ?? defaultSyncName(kbs);
  const gcReady = credentials.data?.credentials.status === "ok";
  const gcSources = useGcSources(gcReady && step > 0);
  const instanceUrl = connection?.instanceUrl ?? "https://your-instance.service-now.com";

  const serverField = (path: string) => (isApiError(error) ? error.fieldError(path) : undefined);
  const fieldError = (path: string) => localErrors[path] ?? serverField(path);
  const generalError = error && !(isApiError(error) && error.code === "VALIDATION" && error.fields.length > 0) ? error : null;
  const filterSummary = [describeFilters(filters), filterQuery.trim() ? "a ServiceNow condition" : null].filter(Boolean).join(" · ");

  function changeKbs(next: SelectedKb[]) {
    setKbs(next);
    setFilters((current) => filtersForKbs(current, next.map((kb) => kb.id)));
  }

  function validate(target: number): boolean {
    const problems: Record<string, string> = {};
    if (target === 0) {
      if (!connectionId) problems.connectionId = "Connect ServiceNow first.";
      if (kbs.length === 0) problems.knowledgeBases = "Pick at least one knowledge base.";
      if (kbs.length > 25) problems.knowledgeBases = "Pick at most 25 knowledge bases.";
      if (kbs.length > 0 && filters.articles?.length === 0) problems["filters.articles"] = "Choose at least one article, or switch to all published articles.";
    }
    if (target === 1) {
      if (source.mode === "new" && !source.name.trim()) problems["source.name"] = "Give the knowledge source a name.";
      if (source.mode === "existing" && !source.id) problems["source.id"] = "Pick a knowledge source.";
      if (link.linkStyle === "custom" && !/^[a-z0-9_-]{1,40}$/i.test(link.linkCustom)) problems.linkCustom = `Enter the portal's address, like ${instanceUrl}/support.`;
    }
    if (target === 2) {
      if (!name.trim()) problems.name = "Give the sync a name.";
      if (schedule.kind === "weekly" && schedule.days.length === 0) problems.schedule = "Pick at least one day.";
    }
    setLocalErrors(problems);
    return Object.keys(problems).length === 0;
  }

  function next() {
    if (!validate(step)) return;
    setError(null);
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function create() {
    if (!validate(2)) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiFetch<{ sync: SyncDTO; run: RunDTO | null; runError: string | null }>("/api/syncs", {
        method: "POST",
        body: {
          name: name.trim(),
          connectionId,
          audience,
          knowledgeBases: kbs,
          filters,
          filterQuery: filterQuery.trim(),
          linkStyle: link.linkStyle,
          linkCustom: link.linkStyle === "custom" ? link.linkCustom : "",
          schedule,
          enabled: true,
          source: source.mode === "new" ? { mode: "new", name: source.name.trim() } : source,
          runNow,
        },
      });
      await mutate((key) => typeof key === "string" && (key === "/api/syncs" || key === "/api/session" || key === "/api/genesys/sources"));
      if (result.runError) toast.error(null, "Sync created, but the first run didn't start", result.runError);
      else toast.success("Sync created", result.run ? "The first run has started." : "It runs on the schedule you picked.");
      router.push(`/syncs/${result.sync.id}`);
    } catch (caught) {
      setError(caught);
      if (isApiError(caught) && caught.fields.length > 0) setStep(Math.min(...caught.fields.map((field) => stepForField(field.path))));
      setSubmitting(false);
    }
  }

  if (!mounted || connections.isLoading || credentials.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-[420px] w-full rounded-2xl" />
      </div>
    );
  }

  const existingSourceName = source.mode === "existing" ? gcSources.data?.sources.find((item) => item.id === source.id)?.name : undefined;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-navy/60 hover:text-navy">
          <ArrowLeft className="size-4" aria-hidden /> All syncs
        </Link>
        <h1 className="mt-3 text-[28px] font-medium tracking-tight text-navy">New sync</h1>
        <p className="mt-1 text-[15px] text-navy/60">Copy articles from ServiceNow to Genesys Cloud, and keep them up to date automatically.</p>
      </div>

      <Stepper step={step} />

      <Card className="animate-fade-in p-6 sm:p-8" key={step}>
        {generalError ? <ErrorCallout error={generalError} className="mb-6" /> : null}

        {step === 0 ? (
          <div className="space-y-7">
            {connectionList.length === 0 ? (
              <Callout
                tone="warning"
                title="Connect ServiceNow first"
                action={
                  <ButtonLink href="/connections" target="_blank">
                    Open Connections in a new tab
                  </ButtonLink>
                }
              >
                <p>A sync reads articles through a ServiceNow connection. Once it&apos;s added, come back to this tab and your knowledge bases appear.</p>
              </Callout>
            ) : (
              <>
                {connectionList.length > 1 ? (
                  <Field label="ServiceNow connection" error={fieldError("connectionId")}>
                    {(props) => (
                      <Select
                        {...props}
                        value={connectionId ?? ""}
                        onChange={(event) => {
                          setConnectionChoice(event.target.value);
                          setKbs([]);
                          setFilters(noFilters());
                        }}
                      >
                        {connectionList.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · {item.instanceUrl.replace(/^https:\/\//, "")}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : (
                  <p className="text-sm text-navy/60">
                    Reading from <span className="font-medium text-navy">{connection?.name}</span> ({connection?.instanceUrl.replace(/^https:\/\//, "")})
                  </p>
                )}
                <div className="space-y-3">
                  <SectionHeading title="Which knowledge bases?">Only published articles that haven&apos;t expired are copied.</SectionHeading>
                  <KnowledgeBasePicker connectionId={connectionId} selected={kbs} onChange={changeKbs} error={fieldError("knowledgeBases")} />
                </div>
                {kbs.length > 0 ? (
                  <>
                    <div className="space-y-3">
                      <SectionHeading title="Who reads these articles?">
                        {suggestedAudience && !audienceOverride
                          ? "We picked this from where these knowledge bases are published. Change it if it's wrong."
                          : "Used to label the articles in Genesys Cloud and to suggest where links open."}
                      </SectionHeading>
                      <AudiencePicker value={audience} onChange={setAudienceOverride} />
                    </div>
                    <ArticlePreview
                      connectionId={connectionId}
                      kbIds={kbs.map((kb) => kb.id)}
                      filters={filters}
                      onFiltersChange={setFilters}
                      filterQuery={filterQuery}
                      onFilterChange={setFilterQuery}
                      filterError={fieldError("filterQuery")}
                      articlesError={fieldError("filters.articles")}
                      onPreview={(preview) => setSampleArticle(preview?.sample[0]?.number ?? null)}
                    />
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="space-y-8">
            {!gcReady ? (
              <Callout
                tone="warning"
                title="Connect Genesys Cloud first"
                action={
                  <ButtonLink href="/connections#genesys" target="_blank">
                    Open Connections in a new tab
                  </ButtonLink>
                }
              >
                <p>Syncs need their own access to Genesys Cloud to create knowledge sources and upload articles. An admin sets it up once on the Connections page. This step unlocks when you come back to this tab.</p>
              </Callout>
            ) : (
              <div className="space-y-3">
                <SectionHeading title="Where should the articles go?">Each article becomes a file in a Genesys Cloud knowledge source.</SectionHeading>
                <SourcePicker value={source} onChange={setSourceOverride} enabled={gcReady} error={fieldError("source.name") ?? fieldError("source.id") ?? fieldError("source")} />
              </div>
            )}
            <div className="space-y-3">
              <SectionHeading title="Where should article links open?">Each article in Genesys Cloud links back to the original, so bots and agents can share it.</SectionHeading>
              <LinkStylePicker
                linkStyle={link.linkStyle}
                linkCustom={link.linkCustom}
                instanceUrl={connection?.instanceUrl ?? null}
                portals={portals}
                sampleArticle={sampleArticle}
                onChange={setLinkOverride}
                customError={fieldError("linkCustom")}
              />
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
            <div className="space-y-7">
              <Field label="Sync name" hint="Only shown in this app." error={fieldError("name")}>
                {(props) => <Input {...props} value={name} onChange={(event) => setNameOverride(event.target.value)} maxLength={100} />}
              </Field>
              <div className="space-y-3">
                <SectionHeading title="How often should it check for changes?" />
                <SchedulePicker value={schedule} onChange={setSchedule} error={fieldError("schedule") ?? fieldError("schedule.days")} />
              </div>
              <Checkbox
                checked={runNow}
                onChange={(event) => setRunNow(event.target.checked)}
                label="Run the first sync now"
                description="Sends every matching article right away. Later runs only send what changed."
              />
            </div>
            <aside className="h-fit rounded-xl bg-nimbus p-5">
              <h2 className="text-sm font-semibold text-navy">Summary</h2>
              <dl className="mt-2 divide-y divide-navy/[0.07]">
                <ReviewRow label="From">{connection?.name}</ReviewRow>
                <ReviewRow label="Knowledge bases">{kbs.map((kb) => kb.title).join(", ")}</ReviewRow>
                {filterSummary ? <ReviewRow label="Only">{filterSummary}</ReviewRow> : null}
                <ReviewRow label="Readers">{AUDIENCE[audience].label}</ReviewRow>
                <ReviewRow label="Goes to">{source.mode === "new" ? `New knowledge source "${source.name}"` : (existingSourceName ?? "An existing knowledge source")}</ReviewRow>
                <ReviewRow label="Links open in">{linkStyleLabel(link.linkStyle, link.linkCustom)}</ReviewRow>
                <ReviewRow label="Runs">{describeSchedule(schedule, { withTimeZone: true })}</ReviewRow>
              </dl>
            </aside>
          </div>
        ) : null}

        <div className="mt-8 flex items-center justify-between gap-3 border-t border-navy/[0.07] pt-6">
          {step > 0 ? (
            <Button variant="ghost" onClick={() => setStep((current) => current - 1)} disabled={submitting} icon={<ArrowLeft className="size-4" aria-hidden />}>
              Back
            </Button>
          ) : (
            <ButtonLink href="/" variant="ghost">
              Cancel
            </ButtonLink>
          )}
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next} disabled={(step === 0 && connectionList.length === 0) || (step === 1 && !gcReady)}>
              Continue <ArrowRight className="size-4" aria-hidden />
            </Button>
          ) : (
            <Button variant="primary" onClick={create} loading={submitting}>
              {submitting ? "Creating…" : runNow ? "Create and run" : "Create sync"}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
