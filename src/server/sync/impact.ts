import type { RemovalImpactDTO, RunMode } from "@/lib/api-types";
import { listManifestLabels } from "../repo/items";
import type { ArticleSummary } from "../servicenow/knowledge";

const SAMPLE_SIZE = 5;

export interface RemovalPlan {
  /** Articles in Genesys Cloud now that the run would remove, by article number. */
  removed: Array<{ articleId: string; number: string; title: string }>;
  additions: number;
}

/**
 * What a run over `articles` would do to the articles in Genesys Cloud: the same comparison
 * `planSync` makes, limited to what people care about before they click.
 */
export async function planRemovals(syncId: string, articles: ArticleSummary[], mode: RunMode = "incremental"): Promise<RemovalPlan> {
  const manifest = await listManifestLabels(syncId);
  const current = new Set(articles.map((article) => article.id));
  const known = new Set(manifest.map((item) => item.articleId));
  const additions = articles.filter((article) => !known.has(article.id)).length;
  // An incremental run that finds no articles stops before deleting anything (SN_NO_ARTICLES).
  if (mode === "incremental" && articles.length === 0) return { removed: [], additions };
  const removed = manifest
    .filter((item) => item.state === "synced" && !current.has(item.articleId))
    .sort((left, right) => left.number.localeCompare(right.number, undefined, { numeric: true }))
    .map(({ articleId, number, title }) => ({ articleId, number, title }));
  return { removed, additions };
}

export function toImpact(plan: RemovalPlan): RemovalImpactDTO {
  return {
    removals: plan.removed.length,
    sample: plan.removed.slice(0, SAMPLE_SIZE).map(({ number, title }) => ({ number, title })),
    additions: plan.additions,
  };
}

export async function removalImpact(syncId: string, articles: ArticleSummary[], mode: RunMode = "incremental"): Promise<RemovalImpactDTO> {
  return toImpact(await planRemovals(syncId, articles, mode));
}
