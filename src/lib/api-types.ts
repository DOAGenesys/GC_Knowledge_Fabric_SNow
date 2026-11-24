import type { ErrorCode } from "./errors";
import type { SyncFilters } from "./filters";
import type { Schedule } from "./schedule";

export type Audience = "csm" | "itsm";
export type LinkStyle = "classic" | "sp" | "esc" | "csm" | "csp" | "custom";
export type SnAuthType = "basic" | "oauth" | "apikey";
export type ConnectionStatus = "ok" | "error" | "unknown";
export type SyncHealth = "new" | "healthy" | "warning" | "error";
export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled" | "noop";
export type RunPhase = "queued" | "planning" | "uploading" | "deleting" | "committing" | "processing" | "finalizing" | "done";
export type RunTrigger = "manual" | "schedule" | "initial";
export type RunMode = "incremental" | "full";
export type ArticleState = "synced" | "error" | "skipped" | "pending_delete";

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running"];

export interface SessionInfo {
  user: { id: string; name: string };
  org: { id: string; name: string; region: string };
  setup: {
    connections: number;
    gcCredentials: "missing" | "ok" | "error";
    syncs: number;
  };
  version: string;
}

export interface ConnectionDTO {
  id: string;
  name: string;
  instanceUrl: string;
  authType: SnAuthType;
  /** Basic auth username or OAuth client ID. Never a secret. */
  principal: string | null;
  status: ConnectionStatus;
  statusMessage: string | null;
  checkedAt: string | null;
  syncCount: number;
  createdAt: string;
}

export interface KnowledgeBaseDTO {
  id: string;
  title: string;
  description: string;
  articleCount: number | null;
  portals: string[];
  suggestedAudience: Audience | null;
}

export interface PreviewDTO {
  count: number;
  sample: Array<{ number: string; title: string; kbName: string; updatedAt: string }>;
  /** Chosen article numbers that won't be synced: not published, or not in the chosen knowledge bases. */
  missing?: string[];
}

/** A published article offered in search results or found from a pasted list. */
export interface ArticleOptionDTO {
  number: string;
  title: string;
  kbId: string;
  kbName: string;
  category: string;
  updatedAt: string;
}

/** What the friendly filters can offer: values that published articles in the chosen knowledge bases actually use. */
export interface FilterOptionsDTO {
  categories: Array<{ id: string; label: string; path: string; kbId: string; kbName: string; count: number }>;
  languages: Array<{ code: string; label: string; count: number }>;
}

export interface GcCredentialsDTO {
  status: "missing" | "ok" | "error";
  clientId: string | null;
  verifiedAt: string | null;
  message: string | null;
}

export interface GcSourceDTO {
  id: string;
  name: string;
  status: string;
  fileCount: number | null;
  lastSync: {
    status: string | null;
    ingestionStatus: string | null;
    dateEnd: string | null;
  } | null;
  usedBy: { syncId: string; syncName: string } | null;
}

export interface RunErrorDTO {
  code: ErrorCode;
  title: string;
  message: string;
  hint: string | null;
  detail: string | null;
}

export interface RunDTO {
  id: string;
  syncId: string;
  trigger: RunTrigger;
  mode: RunMode;
  status: RunStatus;
  phase: RunPhase;
  plannedUploads: number;
  plannedDeletions: number;
  uploaded: number;
  unchanged: number;
  deleted: number;
  failed: number;
  skipped: number;
  gcSyncId: string | null;
  gcSyncStatus: string | null;
  gcIngestionStatus: string | null;
  cancelRequested: boolean;
  error: RunErrorDTO | null;
  note: string | null;
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface SyncDTO {
  id: string;
  name: string;
  audience: Audience;
  connection: { id: string; name: string; instanceUrl: string };
  kbIds: string[];
  kbNames: string[];
  filters: SyncFilters;
  /** Optional ServiceNow encoded query for cases the friendly filters don't cover. */
  filterQuery: string;
  linkStyle: LinkStyle;
  linkCustom: string;
  source: { id: string; name: string };
  schedule: Schedule;
  enabled: boolean;
  nextRunAt: string | null;
  health: SyncHealth;
  statusMessage: string | null;
  consecutiveFailures: number;
  articleCount: number;
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
  activeRun: RunDTO | null;
  lastRun: RunDTO | null;
  createdAt: string;
}

export interface RunItemDTO {
  articleId: string;
  number: string;
  title: string;
  op: "upload" | "delete";
  reason: string;
  status: "pending" | "done" | "unchanged" | "failed" | "skipped";
  error: string | null;
}

export interface RunDetailDTO {
  run: RunDTO;
  items: RunItemDTO[];
  itemCounts: Record<RunItemDTO["status"], number>;
}

export interface ArticleDTO {
  articleId: string;
  number: string;
  title: string;
  kbName: string;
  fileName: string;
  state: ArticleState;
  lastError: string | null;
  syncedAt: string | null;
  snUpdatedAt: string | null;
}

export interface ArticlePage {
  items: ArticleDTO[];
  total: number;
  counts: Record<ArticleState, number>;
}

export interface RunNowResult {
  outcome: "started" | "up_to_date" | "already_running";
  run: RunDTO | null;
}
