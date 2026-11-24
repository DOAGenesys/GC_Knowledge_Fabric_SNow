"use client";

import { RefreshCcw, Trash } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { Audience, LinkStyle, SyncDTO } from "@/lib/api-types";
import { filtersForKbs, noFilters, sameFilters, type SyncFilters } from "@/lib/filters";
import { formatNumber } from "@/lib/format";
import { useConnections, useKnowledgeBases } from "@/lib/hooks";
import type { Schedule } from "@/lib/schedule";
import { Button } from "../ui/button";
import { Callout, ErrorCallout } from "../ui/callout";
import { ConfirmDialog } from "../ui/dialog";
import { Field, Input, Select } from "../ui/field";
import { useToast } from "../ui/toast";
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
  const knowledgeBases = useKnowledgeBases(form.connectionId).data?.knowledgeBases ?? [];
  const portals = useMemo(
    () => [...new Set(knowledgeBases.filter((kb) => form.kbs.some((item) => item.id === kb.id)).flatMap((kb) => kb.portals))],
    [knowledgeBases, form.kbs],
  );

  const original = useMemo(() => JSON.stringify(fromSync(sync)), [sync]);
  const dirty = JSON.stringify(form) !== original;
  const contentChanged =
    form.connectionId !== sync.connection.id ||
    form.kbs.map((kb) => kb.id).join() !== sync.kbIds.join() ||
    !sameFilters(form.filters, sync.filters) ||
    form.filterQuery.trim() !== sync.filterQuery ||
    form.audience !== sync.audience ||
    form.linkStyle !== sync.linkStyle ||
    form.linkCustom !== sync.linkCustom;
  const set = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const fieldError = (path: string) => (isApiError(error) ? error.fieldError(path) : undefined);
  const generalError = error && !(isApiError(error) && error.code === "VALIDATION" && error.fields.length > 0) ? error : null;
  const connection = connections.data?.connections.find((item) => item.id === form.connectionId);

  function changeKbs(kbs: SelectedKb[]) {
    setForm((current) => ({ ...current, kbs, filters: filtersForKbs(current.filters, kbs.map((kb) => kb.id)) }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetch<{ sync: SyncDTO }>(`/api/syncs/${sync.id}`, {
        method: "PUT",
        body: {
          name: form.name.trim(),
          connectionId: form.connectionId,
          audience: form.audience,
          knowledgeBases: form.kbs,
          filters: form.filters,
          filterQuery: form.filterQuery.trim(),
          linkStyle: form.linkStyle,
          linkCustom: form.linkStyle === "custom" ? form.linkCustom : "",
          schedule: form.schedule,
          enabled: sync.enabled,
        },
      });
      await mutate(`/api/syncs/${sync.id}`, { sync: result.sync }, { revalidate: false });
      await mutate("/api/syncs");
      setForm(fromSync(result.sync));
      toast.success("Settings saved", contentChanged ? "The next run re-checks every article against these settings." : undefined);
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
        confirmLabel="Re-upload everything"
      >
        <p>All {formatNumber(sync.articleCount)} articles are sent to Genesys Cloud again, and the knowledge source is replaced with them in one go.</p>
        <p>This takes longer than a normal run. Normal runs already send every change, so you rarely need it.</p>
      </ConfirmDialog>

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} title={`Delete "${sync.name}"?`} confirmLabel="Delete sync" tone="danger">
        <p>
          Future runs stop and the run history is removed. The knowledge source <strong className="font-medium text-navy">{sync.source.name}</strong> keeps its articles; delete them in Genesys Cloud if you no
          longer need them.
        </p>
      </ConfirmDialog>
    </form>
  );
}
