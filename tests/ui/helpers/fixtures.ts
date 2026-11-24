import type {
  ArticleDTO,
  ArticleOptionDTO,
  ArticlePage,
  ConnectionDTO,
  FilterOptionsDTO,
  GcCredentialsDTO,
  GcSourceDTO,
  KnowledgeBaseDTO,
  RunDTO,
  SessionInfo,
  SyncDTO,
} from "@/lib/api-types";

export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
export const minutesAhead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

export const SYNC_ID = "11111111-1111-4111-8111-111111111111";
export const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

export function makeRun(overrides: Partial<RunDTO> = {}): RunDTO {
  return {
    id: "run-1",
    syncId: SYNC_ID,
    trigger: "schedule",
    mode: "incremental",
    status: "succeeded",
    phase: "done",
    plannedUploads: 3,
    plannedDeletions: 1,
    uploaded: 3,
    unchanged: 40,
    deleted: 1,
    failed: 0,
    skipped: 0,
    gcSyncId: "gc-sync-0001",
    gcSyncStatus: "Completed",
    gcIngestionStatus: "Completed",
    cancelRequested: false,
    error: null,
    note: null,
    requestedBy: null,
    startedAt: minutesAgo(30),
    finishedAt: minutesAgo(29),
    durationMs: 61_000,
    ...overrides,
  };
}

export function makeSync(overrides: Partial<SyncDTO> = {}): SyncDTO {
  return {
    id: SYNC_ID,
    name: "Customer Help",
    audience: "csm",
    connection: { id: CONNECTION_ID, name: "Acme production", instanceUrl: "https://acme.service-now.com" },
    kbIds: ["kb-1"],
    kbNames: ["Customer Service"],
    filters: { categories: [], languages: [], articles: null },
    filterQuery: "",
    linkStyle: "csm",
    linkCustom: "",
    source: { id: "source-1", name: "ServiceNow - Customer Help" },
    schedule: { kind: "interval", minutes: 60 },
    enabled: true,
    nextRunAt: minutesAhead(25),
    health: "healthy",
    statusMessage: null,
    consecutiveFailures: 0,
    articleCount: 44,
    lastSuccessAt: minutesAgo(29),
    lastCheckedAt: minutesAgo(29),
    activeRun: null,
    lastRun: makeRun(),
    createdAt: minutesAgo(60 * 24 * 10),
    ...overrides,
  };
}

export function makeConnection(overrides: Partial<ConnectionDTO> = {}): ConnectionDTO {
  return {
    id: CONNECTION_ID,
    name: "Acme production",
    instanceUrl: "https://acme.service-now.com",
    authType: "basic",
    principal: "svc_knowledge",
    status: "ok",
    statusMessage: null,
    checkedAt: minutesAgo(10),
    syncCount: 0,
    createdAt: minutesAgo(60 * 24 * 30),
    ...overrides,
  };
}

export function makeKb(overrides: Partial<KnowledgeBaseDTO> = {}): KnowledgeBaseDTO {
  return {
    id: "kb-1",
    title: "Customer Service",
    description: "Answers for customers",
    articleCount: 120,
    portals: ["csm"],
    suggestedAudience: "csm",
    ...overrides,
  };
}

export const CATEGORY = { billing: "c".repeat(32), payments: "d".repeat(32), returns: "e".repeat(32) };

export function makeFilterOptions(overrides: Partial<FilterOptionsDTO> = {}): FilterOptionsDTO {
  return {
    categories: [
      { id: CATEGORY.billing, label: "Billing", path: "Billing", kbId: "kb-1", kbName: "Customer Service", count: 70 },
      { id: CATEGORY.payments, label: "Payments", path: "Billing / Payments", kbId: "kb-1", kbName: "Customer Service", count: 20 },
      { id: CATEGORY.returns, label: "Returns", path: "Returns", kbId: "kb-2", kbName: "Billing", count: 25 },
      { id: "", label: "Without a category", path: "Without a category", kbId: "", kbName: "", count: 5 },
    ],
    languages: [
      { code: "en", label: "English", count: 100 },
      { code: "it", label: "Italian", count: 20 },
    ],
    ...overrides,
  };
}

export function makeArticleOption(number: string, overrides: Partial<ArticleOptionDTO> = {}): ArticleOptionDTO {
  return { number, title: `Article ${number}`, kbId: "kb-1", kbName: "Customer Service", category: "General", updatedAt: "2026-11-01 10:00:00", ...overrides };
}

export function makeSession(setup: Partial<SessionInfo["setup"]> = {}): SessionInfo {
  return {
    user: { id: "user-1", name: "Jordan Example" },
    org: { id: "org-1", name: "Example Org", region: "mypurecloud.de" },
    setup: { connections: 1, gcCredentials: "ok", syncs: 1, ...setup },
    version: "1.0.0-test",
  };
}

export function makeCredentials(overrides: Partial<GcCredentialsDTO> = {}): GcCredentialsDTO {
  return { status: "ok", clientId: "9a8b7c6d-0000-4000-8000-000000000001", verifiedAt: minutesAgo(5), message: null, ...overrides };
}

export function makeSource(overrides: Partial<GcSourceDTO> = {}): GcSourceDTO {
  return { id: "source-9", name: "Legacy upload", status: "Active", fileCount: 12, lastSync: null, usedBy: null, ...overrides };
}

export function makeArticle(index: number, overrides: Partial<ArticleDTO> = {}): ArticleDTO {
  return {
    articleId: `article-${index}`,
    number: `KB00${String(1000 + index)}`,
    title: `Article ${index}`,
    kbName: "Customer Service",
    fileName: `KB00${String(1000 + index)}.md`,
    state: "synced",
    lastError: null,
    syncedAt: minutesAgo(index),
    snUpdatedAt: minutesAgo(index + 60),
    ...overrides,
  };
}

export function makeArticlePage(items: ArticleDTO[], overrides: Partial<ArticlePage> = {}): ArticlePage {
  return {
    items,
    total: items.length,
    counts: { synced: items.filter((item) => item.state === "synced").length, error: items.filter((item) => item.state === "error").length, skipped: 0, pending_delete: 0 },
    ...overrides,
  };
}
