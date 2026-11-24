"use client";

import { ShieldCheck } from "lucide-react";
import Image from "next/image";
import { type FormEvent, useState } from "react";
import { useSWRConfig } from "swr";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { GcCredentialsDTO } from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import { useGcCredentials } from "@/lib/hooks";
import { gcAdminRequest, GC_PERMISSIONS } from "@/lib/ui-text";
import { StatusBadge } from "../ui/badge";
import { Button } from "../ui/button";
import { Callout, ErrorCallout } from "../ui/callout";
import { Card } from "../ui/card";
import { CopyButton, CopyTextButton } from "../ui/copy-button";
import { ConfirmDialog } from "../ui/dialog";
import { Skeleton } from "../ui/feedback";
import { Field, Input } from "../ui/field";
import { useToast } from "../ui/toast";

function PermissionList() {
  const required = GC_PERMISSIONS.filter((permission) => !permission.optional).map((permission) => permission.name);
  return (
    <div className="rounded-xl bg-nimbus p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-navy">Permissions the role needs</p>
        <CopyButton value={required.join("\n")} label="Copy required permissions" />
      </div>
      <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {GC_PERMISSIONS.map((permission) => (
          <li key={permission.name} className="flex items-center gap-2 text-[13px]">
            <ShieldCheck className={permission.optional ? "size-3.5 text-navy/35" : "size-3.5 text-patina-ink"} aria-hidden />
            <code className="font-mono text-[12px] text-navy/80">{permission.name}</code>
            {permission.optional ? <span className="text-[11px] text-navy/45">optional, shows file counts</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CredentialsForm({ onSaved, onCancel }: { onSaved: (credentials: GcCredentialsDTO) => void; onCancel?: () => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const fieldError = (path: string) => (isApiError(error) ? error.fieldError(path) : undefined);
  const generalError = error && !(isApiError(error) && error.code === "VALIDATION" && error.fields.length > 0) ? error : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetch<{ credentials: GcCredentialsDTO }>("/api/genesys/credentials", {
        method: "PUT",
        body: { clientId: clientId.trim(), clientSecret },
      });
      setClientSecret("");
      onSaved(result.credentials);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {generalError ? <ErrorCallout error={generalError} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client ID" error={fieldError("clientId")}>
          {(props) => (
            <Input {...props} value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} className="font-mono text-[14px]" />
          )}
        </Field>
        <Field label="Client secret" error={fieldError("clientSecret")}>
          {(props) => <Input {...props} type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" />}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" loading={saving} disabled={!clientId.trim() || !clientSecret}>
          {saving ? "Checking…" : "Check and save"}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        ) : null}
        <span className="text-[13px] text-navy/50">We check that it belongs to your organization and has the right permissions.</span>
      </div>
    </form>
  );
}

export function GenesysCredentialsCard() {
  const { data, error, mutate, isLoading } = useGcCredentials();
  const { mutate: mutateGlobal } = useSWRConfig();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const credentials = data?.credentials;
  const status = credentials?.status;

  async function saved(next: GcCredentialsDTO) {
    await mutate({ credentials: next }, { revalidate: false });
    await mutateGlobal("/api/session");
    setEditing(false);
    toast.success("Genesys Cloud access saved", "Syncs will use this OAuth client.");
  }

  async function remove() {
    try {
      const result = await apiFetch<{ credentials: GcCredentialsDTO }>("/api/genesys/credentials", { method: "DELETE" });
      await mutate(result, { revalidate: false });
      await mutateGlobal("/api/session");
      toast.success("Access removed", "Syncs pause until someone adds an OAuth client again.");
    } catch (caught) {
      toast.error(caught, "Couldn't remove the access");
      throw caught;
    }
  }

  return (
    <Card id="genesys" className="scroll-mt-24">
      <div className="flex flex-wrap items-start gap-4 px-6 pt-6">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-soft">
          <Image src="/brand/genesys-cloud-mark.svg" alt="" width={26} height={17} unoptimized />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold tracking-tight">Genesys Cloud access for syncs</h2>
          <p className="mt-1 text-sm text-navy/60">
            Syncs run in the background, even when nobody is signed in, so they need their own access to Genesys Cloud. A Genesys Cloud admin sets this up once for your organization.
          </p>
        </div>
        {status === "ok" ? (
          <StatusBadge tone="success">Connected</StatusBadge>
        ) : status === "error" ? (
          <StatusBadge tone="danger">Not working</StatusBadge>
        ) : status === "missing" ? (
          <StatusBadge tone="neutral">Not set up</StatusBadge>
        ) : null}
      </div>

      <div className="space-y-5 px-6 pt-5 pb-6">
        {isLoading ? <Skeleton className="h-24 w-full" /> : null}
        {error && !data ? <ErrorCallout error={error} /> : null}

        {credentials && status !== "missing" && !editing ? (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl bg-nimbus px-4 py-3.5">
            <div>
              <p className="text-xs text-navy/50">Client ID</p>
              <p className="font-mono text-[13px] text-navy">{credentials.clientId}</p>
            </div>
            <div>
              <p className="text-xs text-navy/50">{status === "ok" ? "Last verified" : "Last checked"}</p>
              <p className="text-[13px] text-navy">{formatRelative(credentials.verifiedAt)}</p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button size="sm" onClick={() => setEditing(true)}>
                Replace
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
            </div>
          </div>
        ) : null}

        {status === "error" && !editing ? (
          <Callout tone="danger" title="This access stopped working">
            <p>{credentials?.message ?? "Genesys Cloud rejected the OAuth client."}</p>
            <p className="text-navy/65">Replace it with a working OAuth client. Syncs retry automatically once it&apos;s fixed.</p>
          </Callout>
        ) : null}

        {status === "missing" || editing ? (
          <>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-navy/70 marker:text-navy/40">
              <li>
                Create a role with the permissions below (<strong className="font-medium text-navy">Admin → Roles / Permissions</strong>).
              </li>
              <li>
                Add an OAuth client with the <strong className="font-medium text-navy">Client Credentials</strong> grant and give it that role in your home division (
                <strong className="font-medium text-navy">Admin → Integrations → OAuth</strong>).
              </li>
              <li>Paste the client ID and secret here.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-3">
              <CopyTextButton value={gcAdminRequest()}>Copy a request for your Genesys Cloud admin</CopyTextButton>
              <span className="text-[13px] text-navy/50">Not an admin? Send this to one.</span>
            </div>
            <PermissionList />
            <CredentialsForm onSaved={saved} onCancel={editing ? () => setEditing(false) : undefined} />
          </>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={remove}
        title="Remove Genesys Cloud access?"
        confirmLabel="Remove access"
        tone="danger"
      >
        <p>No sync can run until someone adds an OAuth client again. Articles already in Genesys Cloud stay where they are.</p>
      </ConfirmDialog>
    </Card>
  );
}
