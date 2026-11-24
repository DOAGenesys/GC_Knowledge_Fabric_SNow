import { z } from "zod";
import type { ArticleOptionDTO, Audience, FilterOptionsDTO, KnowledgeBaseDTO, PreviewDTO } from "@/lib/api-types";
import { AppError } from "@/lib/errors";
import { ARTICLE_NUMBER, categoryLabel, LANGUAGE_CODE, NO_CATEGORY, type SyncFilters } from "@/lib/filters";
import { type Logger, scopedLogger } from "../log";
import { type SnConnection, snGet } from "./client";

const log = scopedLogger("sn.knowledge");

export const ARTICLE_PAGE_SIZE = 1000;
export const MAX_ARTICLES_PER_SYNC = 20_000;
const SYS_ID = /^[0-9a-f]{32}$/;

const scalar = z.union([z.string(), z.number(), z.boolean()]).transform(String);
const wrapped = z.object({ value: scalar.nullish(), display_value: scalar.nullish() });

/** Plain fields. Some instances wrap values as {value, display_value}; the display form wins. */
const str = z
  .union([scalar, wrapped.transform((field) => field.display_value ?? field.value ?? "")])
  .nullish()
  .transform((value) => value ?? "");

/** Reference fields: a sys_id string, or a {value, link} object even with sysparm_exclude_reference_link. */
export const refField = z
  .union([scalar, wrapped.transform((field) => field.value ?? "")])
  .nullish()
  .transform((value) => value ?? "");

const tableResult = <T extends z.ZodType>(row: T) => z.object({ result: z.array(z.unknown()) }).transform((value) =>
  value.result.flatMap((item) => {
    const parsed = row.safeParse(item);
    return parsed.success ? [parsed.data as z.infer<T>] : [];
  }),
);

const kbRow = z.object({ sys_id: z.string().regex(SYS_ID), title: str, description: str });

const articleSummaryRow = z.object({
  sys_id: z.string().regex(SYS_ID),
  number: str,
  short_description: str,
  sys_updated_on: str,
  kb_knowledge_base: refField,
  "kb_knowledge_base.title": str,
  "kb_category.label": str,
});

const articleContentRow = articleSummaryRow.extend({
  text: str,
  wiki: str,
  article_type: str,
  meta: str,
});

export interface ArticleSummary {
  id: string;
  number: string;
  title: string;
  updatedAt: string;
  kbId: string;
  kbName: string;
  category: string;
}

export interface ArticleContent extends ArticleSummary {
  html: string;
  /** Raw wiki markup for wiki-type articles when no rendered HTML is available. */
  plainText: string;
  keywords: string;
}

function toSummary(row: z.infer<typeof articleSummaryRow>): ArticleSummary {
  return {
    id: row.sys_id,
    number: row.number,
    title: row.short_description.trim() || row.number || row.sys_id,
    updatedAt: row.sys_updated_on,
    kbId: row.kb_knowledge_base,
    kbName: row["kb_knowledge_base.title"],
    category: row["kb_category.label"],
  };
}

/** The connection works when it can read knowledge bases. Returns how many are visible. */
export async function testConnection(connection: SnConnection, logger: Logger = log): Promise<{ knowledgeBases: number }> {
  const { data, headers } = await snGet<unknown>(connection, {
    operation: "sn.testConnection",
    path: "/api/now/table/kb_knowledge_base",
    query: { sysparm_query: "active=true", sysparm_fields: "sys_id", sysparm_limit: 1 },
    timeoutMs: 15_000,
    log: logger,
  });
  if (!z.object({ result: z.array(z.unknown()) }).safeParse(data).success) {
    throw new AppError("SN_BAD_RESPONSE", { detail: "sn.testConnection: missing result array" });
  }
  const total = Number(headers.get("x-total-count"));
  return { knowledgeBases: Number.isFinite(total) ? total : 0 };
}

const CSM_PORTALS = new Set(["csm", "csp", "business_portal", "customer", "customers", "support"]);
const ITSM_PORTALS = new Set(["esc", "sp", "ess", "it", "itsm", "employee", "hrportal"]);

export function suggestAudience(portals: string[]): Audience | null {
  const lower = portals.map((portal) => portal.toLowerCase());
  const csm = lower.some((portal) => CSM_PORTALS.has(portal));
  const itsm = lower.some((portal) => ITSM_PORTALS.has(portal));
  if (csm && !itsm) return "csm";
  if (itsm && !csm) return "itsm";
  return null;
}

export function publishedArticleConditions(today: string): string {
  return `workflow_state=published^active=true^valid_to>=${today}^ORvalid_toISEMPTY`;
}

export async function listKnowledgeBases(connection: SnConnection, logger: Logger = log): Promise<KnowledgeBaseDTO[]> {
  const { data } = await snGet<unknown>(connection, {
    operation: "sn.listKnowledgeBases",
    path: "/api/now/table/kb_knowledge_base",
    query: {
      sysparm_query: "active=true^ORDERBYtitle",
      sysparm_fields: "sys_id,title,description",
      sysparm_limit: 500,
      sysparm_exclude_reference_link: true,
    },
    log: logger,
  });
  const parsed = tableResult(kbRow).safeParse(data);
  if (!parsed.success) throw new AppError("SN_BAD_RESPONSE", { detail: "sn.listKnowledgeBases: missing result array" });

  const [counts, portals] = await Promise.all([countByKnowledgeBase(connection, logger), portalsByKnowledgeBase(connection, logger)]);
  return parsed.data.map((kb) => {
    const kbPortals = portals.get(kb.sys_id) ?? [];
    return {
      id: kb.sys_id,
      title: kb.title || "Untitled knowledge base",
      description: kb.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240),
      articleCount: counts ? (counts.get(kb.sys_id) ?? 0) : null,
      portals: kbPortals,
      suggestedAudience: suggestAudience(kbPortals),
    };
  });
}

function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Published article counts per knowledge base via the Aggregate API. Null when unavailable. */
async function countByKnowledgeBase(connection: SnConnection, logger: Logger): Promise<Map<string, number> | null> {
  try {
    const { data } = await snGet<{ result?: Array<{ stats?: { count?: string }; groupby_fields?: Array<{ field?: string; value?: string }> }> }>(
      connection,
      {
        operation: "sn.countByKnowledgeBase",
        path: "/api/now/stats/kb_knowledge",
        query: {
          sysparm_count: true,
          sysparm_group_by: "kb_knowledge_base",
          sysparm_query: publishedArticleConditions(todayUtc()),
        },
        log: logger,
      },
    );
    const counts = new Map<string, number>();
    for (const group of data.result ?? []) {
      const kbId = group.groupby_fields?.find((field) => field.field === "kb_knowledge_base")?.value;
      if (kbId) counts.set(kbId, Number(group.stats?.count ?? 0));
    }
    return counts;
  } catch (error) {
    logger.debug("Article counts unavailable", { err: error, dedupeKey: `sn.counts:${connection.id}` });
    return null;
  }
}

/** Service Portal URL suffixes per knowledge base (e.g. "csm", "esc"). Empty when not readable. */
async function portalsByKnowledgeBase(connection: SnConnection, logger: Logger): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  try {
    const { data } = await snGet<{ result?: Array<Record<string, unknown>> }>(connection, {
      operation: "sn.portalsByKnowledgeBase",
      path: "/api/now/table/m2m_sp_portal_knowledge_base",
      query: { sysparm_fields: "kb_knowledge_base,sp_portal.url_suffix", sysparm_limit: 1000, sysparm_exclude_reference_link: true },
      log: logger,
    });
    for (const row of data.result ?? []) {
      const kbId = refField.safeParse(row.kb_knowledge_base).data ?? "";
      const suffix = str.safeParse(row["sp_portal.url_suffix"]).data ?? "";
      if (!kbId || !suffix) continue;
      const list = result.get(kbId) ?? [];
      if (!list.includes(suffix)) list.push(suffix);
      result.set(kbId, list);
    }
  } catch (error) {
    logger.debug("Portal mapping unavailable", { err: error, dedupeKey: `sn.portals:${connection.id}` });
  }
  return result;
}

/**
 * Validates the optional "advanced filter" (a ServiceNow encoded query). It's ANDed with the
 * knowledge base scope, so it may not start a new query, OR with the scope, or reorder results.
 */
export function validateFilterQuery(filter: string): string | null {
  const value = filter.trim().replace(/^\^+/, "").replace(/\^+$/, "");
  if (!value) return null;
  if (value.length > 1000) return "Keep the condition under 1,000 characters. For long lists of categories or articles, use the choices above instead: they have no length limit.";
  if (/(^|\^)NQ/.test(value)) return "The condition can't start a new query (^NQ).";
  if (/^OR/i.test(value)) return "The condition can't begin with OR.";
  if (/ORDERBY|GROUPBY/i.test(value)) return "Sorting and grouping aren't allowed in the condition.";
  if (/[\r\n]/.test(value)) return "The condition must be on one line.";
  return null;
}

/** List sizes per request, so no URL gets too long however many categories or articles are picked. */
const CATEGORY_CHUNK = 50;
const NUMBER_CHUNK = 100;
const SYS_ID_CHUNK = 50;

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * The friendly filters as encoded queries. Within one filter values are ORed; filters are ANDed.
 * Long lists are split across several queries that together match each article exactly once.
 * Picking articles with none chosen yet matches nothing, so there's no query at all.
 */
export function filterQueries(filters: SyncFilters): string[] {
  const categoryIds = [...new Set(filters.categories.map((category) => category.id).filter((id) => SYS_ID.test(id)))];
  const withoutCategory = filters.categories.some((category) => category.id === NO_CATEGORY);
  const languages = [...new Set(filters.languages.map((language) => language.code).filter((code) => LANGUAGE_CODE.test(code)))];
  const numbers = filters.articles && [...new Set(filters.articles.map((article) => article.number).filter((number) => ARTICLE_NUMBER.test(number)))];

  const categoryParts =
    categoryIds.length > 0
      ? chunked(categoryIds, CATEGORY_CHUNK).map((ids, index) => `kb_categoryIN${ids.join(",")}${withoutCategory && index === 0 ? "^ORkb_categoryISEMPTY" : ""}`)
      : [withoutCategory ? "kb_categoryISEMPTY" : ""];
  const languagePart = languages.length > 0 ? `languageIN${languages.join(",")}` : "";
  const numberParts = numbers ? chunked(numbers, NUMBER_CHUNK).map((list) => `numberIN${list.join(",")}`) : [""];
  return categoryParts.flatMap((categoryPart) => numberParts.map((numberPart) => [categoryPart, languagePart, numberPart].filter(Boolean).join("^")));
}

/** Everything that narrows a sync's articles: the friendly filters plus the optional custom query. */
export function articleFilters(filters: SyncFilters, customQuery: string): string[] {
  const custom = customQuery.trim().replace(/^\^+/, "").replace(/\^+$/, "");
  return filterQueries(filters).map((part) => [part, custom].filter(Boolean).join("^"));
}

export function buildArticleQuery(kbIds: string[], filter: string, today: string, options: { orderBy?: string } = {}): string {
  const scope = `kb_knowledge_baseIN${kbIds.join(",")}^${publishedArticleConditions(today)}`;
  const extra = filter.trim().replace(/^\^+/, "").replace(/\^+$/, "");
  return `${scope}${extra ? `^${extra}` : ""}${options.orderBy ? `^${options.orderBy}` : ""}`;
}

const SUMMARY_FIELDS = "sys_id,number,short_description,sys_updated_on,kb_knowledge_base,kb_knowledge_base.title,kb_category.label";

/** One filter, or several whose matches are combined (see `articleFilters`). */
type ArticleFilter = string | string[];

function filterList(filter: ArticleFilter): string[] {
  return typeof filter === "string" ? [filter] : filter;
}

/** Runs `task` over `items`, a few at a time, keeping the order. */
async function inBatches<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) results.push(...(await Promise.all(items.slice(index, index + size).map(task))));
  return results;
}

function newestFirst(a: ArticleSummary, b: ArticleSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function toSample(article: ArticleSummary): PreviewDTO["sample"][number] {
  return { number: article.number, title: article.title, kbName: article.kbName, updatedAt: article.updatedAt };
}

function toOption(article: ArticleSummary): ArticleOptionDTO {
  return { number: article.number, title: article.title, kbId: article.kbId, kbName: article.kbName, category: article.category, updatedAt: article.updatedAt };
}

/** Every published, current article in the selected knowledge bases (light fields only). */
export async function listArticleSummaries(
  connection: SnConnection,
  params: { kbIds: string[]; filter: ArticleFilter; maxArticles?: number; now?: Date },
  logger: Logger = log,
): Promise<ArticleSummary[]> {
  const filters = filterList(params.filter);
  if (params.kbIds.length === 0 || filters.length === 0) return [];
  const maxArticles = params.maxArticles ?? MAX_ARTICLES_PER_SYNC;
  const today = todayUtc(params.now);
  const byId = new Map<string, ArticleSummary>();

  for (const filter of filters) {
    const query = buildArticleQuery(params.kbIds, filter, today, { orderBy: "ORDERBYsys_id" });
    for (let offset = 0; ; offset += ARTICLE_PAGE_SIZE) {
      const { data } = await snGet<unknown>(connection, {
        operation: "sn.listArticles",
        path: "/api/now/table/kb_knowledge",
        query: {
          sysparm_query: query,
          sysparm_fields: SUMMARY_FIELDS,
          sysparm_limit: ARTICLE_PAGE_SIZE,
          sysparm_offset: offset,
          sysparm_exclude_reference_link: true,
          sysparm_no_count: true,
        },
        log: logger,
      });
      const page = z.object({ result: z.array(z.unknown()) }).safeParse(data);
      if (!page.success) throw new AppError("SN_BAD_RESPONSE", { detail: "sn.listArticles: missing result array" });
      for (const item of page.data.result) {
        const row = articleSummaryRow.safeParse(item);
        if (row.success) byId.set(row.data.sys_id, toSummary(row.data));
      }
      if (byId.size > maxArticles) {
        throw new AppError("SN_TOO_MANY_ARTICLES", { detail: `more than ${maxArticles} articles match` });
      }
      if (page.data.result.length < ARTICLE_PAGE_SIZE) break;
    }
  }
  logger.debug("Listed ServiceNow articles", { connectionId: connection.id, count: byId.size, kbCount: params.kbIds.length, queries: filters.length });
  return [...byId.values()];
}

/**
 * How many articles match, and the most recently updated ones. With hand-picked articles (`chosen`)
 * it also tells which of them won't be synced.
 */
export async function previewArticles(
  connection: SnConnection,
  params: { kbIds: string[]; filter: ArticleFilter; chosen?: string[] | null; now?: Date },
  logger: Logger = log,
): Promise<PreviewDTO> {
  const filters = filterList(params.filter);
  if (params.chosen) {
    const articles = await listArticleSummaries(connection, { kbIds: params.kbIds, filter: filters, now: params.now }, logger);
    const found = new Set(articles.map((article) => article.number.toUpperCase()));
    return {
      count: articles.length,
      sample: [...articles].sort(newestFirst).slice(0, 5).map(toSample),
      missing: params.chosen.filter((number) => !found.has(number.toUpperCase())),
    };
  }

  const today = todayUtc(params.now);
  const pages = await inBatches(filters, 4, async (filter) => {
    const { data, headers } = await snGet<unknown>(connection, {
      operation: "sn.previewArticles",
      path: "/api/now/table/kb_knowledge",
      query: {
        sysparm_query: buildArticleQuery(params.kbIds, filter, today, { orderBy: "ORDERBYDESCsys_updated_on" }),
        sysparm_fields: SUMMARY_FIELDS,
        sysparm_limit: 5,
        sysparm_exclude_reference_link: true,
      },
      log: logger,
    });
    const rows = tableResult(articleSummaryRow).safeParse(data);
    if (!rows.success) throw new AppError("SN_BAD_RESPONSE", { detail: "sn.previewArticles: missing result array" });
    const total = Number(headers.get("x-total-count") ?? Number.NaN);
    return { count: Number.isFinite(total) ? total : rows.data.length, articles: rows.data.map(toSummary) };
  });
  return {
    count: pages.reduce((sum, page) => sum + page.count, 0),
    sample: pages
      .flatMap((page) => page.articles)
      .sort(newestFirst)
      .slice(0, 5)
      .map(toSample),
  };
}

export const ARTICLE_SEARCH_LIMIT = 20;

/** Published articles whose number or title contains `text` (all of them when empty), most recently updated first. */
export async function searchArticles(
  connection: SnConnection,
  params: { kbIds: string[]; text: string; now?: Date },
  logger: Logger = log,
): Promise<{ articles: ArticleOptionDTO[]; more: boolean }> {
  const text = params.text.replace(/[\^\r\n]/g, " ").trim().slice(0, 100);
  const { data } = await snGet<unknown>(connection, {
    operation: "sn.searchArticles",
    path: "/api/now/table/kb_knowledge",
    query: {
      sysparm_query: buildArticleQuery(params.kbIds, text ? `numberLIKE${text}^ORshort_descriptionLIKE${text}` : "", todayUtc(params.now), {
        orderBy: "ORDERBYDESCsys_updated_on",
      }),
      sysparm_fields: SUMMARY_FIELDS,
      sysparm_limit: ARTICLE_SEARCH_LIMIT + 1,
      sysparm_exclude_reference_link: true,
      sysparm_no_count: true,
    },
    log: logger,
  });
  const rows = tableResult(articleSummaryRow).safeParse(data);
  if (!rows.success) throw new AppError("SN_BAD_RESPONSE", { detail: "sn.searchArticles: missing result array" });
  return { articles: rows.data.slice(0, ARTICLE_SEARCH_LIMIT).map((row) => toOption(toSummary(row))), more: rows.data.length > ARTICLE_SEARCH_LIMIT };
}

/** Published articles in these knowledge bases with the given numbers or sys_ids, e.g. from a pasted list. */
export async function lookupArticles(
  connection: SnConnection,
  params: { kbIds: string[]; refs: string[]; now?: Date },
  logger: Logger = log,
): Promise<{ found: ArticleOptionDTO[]; notFound: string[] }> {
  const ids = params.refs.filter((ref) => SYS_ID.test(ref));
  const numbers = params.refs.filter((ref) => !SYS_ID.test(ref) && ARTICLE_NUMBER.test(ref));
  const filters = [...chunked(numbers, NUMBER_CHUNK).map((list) => `numberIN${list.join(",")}`), ...chunked(ids, SYS_ID_CHUNK).map((list) => `sys_idIN${list.join(",")}`)];
  const articles = (await listArticleSummaries(connection, { kbIds: params.kbIds, filter: filters, now: params.now }, logger)).filter((article) =>
    ARTICLE_NUMBER.test(article.number),
  );
  const byId = new Map(articles.map((article) => [article.id, article]));
  const byNumber = new Map(articles.map((article) => [article.number.toUpperCase(), article]));

  const found = new Map<string, ArticleSummary>();
  const notFound: string[] = [];
  for (const ref of params.refs) {
    const article = SYS_ID.test(ref) ? byId.get(ref) : byNumber.get(ref.toUpperCase());
    if (article) found.set(article.number.toUpperCase(), article);
    else notFound.push(ref);
  }
  logger.debug("Looked up ServiceNow articles", { connectionId: connection.id, refs: params.refs.length, found: found.size });
  return { found: [...found.values()].map(toOption), notFound };
}

const MAX_FILTER_OPTIONS = 500;

const aggregateGroups = z.object({
  result: z.array(
    z.object({
      stats: z.object({ count: scalar.optional() }).optional(),
      groupby_fields: z.array(z.object({ field: z.string(), value: scalar.nullish(), display_value: scalar.nullish() })).default([]),
    }),
  ),
});

interface ArticleGroup {
  count: number;
  fields: Map<string, { value: string; label: string }>;
}

/** Published-article counts grouped by `groupBy`, with display values for the grouped fields. */
async function groupPublishedArticles(connection: SnConnection, kbIds: string[], groupBy: string, operation: string, logger: Logger): Promise<ArticleGroup[]> {
  const { data } = await snGet<unknown>(connection, {
    operation,
    path: "/api/now/stats/kb_knowledge",
    query: {
      sysparm_count: true,
      sysparm_group_by: groupBy,
      sysparm_display_value: "all",
      sysparm_query: buildArticleQuery(kbIds, "", todayUtc()),
    },
    log: logger,
  });
  const parsed = aggregateGroups.safeParse(data);
  if (!parsed.success) throw new AppError("SN_BAD_RESPONSE", { detail: `${operation}: unexpected aggregate response` });
  return parsed.data.result.map((group) => ({
    count: Number(group.stats?.count ?? 0) || 0,
    fields: new Map(group.groupby_fields.map((field) => [field.field, { value: field.value ?? "", label: field.display_value ?? field.value ?? "" }])),
  }));
}

/** Full category paths ("Email / Outlook"). Missing entries fall back to the plain label. */
async function categoryPaths(connection: SnConnection, ids: string[], logger: Logger): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  try {
    for (let index = 0; index < ids.length; index += 100) {
      const chunk = ids.slice(index, index + 100);
      const { data } = await snGet<unknown>(connection, {
        operation: "sn.categoryPaths",
        path: "/api/now/table/kb_category",
        query: {
          sysparm_query: `sys_idIN${chunk.join(",")}`,
          sysparm_fields: "sys_id,full_category",
          sysparm_limit: chunk.length,
          sysparm_exclude_reference_link: true,
          sysparm_no_count: true,
        },
        log: logger,
      });
      const rows = tableResult(z.object({ sys_id: z.string().regex(SYS_ID), full_category: str })).safeParse(data);
      for (const row of rows.success ? rows.data : []) {
        if (row.full_category.trim()) paths.set(row.sys_id, row.full_category.trim());
      }
    }
  } catch (error) {
    logger.debug("Category paths unavailable", { err: error, dedupeKey: `sn.categoryPaths:${connection.id}` });
  }
  return paths;
}

async function categoryOptions(connection: SnConnection, kbIds: string[], logger: Logger): Promise<FilterOptionsDTO["categories"]> {
  const groups = await groupPublishedArticles(connection, kbIds, "kb_knowledge_base,kb_category", "sn.categoryCounts", logger);
  const byId = new Map<string, FilterOptionsDTO["categories"][number]>();
  for (const group of groups) {
    const kb = group.fields.get("kb_knowledge_base");
    const category = group.fields.get("kb_category");
    const id = category && SYS_ID.test(category.value) ? category.value : NO_CATEGORY;
    const existing = byId.get(id);
    if (existing) {
      existing.count += group.count;
      continue;
    }
    const label = categoryLabel({ id, label: category?.label ?? "" });
    byId.set(id, {
      id,
      label,
      path: label,
      kbId: id && kb && SYS_ID.test(kb.value) ? kb.value : NO_CATEGORY,
      kbName: id ? (kb?.label ?? "") : "",
      count: group.count,
    });
  }
  const paths = await categoryPaths(connection, [...byId.keys()].filter(Boolean), logger);
  for (const option of byId.values()) option.path = paths.get(option.id) ?? option.label;
  return [...byId.values()]
    .filter((option) => option.count > 0)
    .sort((a, b) => Number(a.id === NO_CATEGORY) - Number(b.id === NO_CATEGORY) || a.kbName.localeCompare(b.kbName) || a.path.localeCompare(b.path))
    .slice(0, MAX_FILTER_OPTIONS);
}

async function languageOptions(connection: SnConnection, kbIds: string[], logger: Logger): Promise<FilterOptionsDTO["languages"]> {
  const groups = await groupPublishedArticles(connection, kbIds, "language", "sn.languageCounts", logger);
  const byCode = new Map<string, FilterOptionsDTO["languages"][number]>();
  for (const group of groups) {
    const language = group.fields.get("language");
    const code = language?.value ?? "";
    if (!LANGUAGE_CODE.test(code) || group.count <= 0) continue;
    const existing = byCode.get(code);
    if (existing) existing.count += group.count;
    else byCode.set(code, { code, label: language?.label && language.label !== code ? language.label : code, count: group.count });
  }
  return [...byCode.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(0, MAX_FILTER_OPTIONS);
}

/**
 * Categories and languages used by published articles in these knowledge bases, with counts.
 * One of them failing (no language field, aggregate access denied) just leaves that list empty.
 */
export async function listFilterOptions(connection: SnConnection, kbIds: string[], logger: Logger = log): Promise<FilterOptionsDTO> {
  const [categories, languages] = await Promise.allSettled([categoryOptions(connection, kbIds, logger), languageOptions(connection, kbIds, logger)]);
  if (categories.status === "rejected" && languages.status === "rejected") throw categories.reason;
  if (categories.status === "rejected") logger.debug("Category filter unavailable", { err: categories.reason, dedupeKey: `sn.categoryOptions:${connection.id}` });
  if (languages.status === "rejected") logger.debug("Language filter unavailable", { err: languages.reason, dedupeKey: `sn.languageOptions:${connection.id}` });
  return {
    categories: categories.status === "fulfilled" ? categories.value : [],
    languages: languages.status === "fulfilled" ? languages.value : [],
  };
}

const CONTENT_FIELDS = `${SUMMARY_FIELDS},text,wiki,article_type,meta`;

/**
 * Full content for a batch of articles. Articles whose body isn't plain HTML (templates,
 * wiki markup) are rendered through the Knowledge Management REST API when it's available.
 */
export async function fetchArticleContents(connection: SnConnection, ids: string[], logger: Logger = log): Promise<Map<string, ArticleContent>> {
  const result = new Map<string, ArticleContent>();
  if (ids.length === 0) return result;
  const { data } = await snGet<unknown>(connection, {
    operation: "sn.fetchArticles",
    path: "/api/now/table/kb_knowledge",
    query: {
      sysparm_query: `sys_idIN${ids.join(",")}`,
      sysparm_fields: CONTENT_FIELDS,
      sysparm_limit: ids.length,
      sysparm_exclude_reference_link: true,
      sysparm_no_count: true,
    },
    timeoutMs: 45_000,
    log: logger,
  });
  const rows = tableResult(articleContentRow).safeParse(data);
  if (!rows.success) throw new AppError("SN_BAD_RESPONSE", { detail: "sn.fetchArticles: missing result array" });

  for (const row of rows.data) {
    const isWiki = row.article_type.toLowerCase() === "wiki";
    result.set(row.sys_id, {
      ...toSummary(row),
      html: isWiki ? "" : row.text,
      plainText: isWiki ? row.wiki : "",
      keywords: row.meta,
    });
  }

  const needsRendering = [...result.values()].filter((article) => !article.html.trim());
  for (let index = 0; index < needsRendering.length; index += 3) {
    await Promise.all(
      needsRendering.slice(index, index + 3).map(async (article) => {
        const rendered = await fetchRenderedArticle(connection, article.id, logger);
        if (rendered) article.html = rendered;
      }),
    );
  }
  return result;
}

/** Rendered HTML from the Knowledge Management REST API, or null when the API or article isn't available. */
export async function fetchRenderedArticle(connection: SnConnection, id: string, logger: Logger = log): Promise<string | null> {
  try {
    const { data } = await snGet<{ result?: { content?: unknown } }>(connection, {
      operation: "sn.renderArticle",
      path: `/api/sn_km_api/knowledge/articles/${id}`,
      query: { fields: "short_description" },
      log: logger,
    });
    const content = data.result?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch (error) {
    if (error instanceof AppError && (error.code === "SN_NOT_FOUND" || error.code === "SN_PERMISSION_DENIED" || error.code === "SN_QUERY_INVALID")) {
      logger.debug("Rendered article unavailable", { articleId: id, code: error.code, dedupeKey: `sn.render:${connection.id}:${error.code}` });
      return null;
    }
    throw error;
  }
}
