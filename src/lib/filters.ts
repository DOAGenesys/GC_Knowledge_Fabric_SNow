import { z } from "zod";
import { formatNumber, plural } from "./format";

const SYS_ID = /^[0-9a-f]{32}$/;
export const LANGUAGE_CODE = /^[A-Za-z0-9_-]{1,20}$/;
/** ServiceNow article numbers such as "KB0012345". Never contains query separators (^ or ,). */
export const ARTICLE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
export const MAX_CHOSEN_ARTICLES = 2000;

/** Category id used for articles that have no category. */
export const NO_CATEGORY = "";

export interface CategoryChoice {
  id: string;
  label: string;
  kbId: string;
}

export interface LanguageChoice {
  code: string;
  label: string;
}

export interface ArticleChoice {
  number: string;
  title: string;
  kbId: string;
}

/** Article filters picked from lists, so nobody has to write a ServiceNow query. Empty lists mean "all". */
export interface SyncFilters {
  categories: CategoryChoice[];
  languages: LanguageChoice[];
  /** Hand-picked articles, by number. Null when not picking, so categories and languages decide. */
  articles: ArticleChoice[] | null;
}

export function noFilters(): SyncFilters {
  return { categories: [], languages: [], articles: null };
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

const sysIdOrNone = (message: string) => z.union([z.string().regex(SYS_ID, message), z.literal(NO_CATEGORY)]);

export const filtersSchema = z
  .object({
    categories: z
      .array(z.object({ id: sysIdOrNone("Invalid category"), label: z.string().trim().max(200).default(""), kbId: sysIdOrNone("Invalid category").default(NO_CATEGORY) }))
      .max(200, "Pick at most 200 categories")
      .default([]),
    languages: z
      .array(z.object({ code: z.string().regex(LANGUAGE_CODE, "Invalid language"), label: z.string().trim().max(100).default("") }))
      .max(50, "Pick at most 50 languages")
      .default([]),
    articles: z
      .array(
        z.object({
          number: z.string().trim().regex(ARTICLE_NUMBER, "Invalid article number"),
          title: z
            .string()
            .default("")
            .transform((title) => title.trim().slice(0, 300)),
          kbId: sysIdOrNone("Invalid knowledge base").default(NO_CATEGORY),
        }),
      )
      .max(MAX_CHOSEN_ARTICLES, `Choose at most ${formatNumber(MAX_CHOSEN_ARTICLES)} articles`)
      .nullable()
      .default(null),
  })
  .superRefine((filters, ctx) => {
    if (filters.articles !== null && (filters.categories.length > 0 || filters.languages.length > 0)) {
      ctx.addIssue({ code: "custom", path: ["articles"], message: "Choose articles, or narrow down by category and language, not both." });
    }
  })
  .transform(
    (filters): SyncFilters => ({
      categories: uniqueBy(filters.categories, (category) => category.id),
      languages: uniqueBy(filters.languages, (language) => language.code),
      articles: filters.articles === null ? null : uniqueBy(filters.articles, (article) => article.number.toUpperCase()),
    }),
  );

/** Filters saved before this field existed, or damaged JSON, read as "no filters". */
export function parseStoredFilters(value: unknown): SyncFilters {
  const parsed = filtersSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : noFilters();
}

export function hasFilters(filters: SyncFilters): boolean {
  return filters.categories.length > 0 || filters.languages.length > 0 || filters.articles !== null;
}

export function sameFilters(a: SyncFilters, b: SyncFilters): boolean {
  const key = (filters: SyncFilters) =>
    JSON.stringify([
      filters.categories.map((category) => category.id).sort(),
      filters.languages.map((language) => language.code).sort(),
      filters.articles?.map((article) => article.number.toUpperCase()).sort() ?? null,
    ]);
  return key(a) === key(b);
}

/** Drops chosen categories and articles that belong to knowledge bases that are no longer picked. */
export function filtersForKbs(filters: SyncFilters, kbIds: string[]): SyncFilters {
  const kept = (kbId: string) => !kbId || kbIds.includes(kbId);
  return {
    ...filters,
    categories: filters.categories.filter((category) => kept(category.kbId)),
    articles: filters.articles?.filter((article) => kept(article.kbId)) ?? null,
  };
}

export function categoryLabel(category: Pick<CategoryChoice, "id" | "label">): string {
  return category.id === NO_CATEGORY ? "Without a category" : category.label || "Unnamed category";
}

export function languageLabel(language: LanguageChoice): string {
  return language.label || language.code;
}

/** "Billing, Payments, Refunds +2 more" */
export function listSummary(labels: string[], max = 3): string {
  if (labels.length <= max) return labels.join(", ");
  return `${labels.slice(0, max).join(", ")} +${labels.length - max} more`;
}

/** One line for reviews and summaries, e.g. "Billing, Payments · Italian". Null when nothing is filtered. */
export function describeFilters(filters: SyncFilters): string | null {
  if (filters.articles !== null) return plural(filters.articles.length, "chosen article");
  const parts = [
    filters.categories.length ? listSummary(filters.categories.map(categoryLabel)) : null,
    filters.languages.length ? listSummary(filters.languages.map(languageLabel)) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Article numbers ("KB0012345") and sys_ids found in pasted text: a list, a spreadsheet column or a
 * query copied from ServiceNow. Numbers come back upper-cased, sys_ids lower-cased, without duplicates.
 */
export function extractArticleRefs(text: string): string[] {
  const unglued = text.replace(/(?:number|sys_id)(?:IN|=|LIKE|STARTSWITH)/gi, " ");
  const refs = (unglued.match(/\b(?:[0-9a-f]{32}|[A-Za-z]{1,10}\d{3,15})\b/gi) ?? []).map((ref) => (SYS_ID.test(ref.toLowerCase()) ? ref.toLowerCase() : ref.toUpperCase()));
  return uniqueBy(refs, (ref) => ref);
}
