"use client";

import { ChevronDown, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { isApiError } from "@/lib/api-client";
import type { FilterOptionsDTO } from "@/lib/api-types";
import { type ArticleChoice, type CategoryChoice, categoryLabel, filtersForKbs, languageLabel, listSummary, NO_CATEGORY, type SyncFilters } from "@/lib/filters";
import { formatNumber } from "@/lib/format";
import { useFilterOptions } from "@/lib/hooks";
import { cn } from "../ui/cn";
import { Skeleton } from "../ui/feedback";
import { ChoiceCards, Field, Input, Textarea } from "../ui/field";
import { ArticlePicker } from "./article-picker";

interface ChecklistItem {
  key: string;
  label: string;
  /** Muted text before the label, e.g. the parent path "Billing / ". */
  prefix?: string;
  detail?: string;
  /** Null when a saved choice no longer has published articles. */
  count: number | null;
}

function Checklist({
  title,
  allLabel,
  items,
  selected,
  summary,
  onToggle,
  onClear,
}: {
  title: string;
  allLabel: string;
  items: ChecklistItem[];
  selected: Set<string>;
  summary: string;
  onToggle: (key: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const visible = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return needle ? items.filter((item) => `${item.prefix ?? ""}${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle)) : items;
  }, [items, term]);

  return (
    <div className="rounded-lg bg-white ring-1 ring-navy/[0.08]">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <span className="w-24 shrink-0 text-[13px] font-medium text-navy/55">{title}</span>
        <span className={cn("min-w-0 flex-1 truncate text-sm", selected.size ? "font-medium text-navy" : "text-navy/70")}>{selected.size ? summary : allLabel}</span>
        {selected.size ? (
          <button type="button" onClick={onClear} className="text-[13px] font-medium text-navy/50 hover:text-navy" aria-label={`Clear ${title.toLowerCase()}`}>
            Clear
          </button>
        ) : null}
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="text-[13px] font-medium text-azure hover:underline">
          {open ? "Done" : "Choose"}
        </button>
      </div>
      {open ? (
        <div className="space-y-2 border-t border-navy/[0.06] p-2">
          {items.length > 8 ? (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-navy/40" aria-hidden />
              <Input value={term} onChange={(event) => setTerm(event.target.value)} placeholder={`Search ${title.toLowerCase()}`} className="h-9 pl-8 text-sm" aria-label={`Search ${title.toLowerCase()}`} />
            </div>
          ) : null}
          <ul className="max-h-64 overflow-y-auto" aria-label={title}>
            {visible.map((item) => (
              <li key={item.key}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-nimbus">
                  <input type="checkbox" checked={selected.has(item.key)} onChange={() => onToggle(item.key)} className="size-4 shrink-0 accent-azure" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-navy">
                      {item.prefix ? <span className="text-navy/45">{item.prefix}</span> : null}
                      {item.label}
                    </span>
                    {item.detail ? <span className="block truncate text-xs text-navy/45">{item.detail}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-navy/45">{item.count === null ? "none right now" : formatNumber(item.count)}</span>
                </label>
              </li>
            ))}
          </ul>
          {visible.length === 0 ? <p className="px-2 py-1 text-[13px] text-navy/55">Nothing matches &quot;{term}&quot;.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

type CategoryOption = FilterOptionsDTO["categories"][number];

function splitPath(path: string): { prefix: string; label: string } {
  const index = path.lastIndexOf(" / ");
  return index === -1 ? { prefix: "", label: path } : { prefix: path.slice(0, index + 3), label: path.slice(index + 3) };
}

/** A category plus its subcategories, so picking "Billing" also picks "Billing / Payments". */
function categoryFamily(option: CategoryOption, all: CategoryOption[]): CategoryOption[] {
  if (option.id === NO_CATEGORY) return [option];
  return [option, ...all.filter((other) => other.id !== NO_CATEGORY && other.kbId === option.kbId && other.path.startsWith(`${option.path} / `))];
}

function toChoice(option: CategoryOption): CategoryChoice {
  return { id: option.id, label: option.id === NO_CATEGORY ? "" : option.path, kbId: option.kbId };
}

type Scope = "all" | "chosen";

export function ArticleFilters({
  connectionId,
  kbIds,
  filters,
  onChange,
  filterQuery,
  onFilterQueryChange,
  filterError,
  missing,
  articlesError,
}: {
  connectionId: string;
  kbIds: string[];
  filters: SyncFilters;
  onChange: (filters: SyncFilters) => void;
  filterQuery: string;
  onFilterQueryChange: (value: string) => void;
  filterError?: string;
  /** Chosen article numbers that won't be synced right now. */
  missing?: string[];
  articlesError?: string;
}) {
  const picking = filters.articles !== null;
  const query = useFilterOptions(picking ? null : connectionId, kbIds);
  const options = query.data?.options;
  const [showCondition, setShowCondition] = useState(() => Boolean(filterQuery.trim()));
  const manyKbs = kbIds.length > 1;
  /** What the other choice had, so switching back and forth doesn't lose anything. */
  const remembered = useRef<{ narrowing: Pick<SyncFilters, "categories" | "languages">; articles: ArticleChoice[] }>({
    narrowing: { categories: [], languages: [] },
    articles: [],
  });

  function chooseScope(scope: Scope) {
    if (scope === "chosen" && !picking) {
      remembered.current.narrowing = { categories: filters.categories, languages: filters.languages };
      onChange(filtersForKbs({ categories: [], languages: [], articles: remembered.current.articles }, kbIds));
    } else if (scope === "all" && picking) {
      remembered.current.articles = filters.articles ?? [];
      onChange(filtersForKbs({ ...remembered.current.narrowing, articles: null }, kbIds));
    }
  }

  const categoryIds = new Set(filters.categories.map((category) => category.id));
  const categoryItems: ChecklistItem[] = [
    ...(options?.categories ?? []).map((option) => ({
      key: option.id,
      ...(option.id === NO_CATEGORY ? { label: option.label } : splitPath(option.path)),
      ...(manyKbs && option.kbName ? { detail: option.kbName } : {}),
      count: option.count,
    })),
    ...filters.categories
      .filter((choice) => !options?.categories.some((option) => option.id === choice.id))
      .map((choice) => ({ key: choice.id, label: categoryLabel(choice), count: null })),
  ];
  const languageCodes = new Set(filters.languages.map((language) => language.code));
  const languageItems: ChecklistItem[] = [
    ...(options?.languages ?? []).map((option) => ({ key: option.code, label: option.label, count: option.count })),
    ...filters.languages
      .filter((choice) => !options?.languages.some((option) => option.code === choice.code))
      .map((choice) => ({ key: choice.code, label: languageLabel(choice), count: null })),
  ];

  function toggleCategory(id: string) {
    const option = options?.categories.find((candidate) => candidate.id === id);
    if (!option) {
      onChange({ ...filters, categories: filters.categories.filter((choice) => choice.id !== id) });
      return;
    }
    const family = categoryFamily(option, options?.categories ?? []);
    if (categoryIds.has(id)) {
      const removed = new Set(family.map((member) => member.id));
      onChange({ ...filters, categories: filters.categories.filter((choice) => !removed.has(choice.id)) });
    } else {
      onChange({ ...filters, categories: [...filters.categories, ...family.filter((member) => !categoryIds.has(member.id)).map(toChoice)] });
    }
  }

  function toggleLanguage(code: string) {
    if (languageCodes.has(code)) {
      onChange({ ...filters, languages: filters.languages.filter((choice) => choice.code !== code) });
      return;
    }
    const option = options?.languages.find((candidate) => candidate.code === code);
    onChange({ ...filters, languages: [...filters.languages, { code, label: option?.label ?? "" }] });
  }

  const showCategories = (options?.categories.length ?? 0) >= 2 || filters.categories.length > 0;
  const showLanguages = (options?.languages.length ?? 0) >= 2 || filters.languages.length > 0;

  return (
    <div className="space-y-2.5">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-navy">Which articles?</p>
        <ChoiceCards<Scope>
          name="articleScope"
          label="Which articles?"
          value={picking ? "chosen" : "all"}
          onChange={chooseScope}
          options={[
            { value: "all", label: "All published articles", description: "You can narrow them down by category or language." },
            { value: "chosen", label: "Only articles I choose", description: "Search for them, or paste a list of article numbers." },
          ]}
        />
      </div>
      {picking ? (
        <ArticlePicker
          connectionId={connectionId}
          kbIds={kbIds}
          chosen={filters.articles ?? []}
          onChange={(articles) => onChange({ ...filters, articles })}
          missing={missing}
          error={articlesError}
        />
      ) : !options && query.isLoading ? (
        <div className="space-y-2" aria-label="Loading categories and languages">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : showCategories || showLanguages ? (
        <div className="space-y-2">
          <div>
            <p className="text-sm font-semibold text-navy">Narrow it down</p>
            <p className="text-[13px] text-navy/55">Optional. Leave everything on &quot;All&quot; to sync every published article.</p>
          </div>
          {showCategories ? (
            <Checklist
              title="Categories"
              allLabel="All categories"
              items={categoryItems}
              selected={categoryIds}
              summary={listSummary(filters.categories.map(categoryLabel))}
              onToggle={toggleCategory}
              onClear={() => onChange({ ...filters, categories: [] })}
            />
          ) : null}
          {showLanguages ? (
            <Checklist
              title="Languages"
              allLabel="All languages"
              items={languageItems}
              selected={languageCodes}
              summary={listSummary(filters.languages.map(languageLabel))}
              onToggle={toggleLanguage}
              onClear={() => onChange({ ...filters, languages: [] })}
            />
          ) : null}
        </div>
      ) : null}
      {!picking && query.error && !query.isValidating ? (
        <p className="text-[13px] text-navy/55">
          Categories and languages couldn&apos;t be loaded, so you can&apos;t narrow the articles down right now.{isApiError(query.error) ? ` ${query.error.message}` : ""}
        </p>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowCondition((value) => !value)}
          aria-expanded={showCondition}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-navy/55 hover:text-navy"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", !showCondition && "-rotate-90")} aria-hidden />
          Add a ServiceNow condition (for ServiceNow admins)
        </button>
        {showCondition ? (
          <Field
            className="mt-2"
            label="ServiceNow condition"
            optional
            error={filterError}
            hint={
              <>
                In ServiceNow, filter the Knowledge list the way you want, right-click the filter shown above the list and choose <strong className="font-medium text-navy/75">Copy query</strong>.
                Paste it here. It applies on top of the choices above.
              </>
            }
          >
            {(props) => (
              <Textarea
                {...props}
                value={filterQuery}
                onChange={(event) => onFilterQueryChange(event.target.value)}
                rows={2}
                spellCheck={false}
                placeholder="Paste a query copied from a ServiceNow list"
              />
            )}
          </Field>
        ) : null}
      </div>
    </div>
  );
}
