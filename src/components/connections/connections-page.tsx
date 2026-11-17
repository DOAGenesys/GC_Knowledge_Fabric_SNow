"use client";

import { ChevronDown, Database, ExternalLink, Pencil, Plus, RefreshCw, RotateCcw, Trash } from "lucide-react";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { apiFetch } from "@/lib/api-client";
import type { ConnectionDTO } from "@/lib/api-types";
import { formatRelative, plural } from "@/lib/format";
import { useConnections } from "@/lib/hooks";
import { AUTH_TYPES, SN_REQUIREMENTS } from "@/lib/ui-text";
import { StatusBadge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorCallout } from "../ui/callout";
import { Card } from "../ui/card";
import { ConfirmDialog } from "../ui/dialog";
import { EmptyState, Skeleton } from "../ui/feedback";
import { useToast } from "../ui/toast";
import { ConnectionDialog } from "./connection-dialog";
import { GenesysCredentialsCard } from "./genesys-credentials";

const CONNECTION_STATUS = {
  ok: { label: "Connected", tone: "success" },
  error: { label: "Can't connect", tone: "danger" },
  unknown: { label: "Not tested", tone: "neutral" },
} as const;

function ConnectionRow({
  connection,
  onEdit,
  onDelete,
  onTested,
}: {
  connection: ConnectionDTO;
  onEdit: () => void;
  onDelete: () => void;
  onTested: (connection: ConnectionDTO) => void;
}) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const status = CONNECTION_STATUS[connection.status];

  async function test() {
    setTesting(true);
    try {
      const result = await apiFetch<{ connection: ConnectionDTO }>(`/api/connections/${connection.id}/test`, { method: "POST" });
      onTested(result.connection);
      if (result.connection.status === "ok") toast.success("Connection works", `${connection.name} can read knowledge.`);
      else toast.error(null, "Connection test failed", result.connection.statusMessage ?? undefined);
    } catch (error) {
      toast.error(error, "Couldn't test the connection");
    } finally {
      setTesting(false);
    }
  }

  return (
    <li className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-arctic-soft text-navy">
          <Database className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold text-navy">{connection.name}</h3>
            <StatusBadge tone={status.tone} size="sm">
              {status.label}
            </StatusBadge>
          </div>
          <a
            href={connection.instanceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-0.5 inline-flex items-center gap-1 text-[13px] text-azure underline-offset-2 hover:underline"
          >
            {connection.instanceUrl.replace(/^https:\/\//, "")} <ExternalLink className="size-3" aria-hidden />
          </a>
          <p className="mt-1 text-[13px] text-navy/55">
            {AUTH_TYPES[connection.authType].label}
            {connection.principal ? ` · ${connection.principal}` : ""} · {connection.syncCount ? `Used by ${plural(connection.syncCount, "sync")}` : "Not used yet"}
            {connection.checkedAt ? ` · Checked ${formatRelative(connection.checkedAt)}` : ""}
          </p>
          {connection.status === "error" && connection.statusMessage ? <p className="mt-1.5 text-[13px] text-danger">{connection.statusMessage}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:pl-4">
        <Button size="sm" variant="subtle" onClick={test} loading={testing} icon={<RefreshCw className="size-3.5" aria-hidden />}>
          Test
        </Button>
        <Button size="sm" variant="ghost" iconOnly aria-label={`Edit ${connection.name}`} onClick={onEdit} icon={<Pencil className="size-4" aria-hidden />} />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          aria-label={connection.syncCount ? "Delete the syncs that use this connection first" : `Delete ${connection.name}`}
          title={connection.syncCount ? "Delete the syncs that use this connection first" : "Delete"}
          disabled={connection.syncCount > 0}
          onClick={onDelete}
          icon={<Trash className="size-4" aria-hidden />}
        />
      </div>
    </li>
  );
}

export function ConnectionsPage() {
  const { data, error, isLoading, mutate } = useConnections();
  const { mutate: mutateGlobal } = useSWRConfig();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ open: boolean; connection: ConnectionDTO | null }>({ open: false, connection: null });
  const [deleting, setDeleting] = useState<ConnectionDTO | null>(null);
  const connections = data?.connections ?? [];

  function replace(next: ConnectionDTO) {
    void mutate(
      (current) => ({ connections: (current?.connections ?? []).some((item) => item.id === next.id) ? (current?.connections ?? []).map((item) => (item.id === next.id ? next : item)) : [...(current?.connections ?? []), next] }),
      { revalidate: false },
    );
  }

  async function remove(connection: ConnectionDTO) {
    try {
      await apiFetch(`/api/connections/${connection.id}`, { method: "DELETE" });
      await mutate();
      await mutateGlobal("/api/session");
      toast.success("Connection deleted");
    } catch (caught) {
      toast.error(caught, "Couldn't delete the connection");
      throw caught;
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-medium tracking-tight text-navy">Connections</h1>
          <p className="mt-1 text-[15px] text-navy/60">Where knowledge comes from, and the credentials syncs use to deliver it.</p>
        </div>
        <Button variant="primary" onClick={() => setDialog({ open: true, connection: null })} icon={<Plus className="size-4" aria-hidden />}>
          Add ServiceNow connection
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-navy/[0.06] px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">ServiceNow instances</h2>
            <p className="mt-1 text-sm text-navy/60">Each connection can feed several syncs, for CSM and ITSM knowledge alike.</p>
          </div>
        </div>
        {isLoading ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : error && !data ? (
          <div className="p-6">
            <ErrorCallout
              error={error}
              action={
                <Button size="sm" onClick={() => mutate()} icon={<RotateCcw className="size-3.5" aria-hidden />}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : connections.length === 0 ? (
          <EmptyState illustration="/brand/icon-connect.svg" title="No ServiceNow instance yet" action={<Button onClick={() => setDialog({ open: true, connection: null })}>Connect ServiceNow</Button>}>
            Add your instance with an integration account that can read knowledge. We test it before saving.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-navy/[0.06]">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                onEdit={() => setDialog({ open: true, connection })}
                onDelete={() => setDeleting(connection)}
                onTested={replace}
              />
            ))}
          </ul>
        )}
        <details className="group border-t border-navy/[0.06] px-6 py-4">
          <summary className="flex list-none items-center justify-between text-sm font-medium text-navy [&::-webkit-details-marker]:hidden">
            What the ServiceNow account needs
            <ChevronDown className="size-4 text-navy/50 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <ul className="mt-3 space-y-2">
            {SN_REQUIREMENTS.map((item) => (
              <li key={item.name} className="text-[13px] leading-relaxed text-navy/65">
                <code className="rounded bg-nimbus px-1.5 py-0.5 font-mono text-[12px] text-navy">{item.name}</code> {item.detail}
              </li>
            ))}
            <li className="text-[13px] leading-relaxed text-navy/65">
              The account must also be able to read the knowledge bases you sync (their &quot;Can read&quot; user criteria). Only published, unexpired articles are synced.
            </li>
          </ul>
        </details>
      </Card>

      <GenesysCredentialsCard />

      <ConnectionDialog
        open={dialog.open}
        connection={dialog.connection}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
        onSaved={(connection, created) => {
          replace(connection);
          void mutateGlobal("/api/session");
          setDialog((current) => ({ ...current, open: false }));
          toast.success(created ? "ServiceNow connected" : "Connection updated", `${connection.name} can read knowledge.`);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
        title={`Delete ${deleting?.name ?? "connection"}?`}
        confirmLabel="Delete connection"
        tone="danger"
      >
        <p>The saved credentials are erased. You can add the instance again at any time.</p>
      </ConfirmDialog>
    </div>
  );
}
