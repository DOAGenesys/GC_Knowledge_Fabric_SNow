import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NewSyncWizard } from "@/components/syncs/new-sync-wizard";
import { type ApiCall, errorBody, mockApi, type Route } from "./helpers/api";
import { CATEGORY, CONNECTION_ID, makeArticleOption, makeConnection, makeCredentials, makeFilterOptions, makeKb, makeRun, makeSource, makeSync } from "./helpers/fixtures";
import { renderUi } from "./helpers/render";

const ARTICLES = [
  makeArticleOption("KB0010001", { title: "Reset your password", category: "Accounts" }),
  makeArticleOption("KB0010002", { title: "Download an invoice", category: "Billing" }),
  makeArticleOption("KB0010003", { title: "Ask for a refund", category: "Billing" }),
];

type PreviewBody = { kbIds: string[]; filters: { categories: unknown[]; languages: unknown[]; articles: Array<{ number: string }> | null }; filterQuery: string };

/** Counts chosen articles, except the `unpublished` ones, which come back as missing. */
function previewRoute(unpublished: string[] = []): Route {
  return (call) => {
    const { filters } = call.body as PreviewBody;
    if (!filters.articles) return { body: { preview: { count: 120, sample: [] } } };
    const missing = filters.articles.map((article) => article.number).filter((number) => unpublished.includes(number));
    return { body: { preview: { count: filters.articles.length - missing.length, sample: [], missing } } };
  };
}

const searchRoute: Route = (call) => {
  const text = (call.query.get("q") ?? "").toLowerCase();
  if (text === "many") return { body: { articles: Array.from({ length: 20 }, (_, index) => makeArticleOption(`KB00200${String(index).padStart(2, "0")}`)), more: true } };
  return { body: { articles: ARTICLES.filter((article) => `${article.number} ${article.title}`.toLowerCase().includes(text)), more: false } };
};

const lookupRoute: Route = (call) => {
  const { refs } = call.body as { refs: string[] };
  const known = new Map(ARTICLES.map((article) => [article.number, article]));
  return { body: { found: refs.flatMap((ref) => known.get(ref) ?? []), notFound: refs.filter((ref) => !known.has(ref)) } };
};

function setup(extra: Record<string, Route> = {}) {
  const api = mockApi({
    "GET /api/connections": { body: { connections: [makeConnection()] } },
    "GET /api/genesys/credentials": { body: { credentials: makeCredentials() } },
    "GET /api/connections/:id/knowledge-bases": { body: { knowledgeBases: [makeKb(), makeKb({ id: "kb-2", title: "Billing", portals: ["csp"], articleCount: 30 })] } },
    "GET /api/connections/:id/filter-options": { body: { options: makeFilterOptions() } },
    "POST /api/connections/:id/preview": previewRoute(),
    "GET /api/connections/:id/articles": searchRoute,
    "POST /api/connections/:id/articles/lookup": lookupRoute,
    "GET /api/genesys/sources": { body: { sources: [makeSource()] } },
    "POST /api/syncs": { body: { sync: makeSync({ id: "new-sync" }), run: makeRun({ status: "queued", phase: "queued" }), runError: null } },
    ...extra,
  });
  renderUi(<NewSyncWizard />);
  return api;
}

const lastPreviewBody = (api: { callsTo: (method: string, path: string | RegExp) => ApiCall[] }) => api.callsTo("POST", /\/preview$/).at(-1)?.body as PreviewBody;
const chosenNumbers = () =>
  within(screen.getByRole("list", { name: "Chosen articles" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent?.match(/KB\d+/)?.[0]);

async function chooseArticles() {
  fireEvent.click(await screen.findByRole("checkbox", { name: /Customer Service/ }));
  fireEvent.click(await screen.findByRole("radio", { name: /Only articles I choose/ }));
}

async function paste(text: string) {
  fireEvent.click(screen.getByRole("button", { name: "Paste a list" }));
  fireEvent.change(screen.getByLabelText("Article numbers"), { target: { value: text } });
}

describe("choosing specific articles", () => {
  it("creates a sync with articles found by searching and ticking them", async () => {
    const api = setup();
    await chooseArticles();
    expect(screen.getByText("Nothing chosen yet.")).toBeTruthy();
    expect(screen.getByText("Nothing chosen yet. Tick articles in the search results, or paste a list of article numbers.")).toBeTruthy();
    expect(screen.queryByText("Narrow it down")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Choose at least one article, or switch to all published articles.")).toBeTruthy();

    const results = await screen.findByRole("list", { name: "Search results" });
    expect(within(results).getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByText("Showing the most recently updated articles. Search to find others.")).toBeTruthy();
    expect(api.callsTo("GET", `/api/connections/${CONNECTION_ID}/articles`)[0]?.query.get("kb")).toBe("kb-1");

    fireEvent.change(screen.getByLabelText("Search articles"), { target: { value: "refund" } });
    await waitFor(() => expect(within(results).getAllByRole("checkbox")).toHaveLength(1), { timeout: 3_000 });
    fireEvent.click(within(results).getByRole("checkbox", { name: /Ask for a refund/ }));
    expect(chosenNumbers()).toEqual(["KB0010003"]);
    expect(screen.queryByText("Choose at least one article, or switch to all published articles.")).toBeNull();
    expect(await screen.findByText(/published article will be synced/, undefined, { timeout: 3_000 })).toBeTruthy();
    expect(lastPreviewBody(api).filters).toEqual({ categories: [], languages: [], articles: [{ number: "KB0010003", title: "Ask for a refund", kbId: "kb-1" }] });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(screen.getByText("Summary").parentElement?.textContent).toContain("1 chosen article");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create and run" })));
    expect(await screen.findByText("Sync created")).toBeTruthy();
    expect((api.callsTo("POST", "/api/syncs")[0]?.body as { filters: unknown }).filters).toEqual({
      categories: [],
      languages: [],
      articles: [{ number: "KB0010003", title: "Ask for a refund", kbId: "kb-1" }],
    });
  });

  it("unticks articles in the search results and explains empty or long result lists", async () => {
    setup();
    await chooseArticles();
    const results = await screen.findByRole("list", { name: "Search results" });
    fireEvent.click(within(results).getByRole("checkbox", { name: /Reset your password/ }));
    expect(chosenNumbers()).toEqual(["KB0010001"]);
    fireEvent.click(within(results).getByRole("checkbox", { name: /Reset your password/ }));
    expect(screen.queryByRole("list", { name: "Chosen articles" })).toBeNull();

    const search = screen.getByLabelText("Search articles");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(await screen.findByText('Nothing matches "zzz".', undefined, { timeout: 3_000 })).toBeTruthy();
    fireEvent.change(search, { target: { value: "many" } });
    expect(await screen.findByText("Showing the first 20 matches. Type more of the title to narrow it down.", undefined, { timeout: 3_000 })).toBeTruthy();
  });

  it("shows the knowledge base of each result when several are picked", async () => {
    setup();
    await chooseArticles();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Billing/ }));
    const results = await screen.findByRole("list", { name: "Search results" });
    await waitFor(() => expect(within(results).getAllByText("Customer Service · Billing")).toHaveLength(2));
  });

  it("says when there's nothing to choose from, and recovers from search errors", async () => {
    let fail = true;
    setup({
      "GET /api/connections/:id/articles": () =>
        fail ? { status: 502, body: errorBody("SN_UNREACHABLE", "No answer.", { title: "ServiceNow is unreachable" }) } : { body: { articles: [], more: false } },
    });
    await chooseArticles();
    expect(await screen.findByText("ServiceNow is unreachable")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("There are no published articles in the chosen knowledge bases.")).toBeTruthy();
  });

  it("adds pasted article numbers, leaving the ones that weren't found in the box", async () => {
    const api = setup();
    await chooseArticles();
    await paste("KB0010001, KB0010002\nKB0019999");
    fireEvent.click(screen.getByRole("button", { name: "Add 3 articles" }));
    expect(
      await screen.findByText("Added 2 articles. 1 couldn't be found among the published articles in the chosen knowledge bases. It's left in the box so you can check it."),
    ).toBeTruthy();
    expect(api.callsTo("POST", `/api/connections/${CONNECTION_ID}/articles/lookup`)[0]?.body).toEqual({ kbIds: ["kb-1"], refs: ["KB0010001", "KB0010002", "KB0019999"] });
    expect((screen.getByLabelText("Article numbers") as HTMLTextAreaElement).value).toBe("KB0019999");
    expect(chosenNumbers()).toEqual(["KB0010001", "KB0010002"]);

    fireEvent.change(screen.getByLabelText("Article numbers"), { target: { value: "numberINKB0010001,KB0010003" } });
    fireEvent.click(screen.getByRole("button", { name: "Add 2 articles" }));
    expect(await screen.findByText("Added 1 article. 1 article was already chosen.")).toBeTruthy();
    expect(chosenNumbers()).toEqual(["KB0010001", "KB0010002", "KB0010003"]);

    fireEvent.change(screen.getByLabelText("Article numbers"), { target: { value: "KB0010002 KB0010003" } });
    fireEvent.click(screen.getByRole("button", { name: "Add 2 articles" }));
    expect(await screen.findByText("2 articles were already chosen.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Article numbers"), { target: { value: "KB0018888" } });
    fireEvent.click(screen.getByRole("button", { name: "Add 1 article" }));
    expect(await screen.findByText(/None of them could be found among the published articles/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Article numbers"), { target: { value: "please add the refund one" } });
    expect(screen.getByText("No article numbers (like KB0012345) found in the text yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add articles" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Remove KB0010002" }));
    expect(chosenNumbers()).toEqual(["KB0010001", "KB0010003"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
    expect(screen.getByText("Nothing chosen yet. Tick articles in the search results, or paste a list of article numbers.")).toBeTruthy();
  });

  it("explains when a pasted list is too long or can't be looked up", async () => {
    setup({ "POST /api/connections/:id/articles/lookup": { status: 502, body: errorBody("SN_UNREACHABLE", "ServiceNow didn't answer.") } });
    await chooseArticles();
    await paste(Array.from({ length: 2001 }, (_, index) => `KB${String(index).padStart(7, "0")}`).join("\n"));
    expect(screen.getByText(/That's more than 2,000 article numbers/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add 2,001 articles" })).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Article numbers"), { target: { value: "KB0010001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add 1 article" }));
    expect(await screen.findByText("Couldn't look up the articles. ServiceNow didn't answer.")).toBeTruthy();
  });

  it("warns about chosen articles that won't be synced and removes them on request", async () => {
    setup({ "POST /api/connections/:id/preview": previewRoute(["KB0010002"]) });
    await chooseArticles();
    await paste("KB0010001 KB0010002");
    fireEvent.click(screen.getByRole("button", { name: "Add 2 articles" }));

    expect(await screen.findByText("1 chosen article won't be synced", undefined, { timeout: 3_000 })).toBeTruthy();
    expect(screen.getByText(/KB0010002 isn't published right now, or it's in a knowledge base you didn't pick\./)).toBeTruthy();
    const row = within(screen.getByRole("list", { name: "Chosen articles" })).getByText("KB0010002").closest("li")!;
    expect(within(row).getByText("Won't sync")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(chosenNumbers()).toEqual(["KB0010001"]);
    await waitFor(() => expect(screen.queryByText("1 chosen article won't be synced")).toBeNull(), { timeout: 3_000 });
  });

  it("keeps the categories and the chosen articles when switching back and forth", async () => {
    const api = setup();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Customer Service/ }));
    const row = (await screen.findByText("Categories", { selector: "span" })).parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: "Choose" }));
    fireEvent.click(within(screen.getByRole("list", { name: "Categories" })).getByRole("checkbox", { name: /Payments/ }));

    fireEvent.click(screen.getByRole("radio", { name: /Only articles I choose/ }));
    await paste("KB0010001");
    fireEvent.click(screen.getByRole("button", { name: "Add 1 article" }));
    await screen.findByText("Added 1 article.");
    await waitFor(() => expect(lastPreviewBody(api).filters).toMatchObject({ categories: [], articles: [{ number: "KB0010001" }] }), { timeout: 3_000 });

    fireEvent.click(screen.getByRole("radio", { name: /All published articles/ }));
    expect(await screen.findByText("Narrow it down")).toBeTruthy();
    expect(screen.getByText("Billing / Payments")).toBeTruthy();
    await waitFor(() => expect(lastPreviewBody(api).filters).toMatchObject({ categories: [{ id: CATEGORY.payments }], articles: null }), { timeout: 3_000 });

    fireEvent.click(screen.getByRole("radio", { name: /Only articles I choose/ }));
    expect(chosenNumbers()).toEqual(["KB0010001"]);
  });
});
