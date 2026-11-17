import type { ArticleState, RunMode } from "@/lib/api-types";
import type { ArticleSummary } from "../servicenow/knowledge";
import { buildFileName, uniqueFileName } from "./document";

export interface ManifestEntry {
  articleId: string;
  fileName: string;
  snUpdatedAt: string | null;
  contentHash: string | null;
  state: ArticleState;
}

export type UploadReason = "new" | "changed" | "retry" | "config" | "full";
export type DeletionReason = "removed" | "retry";

export interface PlannedUpload {
  articleId: string;
  number: string;
  title: string;
  kbName: string;
  fileName: string;
  snUpdatedAt: string;
  reason: UploadReason;
}

export interface PlannedDeletion {
  articleId: string;
  fileName: string;
  reason: DeletionReason;
}

export interface SyncPlan {
  mode: RunMode;
  uploads: PlannedUpload[];
  deletions: PlannedDeletion[];
  unchanged: number;
}

/**
 * Decides what a run must do. File names are assigned once per article and kept stable
 * afterwards (title edits don't rename files), except in a full rebuild, which replaces
 * the whole source and can therefore reassign names.
 */
export function planSync(params: {
  articles: ArticleSummary[];
  manifest: ManifestEntry[];
  mode: RunMode;
  configChanged: boolean;
}): SyncPlan {
  const articles = dedupe(params.articles).sort(byNumber);

  if (params.mode === "full") {
    const taken = new Set<string>();
    const uploads = articles.map((article) => {
      const fileName = uniqueFileName(buildFileName(article.number, article.title, article.id), taken);
      taken.add(fileName);
      return toUpload(article, fileName, "full");
    });
    return { mode: "full", uploads, deletions: [], unchanged: 0 };
  }

  const manifest = new Map(params.manifest.map((entry) => [entry.articleId, entry]));
  const taken = new Set(params.manifest.map((entry) => entry.fileName));
  const uploads: PlannedUpload[] = [];
  let unchanged = 0;

  for (const article of articles) {
    const entry = manifest.get(article.id);
    if (!entry) {
      const fileName = uniqueFileName(buildFileName(article.number, article.title, article.id), taken);
      taken.add(fileName);
      uploads.push(toUpload(article, fileName, "new"));
      continue;
    }
    if (entry.state === "error" || entry.state === "pending_delete") {
      uploads.push(toUpload(article, entry.fileName, "retry"));
    } else if (params.configChanged) {
      uploads.push(toUpload(article, entry.fileName, "config"));
    } else if (entry.snUpdatedAt !== article.updatedAt) {
      uploads.push(toUpload(article, entry.fileName, "changed"));
    } else {
      unchanged += 1;
    }
  }

  const current = new Set(articles.map((article) => article.id));
  const deletions: PlannedDeletion[] = params.manifest
    .filter((entry) => !current.has(entry.articleId))
    .map((entry) => ({
      articleId: entry.articleId,
      fileName: entry.fileName,
      reason: entry.state === "pending_delete" ? "retry" : "removed",
    }));

  return { mode: "incremental", uploads, deletions, unchanged };
}

function toUpload(article: ArticleSummary, fileName: string, reason: UploadReason): PlannedUpload {
  return {
    articleId: article.id,
    number: article.number,
    title: article.title,
    kbName: article.kbName,
    fileName,
    snUpdatedAt: article.updatedAt,
    reason,
  };
}

function dedupe(articles: ArticleSummary[]): ArticleSummary[] {
  const byId = new Map<string, ArticleSummary>();
  for (const article of articles) byId.set(article.id, article);
  return [...byId.values()];
}

function byNumber(a: ArticleSummary, b: ArticleSummary): number {
  return a.number.localeCompare(b.number, "en", { numeric: true }) || a.id.localeCompare(b.id);
}
