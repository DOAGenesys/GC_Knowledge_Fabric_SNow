"use client";

import { RefreshCcw, Trash } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { Audience, LinkStyle, RemovalImpactDTO, SyncDTO } from "@/lib/api-types";
import { type ArticleChoice, filtersForKbs, noFilters, sameFilters, type SyncFilters } from "@/lib/filters";
import { formatNumber, plural } from "@/lib/format";
import { useConnections, useKnowledgeBases } from "@/lib/hooks";
import type { Schedule } from "@/lib/schedule";
import { Button } from "../ui/button";
import { Callout, ErrorCallout } from "../ui/callout";
import { ConfirmDialog } from "../ui/dialog";
import { Field, Input, Select } from "../ui/field";
import { useToast } from "../ui/toast";
import { RemovalDialog, RemovalList } from "./removal-dialog";
import { ArticlePreview, AudiencePicker, KnowledgeBasePicker, LinkStylePicker, SchedulePicker, type SelectedKb } from "./sync-fields";
import { useSyncNow } from "./use-sync-actions";

interface SettingsState {
  name: string;
  connectionId: string;
  kbs: SelectedKb[];
  audience: Audience;
  filters: SyncFilters;
  filterQuery: string;
  linkStyle: LinkStyle;
  linkCustom: string;
  schedule: Schedule;
}

function fromSync(sync: SyncDTO): SettingsState {
  return {
    name: sync.name,
    connectionId: sync.connection.id,
    kbs: sync.kbIds.map((id, index) => ({ id, title: sync.kbNames[index] ?? id })),
    audience: sync.audience,
    filters: sync.filters,
    filterQuery: sync.filterQuery,
    linkStyle: sync.linkStyle,
    linkCustom: sync.linkCustom,
    schedule: sync.schedule,
  };
}

/** While the re-upload dialog is open: the articles a full re-upload would remove, if any. */
function useReuploadImpact(syncId: string, open: boolean): { impact: RemovalImpactDTO | null; checking: boolean } {
  const [impact, setImpact] = useState<RemovalImpactDTO | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setImpact(null);
    if (!open) return;
    const controller = new AbortController();
    setChecking(true);
    apiFetch<{ impact: RemovalImpactDTO }>(`/api/syncs/${syncId}/impact`, { method: "POST", body: { mode: "full" }, signal: controller.signal })
      .then((result) => setImpact(result.impact.removals > 0 ? result.impact : null))
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [syncId, open]);

  return { impact, checking: open && checking };
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-navy/[0.07] py-7 first:pt-0 last:border-0 lg:grid-cols-[240px_1fr] lg:gap-10">
      <div>
        <h3 className="text-sm font-semibold text-navy">{title}</h3>
        {description ? <p className="mt-1 text-[13px] leading-relaxed text-navy/55">{description}</p> : null}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

export function SettingsTab({ sync }: { sync: SyncDTO }) {
  const router = useRouter();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const connections = useConnections();
  const { syncNow } = useSyncNow();
  const [form, setForm] = useState<SettingsState>(() => fromSync(sync));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReupload, setConfirmReupload] = useState(false);
  const [sampleArticle, setSampleArticle] = useState<string | null>(null);
  const [removals, setRemovals] = useState<RemovalImpactDTO | null>(null);
  const reupload = useReuploadImpact(sync.id, confirmReupload);
  const knowledgeBases = useKnowledgeBases(form.connectionId).data?.knowledgeBases ?? [];
  const portals = useMemo(
    () => [...new Set(knowledgeBases.filter((kb) => form.kbs.some((item) => item.id === kb.id)).flatMap((kb) => kb.portals))],
    [knowledgeBases, form.kbs],
  );

  const original = useMemo(() => JSON.stringify(fromSync(sync)), [sync]);
  const dirty = JSON.stringify(form) !== original;
  const selectionChanged = (state: SettingsState) =>
    state.connectionId !== sync.connection.id ||
    state.kbs.map((kb) => kb.id).join() !== sync.kbIds.join() ||
    !sameFilters(state.filters, sync.filters) ||
    state.filterQuery.trim() !== sync.filterQuery;
  const contentChanged = (state: SettingsState) =>
    selectionChanged(state) || state.audience !== sync.audience || state.linkStyle !== sync.linkStyle || state.linkCustom !== sync.linkCustom;
  const set = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const fieldError = (path: string) => (isApiError(error) ? error.fieldError(path) : undefined);
  const generalError = error && !(isApiError(error) && error.code === "VALIDATION" && error.fields.length > 0) ? error : null;
  const connection = connections.data?.connections.find((item) => item.id === form.connectionId);

  function changeKbs(kbs: SelectedKb[]) {
    setForm((current) => ({ ...current, kbs, filters: filtersForKbs(current.filters, kbs.map((kb) => kb.id)) }));
  }

  /** The articles the new settings would remove from Genesys Cloud, or null when none would go or the check failed (saving then reports any problem). */
  async function checkRemovals(state: SettingsState): Promise<RemovalImpactDTO | null> {
    try {
      const { impact } = await apiFetch<{ impact: RemovalImpactDTO }>(`/api/syncs/${sync.id}/impact`, {
        method: "POST",
        body: {
          connectionId: state.connectionId,
          knowledgeBases: state.kbs.map((kb) => ({ id: kb.id })),
          filters: state.filters,
          filterQuery: state.filterQuery.trim(),
        },
      });
      return impact.removals > 0 ? impact : null;
    } catch {
      return null;
    }
  }

  /** Saves, after asking first when the new settings would remove articles from Genesys Cloud. */
  async function checkAndSave(state: SettingsState) {
    setError(null);
    if (selectionChanged(state)) {
      setSaving(true);
      const impact = await checkRemovals(state);
      if (impact) {
        setSaving(false);
        setRemovals(impact);
        return;
      }
    }
    await persist(state);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await checkAndSave(form);
  }

  /** Chooses the articles that would be removed again, then saves (re-checking, in case some still go). */
  async function keepAndSave(keep: ArticleChoice[]) {
    const chosen = form.filters.articles ?? [];
    const numbers = new Set(chosen.map((article) => article.number.toUpperCase()));
    const next = { ...form, filters: { ...form.filters, articles: [...chosen, ...keep.filter((article) => !numbers.has(article.number.toUpperCase()))] } };
    setForm(next);
    setRemovals(null);
    await checkAndSave(next);
  }

  async function persist(state: SettingsState) {
    setSaving(true);
    try {
      const result = await apiFetch<{ sync: SyncDTO }>(`/api/syncs/${sync.id}`, {
        method: "PUT",
        body: {
          name: state.name.trim(),
          connectionId: state.connectionId,
          audience: state.audience,
          knowledgeBases: state.kbs,
          filters: state.filters,
          filterQuery: state.filterQuery.trim(),
          linkStyle: state.linkStyle,
          linkCustom: state.linkStyle === "custom" ? state.linkCustom : "",
          schedule: state.schedule,
          enabled: sync.enabled,
        },
      });
      await mutate(`/api/syncs/${sync.id}`, { sync: result.sync }, { revalidate: false });
      await mutate("/api/syncs");
      setForm(fromSync(result.sync));
      toast.success("Settings saved", contentChanged(state) ? "The next run re-checks every article against these settings." : undefined);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await apiFetch(`/api/syncs/${sync.id}`, { method: "DELETE" });
      await mutate((key) => typeof key === "string" && (key === "/api/syncs" || key === "/api/session"));
      toast.success("Sync deleted", `The knowledge source "${sync.source.name}" and its articles remain in Genesys Cloud.`);
      router.push("/");
    } catch (caught) {
      toast.error(caught, "Couldn't delete the sync");
      throw caught;
    }
  }

  return (
    <form onSubmit={save} noValidate>
      {generalError ? <ErrorCallout error={generalError} className="mb-6" /> : null}

      <Section title="Name">
        <Field label="Sync name" hint="Only shown in this app." error={fieldError("name")}>
          {(props) => <Input {...props} value={form.name} onChange={(event) => set("name", event.target.value)} maxLength={100} />}
        </Field>
      </Section>

      <Section title="Articles" description="Changing which articles are synced makes the next run re-check all of them.">
        {(connections.data?.connections.length ?? 0) > 1 ? (
          <Field label="ServiceNow connection" error={fieldError("connectionId")}>
            {(props) => (
              <Select
                {...props}
                value={form.connectionId}
                onChange={(event) => setForm((current) => ({ ...current, connectionId: event.target.value, kbs: [], filters: noFilters() }))}
              >
                {connections.data?.connections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <KnowledgeBasePicker connectionId={form.connectionId} selected={form.kbs} onChange={changeKbs} error={fieldError("knowledgeBases")} />
        <div className="space-y-2">
          <p className="text-sm font-medium text-navy">Which ServiceNow product?</p>
          <AudiencePicker value={form.audience} onChange={(audience) => set("audience", audience)} />
        </div>
        <ArticlePreview
          connectionId={form.connectionId}
          kbIds={form.kbs.map((kb) => kb.id)}
          filters={form.filters}
          onFiltersChange={(filters) => set("filters", filters)}
          filterQuery={form.filterQuery}
          onFilterChange={(value) => set("filterQuery", value)}
          filterError={fieldError("filterQuery")}
          articlesError={fieldError("filters.articles")}
          onPreview={(preview) => setSampleArticle(preview?.sample[0]?.number ?? null)}
        />
      </Section>

      <Section title="Destination" description="The knowledge source can't be changed. Create a new sync to send articles somewhere else.">
        <div className="rounded-xl bg-nimbus px-4 py-3 text-sm">
          <p className="text-xs text-navy/50">Knowledge source in Genesys Cloud</p>
          <p className="font-medium text-navy">{sync.source.name}</p>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-navy">Where article links open</p>
          <LinkStylePicker
            linkStyle={form.linkStyle}
            linkCustom={form.linkCustom}
            instanceUrl={connection?.instanceUrl ?? sync.connection.instanceUrl}
            portals={portals}
            sampleArticle={sampleArticle}
            onChange={(next) => setForm((current) => ({ ...current, ...next }))}
            customError={fieldError("linkCustom")}
          />
        </div>
      </Section>

      <Section title="Schedule">
        <SchedulePicker value={form.schedule} onChange={(schedule) => set("schedule", schedule)} error={fieldError("schedule") ?? fieldError("schedule.days")} />
      </Section>

      <Section title="Re-upload everything" description="Rarely needed. Normal runs already send every change.">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-nimbus px-4 py-3">
          <p className="min-w-0 flex-1 text-[13px] text-navy/65">
            Sends every article to Genesys Cloud again, even unchanged ones. Use it if articles in Genesys Cloud look wrong or out of date, or after someone edited the knowledge source by hand.
          </p>
          <Button size="sm" onClick={() => setConfirmReupload(true)} disabled={Boolean(sync.activeRun) || dirty} icon={<RefreshCcw className="size-3.5" aria-hidden />}>
            Re-upload all articles
          </Button>
        </div>
        {sync.activeRun ? <p className="text-[13px] text-navy/55">Available when the current run finishes.</p> : dirty ? <p className="text-[13px] text-navy/55">Save or discard your changes first.</p> : null}
      </Section>

      {dirty ? (
        <div className="sticky bottom-4 z-10 mt-2 flex animate-fade-in flex-wrap items-center justify-end gap-3 rounded-2xl bg-white/95 px-4 py-3 shadow-raised ring-1 ring-navy/[0.07] backdrop-blur">
          <span className="mr-auto text-[13px] font-medium text-amber-ink">Unsaved changes</span>
          <Button
            variant="ghost"
            onClick={() => {
              setForm(fromSync(sync));
              setError(null);
            }}
            disabled={saving}
          >
            Discard
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            Save changes
          </Button>
        </div>
      ) : null}

      <div className="mt-10">
        <Callout
          tone="danger"
          title="Delete this sync"
          action={
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)} disabled={Boolean(sync.activeRun)} icon={<Trash className="size-3.5" aria-hidden />}>
              Delete sync
            </Button>
          }
        >
          <p>Stops all future runs and removes the sync&apos;s history. The knowledge source and its articles stay in Genesys Cloud.</p>
          {sync.activeRun ? <p className="text-navy/60">Wait for the current run to finish, or cancel it, before deleting.</p> : null}
        </Callout>
      </div>

      <ConfirmDialog
        open={confirmReupload}
        onClose={() => setConfirmReupload(false)}
        onConfirm={async () => {
          const result = await syncNow(sync, "full");
          if (!result) throw new Error("not started");
        }}
        title="Re-upload every article?"
        confirmLabel={reupload.impact ? "Re-upload and remove them" : "Re-upload everything"}
        tone={reupload.impact ? "danger" : "primary"}
      >
        <p>All {formatNumber(sync.articleCount)} articles are sent to Genesys Cloud again, and the knowledge source is replaced with them in one go.</p>
        {reupload.checking ? <p className="text-navy/55">Checking whether any articles would be removed…</p> : null}
        {reupload.impact ? (
          <>
            <p className="font-medium text-danger">
              {plural(reupload.impact.removals, "article")} in Genesys Cloud no longer {reupload.impact.removals === 1 ? "matches" : "match"} this sync&apos;s settings and will be removed:
            </p>
            <RemovalList impact={reupload.impact} />
          </>
        ) : null}
        <p>This takes longer than a normal run. Normal runs already send every change, so you rarely need it.</p>
      </ConfirmDialog>

      <RemovalDialog
        impact={removals}
        reason="settings"
        confirmLabel="Save and remove them"
        onClose={() => setRemovals(null)}
        onConfirm={() => persist(form)}
        onKeep={keepAndSave}
      />

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} title={`Delete "${sync.name}"?`} confirmLabel="Delete sync" tone="danger">
        <p>
          Future runs stop and the run history is removed. The knowledge source <strong className="font-medium text-navy">{sync.source.name}</strong> keeps its articles; delete them in Genesys Cloud if you no
          longer need them.
        </p>
      </ConfirmDialog>
    </form>
  );
}
