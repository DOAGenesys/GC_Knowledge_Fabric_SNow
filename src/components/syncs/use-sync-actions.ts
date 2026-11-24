"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { apiFetch } from "@/lib/api-client";
import type { RunDTO, RunMode, RunNowResult, SyncDTO } from "@/lib/api-types";
import { useToast } from "../ui/toast";

/** Revalidates every cached view of one sync (detail, runs, articles) and the sync list. */
export function useRefreshSync() {
  const { mutate } = useSWRConfig();
  return (syncId: string) =>
    mutate((key) => typeof key === "string" && (key === "/api/syncs" || key === "/api/session" || key.startsWith(`/api/syncs/${syncId}`)));
}

export function useSyncNow() {
  const toast = useToast();
  const refresh = useRefreshSync();
  const [pending, setPending] = useState<string | null>(null);

  async function syncNow(sync: Pick<SyncDTO, "id" | "name">, mode: RunMode = "incremental"): Promise<RunNowResult | null> {
    setPending(sync.id);
    try {
      const result = await apiFetch<RunNowResult>(`/api/syncs/${sync.id}/run`, { method: "POST", body: { mode } });
      if (result.outcome === "started") {
        toast.success(mode === "full" ? "Full re-upload started" : "Sync started", "Progress updates live on the sync's page.");
      } else if (result.outcome === "up_to_date") {
        toast.success("Already up to date", `Nothing changed in ServiceNow since the last sync of ${sync.name}.`);
      } else {
        toast.info("A sync is already running", "Its progress is shown below.");
      }
      await refresh(sync.id);
      return result;
    } catch (error) {
      toast.error(error, "Couldn't start the sync");
      await refresh(sync.id);
      return null;
    } finally {
      setPending(null);
    }
  }

  return { syncNow, pending };
}

export function useCancelRun() {
  const toast = useToast();
  const refresh = useRefreshSync();
  return async (run: Pick<RunDTO, "id" | "syncId">) => {
    try {
      await apiFetch(`/api/syncs/${run.syncId}/runs/${run.id}/cancel`, { method: "POST" });
      toast.info("Cancelling", "The run stops after the current step. Files already sent stay in Genesys Cloud.");
    } catch (error) {
      toast.error(error, "Couldn't cancel the run");
      throw error;
    } finally {
      await refresh(run.syncId);
    }
  };
}
