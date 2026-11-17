import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type FakeHandler, json } from "./fetch-router";

export const KNOWLEDGE_PERMISSIONS = [
  "knowledge:source:view",
  "knowledge:source:add",
  "knowledge:sourceFileCount:view",
  "knowledge:synchronization:add",
  "knowledge:synchronization:view",
  "knowledge:synchronization:edit",
  "knowledge:synchronization:upload",
  "knowledge:synchronization:deleteFile",
] as const;

export interface FakeGcFile {
  fileName: string;
  text: string;
  contentType: string;
  md5: string;
  metadata: { originUri?: string; tags?: Array<{ name: string }> };
}

export interface FakeRound {
  id: string;
  sourceId: string;
  type: "Incremental" | "Full";
  status: string;
  ingestionStatus: string;
  dateStart: string;
  uploads: Map<string, FakeGcFile>;
  deletions: Set<string>;
  queuedPolls: number;
  pollsAfterCompletion: number;
  completionRequests: number;
  statistics: { synchronizedItemCount: number; failedItemCount: number } | null;
}

export interface FakeSource {
  id: string;
  name: string;
  type: string;
  status: string;
  files: Map<string, FakeGcFile>;
}

interface Principal {
  kind: "client" | "user";
  id: string;
  orgId: string;
  permissions: Set<string>;
}

interface InjectedFailure {
  method?: string;
  path: RegExp;
  times: number;
  status: number;
  body: unknown;
  network?: boolean;
  /** Process the request normally, then drop the connection (the caller never sees the response). */
  afterHandling?: boolean;
}

interface PendingTicket {
  roundId: string;
  fileName: string;
  contentLength: number;
  contentMd5: string;
  contentType: string;
  metadata: FakeGcFile["metadata"];
  signature: string;
}

const OPEN = new Set(["InQueue", "InProgress", "Throttled", "PostProcessing"]);
const FILE_NAME_DISALLOWED = /[\\{^}%`\]">[~<#|\s]/;

function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

/**
 * Genesys Cloud as far as this app is concerned: OAuth (client credentials + PKCE),
 * users/me, organizations/me and the Knowledge Fabric V3 File Upload synchronization API.
 */
export class FakeGenesys {
  readonly region = "mypurecloud.de";
  readonly loginHost = "login.mypurecloud.de";
  readonly apiHost = "api.mypurecloud.de";
  readonly s3Host = "fake-s3.genesys.test";
  readonly orgId: string;
  readonly orgName: string;

  readonly clients = new Map<string, { secret: string; orgId: string; permissions: Set<string> }>();
  readonly users = new Map<string, { id: string; name: string; orgId: string; permissions: Set<string> }>();
  readonly sources = new Map<string, FakeSource>();
  readonly rounds = new Map<string, FakeRound>();
  readonly calls: Array<{ method: string; path: string; body: unknown }> = [];

  /** How a round ends after PATCH Completed. */
  completion = { status: "Completed", ingestion: "Complete", polls: 0, failedItems: 0 };
  /** New rounds stay InQueue for this many status reads. */
  queuedPolls = 0;
  /** This many PATCH Completed requests are acknowledged but have no effect. */
  ignoreCompletions = 0;
  /** Upload tickets for file names containing a key are rejected with the given status. */
  readonly rejectUploads = new Map<string, { status: number; message: string }>();
  /** Every access token and pre-signed upload signature handed out, for "never logged" assertions. */
  readonly issuedSecrets: string[] = [];

  private readonly tokens = new Map<string, Principal>();
  private readonly codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; userId: string }>();
  private readonly tickets = new Map<string, PendingTicket>();
  private readonly failures: InjectedFailure[] = [];
  private clock = 0;

  constructor(options: { orgId?: string; orgName?: string } = {}) {
    this.orgId = options.orgId ?? "8f1c2e4a-0b7d-4f6e-9a31-2c5d7e9f1a3b";
    this.orgName = options.orgName ?? "Acme Corp";
  }

  addClient(clientId: string, secret: string, options: { orgId?: string; permissions?: readonly string[] } = {}): void {
    this.clients.set(clientId, { secret, orgId: options.orgId ?? this.orgId, permissions: new Set(options.permissions ?? KNOWLEDGE_PERMISSIONS) });
  }

  addUser(id: string, name: string, permissions: readonly string[] = ["knowledge:source:view"]): void {
    this.users.set(id, { id, name, orgId: this.orgId, permissions: new Set(permissions) });
  }

  addSource(name: string, type = "FileUpload"): FakeSource {
    const source: FakeSource = { id: randomUUID(), name, type, status: "Active", files: new Map() };
    this.sources.set(source.id, source);
    return source;
  }

  /** Simulates the user finishing the hosted login page: returns the code GC would redirect with. */
  issueAuthorizationCode(params: { clientId: string; challenge: string; redirectUri: string; userId: string }): string {
    const code = `code-${randomBytes(8).toString("hex")}`;
    this.codes.set(code, params);
    return code;
  }

  /** Opens a round as if another tool (or a crashed run) had started it. */
  openRound(sourceId: string, type: "Incremental" | "Full" = "Incremental"): FakeRound {
    return this.createRound(sourceId, type);
  }

  fail(path: RegExp, status: number, options: { method?: string; times?: number; body?: unknown; network?: boolean; afterHandling?: boolean } = {}): void {
    this.failures.push({
      method: options.method,
      path,
      times: options.times ?? 1,
      status,
      body: options.body ?? { message: "Injected failure", code: "injected", status },
      network: options.network,
      afterHandling: options.afterHandling,
    });
  }

  revokeTokens(): void {
    this.tokens.clear();
  }

  roundsFor(sourceId: string): FakeRound[] {
    return [...this.rounds.values()].filter((round) => round.sourceId === sourceId);
  }

  callsTo(method: string, path: RegExp): number {
    return this.calls.filter((call) => call.method === method && path.test(call.path)).length;
  }

  /* ------------------------------ handlers ------------------------------ */

  readonly handleLogin: FakeHandler = async (request, url) => {
    this.calls.push({ method: request.method, path: url.pathname, body: null });
    if (url.pathname !== "/oauth/token" || request.method !== "POST") return json({ error: "not_found" }, 404);
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") === "client_credentials") {
      const basic = request.headers.get("authorization")?.match(/^Basic (.+)$/)?.[1];
      const [clientId, secret] = basic ? Buffer.from(basic, "base64").toString("utf8").split(":") : [];
      const client = clientId ? this.clients.get(clientId) : undefined;
      if (!client || client.secret !== secret) return json({ error: "invalid_client", description: "client not found" }, 401);
      return json(this.issueToken({ kind: "client", id: clientId!, orgId: client.orgId, permissions: client.permissions }));
    }
    if (form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!code || code.clientId !== form.get("client_id") || code.redirectUri !== form.get("redirect_uri") || code.challenge !== challenge) {
        return json({ error: "invalid_grant", description: "authorization code invalid" }, 400);
      }
      this.codes.delete(form.get("code") ?? "");
      const user = this.users.get(code.userId)!;
      return json(this.issueToken({ kind: "user", id: user.id, orgId: user.orgId, permissions: user.permissions }));
    }
    return json({ error: "unsupported_grant_type" }, 400);
  };

  readonly handleApi: FakeHandler = async (request, url) => {
    const bodyText = request.method === "GET" ? "" : await request.text();
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
    this.calls.push({ method: request.method, path: url.pathname, body });

    const failure = this.failures.find((candidate) => candidate.times > 0 && candidate.path.test(url.pathname) && (!candidate.method || candidate.method === request.method));
    if (failure) {
      failure.times -= 1;
      if (failure.afterHandling) {
        this.route(request, url, body);
        throw new TypeError("fetch failed (connection dropped after the request was processed)");
      }
      if (failure.network) throw new TypeError("fetch failed (injected network error)");
      return json(failure.body, failure.status);
    }
    return this.route(request, url, body);
  };

  private route(request: Request, url: URL, body: Record<string, unknown> | null): Response {
    const principal = this.tokens.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (!principal) return json({ message: "Invalid login credentials.", code: "bad.credentials", status: 401 }, 401);

    const path = url.pathname;
    if (path === "/api/v2/users/me" && request.method === "GET") {
      const user = this.users.get(principal.id);
      return user ? this.ok({ id: user.id, name: user.name }) : json({ message: "This request requires a user context.", code: "bad.request" }, 400);
    }
    if (path === "/api/v2/organizations/me" && request.method === "GET") {
      return this.ok({ id: principal.orgId, name: principal.orgId === this.orgId ? this.orgName : "Other Org" });
    }
    if (path === "/api/v2/knowledge/sources") {
      if (request.method === "GET") {
        return this.guard(principal, "knowledge:source:view", () => this.ok({ entities: [...this.sources.values()].map((source) => this.serializeSource(source)), pageSize: 25 }));
      }
      if (request.method === "POST") {
        return this.guard(principal, "knowledge:source:add", () => {
          const source = this.addSource(String(body?.name ?? ""), String(body?.type ?? "FileUpload"));
          return this.ok(this.serializeSource(source));
        });
      }
    }
    if (path === "/api/v2/knowledge/sources/files/counts" && request.method === "POST") {
      return this.guard(principal, "knowledge:sourceFileCount:view", () =>
        this.ok({
          entities: ((body?.sourceIds as string[] | undefined) ?? []).map((id) => ({ source: { id }, totalFileCount: this.sources.get(id)?.files.size ?? 0 })),
        }),
      );
    }

    const sourceMatch = path.match(/^\/api\/v2\/knowledge\/sources\/([^/]+)(?:\/synchronizations(?:\/([^/]+)(?:\/(uploads|deletions))?)?)?$/);
    if (!sourceMatch) return json({ message: "Not found", code: "not.found", status: 404 }, 404);
    const [, sourceId, roundId, action] = sourceMatch as unknown as [string, string, string | undefined, string | undefined];
    const source = this.sources.get(decodeURIComponent(sourceId));
    const isSyncPath = path.includes("/synchronizations");

    if (!isSyncPath) {
      return this.guard(principal, "knowledge:source:view", () =>
        source && source.status !== "Deleted" ? this.ok(this.serializeSource(source)) : json({ message: "Source not found", code: "not.found", status: 404 }, 404),
      );
    }
    if (!source) return json({ message: "Source not found", code: "not.found", status: 404 }, 404);

    if (!roundId) {
      if (request.method === "POST") {
        return this.guard(principal, "knowledge:synchronization:add", () => {
          if (this.roundsFor(source.id).some((round) => OPEN.has(round.status))) {
            return json({ message: "A synchronization is already in progress for this source.", code: "conflict", status: 409 }, 409);
          }
          return this.ok(this.serializeRound(this.createRound(source.id, body?.type === "Full" ? "Full" : "Incremental")));
        });
      }
      return this.guard(principal, "knowledge:synchronization:view", () => {
        const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
        const entities = this.roundsFor(source.id)
          .sort((a, b) => b.dateStart.localeCompare(a.dateStart))
          .slice(0, pageSize)
          .map((round) => this.serializeRound(round));
        return this.ok({ entities });
      });
    }

    const round = this.rounds.get(decodeURIComponent(roundId));
    if (!round || round.sourceId !== source.id) return json({ message: "Synchronization not found", code: "not.found", status: 404 }, 404);

    if (action === "uploads") return this.guard(principal, "knowledge:synchronization:upload", () => this.uploadTicket(round, body ?? {}));
    if (action === "deletions") return this.guard(principal, "knowledge:synchronization:deleteFile", () => this.markDeletion(round, source, body ?? {}));
    if (request.method === "PATCH") return this.guard(principal, "knowledge:synchronization:edit", () => this.patchRound(round, source, String(body?.status ?? "")));
    return this.guard(principal, "knowledge:synchronization:view", () => this.ok(this.serializeRound(this.advance(round))));
  }

  readonly handleS3: FakeHandler = async (request, url) => {
    this.calls.push({ method: request.method, path: url.pathname, body: null });
    const ticket = this.tickets.get(url.pathname);
    if (request.method !== "PUT" || !ticket || url.searchParams.get("X-Amz-Signature") !== ticket.signature) {
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403, headers: { "content-type": "application/xml" } });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== ticket.contentLength || md5(bytes) !== request.headers.get("content-md5") || md5(bytes) !== ticket.contentMd5) {
      return new Response("<Error><Code>BadDigest</Code></Error>", { status: 400, headers: { "content-type": "application/xml" } });
    }
    const round = this.rounds.get(ticket.roundId);
    if (!round || round.status !== "InProgress") {
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403, headers: { "content-type": "application/xml" } });
    }
    round.uploads.set(ticket.fileName, {
      fileName: ticket.fileName,
      text: new TextDecoder().decode(bytes),
      contentType: ticket.contentType,
      md5: ticket.contentMd5,
      metadata: ticket.metadata,
    });
    return new Response(null, { status: 200 });
  };

  /* ------------------------------ internals ----------------------------- */

  private issueToken(principal: Principal): { access_token: string; token_type: string; expires_in: number } {
    const token = `gc-token-${randomBytes(12).toString("hex")}`;
    this.tokens.set(token, principal);
    this.issuedSecrets.push(token);
    return { access_token: token, token_type: "bearer", expires_in: 86_399 };
  }

  private ok(data: unknown): Response {
    return json(data, 200, { "inin-correlation-id": randomUUID() });
  }

  private guard(principal: Principal, permission: string, action: () => Response): Response {
    if (!principal.permissions.has(permission)) {
      return json(
        { message: `Unable to perform the requested action. You are missing the following permission(s): ${permission}`, code: "missing.permissions", status: 403 },
        403,
      );
    }
    return action();
  }

  private createRound(sourceId: string, type: "Incremental" | "Full"): FakeRound {
    this.clock = Math.max(Date.now(), this.clock + 1);
    const round: FakeRound = {
      id: randomUUID(),
      sourceId,
      type,
      status: this.queuedPolls > 0 ? "InQueue" : "InProgress",
      ingestionStatus: "Unknown",
      dateStart: new Date(this.clock).toISOString(),
      uploads: new Map(),
      deletions: new Set(),
      queuedPolls: this.queuedPolls,
      pollsAfterCompletion: 0,
      completionRequests: 0,
      statistics: null,
    };
    this.rounds.set(round.id, round);
    return round;
  }

  private advance(round: FakeRound): FakeRound {
    if (round.status === "InQueue" && --round.queuedPolls <= 0) round.status = "InProgress";
    if (round.status === "PostProcessing" && ++round.pollsAfterCompletion > this.completion.polls) this.finish(round);
    return round;
  }

  private finish(round: FakeRound): void {
    const source = this.sources.get(round.sourceId)!;
    round.status = this.completion.status;
    round.ingestionStatus = this.completion.status === "Completed" ? this.completion.ingestion : "Unknown";
    if (round.status === "Completed") {
      if (round.type === "Full") source.files = new Map(round.uploads);
      else {
        for (const [name, file] of round.uploads) source.files.set(name, file);
        for (const name of round.deletions) source.files.delete(name);
      }
    }
    round.statistics = { synchronizedItemCount: round.uploads.size + round.deletions.size - this.completion.failedItems, failedItemCount: this.completion.failedItems };
  }

  private patchRound(round: FakeRound, source: FakeSource, status: string): Response {
    if (status === "Completed") {
      round.completionRequests += 1;
      if (this.ignoreCompletions > 0) {
        this.ignoreCompletions -= 1;
        return this.ok(this.serializeRound(round));
      }
      if (round.status === "InProgress") {
        round.status = "PostProcessing";
        if (this.completion.polls === 0) this.finish(round);
      }
      return this.ok(this.serializeRound(round));
    }
    if (status === "Cancelled") {
      if (OPEN.has(round.status)) {
        round.status = "Cancelled";
        round.uploads.clear();
        round.deletions.clear();
      }
      void source;
      return this.ok(this.serializeRound(round));
    }
    return json({ message: `Invalid status ${status}`, code: "bad.request", status: 400 }, 400);
  }

  private uploadTicket(round: FakeRound, body: Record<string, unknown>): Response {
    const fileName = String(body.fileName ?? "");
    if (round.status !== "InProgress") return json({ message: "The synchronization is not in progress.", code: "bad.request", status: 400 }, 400);
    if (!fileName || fileName.startsWith(".") || FILE_NAME_DISALLOWED.test(fileName)) {
      return json({ message: `Invalid file name: ${fileName}`, code: "bad.request", status: 400 }, 400);
    }
    for (const [key, rejection] of this.rejectUploads) {
      if (fileName.includes(key)) return json({ message: rejection.message, code: "bad.request", status: rejection.status }, rejection.status);
    }
    const path = `/${round.id}/${encodeURIComponent(fileName)}`;
    const ticket: PendingTicket = {
      roundId: round.id,
      fileName,
      contentLength: Number(body.contentLength),
      contentMd5: String(body.contentMd5 ?? ""),
      contentType: String(body.contentType ?? ""),
      metadata: (body.metadata as FakeGcFile["metadata"]) ?? {},
      signature: `sig${randomBytes(16).toString("hex")}`,
    };
    this.tickets.set(path, ticket);
    this.issuedSecrets.push(ticket.signature);
    return this.ok({
      fileId: randomUUID(),
      fileName,
      url: `https://${this.s3Host}${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=fake-credential&X-Amz-Signature=${ticket.signature}`,
      headers: { "Content-Type": ticket.contentType, "Content-MD5": ticket.contentMd5, "x-amz-server-side-encryption": ["AES256"] },
      metadata: ticket.metadata,
    });
  }

  private markDeletion(round: FakeRound, source: FakeSource, body: Record<string, unknown>): Response {
    const fileName = String(body.fileName ?? "");
    if (round.status !== "InProgress") return json({ message: "The synchronization is not in progress.", code: "bad.request", status: 400 }, 400);
    if (!source.files.has(fileName)) return json({ message: "File not found", code: "not.found", status: 404 }, 404);
    round.deletions.add(fileName);
    return this.ok({ fileName });
  }

  private serializeSource(source: FakeSource) {
    const last = this.roundsFor(source.id).sort((a, b) => b.dateStart.localeCompare(a.dateStart))[0];
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      status: source.status,
      dateModified: new Date(this.clock).toISOString(),
      ...(last ? { lastSync: this.serializeRound(last) } : {}),
    };
  }

  private serializeRound(round: FakeRound) {
    return {
      id: round.id,
      type: round.type,
      status: round.status,
      ingestionStatus: round.ingestionStatus,
      dateStart: round.dateStart,
      ...(round.statistics ? { statistics: round.statistics } : {}),
    };
  }
}
