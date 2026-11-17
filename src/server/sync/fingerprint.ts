import type { Audience, LinkStyle } from "@/lib/api-types";
import { sha256Hex } from "../crypto";
import type { ArticleSummary } from "../servicenow/knowledge";
import { DOC_FORMAT_VERSION } from "./document";

/** Settings that change the generated documents. A change re-uploads every article once. */
export function computeConfigHash(config: { instanceUrl: string; audience: Audience; linkStyle: LinkStyle; linkCustom: string }): string {
  return sha256Hex(
    JSON.stringify([DOC_FORMAT_VERSION, config.instanceUrl, config.audience, config.linkStyle, config.linkStyle === "custom" ? config.linkCustom : ""]),
  ).slice(0, 32);
}

/** Cheap change detector: same fingerprint means no article was added, removed or edited. */
export function computeFingerprint(articles: Pick<ArticleSummary, "id" | "updatedAt">[], configHash: string): string {
  const lines = articles.map((article) => `${article.id}:${article.updatedAt}`).sort();
  return sha256Hex(`${configHash}\n${lines.join("\n")}`);
}
