"use client";

import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { ArticleState, SyncDTO } from "@/lib/api-types";
import { formatNumber, formatRelative } from "@/lib/format";
import { useArticles } from "@/lib/hooks";
import { ARTICLE_STATE } from "@/lib/ui-text";
import { StatusBadge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorCallout } from "../ui/callout";
import { cn } from "../ui/cn";
import { EmptyState, Skeleton } from "../ui/feedback";
import { Input } from "../ui/field";

const PAGE_SIZE = 50;
const FILTERS: Array<{ id: ArticleState | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "synced", label: "Synced" },
  { id: "error", label: "Failed" },
  { id: "skipped", label: "Skipped" },
  { id: "pending_delete", label: "Removing" },
];

export function ArticlesTab({ sync, initialState = "all" }: { sync: SyncDTO; initialState?: ArticleState | "all" }) {
  const [state, setState] = useState<ArticleState | "all">(initialState);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const next = searchInput.trim();
    if (next === search) return;
    const timer = setTimeout(() => {
      setSearch(next);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const query = useArticles(sync.id, { state: state === "all" ? undefined : state, search: search || undefined, offset, limit: PAGE_SIZE });
  const page = query.data;
  const counts = page?.counts;
  const totalAll = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : null;

  if (query.error && !page) {
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

  if (page && totalAll === 0 && !search) {
    return (
      <EmptyState illustration="/brand/icon-search.svg" title="No articles synced yet">
        Articles appear here after the first successful run.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by state">
          {FILTERS.map((filter) => {
            const count = filter.id === "all" ? totalAll : (counts?.[filter.id] ?? null);
            if (filter.id !== "all" && filter.id !== "synced" && !count) return null;
            const active = state === filter.id;
            return (
              <button
                key={filter.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setState(filter.id);
                  setOffset(0);
                }}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors",
                  active ? "bg-navy text-white" : "bg-white text-navy/70 ring-1 ring-navy/12 ring-inset hover:ring-navy/25",
                )}
              >
                {filter.label}
                {count !== null ? <span className={active ? "text-white/70" : "text-navy/45"}>{formatNumber(count)}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="relative md:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-navy/40" aria-hidden />
          <Input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search number or title" className="h-10 pl-10 text-sm" aria-label="Search articles" />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl bg-white ring-1 ring-navy/[0.07]">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-nimbus/70 text-xs text-navy/55">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Article
              </th>
              <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">
                Knowledge base
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                State
              </th>
              <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">
                Synced
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy/[0.06]">
            {!page
              ? [0, 1, 2, 3, 4].map((index) => (
                  <tr key={index}>
                    <td colSpan={4} className="px-4 py-3">
                      <Skeleton className="h-5 w-full" />
                    </td>
                  </tr>
                ))
              : page.items.map((article) => {
                  const badge = ARTICLE_STATE[article.state];
                  return (
                    <tr key={article.articleId} className="align-top">
                      <td className="px-4 py-3">
                        <p className="font-medium text-navy">{article.title}</p>
                        <p className="font-mono text-[11px] text-navy/45">{article.number}</p>
                        {article.lastError ? <p className="mt-1 text-[12px] text-danger">{article.lastError}</p> : null}
                      </td>
                      <td className="hidden px-4 py-3 text-navy/60 md:table-cell">{article.kbName}</td>
                      <td className="px-4 py-3">
                        <StatusBadge tone={badge.tone} size="sm">
                          {badge.label}
                        </StatusBadge>
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap text-navy/55 sm:table-cell">{article.syncedAt ? formatRelative(article.syncedAt) : "—"}</td>
                    </tr>
                  );
                })}
            {page && page.items.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-navy/55">
                  No articles match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {page && page.total > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-[13px] text-navy/60">
          <span>
            {formatNumber(offset + 1)}–{formatNumber(Math.min(offset + PAGE_SIZE, page.total))} of {formatNumber(page.total)}
          </span>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} icon={<ChevronLeft className="size-4" aria-hidden />}>
              Previous
            </Button>
            <Button size="sm" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= page.total}>
              Next <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
