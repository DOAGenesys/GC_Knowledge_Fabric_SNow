import type { Audience, LinkStyle } from "@/lib/api-types";
import { md5Base64, sha256Hex } from "../crypto";
import type { ArticleContent } from "../servicenow/knowledge";
import { htmlToMarkdown, plainTextToMarkdown } from "./markdown";

/** Bump when the generated document format changes: every article is re-uploaded once. */
export const DOC_FORMAT_VERSION = 1;
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const CONTENT_TYPE = "text/markdown";

// Knowledge Fabric file names: no leading dot, no trailing slash, no whitespace and none of \ { ^ } % ` ] " > [ ~ < # |
const DISALLOWED_FILE_CHARS = /[\\{^}%`\]">[~<#|\s]/;

export function isValidKnowledgeFileName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && !name.startsWith(".") && !name.endsWith("/") && !DISALLOWED_FILE_CHARS.test(name);
}

export function slugify(text: string, maxLength: number): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}

/** "KB0010001_How-to-reset-your-password.md" */
export function buildFileName(number: string, title: string, articleId: string): string {
  const prefix = number.replace(/[^A-Za-z0-9_-]/g, "") || articleId;
  const slug = slugify(title, 80);
  return `${prefix}${slug ? `_${slug}` : ""}.md`;
}

export function uniqueFileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const base = name.replace(/\.md$/, "");
  for (let index = 2; ; index++) {
    const candidate = `${base}_${index}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function articleUrl(params: { instanceUrl: string; linkStyle: LinkStyle; linkCustom: string; number: string; articleId: string }): string {
  const article = encodeURIComponent(params.number || params.articleId);
  const portal = (suffix: string) => `${params.instanceUrl}/${suffix}?id=kb_article_view&sysparm_article=${article}`;
  switch (params.linkStyle) {
    case "classic":
      return `${params.instanceUrl}/kb_view.do?sysparm_article=${article}`;
    case "sp":
      return portal("sp");
    case "esc":
      return portal("esc");
    case "csm":
      return portal("csm");
    case "csp":
      return portal("csp");
    case "custom":
      return portal(encodeURIComponent(params.linkCustom.trim() || "sp"));
  }
}

const AUDIENCE_LABEL: Record<Audience, string> = {
  csm: "Customers (Customer Service Management)",
  itsm: "Employees (IT Service Management)",
};

function tagFor(text: string): string {
  return slugify(text, 50).toLowerCase();
}

export interface DocumentInput {
  article: ArticleContent;
  fileName: string;
  instanceUrl: string;
  audience: Audience;
  linkStyle: LinkStyle;
  linkCustom: string;
}

export interface ArticleDocument {
  fileName: string;
  markdown: string;
  bytes: Uint8Array;
  contentMd5: string;
  /** Hash of the meaningful content (excludes the "updated" date) used to skip no-op uploads. */
  contentHash: string;
  originUri: string;
  tags: string[];
  isEmpty: boolean;
  tooLarge: boolean;
}

function escapeInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildArticleDocument(input: DocumentInput): ArticleDocument {
  const { article } = input;
  const originUri = articleUrl({
    instanceUrl: input.instanceUrl,
    linkStyle: input.linkStyle,
    linkCustom: input.linkCustom,
    number: article.number,
    articleId: article.id,
  });
  const body = article.html.trim() ? htmlToMarkdown(article.html, input.instanceUrl) : plainTextToMarkdown(article.plainText);
  const title = escapeInline(article.title);
  const facts = [
    article.number ? `**Article:** ${article.number}` : null,
    article.kbName ? `**Knowledge base:** ${escapeInline(article.kbName)}` : null,
    article.category ? `**Category:** ${escapeInline(article.category)}` : null,
    `**Audience:** ${AUDIENCE_LABEL[input.audience]}`,
  ].filter(Boolean);
  const keywords = escapeInline(article.keywords);
  const updated = article.updatedAt ? article.updatedAt.slice(0, 10) : "";

  const markdown = [
    `# ${title}`,
    "",
    facts.join(" · "),
    ...(keywords ? ["", `**Keywords:** ${keywords}`] : []),
    ...(updated ? ["", `_Last updated: ${updated}_`] : []),
    "",
    body,
    "",
    "---",
    "",
    `Source: [${article.number || title}](${originUri})`,
    "",
  ].join("\n");

  const bytes = new TextEncoder().encode(markdown);
  const contentHash = sha256Hex(
    JSON.stringify([DOC_FORMAT_VERSION, title, facts, keywords, body, originUri]),
  );
  const tags = [...new Set(["servicenow", input.audience, tagFor(article.kbName), tagFor(article.category)].filter((tag) => tag.length > 0))];

  return {
    fileName: input.fileName,
    markdown,
    bytes,
    contentMd5: md5Base64(bytes),
    contentHash,
    originUri,
    tags,
    isEmpty: body.trim().length === 0,
    tooLarge: bytes.byteLength > MAX_DOCUMENT_BYTES,
  };
}
