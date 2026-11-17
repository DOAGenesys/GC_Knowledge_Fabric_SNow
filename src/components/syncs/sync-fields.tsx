"use client";

import { Building, CalendarDays, ChevronDown, Clock, Hand, Repeat, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { Audience, GcSourceDTO, KnowledgeBaseDTO, LinkStyle, PreviewDTO } from "@/lib/api-types";
import { formatNumber, formatRelative, plural } from "@/lib/format";
import { useGcSources, useKnowledgeBases } from "@/lib/hooks";
import { describeSchedule, INTERVAL_OPTIONS, type IntervalMinutes, type Schedule } from "@/lib/schedule";
import { AUDIENCE, defaultLinkStyle, LINK_STYLES } from "@/lib/ui-text";
import { Chip } from "../ui/badge";
import { Button } from "../ui/button";
import { Callout, ErrorCallout } from "../ui/callout";
import { cn } from "../ui/cn";
import { Skeleton } from "../ui/feedback";
import { ChoiceCards, Field, Input, Select, Textarea } from "../ui/field";

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
        <p>The ServiceNow account can&apos;t see any active knowledge base. Check its roles and each knowledge base&apos;s &quot;Can read&quot; user criteria.</p>
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
                  {kb.portals.length || kb.suggestedAudience ? (
                    <span className="mt-2 flex flex-wrap gap-1">
                      {kb.suggestedAudience ? <Chip>{AUDIENCE[kb.suggestedAudience].short}</Chip> : null}
                      {kb.portals.slice(0, 3).map((portal) => (
                        <Chip key={portal} className="bg-nimbus-shade">
                          /{portal}
                        </Chip>
                      ))}
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
      label="Audience"
      value={value}
      onChange={onChange}
      options={[
        { value: "csm", label: AUDIENCE.csm.label, description: AUDIENCE.csm.description, icon: <Building className="size-4" /> },
        { value: "itsm", label: AUDIENCE.itsm.label, description: AUDIENCE.itsm.description, icon: <Users className="size-4" /> },
      ]}
    />
  );
}

/** Live article count and a sample of the most recently updated articles. */
export function ArticlePreview({
  connectionId,
  kbIds,
  filterQuery,
  onFilterChange,
  filterError,
}: {
  connectionId: string | null;
  kbIds: string[];
  filterQuery: string;
  onFilterChange: (value: string) => void;
  filterError?: string;
}) {
  const [preview, setPreview] = useState<PreviewDTO | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [showFilter, setShowFilter] = useState(Boolean(filterQuery));
  const key = `${connectionId}|${kbIds.join(",")}|${filterQuery.trim()}`;

  useEffect(() => {
    if (!connectionId || kbIds.length === 0) {
      setPreview(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await apiFetch<{ preview: PreviewDTO }>(`/api/connections/${connectionId}/preview`, {
          method: "POST",
          body: { kbIds, filterQuery: filterQuery.trim() },
          signal: controller.signal,
        });
        setPreview(result.preview);
        setError(null);
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

  return (
    <div className="space-y-4 rounded-xl bg-nimbus p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-navy/70" aria-live="polite">
          {loading && !preview ? (
            "Counting articles…"
          ) : preview ? (
            <>
              <span className="text-lg font-semibold text-navy">{formatNumber(preview.count)}</span> published {preview.count === 1 ? "article" : "articles"} will be synced
            </>
          ) : error ? (
            "Couldn't count the articles."
          ) : null}
        </p>
        <button type="button" onClick={() => setShowFilter((value) => !value)} className="inline-flex items-center gap-1 text-[13px] font-medium text-azure hover:underline" aria-expanded={showFilter}>
          Advanced filter <ChevronDown className={cn("size-3.5 transition-transform", showFilter && "rotate-180")} aria-hidden />
        </button>
      </div>
      {preview && preview.count > MAX_ARTICLES ? (
        <p className="text-[13px] font-medium text-danger">One sync handles up to {formatNumber(MAX_ARTICLES)} articles. Narrow the filter or split the knowledge bases across syncs.</p>
      ) : null}
      {showFilter ? (
        <Field
          label="ServiceNow encoded query"
          optional
          hint="Added to the scope with AND. Example: kb_category.label=Billing^languageINen,es"
          error={filterError ?? filterProblem}
        >
          {(props) => <Textarea {...props} value={filterQuery} onChange={(event) => onFilterChange(event.target.value)} rows={2} spellCheck={false} placeholder="kb_category.label=Billing" />}
        </Field>
      ) : null}
      {error && !filterProblem ? <ErrorCallout error={error} /> : null}
      {preview && preview.sample.length > 0 ? (
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

export function LinkStylePicker({
  linkStyle,
  linkCustom,
  instanceUrl,
  onChange,
  customError,
}: {
  linkStyle: LinkStyle;
  linkCustom: string;
  instanceUrl: string | null;
  onChange: (next: { linkStyle: LinkStyle; linkCustom: string }) => void;
  customError?: string;
}) {
  const option = LINK_STYLES.find((item) => item.value === linkStyle) ?? LINK_STYLES[0]!;
  const base = instanceUrl ?? "https://instance.service-now.com";
  const example =
    linkStyle === "classic" ? `${base}/kb_view.do?sysparm_article=KB0010001` : `${base}/${linkStyle === "custom" ? linkCustom || "<suffix>" : linkStyle}?id=kb_article_view&sysparm_article=KB0010001`;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Article links open in" hint="Each article in Genesys Cloud links back to its ServiceNow page.">
          {(props) => (
            <Select {...props} value={linkStyle} onChange={(event) => onChange({ linkStyle: event.target.value as LinkStyle, linkCustom })}>
              {LINK_STYLES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label} ({item.path})
                </option>
              ))}
            </Select>
          )}
        </Field>
        {linkStyle === "custom" ? (
          <Field label="Portal URL suffix" error={customError}>
            {(props) => <Input {...props} value={linkCustom} onChange={(event) => onChange({ linkStyle, linkCustom: event.target.value.trim() })} placeholder="support" maxLength={40} spellCheck={false} />}
          </Field>
        ) : null}
      </div>
      <p className="truncate rounded-lg bg-nimbus px-3 py-2 font-mono text-[12px] text-navy/60" title={example}>
        {option.label}: {example}
      </p>
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
        label="Knowledge source"
        value={value.mode}
        onChange={(mode) => onChange(mode === "new" ? { mode: "new", name: value.mode === "new" ? value.name : "" } : { mode: "existing", id: available[0]?.id ?? "" })}
        options={[
          { value: "new", label: "Create a new source", description: "Recommended. A dedicated File Upload source for this sync." },
          {
            value: "existing",
            label: "Use an existing source",
            description: sources.isLoading ? "Loading sources…" : available.length ? `${plural(available.length, "File Upload source")} available.` : "No unused File Upload source.",
            disabled: !sources.isLoading && available.length === 0,
          },
        ]}
      />
      {sources.error ? <ErrorCallout error={sources.error} /> : null}
      {value.mode === "new" ? (
        <Field label="New source name" hint="You'll see this name in Genesys Cloud Knowledge." error={error}>
          {(props) => <Input {...props} value={value.name} onChange={(event) => onChange({ mode: "new", name: event.target.value })} maxLength={100} />}
        </Field>
      ) : (
        <Field label="Source" hint="Only File Upload sources not used by another sync are listed. Files uploaded by hand stay untouched." error={error}>
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
          Not listed because another sync writes to them:{" "}
          {list
            .filter((source) => source.usedBy)
            .map((source) => `${source.name} (${source.usedBy?.syncName})`)
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

function useTimeZones(current: string): string[] {
  const [zones, setZones] = useState<string[]>([current]);
  useEffect(() => {
    try {
      const all = Intl.supportedValuesOf("timeZone");
      setZones(all.includes(current) ? all : [current, ...all]);
    } catch {
      setZones([current, "UTC"]);
    }
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
        label="Schedule"
        columns={4}
        value={value.kind}
        onChange={setKind}
        options={[
          { value: "interval", label: "Repeating", icon: <Repeat className="size-4" /> },
          { value: "daily", label: "Daily", icon: <Clock className="size-4" /> },
          { value: "weekly", label: "Weekly", icon: <CalendarDays className="size-4" /> },
          { value: "manual", label: "Manual", icon: <Hand className="size-4" /> },
        ]}
      />
      {value.kind === "interval" ? (
        <Field label="Run" hint="Each run only sends what changed, so frequent syncs stay light.">
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
          <p className="text-sm font-medium text-navy">On</p>
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
          <Field label="At">
            {(props) => <Input {...props} type="time" value={value.time} onChange={(event) => onChange({ ...value, time: event.target.value || "06:00" })} step={60} />}
          </Field>
          <Field label="Time zone">
            {(props) => (
              <Select {...props} value={value.tz} onChange={(event) => onChange({ ...value, tz: event.target.value })}>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      ) : null}
      {value.kind === "manual" ? <p className="text-[13px] text-navy/55">Runs only when someone clicks Sync now.</p> : null}
      {value.kind !== "manual" ? <p className="text-[13px] text-navy/50">Scheduled runs start within 15 minutes of the planned time.</p> : null}
      {error ? <p className="text-[13px] font-medium text-danger">{error}</p> : null}
    </div>
  );
}
