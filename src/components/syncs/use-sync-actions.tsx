"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { apiFetch } from "@/lib/api-client";
import type { RemovalImpactDTO, RunDTO, RunMode, RunNowResult, SyncDTO } from "@/lib/api-types";
import { useToast } from "../ui/toast";
import { RemovalDialog } from "./removal-dialog";

/** Revalidates every cached view of one sync (detail, runs, articles) and the sync list. */
export function useRefreshSync() {
  const { mutate } = useSWRConfig();
  return (syncId: string) =>
    mutate((key) => typeof key === "string" && (key === "/api/syncs" || key === "/api/session" || key.startsWith(`/api/syncs/${syncId}`)));
}

/**
 * Starts a run. A normal run that would remove articles from Genesys Cloud asks first:
 * render `removalDialog` wherever `syncNow` is used.
 */
export function useSyncNow() {
  const toast = useToast();
  const refresh = useRefreshSync();
  const [pending, setPending] = useState<string | null>(null);
  const [held, setHeld] = useState<{ sync: Pick<SyncDTO, "id" | "name">; impact: RemovalImpactDTO } | null>(null);

  async function syncNow(
    sync: Pick<SyncDTO, "id" | "name">,
    mode: RunMode = "incremental",
    options: { allowRemovals?: boolean } = {},
  ): Promise<RunNowResult | null> {
    setPending(sync.id);
    try {
      const result = await apiFetch<RunNowResult>(`/api/syncs/${sync.id}/run`, {
        method: "POST",
        body: options.allowRemovals ? { mode, allowRemovals: true } : { mode },
      });
      if (result.outcome === "confirm_removals" && result.impact) {
        setHeld({ sync, impact: result.impact });
        return result;
      }
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

  const removalDialog = (
    <RemovalDialog
      impact={held?.impact ?? null}
      reason="run"
      confirmLabel="Sync and remove them"
      onClose={() => setHeld(null)}
      onConfirm={async () => {
        if (!held) return;
        const result = await syncNow(held.sync, "incremental", { allowRemovals: true });
        if (!result) throw new Error("not started");
      }}
    />
  );

  return { syncNow, pending, removalDialog };
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
