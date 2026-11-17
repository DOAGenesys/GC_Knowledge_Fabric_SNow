import { z } from "zod";
import type { Audience, KnowledgeBaseDTO, PreviewDTO } from "@/lib/api-types";
import { AppError } from "@/lib/errors";
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
  if (value.length > 1000) return "Keep the filter under 1,000 characters.";
  if (/(^|\^)NQ/.test(value)) return "The filter can't start a new query (^NQ).";
  if (/^OR/i.test(value)) return "The filter can't begin with OR.";
  if (/ORDERBY|GROUPBY/i.test(value)) return "Sorting and grouping aren't allowed in the filter.";
  if (/[\r\n]/.test(value)) return "The filter must be on one line.";
  return null;
}

export function buildArticleQuery(kbIds: string[], filter: string, today: string, options: { orderBy?: string } = {}): string {
  const scope = `kb_knowledge_baseIN${kbIds.join(",")}^${publishedArticleConditions(today)}`;
  const extra = filter.trim().replace(/^\^+/, "").replace(/\^+$/, "");
  return `${scope}${extra ? `^${extra}` : ""}${options.orderBy ? `^${options.orderBy}` : ""}`;
}

const SUMMARY_FIELDS = "sys_id,number,short_description,sys_updated_on,kb_knowledge_base,kb_knowledge_base.title,kb_category.label";

/** Every published, current article in the selected knowledge bases (light fields only). */
export async function listArticleSummaries(
  connection: SnConnection,
  params: { kbIds: string[]; filter: string; maxArticles?: number; now?: Date },
  logger: Logger = log,
): Promise<ArticleSummary[]> {
  if (params.kbIds.length === 0) return [];
  const maxArticles = params.maxArticles ?? MAX_ARTICLES_PER_SYNC;
  const query = buildArticleQuery(params.kbIds, params.filter, todayUtc(params.now), { orderBy: "ORDERBYsys_id" });
  const byId = new Map<string, ArticleSummary>();

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
  logger.debug("Listed ServiceNow articles", { connectionId: connection.id, count: byId.size, kbCount: params.kbIds.length });
  return [...byId.values()];
}

export async function previewArticles(
  connection: SnConnection,
  params: { kbIds: string[]; filter: string; now?: Date },
  logger: Logger = log,
): Promise<PreviewDTO> {
  const { data, headers } = await snGet<unknown>(connection, {
    operation: "sn.previewArticles",
    path: "/api/now/table/kb_knowledge",
    query: {
      sysparm_query: buildArticleQuery(params.kbIds, params.filter, todayUtc(params.now), { orderBy: "ORDERBYDESCsys_updated_on" }),
      sysparm_fields: SUMMARY_FIELDS,
      sysparm_limit: 5,
      sysparm_exclude_reference_link: true,
    },
    log: logger,
  });
  const rows = tableResult(articleSummaryRow).safeParse(data);
  if (!rows.success) throw new AppError("SN_BAD_RESPONSE", { detail: "sn.previewArticles: missing result array" });
  const total = Number(headers.get("x-total-count"));
  return {
    count: Number.isFinite(total) ? total : rows.data.length,
    sample: rows.data.map((row) => {
      const summary = toSummary(row);
      return { number: summary.number, title: summary.title, kbName: summary.kbName, updatedAt: summary.updatedAt };
    }),
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
