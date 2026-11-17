import { randomBytes } from "node:crypto";
import { type FakeHandler, json } from "./fetch-router";

export type FakeSnAuth =
  | { type: "basic"; username: string; password: string }
  | { type: "oauth"; clientId: string; clientSecret: string }
  | { type: "apikey"; apiKey: string };

export interface FakeKb {
  sys_id: string;
  title: string;
  description: string;
  portals: string[];
  active: boolean;
}

export interface FakeArticle {
  sys_id: string;
  number: string;
  short_description: string;
  text: string;
  wiki: string;
  /** OOTB value is "text" (HTML in `text`); "wiki" articles keep markup in `wiki`. */
  article_type: "text" | "html" | "wiki";
  meta: string;
  kb: string;
  category: string;
  sys_updated_on: string;
  workflow_state: string;
  active: boolean;
  valid_to: string;
  /** What the Knowledge Management API renders (templates, wiki). Defaults to `text`. */
  rendered?: string;
}

interface InjectedFailure {
  path: RegExp;
  times: number;
  when?: (url: URL) => boolean;
  respond: () => Response;
}

type Predicate = (record: Record<string, string>) => boolean;

export function sysId(): string {
  return randomBytes(16).toString("hex");
}

function stamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * A small but faithful ServiceNow: Table API with encoded queries, pagination and
 * X-Total-Count, the Aggregate API, the Knowledge Management API and the OAuth endpoint.
 */
export class FakeServiceNow {
  readonly host: string;
  readonly instanceUrl: string;
  auth: FakeSnAuth;
  readonly kbs = new Map<string, FakeKb>();
  readonly articles = new Map<string, FakeArticle>();
  kmApiEnabled = true;
  statsEnabled = true;
  portalsEnabled = true;
  hibernating = false;
  /**
   * Reference fields come back as {link, value} unless sysparm_exclude_reference_link=true, which
   * usually flattens them to the sys_id. "wrapped" keeps a {value} object even then, as some
   * instances do.
   */
  referenceStyle: "plain" | "wrapped" = "plain";
  readonly calls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  private readonly failures: InjectedFailure[] = [];
  private readonly tokens = new Set<string>();
  /** Every OAuth access token handed out, for "never logged" assertions. */
  readonly issuedSecrets: string[] = [];
  private articleCounter = 10_000;
  private clock = Date.parse("2026-10-01T08:00:00Z");

  constructor(options: { host?: string; auth?: FakeSnAuth } = {}) {
    this.host = options.host ?? "acme.service-now.com";
    this.instanceUrl = `https://${this.host}`;
    this.auth = options.auth ?? { type: "basic", username: "kf.integration", password: "fake-sn-password-1" };
  }

  addKb(partial: Partial<FakeKb> & { title: string }): FakeKb {
    const kb: FakeKb = { sys_id: sysId(), description: "", portals: [], active: true, ...partial };
    this.kbs.set(kb.sys_id, kb);
    return kb;
  }

  addArticle(kb: FakeKb, partial: Partial<FakeArticle> = {}): FakeArticle {
    this.articleCounter += 1;
    this.clock += 60_000;
    const article: FakeArticle = {
      sys_id: sysId(),
      number: `KB00${this.articleCounter}`,
      short_description: `Article ${this.articleCounter}`,
      text: `<p>Body of article ${this.articleCounter}.</p>`,
      wiki: "",
      article_type: "text",
      meta: "",
      kb: kb.sys_id,
      category: "General",
      sys_updated_on: stamp(new Date(this.clock)),
      workflow_state: "published",
      active: true,
      valid_to: "",
      ...partial,
    };
    this.articles.set(article.sys_id, article);
    return article;
  }

  addArticles(kb: FakeKb, count: number, partial: Partial<FakeArticle> = {}): FakeArticle[] {
    return Array.from({ length: count }, () => this.addArticle(kb, partial));
  }

  /** Edits an article the way an author would: content changes and sys_updated_on moves. */
  updateArticle(id: string, patch: Partial<FakeArticle>): FakeArticle {
    const article = this.articles.get(id);
    if (!article) throw new Error(`unknown article ${id}`);
    this.clock += 60_000;
    Object.assign(article, patch, { sys_updated_on: patch.sys_updated_on ?? stamp(new Date(this.clock)) });
    return article;
  }

  /** Inject a failure for requests whose path matches (and `when`, if given), `times` times. */
  fail(
    path: RegExp,
    response: { status: number; body?: unknown; contentType?: string; headers?: Record<string, string> },
    times = 1,
    when?: (url: URL) => boolean,
  ): void {
    this.failures.push({
      path,
      times,
      when,
      respond: () =>
        response.contentType && !response.contentType.includes("json")
          ? new Response(String(response.body ?? ""), { status: response.status, headers: { "content-type": response.contentType, ...response.headers } })
          : json(response.body ?? { error: { message: "Injected failure", detail: null }, status: "failure" }, response.status, response.headers),
    });
  }

  revokeTokens(): void {
    this.tokens.clear();
  }

  callsTo(path: string | RegExp): number {
    return this.calls.filter((call) => (typeof path === "string" ? call.path === path : path.test(call.path))).length;
  }

  readonly handle: FakeHandler = async (request, url) => {
    this.calls.push({ method: request.method, path: url.pathname, query: url.searchParams });
    const failure = this.failures.find((candidate) => candidate.times > 0 && candidate.path.test(url.pathname) && (!candidate.when || candidate.when(url)));
    if (failure) {
      failure.times -= 1;
      return failure.respond();
    }
    if (this.hibernating) {
      return new Response("<html><body>Your instance is hibernating</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/oauth_token.do" && request.method === "POST") return this.issueToken(await request.text());
    if (!this.authorized(request.headers)) {
      return json({ error: { message: "User Not Authenticated", detail: "Required to provide Auth information" }, status: "failure" }, 401);
    }
    if (request.method !== "GET") return json({ error: { message: "Method not allowed" } }, 405);

    try {
      if (url.pathname === "/api/now/table/kb_knowledge_base") return this.table(this.kbRecords(), url.searchParams);
      if (url.pathname === "/api/now/table/kb_knowledge") return this.table(this.articleRecords(), url.searchParams);
      if (url.pathname === "/api/now/stats/kb_knowledge") return this.stats(url.searchParams);
      if (url.pathname === "/api/now/table/m2m_sp_portal_knowledge_base") return this.portals(url.searchParams);
      const km = url.pathname.match(/^\/api\/sn_km_api\/knowledge\/articles\/([0-9a-f]{32})$/);
      if (km?.[1]) return this.render(km[1]);
    } catch (error) {
      return json({ error: { message: (error as Error).message, detail: null }, status: "failure" }, 400);
    }
    return json({ error: { message: "Requested URI does not represent any resource" }, status: "failure" }, 400);
  };

  private authorized(headers: Headers): boolean {
    const auth = this.auth;
    if (auth.type === "basic") {
      const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
      return headers.get("authorization") === expected;
    }
    if (auth.type === "apikey") return headers.get("x-sn-apikey") === auth.apiKey;
    const bearer = headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    return Boolean(bearer && this.tokens.has(bearer));
  }

  private issueToken(body: string): Response {
    const form = new URLSearchParams(body);
    const auth = this.auth;
    if (
      auth.type !== "oauth" ||
      form.get("grant_type") !== "client_credentials" ||
      form.get("client_id") !== auth.clientId ||
      form.get("client_secret") !== auth.clientSecret
    ) {
      return json({ error_description: "access_denied", error: "server_error" }, 401);
    }
    const token = `sn-token-${randomBytes(8).toString("hex")}`;
    this.tokens.add(token);
    this.issuedSecrets.push(token);
    return json({ access_token: token, token_type: "Bearer", expires_in: 1799, scope: "useraccount" });
  }

  private kbRecords(): Array<Record<string, string>> {
    return [...this.kbs.values()].map((kb) => ({
      sys_id: kb.sys_id,
      title: kb.title,
      description: kb.description,
      active: String(kb.active),
    }));
  }

  private articleRecords(): Array<Record<string, string>> {
    return [...this.articles.values()].map((article) => ({
      sys_id: article.sys_id,
      number: article.number,
      short_description: article.short_description,
      text: article.text,
      wiki: article.wiki,
      article_type: article.article_type,
      meta: article.meta,
      sys_updated_on: article.sys_updated_on,
      kb_knowledge_base: article.kb,
      "kb_knowledge_base.title": this.kbs.get(article.kb)?.title ?? "",
      "kb_category.label": article.category,
      workflow_state: article.workflow_state,
      active: String(article.active),
      valid_to: article.valid_to,
    }));
  }

  private table(records: Array<Record<string, string>>, params: URLSearchParams): Response {
    const { predicate, order } = this.parseQuery(params.get("sysparm_query") ?? "");
    let rows = records.filter(predicate);
    if (order) {
      rows = [...rows].sort((a, b) => (a[order.field] ?? "").localeCompare(b[order.field] ?? "") * (order.desc ? -1 : 1));
    }
    const total = rows.length;
    const offset = Number(params.get("sysparm_offset") ?? 0);
    const limit = Number(params.get("sysparm_limit") ?? 10_000);
    const fields = params.get("sysparm_fields")?.split(",").filter(Boolean);
    const page = rows
      .slice(offset, offset + limit)
      .map((row) => this.withReferences(fields ? Object.fromEntries(fields.map((field) => [field, row[field] ?? ""])) : row, params));
    const headers: Record<string, string> = params.get("sysparm_no_count") === "true" ? {} : { "X-Total-Count": String(total) };
    return json({ result: page }, 200, headers);
  }

  private withReferences(row: Record<string, string>, params: URLSearchParams): Record<string, unknown> {
    const excludeLinks = params.get("sysparm_exclude_reference_link") === "true";
    if (excludeLinks && this.referenceStyle === "plain") return row;
    const output: Record<string, unknown> = { ...row };
    for (const field of ["kb_knowledge_base"]) {
      const value = row[field];
      if (value === undefined) continue;
      output[field] = excludeLinks ? { value } : { link: `${this.instanceUrl}/api/now/table/kb_knowledge_base/${value}`, value };
    }
    return output;
  }

  private stats(params: URLSearchParams): Response {
    if (!this.statsEnabled) return json({ error: { message: "Insufficient rights to query aggregate" } }, 403);
    const { predicate } = this.parseQuery(params.get("sysparm_query") ?? "");
    const counts = new Map<string, number>();
    for (const record of this.articleRecords().filter(predicate)) {
      counts.set(record.kb_knowledge_base!, (counts.get(record.kb_knowledge_base!) ?? 0) + 1);
    }
    return json({
      result: [...counts].map(([kb, count]) => ({ stats: { count: String(count) }, groupby_fields: [{ field: "kb_knowledge_base", value: kb }] })),
    });
  }

  private portals(params: URLSearchParams): Response {
    if (!this.portalsEnabled) return json({ error: { message: "Insufficient rights" } }, 403);
    const fields = params.get("sysparm_fields")?.split(",") ?? [];
    const rows = [...this.kbs.values()].flatMap((kb) =>
      kb.portals.map((suffix) => {
        const row: Record<string, string> = { kb_knowledge_base: kb.sys_id, "sp_portal.url_suffix": suffix };
        return this.withReferences(fields.length ? Object.fromEntries(fields.map((field) => [field, row[field] ?? ""])) : row, params);
      }),
    );
    return json({ result: rows });
  }

  private render(id: string): Response {
    if (!this.kmApiEnabled) return json({ error: { message: "Requested URI does not represent any resource" } }, 404);
    const article = this.articles.get(id);
    if (!article) return json({ error: { message: "Article not found" } }, 404);
    return json({ result: { content: article.rendered ?? article.text, short_description: article.short_description } });
  }

  /** Encoded query subset: field=, field>=, fieldIN, fieldLIKE, fieldSTARTSWITH, fieldISEMPTY, OR, ORDERBY/ORDERBYDESC. */
  private parseQuery(query: string): { predicate: Predicate; order: { field: string; desc: boolean } | null } {
    const groups: Predicate[][] = [];
    let order: { field: string; desc: boolean } | null = null;
    for (const token of query.split("^").filter(Boolean)) {
      if (token.startsWith("ORDERBYDESC")) {
        order = { field: token.slice("ORDERBYDESC".length), desc: true };
        continue;
      }
      if (token.startsWith("ORDERBY")) {
        order = { field: token.slice("ORDERBY".length), desc: false };
        continue;
      }
      if (token.startsWith("OR") && groups.length > 0) {
        groups.at(-1)!.push(this.condition(token.slice(2)));
        continue;
      }
      groups.push([this.condition(token)]);
    }
    return { predicate: (record) => groups.every((group) => group.some((test) => test(record))), order };
  }

  private condition(token: string): Predicate {
    let match = token.match(/^([a-z_.]+)ISEMPTY$/);
    if (match) {
      const field = match[1]!;
      return (record) => !record[field];
    }
    match = token.match(/^([a-z_.]+)IN(.*)$/);
    if (match) {
      const [, field, list] = match as unknown as [string, string, string];
      const values = new Set(list.split(","));
      return (record) => values.has(record[field] ?? "");
    }
    match = token.match(/^([a-z_.]+)LIKE(.*)$/);
    if (match) {
      const [, field, value] = match as unknown as [string, string, string];
      return (record) => (record[field] ?? "").toLowerCase().includes(value.toLowerCase());
    }
    match = token.match(/^([a-z_.]+)STARTSWITH(.*)$/);
    if (match) {
      const [, field, value] = match as unknown as [string, string, string];
      return (record) => (record[field] ?? "").startsWith(value);
    }
    match = token.match(/^([a-z_.]+)(>=|<=|!=|=)(.*)$/);
    if (match) {
      const [, field, operator, value] = match as unknown as [string, string, string, string];
      return (record) => {
        const actual = record[field] ?? "";
        if (operator === "=") return actual === value;
        if (operator === "!=") return actual !== value;
        if (operator === ">=") return actual !== "" && actual >= value;
        return actual !== "" && actual <= value;
      };
    }
    throw new Error(`Invalid query token: ${token}`);
  }
}
