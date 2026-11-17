import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ArticleContent, ArticleSummary } from "@/server/servicenow/knowledge";
import {
  articleUrl,
  buildArticleDocument,
  buildFileName,
  isValidKnowledgeFileName,
  MAX_DOCUMENT_BYTES,
  slugify,
  uniqueFileName,
} from "@/server/sync/document";
import { computeConfigHash, computeFingerprint } from "@/server/sync/fingerprint";
import { htmlToMarkdown, plainTextToMarkdown } from "@/server/sync/markdown";
import { type ManifestEntry, planSync } from "@/server/sync/plan";

const BASE = "https://acme.service-now.com";

describe("htmlToMarkdown", () => {
  const convert = (html: string) => htmlToMarkdown(html, BASE);

  it("converts headings, emphasis and lists", () => {
    expect(convert("<h2>Title</h2><p>Hello <strong>world</strong></p>")).toBe("## Title\n\nHello **world**");
    expect(convert("<ul><li>One</li><li>Two</li></ul>")).toBe("- One\n- Two");
    expect(convert("<ol><li>One</li><li>Two</li></ol>")).toBe("1. One\n2. Two");
  });

  it("makes relative links absolute and keeps mail links", () => {
    expect(convert('<a href="/kb_view.do?sysparm_article=KB1">see</a>')).toBe(`[see](${BASE}/kb_view.do?sysparm_article=KB1)`);
    expect(convert('<a href="mailto:help@acme.example">mail</a>')).toBe("[mail](mailto:help@acme.example)");
    expect(convert('<a href="https://x.example/a_(b)">x</a>')).toBe("[x](https://x.example/a_%28b%29)");
  });

  it("drops dangerous and in-page links but keeps their text", () => {
    expect(convert('<a href="javascript:alert(1)">click</a>')).toBe("click");
    expect(convert('<a href="data:text/html;base64,xx">data</a>')).toBe("data");
    expect(convert('<a href="#section">jump</a>')).toBe("jump");
    expect(convert('<a href="ftp://files.example/x">ftp</a>')).toBe("ftp");
  });

  it("replaces images with their alt text, or drops them", () => {
    expect(convert('<p>See <img src="/sys_attachment.do?sys_id=1" alt="Settings  screen"></p>')).toBe("See [Image: Settings screen]");
    expect(convert('<p>A<img src="/x.png" alt="screenshot.png">B</p>')).toBe("AB");
    expect(convert('<p>A<img src="/x.png">B</p>')).toBe("AB");
  });

  it("removes scripts, styles and form controls", () => {
    expect(convert("<script>alert(1)</script><style>p{color:red}</style><p>Text</p><button>Go</button>")).toBe("Text");
  });

  it("keeps code blocks and tables", () => {
    expect(convert("<pre><code>npm install</code></pre>")).toBe("```\nnpm install\n```");
    const table = convert("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(table).toContain("| A | B |");
    expect(table).toContain("| 1 | 2 |");
  });

  it("cleans whitespace and invisible characters", () => {
    expect(convert("<p>a\u200Bb</p><p></p><p></p><p>c   </p>")).toBe("ab\n\nc");
    expect(convert("   ")).toBe("");
  });

  it("formats wiki plain text", () => {
    expect(plainTextToMarkdown("line 1\r\nline 2\u200B\r\n\r\n\r\n\r\nline 3  ")).toBe("line 1\nline 2\n\nline 3");
  });
});

describe("file names", () => {
  it.each(["KB0010001_Reset-password.md", "a.md", "KB1_x_2.md"])("accepts %s", (name) => {
    expect(isValidKnowledgeFileName(name)).toBe(true);
  });

  it.each(["", ".hidden.md", "folder/", "has space.md", "a#b.md", "a%20b.md", "a[1].md", "x".repeat(201)])("rejects %j", (name) => {
    expect(isValidKnowledgeFileName(name)).toBe(false);
  });

  it("slugs titles to ASCII", () => {
    expect(slugify("Réinitialiser votre mot de passe !", 80)).toBe("Reinitialiser-votre-mot-de-passe");
    expect(slugify("a b c d e", 4)).toBe("a-b");
    expect(slugify("日本語のタイトル", 80)).toBe("");
  });

  it("builds stable names from number and title", () => {
    expect(buildFileName("KB0010001", "How to reset your password?", "sys1")).toBe("KB0010001_How-to-reset-your-password.md");
    expect(buildFileName("KB0010001", "", "sys1")).toBe("KB0010001.md");
    expect(buildFileName("KB 001/2", "x", "sys1")).toBe("KB0012_x.md");
    expect(buildFileName("", "Title", "sys1")).toBe("sys1_Title.md");
  });

  it.each(["Émojis 🚀 & <tags> [brackets] {braces} | pipes ~ tilde", "日本語のタイトル", "  ", "x".repeat(500), '"quoted" `code` 100% #1 ^up^'])(
    "always produces a valid name for %j",
    (title) => {
      expect(isValidKnowledgeFileName(buildFileName("KB0000001", title, "sys1"))).toBe(true);
    },
  );

  it("suffixes duplicates", () => {
    expect(uniqueFileName("a.md", new Set())).toBe("a.md");
    expect(uniqueFileName("a.md", new Set(["a.md"]))).toBe("a_2.md");
    expect(uniqueFileName("a.md", new Set(["a.md", "a_2.md"]))).toBe("a_3.md");
  });
});

describe("articleUrl", () => {
  const base = { instanceUrl: BASE, linkCustom: "", number: "KB0010001", articleId: "sys1" };

  it.each([
    ["classic", `${BASE}/kb_view.do?sysparm_article=KB0010001`],
    ["sp", `${BASE}/sp?id=kb_article_view&sysparm_article=KB0010001`],
    ["esc", `${BASE}/esc?id=kb_article_view&sysparm_article=KB0010001`],
    ["csm", `${BASE}/csm?id=kb_article_view&sysparm_article=KB0010001`],
    ["csp", `${BASE}/csp?id=kb_article_view&sysparm_article=KB0010001`],
  ] as const)("%s links", (linkStyle, expected) => {
    expect(articleUrl({ ...base, linkStyle })).toBe(expected);
  });

  it("supports custom portals and falls back sensibly", () => {
    expect(articleUrl({ ...base, linkStyle: "custom", linkCustom: " help " })).toBe(`${BASE}/help?id=kb_article_view&sysparm_article=KB0010001`);
    expect(articleUrl({ ...base, linkStyle: "custom", linkCustom: "" })).toBe(`${BASE}/sp?id=kb_article_view&sysparm_article=KB0010001`);
    expect(articleUrl({ ...base, linkStyle: "custom", linkCustom: "a/b?c" })).toBe(`${BASE}/a%2Fb%3Fc?id=kb_article_view&sysparm_article=KB0010001`);
    expect(articleUrl({ ...base, linkStyle: "classic", number: "" })).toBe(`${BASE}/kb_view.do?sysparm_article=sys1`);
  });
});

function article(overrides: Partial<ArticleContent> = {}): ArticleContent {
  return {
    id: "sys1",
    number: "KB0010001",
    title: "Reset your password",
    updatedAt: "2026-11-01 10:00:00",
    kbId: "kb1",
    kbName: "IT Help",
    category: "Accounts & Access",
    html: "<p>Go to <a href='/reset'>reset</a>.</p>",
    plainText: "",
    keywords: "password, reset",
    ...overrides,
  };
}

describe("buildArticleDocument", () => {
  const build = (overrides: Partial<ArticleContent> = {}) =>
    buildArticleDocument({ article: article(overrides), fileName: "KB0010001_Reset-your-password.md", instanceUrl: BASE, audience: "itsm", linkStyle: "sp", linkCustom: "" });

  it("writes a self-describing Markdown document", () => {
    const document = build();
    expect(document.markdown).toBe(
      [
        "# Reset your password",
        "",
        "**Article:** KB0010001 · **Knowledge base:** IT Help · **Category:** Accounts & Access · **Audience:** Employees (IT Service Management)",
        "",
        "**Keywords:** password, reset",
        "",
        "_Last updated: 2026-11-01_",
        "",
        `Go to [reset](${BASE}/reset).`,
        "",
        "---",
        "",
        `Source: [KB0010001](${BASE}/sp?id=kb_article_view&sysparm_article=KB0010001)`,
        "",
      ].join("\n"),
    );
    expect(document.originUri).toBe(`${BASE}/sp?id=kb_article_view&sysparm_article=KB0010001`);
    expect(document.tags).toEqual(["servicenow", "itsm", "it-help", "accounts-access"]);
    expect(document.contentMd5).toBe(createHash("md5").update(document.bytes).digest("base64"));
    expect(document).toMatchObject({ isEmpty: false, tooLarge: false });
  });

  it("ignores the updated date when deciding whether content changed", () => {
    expect(build({ updatedAt: "2026-11-02 08:00:00" }).contentHash).toBe(build().contentHash);
    expect(build({ html: "<p>Different</p>" }).contentHash).not.toBe(build().contentHash);
    expect(build({ title: "New title" }).contentHash).not.toBe(build().contentHash);
  });

  it("falls back to wiki text and flags empty or oversized articles", () => {
    expect(build({ html: "", plainText: "Wiki body" }).markdown).toContain("Wiki body");
    expect(build({ html: "  ", plainText: "" }).isEmpty).toBe(true);
    expect(build({ html: "", plainText: "a".repeat(MAX_DOCUMENT_BYTES + 1) }).tooLarge).toBe(true);
  });

  it("omits facts it doesn't have", () => {
    const markdown = build({ kbName: "", category: "", keywords: "", updatedAt: "", number: "" }).markdown;
    expect(markdown).not.toMatch(/Knowledge base:|Category:|Keywords:|Last updated/);
    expect(markdown).toContain("Source: [Reset your password](");
  });
});

function summary(id: string, number: string, updatedAt = "2026-11-01 10:00:00", title = `Article ${number}`): ArticleSummary {
  return { id, number, title, updatedAt, kbId: "kb1", kbName: "IT Help", category: "" };
}

function entry(articleId: string, fileName: string, overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return { articleId, fileName, snUpdatedAt: "2026-11-01 10:00:00", contentHash: "h", state: "synced", ...overrides };
}

describe("planSync", () => {
  it("rebuilds everything in number order with unique names", () => {
    const plan = planSync({
      articles: [summary("b", "KB10"), summary("a", "KB2"), summary("c", "KB2", undefined, "Article KB2")],
      manifest: [entry("a", "old.md")],
      mode: "full",
      configChanged: false,
    });
    expect(plan.uploads.map((upload) => [upload.articleId, upload.fileName, upload.reason])).toEqual([
      ["a", "KB2_Article-KB2.md", "full"],
      ["c", "KB2_Article-KB2_2.md", "full"],
      ["b", "KB10_Article-KB10.md", "full"],
    ]);
    expect(plan.deletions).toEqual([]);
  });

  it("uploads only what changed and gives each a reason", () => {
    const plan = planSync({
      articles: [
        summary("new", "KB1"),
        summary("changed", "KB2", "2026-11-05 09:00:00"),
        summary("same", "KB3"),
        summary("failed", "KB4"),
        summary("skipped", "KB5"),
        summary("returning", "KB6"),
      ],
      manifest: [
        entry("changed", "KB2_x.md"),
        entry("same", "KB3_x.md"),
        entry("failed", "KB4_x.md", { state: "error" }),
        entry("skipped", "KB5_x.md", { state: "skipped" }),
        entry("returning", "KB6_x.md", { state: "pending_delete" }),
        entry("gone", "KB7_x.md"),
        entry("gone-again", "KB8_x.md", { state: "pending_delete" }),
      ],
      mode: "incremental",
      configChanged: false,
    });
    expect(plan.uploads.map((upload) => [upload.articleId, upload.reason])).toEqual([
      ["new", "new"],
      ["changed", "changed"],
      ["failed", "retry"],
      ["returning", "retry"],
    ]);
    expect(plan.unchanged).toBe(2);
    expect(plan.deletions).toEqual([
      { articleId: "gone", fileName: "KB7_x.md", reason: "removed" },
      { articleId: "gone-again", fileName: "KB8_x.md", reason: "retry" },
    ]);
  });

  it("keeps existing file names even when titles change", () => {
    const plan = planSync({
      articles: [summary("a", "KB1", "2026-11-05 09:00:00", "Renamed article")],
      manifest: [entry("a", "KB1_Original-title.md")],
      mode: "incremental",
      configChanged: false,
    });
    expect(plan.uploads[0]).toMatchObject({ fileName: "KB1_Original-title.md", reason: "changed" });
  });

  it("re-uploads everything once when settings change", () => {
    const plan = planSync({ articles: [summary("a", "KB1")], manifest: [entry("a", "KB1_x.md")], mode: "incremental", configChanged: true });
    expect(plan.uploads.map((upload) => upload.reason)).toEqual(["config"]);
  });

  it("avoids clashing with names already in the source and dedupes input", () => {
    const plan = planSync({
      articles: [summary("new", "KB1"), summary("new", "KB1")],
      manifest: [entry("old", "KB1_Article-KB1.md")],
      mode: "incremental",
      configChanged: false,
    });
    expect(plan.uploads).toHaveLength(1);
    expect(plan.uploads[0]!.fileName).toBe("KB1_Article-KB1_2.md");
  });
});

describe("fingerprints", () => {
  const config = { instanceUrl: BASE, audience: "csm" as const, linkStyle: "sp" as const, linkCustom: "" };

  it("changes when documents would change", () => {
    const hash = computeConfigHash(config);
    expect(hash).toHaveLength(32);
    expect(computeConfigHash({ ...config, linkCustom: "ignored unless custom" })).toBe(hash);
    expect(computeConfigHash({ ...config, linkStyle: "custom", linkCustom: "help" })).not.toBe(hash);
    expect(computeConfigHash({ ...config, audience: "itsm" })).not.toBe(hash);
  });

  it("ignores order but notices edits, additions and removals", () => {
    const a = { id: "a", updatedAt: "1" };
    const b = { id: "b", updatedAt: "1" };
    const base = computeFingerprint([a, b], "cfg");
    expect(computeFingerprint([b, a], "cfg")).toBe(base);
    expect(computeFingerprint([a, { ...b, updatedAt: "2" }], "cfg")).not.toBe(base);
    expect(computeFingerprint([a], "cfg")).not.toBe(base);
    expect(computeFingerprint([a, b, { id: "c", updatedAt: "1" }], "cfg")).not.toBe(base);
    expect(computeFingerprint([a, b], "other")).not.toBe(base);
  });
});
