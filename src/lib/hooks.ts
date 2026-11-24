"use client";

import useSWR from "swr";
import { swrFetcher } from "./api-client";
import type {
  ArticleOptionDTO,
  ArticlePage,
  ConnectionDTO,
  FilterOptionsDTO,
  GcCredentialsDTO,
  GcSourceDTO,
  KnowledgeBaseDTO,
  RunDetailDTO,
  RunDTO,
  SessionInfo,
  SyncDTO,
} from "./api-types";

const ACTIVE_POLL_MS = 2_500;
const IDLE_POLL_MS = 30_000;

export function useSessionInfo() {
  return useSWR<SessionInfo>("/api/session", swrFetcher);
}

export function useSyncs() {
  return useSWR<{ syncs: SyncDTO[] }>("/api/syncs", swrFetcher, {
    refreshInterval: (data) => (data?.syncs.some((sync) => sync.activeRun) ? ACTIVE_POLL_MS : IDLE_POLL_MS),
  });
}

export function useSync(id: string) {
  return useSWR<{ sync: SyncDTO }>(`/api/syncs/${id}`, swrFetcher, {
    refreshInterval: (data) => (data?.sync.activeRun ? ACTIVE_POLL_MS : IDLE_POLL_MS),
  });
}

export function useRuns(syncId: string, live: boolean) {
  return useSWR<{ runs: RunDTO[] }>(`/api/syncs/${syncId}/runs?limit=25`, swrFetcher, {
    refreshInterval: live ? ACTIVE_POLL_MS * 2 : IDLE_POLL_MS,
  });
}

export function useRunDetail(syncId: string, runId: string | null, live: boolean, status?: "attention") {
  return useSWR<RunDetailDTO>(runId ? `/api/syncs/${syncId}/runs/${runId}${status ? `?status=${status}` : ""}` : null, swrFetcher, {
    refreshInterval: live ? ACTIVE_POLL_MS * 2 : 0,
  });
}

export function useArticles(syncId: string, query: { state?: string; search?: string; offset: number; limit: number }) {
  const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
  if (query.state) params.set("state", query.state);
  if (query.search) params.set("search", query.search);
  return useSWR<ArticlePage>(`/api/syncs/${syncId}/articles?${params}`, swrFetcher, { keepPreviousData: true });
}

export function useConnections() {
  return useSWR<{ connections: ConnectionDTO[] }>("/api/connections", swrFetcher);
}

export function useGcCredentials() {
  return useSWR<{ credentials: GcCredentialsDTO }>("/api/genesys/credentials", swrFetcher);
}

export function useGcSources(enabled: boolean) {
  return useSWR<{ sources: GcSourceDTO[] }>(enabled ? "/api/genesys/sources" : null, swrFetcher, { revalidateOnFocus: false });
}

export function useFilterOptions(connectionId: string | null, kbIds: string[]) {
  const kbKey = [...kbIds].sort().join(",");
  return useSWR<{ options: FilterOptionsDTO }>(connectionId && kbKey ? `/api/connections/${connectionId}/filter-options?kb=${kbKey}` : null, swrFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    keepPreviousData: true,
  });
}

export function useArticleSearch(connectionId: string | null, kbIds: string[], text: string) {
  const kbKey = [...kbIds].sort().join(",");
  const query = new URLSearchParams({ kb: kbKey, q: text.trim() });
  return useSWR<{ articles: ArticleOptionDTO[]; more: boolean }>(connectionId && kbKey ? `/api/connections/${connectionId}/articles?${query}` : null, swrFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    keepPreviousData: true,
  });
}

export function useKnowledgeBases(connectionId: string | null) {
  return useSWR<{ knowledgeBases: KnowledgeBaseDTO[] }>(connectionId ? `/api/connections/${connectionId}/knowledge-bases` : null, swrFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}
