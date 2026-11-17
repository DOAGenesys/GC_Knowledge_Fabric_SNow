"use client";

import { Globe, KeyRound, Lock, User } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { ConnectionDTO, SnAuthType } from "@/lib/api-types";
import { AUTH_TYPES } from "@/lib/ui-text";
import { Button } from "../ui/button";
import { ErrorCallout } from "../ui/callout";
import { Dialog } from "../ui/dialog";
import { ChoiceCards, Field, Input } from "../ui/field";

interface FormState {
  name: string;
  instanceUrl: string;
  authType: SnAuthType;
  username: string;
  password: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
}

function initialState(connection: ConnectionDTO | null): FormState {
  return {
    name: connection?.name ?? "",
    instanceUrl: connection?.instanceUrl ?? "",
    authType: connection?.authType ?? "basic",
    username: connection?.authType === "basic" ? (connection.principal ?? "") : "",
    password: "",
    clientId: connection?.authType === "oauth" ? (connection.principal ?? "") : "",
    clientSecret: "",
    apiKey: "",
  };
}

/** Request body: blank secrets are omitted so the server keeps the saved ones. */
export function connectionBody(form: FormState) {
  const optional = (value: string) => (value ? value : undefined);
  const auth =
    form.authType === "basic"
      ? { type: "basic" as const, username: form.username.trim(), password: optional(form.password) }
      : form.authType === "oauth"
        ? { type: "oauth" as const, clientId: form.clientId.trim(), clientSecret: optional(form.clientSecret) }
        : { type: "apikey" as const, apiKey: optional(form.apiKey) };
  return { name: form.name.trim(), instanceUrl: form.instanceUrl.trim(), auth };
}

export function ConnectionDialog({
  open,
  connection,
  onClose,
  onSaved,
}: {
  open: boolean;
  connection: ConnectionDTO | null;
  onClose: () => void;
  onSaved: (connection: ConnectionDTO, created: boolean) => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(connection));
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const editing = connection !== null;
  const keepsSecret = editing && connection.authType === form.authType;

  useEffect(() => {
    if (open) {
      setForm(initialState(connection));
      setError(null);
    }
  }, [open, connection]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const fieldError = (path: string) => (isApiError(error) ? error.fieldError(path) : undefined);
  const generalError = error && !(isApiError(error) && error.code === "VALIDATION" && error.fields.length > 0) ? error : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = connectionBody(form);
      const result = editing
        ? await apiFetch<{ connection: ConnectionDTO }>(`/api/connections/${connection.id}`, { method: "PUT", body })
        : await apiFetch<{ connection: ConnectionDTO }>("/api/connections", { method: "POST", body });
      onSaved(result.connection, !editing);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  const secretHint = keepsSecret ? "Leave blank to keep the saved value." : undefined;

  return (
    <Dialog
      open={open}
      onClose={saving ? () => undefined : onClose}
      title={editing ? "Edit ServiceNow connection" : "Connect ServiceNow"}
      description="We test the connection before saving. Secrets are encrypted and never shown again."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="connection-form" loading={saving}>
            {saving ? "Testing connection…" : editing ? "Test and save" : "Test and connect"}
          </Button>
        </>
      }
    >
      <form id="connection-form" onSubmit={submit} className="space-y-5" noValidate>
        {generalError ? <ErrorCallout error={generalError} /> : null}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Name" hint="Shown in sync settings." error={fieldError("name")}>
            {(props) => <Input {...props} value={form.name} onChange={(event) => set("name", event.target.value)} placeholder="Acme production" maxLength={80} autoFocus />}
          </Field>
          <Field label="Instance" hint="Like acme, acme.service-now.com or a custom domain." error={fieldError("instanceUrl")}>
            {(props) => (
              <Input
                {...props}
                value={form.instanceUrl}
                onChange={(event) => set("instanceUrl", event.target.value)}
                placeholder="https://acme.service-now.com"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-navy">Authentication</p>
          <ChoiceCards
            name="authType"
            label="Authentication"
            columns={3}
            value={form.authType}
            onChange={(value) => set("authType", value)}
            options={[
              { value: "basic", label: AUTH_TYPES.basic.label, description: "Integration user", icon: <User className="size-4" /> },
              { value: "oauth", label: AUTH_TYPES.oauth.label, description: "Client credentials", icon: <Globe className="size-4" /> },
              { value: "apikey", label: AUTH_TYPES.apikey.label, description: "Washington DC+", icon: <KeyRound className="size-4" /> },
            ]}
          />
          <p className="text-[13px] text-navy/55">{AUTH_TYPES[form.authType].description}</p>
        </div>

        {form.authType === "basic" ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Username" error={fieldError("auth.username")}>
              {(props) => <Input {...props} value={form.username} onChange={(event) => set("username", event.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="Password" hint={secretHint} error={fieldError("auth.password")}>
              {(props) => (
                <Input {...props} type="password" value={form.password} onChange={(event) => set("password", event.target.value)} autoComplete="new-password" placeholder={keepsSecret ? "••••••••" : ""} />
              )}
            </Field>
          </div>
        ) : form.authType === "oauth" ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Client ID" error={fieldError("auth.clientId")}>
              {(props) => <Input {...props} value={form.clientId} onChange={(event) => set("clientId", event.target.value)} autoComplete="off" spellCheck={false} className="font-mono text-[14px]" />}
            </Field>
            <Field label="Client secret" hint={secretHint} error={fieldError("auth.clientSecret")}>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  value={form.clientSecret}
                  onChange={(event) => set("clientSecret", event.target.value)}
                  autoComplete="new-password"
                  placeholder={keepsSecret ? "••••••••" : ""}
                />
              )}
            </Field>
          </div>
        ) : (
          <Field label="API key" hint={secretHint ?? "Sent in the x-sn-apikey header."} error={fieldError("auth.apiKey")}>
            {(props) => (
              <Input {...props} type="password" value={form.apiKey} onChange={(event) => set("apiKey", event.target.value)} autoComplete="new-password" placeholder={keepsSecret ? "••••••••" : ""} />
            )}
          </Field>
        )}

        <p className="flex items-center gap-1.5 text-xs text-navy/50">
          <Lock className="size-3.5" aria-hidden /> Encrypted with AES-256-GCM before it&apos;s stored.
        </p>
      </form>
    </Dialog>
  );
}
