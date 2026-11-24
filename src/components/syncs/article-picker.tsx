"use client";

import { ClipboardList, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { ArticleOptionDTO } from "@/lib/api-types";
import { type ArticleChoice, extractArticleRefs, MAX_CHOSEN_ARTICLES } from "@/lib/filters";
import { formatNumber, formatRelative, plural } from "@/lib/format";
import { useArticleSearch } from "@/lib/hooks";
import { StatusBadge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorCallout } from "../ui/callout";
import { cn } from "../ui/cn";
import { Skeleton } from "../ui/feedback";
import { Input, Textarea } from "../ui/field";

const LIMIT_TEXT = `A sync can have up to ${formatNumber(MAX_CHOSEN_ARTICLES)} chosen articles. For more, sync all published articles and narrow them down by category instead.`;

function toChoice(article: ArticleOptionDTO): ArticleChoice {
  return { number: article.number, title: article.title, kbId: article.kbId };
}

function numberKey(number: string): string {
  return number.toUpperCase();
}

function SearchPanel({
  connectionId,
  kbIds,
  chosenNumbers,
  full,
  onToggle,
}: {
  connectionId: string;
  kbIds: string[];
  chosenNumbers: Set<string>;
  full: boolean;
  onToggle: (article: ArticleOptionDTO) => void;
}) {
  const [input, setInput] = useState("");
  const [text, setText] = useState("");
  const search = useArticleSearch(connectionId, kbIds, text);
  const results = search.data?.articles ?? [];
  const manyKbs = kbIds.length > 1;

  useEffect(() => {
    const next = input.trim();
    if (next === text) return;
    const timer = setTimeout(() => setText(next), 300);
    return () => clearTimeout(timer);
  }, [input, text]);

  return (
    <div className="space-y-2 p-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-navy/40" aria-hidden />
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search by title or article number"
          className="h-9 pl-8 text-sm"
          aria-label="Search articles"
          maxLength={100}
        />
      </div>
      {!search.data && search.isLoading ? (
        <div className="space-y-1.5 px-2 py-1" aria-label="Searching articles">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
      ) : search.error && !search.data ? (
        <ErrorCallout
          error={search.error}
          action={
            <Button size="sm" onClick={() => search.mutate()}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <ul className={cn("max-h-64 overflow-y-auto transition-opacity", search.isValidating && "opacity-60")} aria-label="Search results">
            {results.map((article) => {
              const checked = chosenNumbers.has(numberKey(article.number));
              return (
                <li key={article.number}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-nimbus has-disabled:cursor-not-allowed has-disabled:opacity-50">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={full && !checked}
                      onChange={() => onToggle(article)}
                      className="size-4 shrink-0 accent-azure"
                    />
                    <span className="w-24 shrink-0 font-mono text-[12px] text-navy/50">{article.number}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-navy">{article.title}</span>
                      {manyKbs || article.category ? (
                        <span className="block truncate text-xs text-navy/45">{[manyKbs ? article.kbName : null, article.category].filter(Boolean).join(" · ")}</span>
                      ) : null}
                    </span>
                    <span className="hidden shrink-0 text-xs text-navy/45 sm:block">{formatRelative(`${article.updatedAt.replace(" ", "T")}Z`)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="px-2 pb-1 text-xs text-navy/50">
            {results.length === 0
              ? text
                ? `Nothing matches "${text}".`
                : "There are no published articles in the chosen knowledge bases."
              : text
                ? search.data?.more
                  ? "Showing the first 20 matches. Type more of the title to narrow it down."
                  : null
                : "Showing the most recently updated articles. Search to find others."}
          </p>
        </>
      )}
    </div>
  );
}

interface PasteResult {
  added: number;
  already: number;
  overLimit: number;
  notFound: string[];
}

function pasteSummary(result: PasteResult): string {
  if (result.added + result.already + result.overLimit === 0) {
    return "None of them could be found among the published articles in the chosen knowledge bases. Check the numbers, or pick other knowledge bases.";
  }
  return [
    result.added ? `Added ${plural(result.added, "article")}.` : null,
    result.already ? `${plural(result.already, "article")} ${result.already === 1 ? "was" : "were"} already chosen.` : null,
    result.overLimit ? `${plural(result.overLimit, "article")} didn't fit. ${LIMIT_TEXT}` : null,
    result.notFound.length
      ? `${formatNumber(result.notFound.length)} couldn't be found among the published articles in the chosen knowledge bases. ${result.notFound.length === 1 ? "It's" : "They're"} left in the box so you can check ${result.notFound.length === 1 ? "it" : "them"}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function PastePanel({
  connectionId,
  kbIds,
  chosen,
  onAdd,
}: {
  connectionId: string;
  kbIds: string[];
  chosen: ArticleChoice[];
  onAdd: (articles: ArticleChoice[]) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PasteResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refs = useMemo(() => extractArticleRefs(text), [text]);
  const tooMany = refs.length > MAX_CHOSEN_ARTICLES;

  async function add() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiFetch<{ found: ArticleOptionDTO[]; notFound: string[] }>(`/api/connections/${connectionId}/articles/lookup`, {
        method: "POST",
        body: { kbIds, refs },
      });
      const known = new Set(chosen.map((article) => numberKey(article.number)));
      const fresh = response.found.filter((article) => !known.has(numberKey(article.number)));
      const added = fresh.slice(0, Math.max(0, MAX_CHOSEN_ARTICLES - chosen.length));
      if (added.length) onAdd(added.map(toChoice));
      setResult({ added: added.length, already: response.found.length - fresh.length, overLimit: fresh.length - added.length, notFound: response.notFound });
      setText(response.notFound.join("\n"));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 p-3">
      <Textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setResult(null);
        }}
        rows={4}
        spellCheck={false}
        placeholder={"KB0012345\nKB0012346\nKB0012347"}
        aria-label="Article numbers"
      />
      <p className="text-xs text-navy/55">
        One per line, separated by commas or spaces, or a column copied from a spreadsheet. A query copied from ServiceNow works too.
      </p>
      {tooMany ? (
        <p className="text-[13px] font-medium text-danger">
          That&apos;s more than {formatNumber(MAX_CHOSEN_ARTICLES)} article numbers. Paste them in smaller batches, or narrow the articles down by category instead.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="primary" onClick={add} loading={busy} disabled={refs.length === 0 || tooMany}>
          {refs.length ? `Add ${plural(refs.length, "article")}` : "Add articles"}
        </Button>
        {text.trim() && refs.length === 0 ? <span className="text-[13px] text-navy/55">No article numbers (like KB0012345) found in the text yet.</span> : null}
      </div>
      {result ? (
        <p className="text-[13px] text-navy/75" role="status">
          {pasteSummary(result)}
        </p>
      ) : null}
      {error ? <p className="text-[13px] text-danger">Couldn&apos;t look up the articles.{isApiError(error) ? ` ${error.message}` : ""}</p> : null}
    </div>
  );
}

/** Hand-picked articles: search and tick them, or paste a list of article numbers. */
export function ArticlePicker({
  connectionId,
  kbIds,
  chosen,
  onChange,
  missing = [],
  error,
}: {
  connectionId: string;
  kbIds: string[];
  chosen: ArticleChoice[];
  onChange: (articles: ArticleChoice[]) => void;
  /** Chosen article numbers that won't be synced right now. */
  missing?: string[];
  /** Shown until an article is chosen. */
  error?: string;
}) {
  const [pasting, setPasting] = useState(false);
  const chosenNumbers = useMemo(() => new Set(chosen.map((article) => numberKey(article.number))), [chosen]);
  const missingNumbers = useMemo(() => new Set(missing.map(numberKey)), [missing]);
  const full = chosen.length >= MAX_CHOSEN_ARTICLES;

  function toggle(article: ArticleOptionDTO) {
    const key = numberKey(article.number);
    if (chosenNumbers.has(key)) onChange(chosen.filter((item) => numberKey(item.number) !== key));
    else if (!full) onChange([...chosen, toChoice(article)]);
  }

  const tabClass = (active: boolean) =>
    cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-medium transition-colors", active ? "bg-navy text-white" : "text-navy/60 hover:bg-nimbus hover:text-navy");

  return (
    <div className="space-y-2">
      <div className="rounded-lg bg-white ring-1 ring-navy/[0.08]">
        <div className="flex gap-1 border-b border-navy/[0.06] p-1.5">
          <button type="button" className={tabClass(!pasting)} aria-pressed={!pasting} onClick={() => setPasting(false)}>
            <Search className="size-3.5" aria-hidden />
            Search
          </button>
          <button type="button" className={tabClass(pasting)} aria-pressed={pasting} onClick={() => setPasting(true)}>
            <ClipboardList className="size-3.5" aria-hidden />
            Paste a list
          </button>
        </div>
        {pasting ? (
          <PastePanel connectionId={connectionId} kbIds={kbIds} chosen={chosen} onAdd={(added) => onChange([...chosen, ...added])} />
        ) : (
          <SearchPanel connectionId={connectionId} kbIds={kbIds} chosenNumbers={chosenNumbers} full={full} onToggle={toggle} />
        )}
      </div>

      <div className="rounded-lg bg-white ring-1 ring-navy/[0.08]">
        <div className="flex items-center gap-3 border-b border-navy/[0.06] px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-[13px] font-medium text-navy">
            Chosen articles <span className="ml-1 text-navy/45">{formatNumber(chosen.length)}</span>
          </span>
          {chosen.length ? (
            <button type="button" onClick={() => onChange([])} className="text-[13px] font-medium text-navy/50 hover:text-navy">
              Remove all
            </button>
          ) : null}
        </div>
        {chosen.length === 0 ? (
          <p className="px-3.5 py-3 text-[13px] text-navy/55">Nothing chosen yet. Tick articles in the search results, or paste a list of article numbers.</p>
        ) : (
          <ul className="max-h-72 divide-y divide-navy/[0.06] overflow-y-auto" aria-label="Chosen articles">
            {chosen.map((article) => (
              <li key={article.number} className="flex items-center gap-3 px-3.5 py-2 text-[13px]">
                <span className="w-24 shrink-0 font-mono text-[12px] text-navy/50">{article.number}</span>
                <span className="min-w-0 flex-1 truncate text-navy">{article.title || article.number}</span>
                {missingNumbers.has(numberKey(article.number)) ? (
                  <StatusBadge tone="warning" size="sm">
                    Won&apos;t sync
                  </StatusBadge>
                ) : null}
                <button
                  type="button"
                  onClick={() => onChange(chosen.filter((item) => item.number !== article.number))}
                  aria-label={`Remove ${article.number}`}
                  className="rounded p-1 text-navy/40 hover:bg-nimbus hover:text-navy"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {full ? <p className="text-[13px] text-navy/60">{LIMIT_TEXT}</p> : null}
      {error && chosen.length === 0 ? <p className="text-[13px] font-medium text-danger">{error}</p> : null}
    </div>
  );
}
