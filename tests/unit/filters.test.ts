import { describe, expect, it } from "vitest";
import {
  describeFilters,
  extractArticleRefs,
  filtersForKbs,
  filtersSchema,
  hasFilters,
  listSummary,
  noFilters,
  parseStoredFilters,
  sameFilters,
  type SyncFilters,
} from "@/lib/filters";
import { articleFilters, filterQueries } from "@/server/servicenow/knowledge";

const BILLING = "a".repeat(32);
const PAYMENTS = "b".repeat(32);
const KB = "c".repeat(32);
const OTHER_KB = "d".repeat(32);

function filters(partial: Partial<SyncFilters>): SyncFilters {
  return { ...noFilters(), ...partial };
}

function hexId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

describe("filters as ServiceNow conditions", () => {
  it("ORs values within a filter and ANDs the filters", () => {
    expect(filterQueries(noFilters())).toEqual([""]);
    expect(
      filterQueries(
        filters({
          categories: [
            { id: BILLING, label: "Billing", kbId: KB },
            { id: PAYMENTS, label: "Payments", kbId: KB },
          ],
          languages: [
            { code: "en", label: "English" },
            { code: "it", label: "Italian" },
          ],
        }),
      ),
    ).toEqual([`kb_categoryIN${BILLING},${PAYMENTS}^languageINen,it`]);
  });

  it("picks up articles without a category with or without other categories", () => {
    const none = { id: "", label: "", kbId: "" };
    expect(filterQueries(filters({ categories: [none] }))).toEqual(["kb_categoryISEMPTY"]);
    expect(filterQueries(filters({ categories: [{ id: BILLING, label: "Billing", kbId: KB }, none] }))).toEqual([`kb_categoryIN${BILLING}^ORkb_categoryISEMPTY`]);
  });

  it("drops anything that isn't an id, a language code or an article number, even when called without validation", () => {
    expect(
      filterQueries(
        filters({
          categories: [{ id: "x^NQactive=true", label: "", kbId: "" }],
          languages: [{ code: "en^ORactive=false", label: "" }],
        }),
      ),
    ).toEqual([""]);
    expect(filterQueries(filters({ articles: [{ number: "KB1^ORactive=false", title: "", kbId: "" }, { number: "KB0010001", title: "", kbId: "" }] }))).toEqual([
      "numberINKB0010001",
    ]);
  });

  it("splits long lists so no single request gets too long, keeping each article in exactly one query", () => {
    const many = Array.from({ length: 120 }, (_, index) => ({ id: hexId(index + 1), label: "", kbId: KB }));
    const queries = filterQueries(filters({ categories: [...many, { id: "", label: "", kbId: "" }], languages: [{ code: "en", label: "" }] }));
    expect(queries).toHaveLength(3);
    expect(queries.map((query) => query.split("^")[0]!.replace("kb_categoryIN", "").split(",").length)).toEqual([50, 50, 20]);
    expect(queries.filter((query) => query.includes("kb_categoryISEMPTY"))).toHaveLength(1);
    expect(queries.every((query) => query.endsWith("^languageINen") && query.length < 2000)).toBe(true);

    const chosen = Array.from({ length: 250 }, (_, index) => ({ number: `KB${String(index).padStart(7, "0")}`, title: "", kbId: KB }));
    const numberQueries = filterQueries(filters({ articles: chosen }));
    expect(numberQueries).toHaveLength(3);
    expect(numberQueries.join(",").match(/KB\d{7}/g)).toHaveLength(250);
  });

  it("matches nothing while articles are being picked but none is chosen yet", () => {
    expect(filterQueries(filters({ articles: [] }))).toEqual([]);
    expect(articleFilters(filters({ articles: [] }), "short_descriptionLIKEvpn")).toEqual([]);
  });

  it("appends the custom condition after the friendly filters", () => {
    const german = filters({ languages: [{ code: "de", label: "German" }] });
    expect(articleFilters(german, "")).toEqual(["languageINde"]);
    expect(articleFilters(german, "^short_descriptionLIKEvpn^")).toEqual(["languageINde^short_descriptionLIKEvpn"]);
    expect(articleFilters(noFilters(), " short_descriptionLIKEvpn ")).toEqual(["short_descriptionLIKEvpn"]);
  });
});

describe("filter values", () => {
  it("defaults missing lists, removes duplicates and rejects junk", () => {
    expect(filtersSchema.parse({})).toEqual(noFilters());
    expect(
      filtersSchema.parse({
        categories: [
          { id: BILLING, label: "Billing" },
          { id: BILLING, label: "Billing again" },
        ],
        languages: [{ code: "en" }, { code: "en" }],
      }),
    ).toEqual({ categories: [{ id: BILLING, label: "Billing", kbId: "" }], languages: [{ code: "en", label: "" }], articles: null });
    expect(filtersSchema.safeParse({ categories: [{ id: "Billing" }] }).success).toBe(false);
    expect(filtersSchema.safeParse({ languages: [{ code: "en it" }] }).success).toBe(false);
  });

  it("keeps chosen articles once each, by number, and rejects anything that isn't an article number", () => {
    expect(
      filtersSchema.parse({ articles: [{ number: "KB0010001", title: " Reset a password " }, { number: "kb0010001" }, { number: "KB0010002", kbId: KB }] }).articles,
    ).toEqual([
      { number: "KB0010001", title: "Reset a password", kbId: "" },
      { number: "KB0010002", title: "", kbId: KB },
    ]);
    expect(filtersSchema.parse({ articles: [{ number: "KB1", title: "x".repeat(400) }] }).articles?.[0]?.title).toHaveLength(300);
    expect(filtersSchema.safeParse({ articles: [{ number: "KB1,KB2" }] }).success).toBe(false);
    expect(filtersSchema.safeParse({ articles: Array.from({ length: 2001 }, (_, index) => ({ number: `KB${index}` })) }).success).toBe(false);
  });

  it("doesn't mix chosen articles with categories or languages", () => {
    const result = filtersSchema.safeParse({ categories: [{ id: BILLING }], articles: [{ number: "KB0010001" }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["articles"], message: "Choose articles, or narrow down by category and language, not both." });
  });

  it("reads damaged or legacy stored values as no filters", () => {
    expect(parseStoredFilters(null)).toEqual(noFilters());
    expect(parseStoredFilters({})).toEqual(noFilters());
    expect(parseStoredFilters({ categories: "nope" })).toEqual(noFilters());
    expect(parseStoredFilters({ categories: [], languages: [] })).toEqual(noFilters());
  });

  it("compares by ids, codes and article numbers only, in any order", () => {
    const a = filters({ categories: [{ id: BILLING, label: "Billing", kbId: KB }, { id: PAYMENTS, label: "Payments", kbId: KB }] });
    const b = filters({ categories: [{ id: PAYMENTS, label: "Renamed", kbId: KB }, { id: BILLING, label: "Billing", kbId: KB }] });
    expect(sameFilters(a, b)).toBe(true);
    expect(sameFilters(a, noFilters())).toBe(false);
    expect(hasFilters(a)).toBe(true);
    expect(hasFilters(noFilters())).toBe(false);

    const picked = filters({ articles: [{ number: "KB0010001", title: "A", kbId: KB }, { number: "KB0010002", title: "B", kbId: KB }] });
    expect(sameFilters(picked, filters({ articles: [{ number: "kb0010002", title: "", kbId: "" }, { number: "KB0010001", title: "Renamed", kbId: KB }] }))).toBe(true);
    expect(sameFilters(picked, filters({ articles: [{ number: "KB0010001", title: "A", kbId: KB }] }))).toBe(false);
    expect(sameFilters(filters({ articles: [] }), noFilters())).toBe(false);
    expect(hasFilters(filters({ articles: [] }))).toBe(true);
  });

  it("summarizes filters in plain words", () => {
    expect(describeFilters(noFilters())).toBeNull();
    expect(
      describeFilters(
        filters({
          categories: [
            { id: BILLING, label: "Billing", kbId: KB },
            { id: "", label: "", kbId: "" },
          ],
          languages: [{ code: "it", label: "Italian" }, { code: "pt", label: "" }],
        }),
      ),
    ).toBe("Billing, Without a category · Italian, pt");
    expect(describeFilters(filters({ articles: [{ number: "KB0010001", title: "", kbId: "" }] }))).toBe("1 chosen article");
    expect(describeFilters(filters({ articles: [] }))).toBe("0 chosen articles");
    expect(listSummary(["A", "B", "C", "D", "E"])).toBe("A, B, C +2 more");
  });

  it("drops chosen categories and articles from knowledge bases that are no longer picked", () => {
    const mixed = filters({
      categories: [
        { id: BILLING, label: "Billing", kbId: KB },
        { id: PAYMENTS, label: "Payments", kbId: OTHER_KB },
        { id: "", label: "", kbId: "" },
      ],
    });
    expect(filtersForKbs(mixed, [KB]).categories.map((category) => category.id)).toEqual([BILLING, ""]);
    expect(filtersForKbs(mixed, [KB]).articles).toBeNull();

    const picked = filters({ articles: [{ number: "KB1", title: "", kbId: KB }, { number: "KB2", title: "", kbId: OTHER_KB }, { number: "KB3", title: "", kbId: "" }] });
    expect(filtersForKbs(picked, [OTHER_KB]).articles?.map((article) => article.number)).toEqual(["KB2", "KB3"]);
  });
});

describe("article numbers in pasted text", () => {
  it("finds numbers in lists, spreadsheet columns and sentences, once each", () => {
    expect(extractArticleRefs("KB0012345\nKB0012346\r\nkb0012347")).toEqual(["KB0012345", "KB0012346", "KB0012347"]);
    expect(extractArticleRefs("KB0012345, KB0012346;KB0012345\tKB0012348")).toEqual(["KB0012345", "KB0012346", "KB0012348"]);
    expect(extractArticleRefs("Please sync KB0012345 and also KB0012346.")).toEqual(["KB0012345", "KB0012346"]);
  });

  it("reads queries copied from ServiceNow, including sys_ids", () => {
    const id = "0123456789ABCDEF0123456789abcdef";
    expect(extractArticleRefs("number=KB0012345^ORnumber=KB0012346")).toEqual(["KB0012345", "KB0012346"]);
    expect(extractArticleRefs("numberINKB0012345,KB0012346")).toEqual(["KB0012345", "KB0012346"]);
    expect(extractArticleRefs(`sys_id=${id}^ORsys_idIN${"f".repeat(32)}`)).toEqual([id.toLowerCase(), "f".repeat(32)]);
  });

  it("ignores words and short numbers", () => {
    expect(extractArticleRefs("Windows 10 and Office 365 articles")).toEqual([]);
    expect(extractArticleRefs("")).toEqual([]);
  });
});
