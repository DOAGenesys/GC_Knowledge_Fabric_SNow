"use client";

import { Building, CalendarDays, Clock, ExternalLink, Hand, Link2, Repeat, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { Audience, GcSourceDTO, KnowledgeBaseDTO, LinkStyle, PreviewDTO } from "@/lib/api-types";
import { hasFilters, listSummary, noFilters, type SyncFilters } from "@/lib/filters";
import { formatNumber, formatRelative, plural } from "@/lib/format";
import { useGcSources, useKnowledgeBases } from "@/lib/hooks";
import { describeSchedule, INTERVAL_OPTIONS, type IntervalMinutes, type Schedule } from "@/lib/schedule";
import { articleLink, AUDIENCE, defaultLinkStyle, LINK_STYLES, portalName, portalSuffixFrom } from "@/lib/ui-text";
import { Chip } from "../ui/badge";
import { Button } from "../ui/button";
import { Callout, ErrorCallout } from "../ui/callout";
import { cn } from "../ui/cn";
import { Skeleton } from "../ui/feedback";
import { ChoiceCards, Field, Input, Select } from "../ui/field";
import { ArticleFilters } from "./article-filters";

export interface SelectedKb {
  id: string;
  title: string;
}

const MAX_ARTICLES = 20_000;

export function KnowledgeBasePicker({
  connectionId,
  selected,
  onChange,
  error,
}: {
  connectionId: string | null;
  selected: SelectedKb[];
  onChange: (next: SelectedKb[], picked?: KnowledgeBaseDTO) => void;
  error?: string;
}) {
  const query = useKnowledgeBases(connectionId);
  const [filter, setFilter] = useState("");
  const knowledgeBases = query.data?.knowledgeBases ?? [];
  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return term ? knowledgeBases.filter((kb) => `${kb.title} ${kb.description}`.toLowerCase().includes(term)) : knowledgeBases;
  }, [knowledgeBases, filter]);
  const selectedIds = new Set(selected.map((kb) => kb.id));

  if (!connectionId) return null;
  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (query.error) {
    return (
      <ErrorCallout
        error={query.error}
        action={
          <Button size="sm" onClick={() => query.mutate()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (knowledgeBases.length === 0) {
    return (
      <Callout
        tone="warning"
        title="No knowledge bases visible"
        action={
          <Button size="sm" onClick={() => query.mutate()}>
            Check again
          </Button>
        }
      >
        <p>The ServiceNow user can&apos;t see any active knowledge base. Ask your ServiceNow admin to give it read access to the knowledge bases you need.</p>
      </Callout>
    );
  }

  function toggle(kb: KnowledgeBaseDTO) {
    if (selectedIds.has(kb.id)) onChange(selected.filter((item) => item.id !== kb.id));
    else onChange([...selected, { id: kb.id, title: kb.title }], kb);
  }

  return (
    <div className="space-y-3">
      {knowledgeBases.length > 6 ? (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-navy/40" aria-hidden />
          <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={`Search ${knowledgeBases.length} knowledge bases`} className="pl-10" aria-label="Search knowledge bases" />
        </div>
      ) : null}
      <ul className="grid max-h-[360px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2" aria-label="Knowledge bases">
        {visible.map((kb) => {
          const checked = selectedIds.has(kb.id);
          return (
            <li key={kb.id}>
              <label
                className={cn(
                  "flex h-full cursor-pointer gap-3 rounded-xl bg-white p-3.5 ring-1 transition-all ring-inset has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-azure",
                  checked ? "ring-2 ring-azure" : "ring-navy/12 hover:ring-navy/25",
                )}
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(kb)} className="mt-0.5 size-4 shrink-0 accent-azure" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-navy">{kb.title}</span>
                    {kb.articleCount !== null ? <span className="shrink-0 text-xs text-navy/50">{plural(kb.articleCount, "article")}</span> : null}
                  </span>
                  {kb.description ? <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-navy/55">{kb.description}</span> : null}
                  {kb.suggestedAudience ? (
                    <span className="mt-2 flex flex-wrap gap-1">
                      <Chip>{AUDIENCE[kb.suggestedAudience].short}</Chip>
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 ? <p className="text-sm text-navy/55">No knowledge base matches &quot;{filter}&quot;.</p> : null}
      {error ? <p className="text-[13px] font-medium text-danger">{error}</p> : null}
    </div>
  );
}

export function AudiencePicker({ value, onChange }: { value: Audience; onChange: (value: Audience) => void }) {
  return (
    <ChoiceCards
      name="audience"
      label="Which ServiceNow product?"
      value={value}
      onChange={onChange}
      options={[
        { value: "csm", label: AUDIENCE.csm.label, description: AUDIENCE.csm.description, icon: <Building className="size-4" /> },
        { value: "itsm", label: AUDIENCE.itsm.label, description: AUDIENCE.itsm.description, icon: <Users className="size-4" /> },
      ]}
    />
  );
}

/** Live article count, optional filters, and a sample of the most recently updated articles. */
export function ArticlePreview({
  connectionId,
  kbIds,
  filters,
  onFiltersChange,
  filterQuery,
  onFilterChange,
  filterError,
  articlesError,
  onPreview,
}: {
  connectionId: string | null;
  kbIds: string[];
  filters: SyncFilters;
  onFiltersChange: (filters: SyncFilters) => void;
  filterQuery: string;
  onFilterChange: (value: string) => void;
  filterError?: string;
  articlesError?: string;
  onPreview?: (preview: PreviewDTO | null) => void;
}) {
  const [preview, setPreview] = useState<PreviewDTO | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const key = `${connectionId}|${kbIds.join(",")}|${JSON.stringify(filters)}|${filterQuery.trim()}`;
  const choosing = filters.articles !== null;
  const nothingChosen = filters.articles?.length === 0;

  useEffect(() => {
    if (!connectionId || kbIds.length === 0 || nothingChosen) {
      setPreview(null);
      setError(null);
      onPreview?.(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await apiFetch<{ preview: PreviewDTO }>(`/api/connections/${connectionId}/preview`, {
          method: "POST",
          body: { kbIds, filters, filterQuery: filterQuery.trim() },
          signal: controller.signal,
        });
        setPreview(result.preview);
        setError(null);
        onPreview?.(result.preview);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught);
          setPreview(null);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key]);

  if (!connectionId || kbIds.length === 0) return null;
  const filterProblem = isApiError(error) && error.code === "VALIDATION" ? error.message : undefined;
  const narrowed = hasFilters(filters) || Boolean(filterQuery.trim());
  const chosenNumbers = new Set((filters.articles ?? []).map((article) => article.number.toUpperCase()));
  const missing = (preview?.missing ?? []).filter((number) => chosenNumbers.has(number.toUpperCase()));

  function removeMissing() {
    const gone = new Set(missing.map((number) => number.toUpperCase()));
    onFiltersChange({ ...filters, articles: (filters.articles ?? []).filter((article) => !gone.has(article.number.toUpperCase())) });
  }

  return (
    <div className="space-y-4 rounded-xl bg-nimbus p-4">
      <p className="text-sm text-navy/70" aria-live="polite">
        {nothingChosen ? (
          "Nothing chosen yet."
        ) : loading && !preview ? (
          "Counting articles…"
        ) : preview ? (
          <>
            <span className="text-lg font-semibold text-navy">{formatNumber(preview.count)}</span> published {preview.count === 1 ? "article" : "articles"} will be synced
          </>
        ) : error ? (
          "Couldn't count the articles."
        ) : null}
      </p>
      {!choosing && preview && preview.count > MAX_ARTICLES ? (
        <p className="text-[13px] font-medium text-danger">
          One sync can handle up to {formatNumber(MAX_ARTICLES)} articles. Narrow it down below, or split the knowledge bases across several syncs.
        </p>
      ) : null}
      <ArticleFilters
        connectionId={connectionId}
        kbIds={kbIds}
        filters={filters}
        onChange={onFiltersChange}
        filterQuery={filterQuery}
        onFilterQueryChange={onFilterChange}
        filterError={filterError ?? filterProblem}
        missing={missing}
        articlesError={articlesError}
      />
      {missing.length > 0 ? (
        <Callout
          tone="warning"
          title={`${plural(missing.length, "chosen article")} won't be synced`}
          action={
            <Button size="sm" onClick={removeMissing}>
              Remove {missing.length === 1 ? "it" : "them"}
            </Button>
          }
        >
          <p>
            {listSummary(missing, 5)} {missing.length === 1 ? "isn't published right now, or it's" : "aren't published right now, or they're"} in a knowledge base you
            didn&apos;t pick.{filterQuery.trim() ? " The ServiceNow condition can also leave articles out." : ""}
          </p>
        </Callout>
      ) : null}
      {!choosing && preview && preview.count === 0 ? (
        narrowed ? (
          <Callout
            tone="warning"
            title="No articles match"
            action={
              <Button
                size="sm"
                onClick={() => {
                  onFiltersChange(noFilters());
                  onFilterChange("");
                }}
              >
                Clear all filters
              </Button>
            }
          >
            <p>Choose more categories or languages, or clear the filters to see every published article again.</p>
          </Callout>
        ) : (
          <Callout tone="warning" title="No published articles yet">
            <p>Only articles that are published, active and not past their &quot;Valid to&quot; date are synced. Pick other knowledge bases, or publish articles in ServiceNow first.</p>
          </Callout>
        )
      ) : null}
      {error && !filterProblem ? <ErrorCallout error={error} /> : null}
      {!choosing && preview && preview.sample.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-medium tracking-wide text-navy/50 uppercase">Recently updated</p>
          <ul className="divide-y divide-navy/[0.06] rounded-lg bg-white ring-1 ring-navy/[0.06]">
            {preview.sample.map((article) => (
              <li key={article.number} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="w-24 shrink-0 font-mono text-[12px] text-navy/50">{article.number}</span>
                <span className="min-w-0 flex-1 truncate text-navy">{article.title}</span>
                <span className="hidden shrink-0 text-navy/45 sm:block">{formatRelative(article.updatedAt.replace(" ", "T") + "Z")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const STANDARD_PORTALS = new Set(["csm", "csp", "esc", "sp"]);

/** Suggested link style from the portals the chosen knowledge bases are published on. */
export function suggestLinkStyle(audience: Audience, portals: string[]): { linkStyle: LinkStyle; linkCustom: string } {
  const lower = portals.map((portal) => portal.toLowerCase());
  const preferred = audience === "csm" ? (["csm", "csp", "esc", "sp"] as const) : (["esc", "sp", "csm", "csp"] as const);
  for (const style of preferred) {
    if (lower.includes(style)) return { linkStyle: style, linkCustom: "" };
  }
  const custom = lower.find((portal) => /^[a-z0-9_-]{1,40}$/.test(portal));
  if (custom) return { linkStyle: "custom", linkCustom: custom };
  return { linkStyle: defaultLinkStyle(audience), linkCustom: "" };
}

interface LinkOption {
  key: string;
  linkStyle: LinkStyle;
  linkCustom: string;
  label: string;
  path: string;
  description: string;
  publishedHere: boolean;
}

function linkOptions(portals: string[]): LinkOption[] {
  const published = new Set(portals.map((portal) => portal.toLowerCase()));
  const standard: LinkOption[] = LINK_STYLES.filter((style) => STANDARD_PORTALS.has(style.value)).map((style) => ({
    key: style.value,
    linkStyle: style.value,
    linkCustom: "",
    label: style.label,
    path: style.path,
    description: style.description,
    publishedHere: published.has(style.value),
  }));
  const otherPublished: LinkOption[] = [...published]
    .filter((portal) => !STANDARD_PORTALS.has(portal) && /^[a-z0-9_-]{1,40}$/.test(portal))
    .map((portal) => ({
      key: `custom:${portal}`,
      linkStyle: "custom",
      linkCustom: portal,
      label: portalName(portal),
      path: `/${portal}`,
      description: "A portal these knowledge bases are published on.",
      publishedHere: true,
    }));
  const classic = LINK_STYLES.find((style) => style.value === "classic")!;
  return [
    ...[...standard, ...otherPublished].sort((a, b) => Number(b.publishedHere) - Number(a.publishedHere)),
    { key: "classic", linkStyle: "classic", linkCustom: "", label: classic.label, path: classic.path, description: classic.description, publishedHere: false },
  ];
}

export function LinkStylePicker({
  linkStyle,
  linkCustom,
  instanceUrl,
  portals,
  sampleArticle,
  onChange,
  customError,
}: {
  linkStyle: LinkStyle;
  linkCustom: string;
  instanceUrl: string | null;
  /** Portals the chosen knowledge bases are published on. */
  portals: string[];
  /** A real article number, for a link the user can try. */
  sampleArticle?: string | null;
  onChange: (next: { linkStyle: LinkStyle; linkCustom: string }) => void;
  customError?: string;
}) {
  const options = useMemo(() => linkOptions(portals), [portals]);
  const current = options.find((option) => option.linkStyle === linkStyle && option.linkCustom === (linkStyle === "custom" ? linkCustom : ""));
  const [open, setOpen] = useState(() => linkStyle === "custom" && !current && !linkCustom);
  const [customText, setCustomText] = useState(() => (linkStyle === "custom" && !current ? linkCustom : ""));
  const expanded = open || Boolean(customError);
  const base = instanceUrl ?? "https://your-instance.service-now.com";
  const example = articleLink(base, linkStyle, linkCustom, sampleArticle ?? "KB0010001");
  const label = current?.label ?? (linkCustom ? portalName(linkCustom) : "Another portal");

  return (
    <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-navy/[0.08]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-navy">
            <Link2 className="size-4 text-azure" aria-hidden />
            {label}
            {current?.publishedHere ? <Chip className="bg-patina-soft text-patina-ink">Published here</Chip> : null}
          </p>
          <p className="mt-1 truncate font-mono text-[12px] text-navy/55" title={example}>
            {example}
          </p>
        </div>
        {!expanded ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Change
          </Button>
        ) : null}
      </div>
      {sampleArticle && instanceUrl && !expanded ? (
        <a href={example} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-medium text-azure hover:underline">
          Open {sampleArticle} to check the link <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ) : null}
      {expanded ? (
        <div className="space-y-2 border-t border-navy/[0.06] pt-3">
          <div role="radiogroup" aria-label="Where article links open" className="space-y-1">
            {options.map((option) => {
              const selected = option === current;
              return (
                <label key={option.key} className={cn("flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2", selected ? "bg-azure-soft/60" : "hover:bg-nimbus")}>
                  <input
                    type="radio"
                    name="linkStyle"
                    checked={selected}
                    onChange={() => onChange({ linkStyle: option.linkStyle, linkCustom: option.linkCustom })}
                    className="mt-1 size-4 shrink-0 accent-azure"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-navy">
                      {option.label}
                      <span className="font-mono text-[12px] font-normal text-navy/45">{option.path}</span>
                      {option.publishedHere ? <Chip className="bg-patina-soft text-patina-ink">Published here</Chip> : null}
                    </span>
                    <span className="block text-[13px] text-navy/55">{option.description}</span>
                  </span>
                </label>
              );
            })}
            <label className={cn("flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2", !current ? "bg-azure-soft/60" : "hover:bg-nimbus")}>
              <input
                type="radio"
                name="linkStyle"
                checked={!current}
                onChange={() => onChange({ linkStyle: "custom", linkCustom: portalSuffixFrom(customText) })}
                className="mt-1 size-4 shrink-0 accent-azure"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-navy">Another portal</span>
                <span className="block text-[13px] text-navy/55">A portal with its own address, like {base.replace(/^https:\/\//, "")}/support.</span>
              </span>
            </label>
          </div>
          {!current ? (
            <Field
              label="Portal address"
              hint="Paste a link to the portal (any page works), or type its name after the slash."
              error={customError}
              className="pl-9"
            >
              {(props) => (
                <Input
                  {...props}
                  value={customText}
                  onChange={(event) => {
                    setCustomText(event.target.value);
                    onChange({ linkStyle: "custom", linkCustom: portalSuffixFrom(event.target.value) });
                  }}
                  placeholder={`${base}/support`}
                  spellCheck={false}
                />
              )}
            </Field>
          ) : null}
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setOpen(false)} disabled={!current && !/^[a-z0-9_-]{1,40}$/i.test(linkCustom)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type SourceChoice = { mode: "new"; name: string } | { mode: "existing"; id: string };

export function SourcePicker({
  value,
  onChange,
  enabled,
  error,
}: {
  value: SourceChoice;
  onChange: (value: SourceChoice) => void;
  enabled: boolean;
  error?: string;
}) {
  const sources = useGcSources(enabled);
  const list: GcSourceDTO[] = sources.data?.sources ?? [];
  const available = list.filter((source) => !source.usedBy);

  return (
    <div className="space-y-4">
      <ChoiceCards
        name="sourceMode"
        label="New or existing knowledge source"
        value={value.mode}
        onChange={(mode) => onChange(mode === "new" ? { mode: "new", name: value.mode === "new" ? value.name : "" } : { mode: "existing", id: available[0]?.id ?? "" })}
        options={[
          { value: "new", label: "Create a new knowledge source", description: "Recommended. Keeps these articles together and easy to manage." },
          {
            value: "existing",
            label: "Add to an existing one",
            description: sources.isLoading
              ? "Loading knowledge sources…"
              : available.length
                ? `${plural(available.length, "knowledge source")} you can use.`
                : "None available. Only File upload sources that no other sync uses can be picked.",
            disabled: !sources.isLoading && available.length === 0,
          },
        ]}
      />
      {sources.error ? <ErrorCallout error={sources.error} /> : null}
      {value.mode === "new" ? (
        <Field label="Name in Genesys Cloud" hint="This is how the knowledge source appears in Genesys Cloud." error={error}>
          {(props) => <Input {...props} value={value.name} onChange={(event) => onChange({ mode: "new", name: event.target.value })} maxLength={100} />}
        </Field>
      ) : (
        <Field label="Knowledge source" hint="Only File upload sources that no other sync uses are listed. Files someone uploaded by hand stay untouched." error={error}>
          {(props) => (
            <Select {...props} value={value.id} onChange={(event) => onChange({ mode: "existing", id: event.target.value })}>
              {available.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                  {source.fileCount !== null ? ` · ${plural(source.fileCount, "file")}` : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {value.mode === "existing" && list.some((source) => source.usedBy) ? (
        <p className="text-[13px] text-navy/50">
          Already used by another sync:{" "}
          {list
            .filter((source) => source.usedBy)
            .map((source) => `${source.name} (used by ${source.usedBy?.syncName})`)
            .join(", ")}
        </p>
      ) : null}
    </div>
  );
}

const DAYS = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "GMT+01:00" for the zone right now. */
export function gmtOffset(zone: string, now = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value;
    return !name ? "" : name === "GMT" ? "GMT+00:00" : name;
  } catch {
    return "";
  }
}

function zoneLabel(zone: string, now: Date): string {
  const offset = gmtOffset(zone, now);
  return `${zone.replaceAll("_", " ")}${offset ? ` (${offset})` : ""}`;
}

function useTimeZones(current: string): Array<{ zone: string; label: string }> {
  const [zones, setZones] = useState(() => [{ zone: current, label: current.replaceAll("_", " ") }]);
  useEffect(() => {
    const now = new Date();
    let all: string[];
    try {
      all = Intl.supportedValuesOf("timeZone");
    } catch {
      all = ["UTC"];
    }
    setZones((all.includes(current) ? all : [current, ...all]).map((zone) => ({ zone, label: zoneLabel(zone, now) })));
  }, [current]);
  return zones;
}

export function SchedulePicker({ value, onChange, error }: { value: Schedule; onChange: (value: Schedule) => void; error?: string }) {
  const tz = value.kind === "daily" || value.kind === "weekly" ? value.tz : browserTimeZone();
  const time = value.kind === "daily" || value.kind === "weekly" ? value.time : "06:00";
  const zones = useTimeZones(tz);

  function setKind(kind: Schedule["kind"]) {
    if (kind === "manual") onChange({ kind });
    else if (kind === "interval") onChange({ kind, minutes: value.kind === "interval" ? value.minutes : 60 });
    else if (kind === "daily") onChange({ kind, time, tz });
    else onChange({ kind, days: value.kind === "weekly" ? value.days : [1, 2, 3, 4, 5], time, tz });
  }

  return (
    <div className="space-y-4">
      <ChoiceCards
        name="scheduleKind"
        label="When it runs"
        columns={4}
        value={value.kind}
        onChange={setKind}
        options={[
          { value: "interval", label: "Several times a day", icon: <Repeat className="size-4" /> },
          { value: "daily", label: "Once a day", icon: <Clock className="size-4" /> },
          { value: "weekly", label: "On certain days", icon: <CalendarDays className="size-4" /> },
          { value: "manual", label: "Only by hand", icon: <Hand className="size-4" /> },
        ]}
      />
      {value.kind === "interval" ? (
        <Field label="How often" hint="Each run only sends what changed, so running often is fine.">
          {(props) => (
            <Select {...props} value={value.minutes} onChange={(event) => onChange({ kind: "interval", minutes: Number(event.target.value) as IntervalMinutes })}>
              {INTERVAL_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {describeSchedule({ kind: "interval", minutes })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {value.kind === "weekly" ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-navy">Days</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
            {DAYS.map(({ day, label }) => {
              const active = value.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange({ ...value, days: active ? value.days.filter((item) => item !== day) : [...value.days, day] })}
                  className={cn(
                    "h-9 min-w-12 rounded-full px-3 text-sm font-medium transition-colors",
                    active ? "bg-azure text-white" : "bg-white text-navy/70 ring-1 ring-navy/15 ring-inset hover:ring-navy/30",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {value.kind === "daily" || value.kind === "weekly" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Time">
            {(props) => <Input {...props} type="time" value={value.time} onChange={(event) => onChange({ ...value, time: event.target.value || "06:00" })} step={60} />}
          </Field>
          <Field label="Time zone">
            {(props) => (
              <Select {...props} value={value.tz} onChange={(event) => onChange({ ...value, tz: event.target.value })}>
                {zones.map(({ zone, label }) => (
                  <option key={zone} value={zone}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      ) : null}
      {value.kind === "manual" ? <p className="text-[13px] text-navy/55">It only runs when someone clicks Sync now.</p> : null}
      {value.kind !== "manual" ? <p className="text-[13px] text-navy/50">A run can start up to 15 minutes after the planned time.</p> : null}
      {error ? <p className="text-[13px] font-medium text-danger">{error}</p> : null}
    </div>
  );
}
