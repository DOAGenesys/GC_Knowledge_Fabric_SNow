import { NodeHtmlMarkdown, type TranslatorConfigObject } from "node-html-markdown";

/**
 * ServiceNow article HTML → Markdown for Knowledge Fabric. Relative links become absolute
 * instance links; images (which need a ServiceNow session to load) are replaced by their alt text.
 */

let currentBaseUrl = "https://invalid.example/";

const IMAGE_FILE_ALT = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

const translators: TranslatorConfigObject = {
  img: ({ node }) => {
    const alt = (node.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
    if (!alt || IMAGE_FILE_ALT.test(alt)) return { ignore: true };
    return { content: `[Image: ${alt}]`, recurse: false };
  },
  a: ({ node }) => {
    const href = (node.getAttribute("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(javascript|data|vbscript):/i.test(href)) return {};
    let absolute: URL;
    try {
      absolute = new URL(href, currentBaseUrl);
    } catch {
      return {};
    }
    if (!["http:", "https:", "mailto:"].includes(absolute.protocol)) return {};
    return { prefix: "[", postfix: `](${absolute.toString().replace(/\(/g, "%28").replace(/\)/g, "%29")})` };
  },
};

const converter = new NodeHtmlMarkdown(
  {
    bulletMarker: "-",
    codeBlockStyle: "fenced",
    keepDataImages: false,
    useInlineLinks: true,
    maxConsecutiveNewlines: 2,
    ignore: ["script", "style", "noscript", "iframe", "object", "embed", "form", "button", "input", "select", "textarea"],
  },
  translators,
);

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

export function htmlToMarkdown(html: string, baseUrl: string): string {
  if (!html.trim()) return "";
  currentBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const markdown = converter.translate(html.replace(ZERO_WIDTH, ""));
  return tidy(markdown);
}

/** Wiki-markup articles without rendered HTML: keep the text readable rather than dropping it. */
export function plainTextToMarkdown(text: string): string {
  return tidy(text.replace(ZERO_WIDTH, "").replace(/\r\n?/g, "\n"));
}

function tidy(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
