"use client";

import { ChevronDown, Globe, KeyRound, Lock, User } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api-client";
import type { ConnectionDTO, SnAuthType } from "@/lib/api-types";
import { AUTH_TYPES, SN_ADMIN_REQUEST } from "@/lib/ui-text";
import { Button } from "../ui/button";
import { ErrorCallout } from "../ui/callout";
import { CopyTextButton } from "../ui/copy-button";
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

const AUTH_HELP: Record<SnAuthType, { need: string; steps: string[] }> = {
  basic: {
    need: "A ServiceNow user set aside for this app, that can read your knowledge bases.",
    steps: [
      "In ServiceNow, open User Administration > Users and create a user. Tick \"Web service access only\".",
      "Give it the knowledge role. If your instance restricts REST API access, also give it snc_platform_rest_api_access.",
      "Set a password, then paste the username and password here.",
    ],
  },
  oauth: {
    need: "An OAuth client from ServiceNow's Application Registry that can sign in on its own (client credentials).",
    steps: [
      "In ServiceNow, open System OAuth > Application Registry and create an OAuth API endpoint for external clients.",
      "Make sure the instance allows the client credentials grant (system property glide.oauth.inbound.client.credential.grant_type.enabled set to true).",
      "Set the client's OAuth Application User to a user with the knowledge role.",
      "Paste the client ID and secret here.",
    ],
  },
  apikey: {
    need: "A ServiceNow REST API key. Needs the Washington DC release or later.",
    steps: [
      "In ServiceNow, create an inbound authentication profile for API keys that reads the x-sn-apikey header.",
      "Create a REST API key for a user with the knowledge role.",
      "Add a REST API access policy that applies the profile to the Table API, the Aggregate API and the Knowledge Management API.",
      "Paste the key here.",
    ],
  },
};

const AUTH_ICONS: Record<SnAuthType, React.ReactNode> = {
  basic: <User className="size-4" />,
  oauth: <Globe className="size-4" />,
  apikey: <KeyRound className="size-4" />,
};

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

/** "acme" or "https://acme.service-now.com" → "Acme ServiceNow". Custom domains keep their host name. */
export function suggestedConnectionName(instance: string): string {
  const value = instance.trim();
  if (!value) return "";
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname;
  } catch {
    return "";
  }
  if (host.includes(".") && !host.endsWith(".service-now.com")) return host;
  const label = host.split(".")[0] ?? host;
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} ServiceNow`;
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
  return { name: form.name.trim() || suggestedConnectionName(form.instanceUrl), instanceUrl: form.instanceUrl.trim(), auth };
}

function AuthHelp({ type }: { type: SnAuthType }) {
  const help = AUTH_HELP[type];
  return (
    <div className="rounded-xl bg-nimbus px-4 py-3 text-[13px] leading-relaxed text-navy/70">
      <p>
        <span className="font-medium text-navy">What you need:</span> {help.need}
      </p>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <details className="group min-w-0 flex-1">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-azure [&::-webkit-details-marker]:hidden">
            Steps for your ServiceNow admin <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 marker:text-navy/40">
            {help.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </details>
        <CopyTextButton value={SN_ADMIN_REQUEST}>Copy a request for your admin</CopyTextButton>
      </div>
    </div>
  );
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
  const [showMethods, setShowMethods] = useState(false);
  const editing = connection !== null;
  const keepsSecret = editing && connection.authType === form.authType;
  const methodsVisible = showMethods || form.authType !== "basic";
  const nameSuggestion = suggestedConnectionName(form.instanceUrl);

  useEffect(() => {
    if (open) {
      setForm(initialState(connection));
      setError(null);
      setShowMethods(false);
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
      description="We check that it works before saving."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="connection-form" loading={saving}>
            {saving ? "Checking the connection…" : editing ? "Check and save" : "Check and connect"}
          </Button>
        </>
      }
    >
      <form id="connection-form" onSubmit={submit} className="space-y-5" noValidate>
        {generalError ? <ErrorCallout error={generalError} /> : null}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="ServiceNow address" hint="The address you use to open ServiceNow." error={fieldError("instanceUrl")}>
            {(props) => (
              <Input
                {...props}
                value={form.instanceUrl}
                onChange={(event) => set("instanceUrl", event.target.value)}
                placeholder="acme.service-now.com"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            )}
          </Field>
          <Field label="Name" optional hint="Shown when you create syncs." error={fieldError("name")}>
            {(props) => (
              <Input {...props} value={form.name} onChange={(event) => set("name", event.target.value)} placeholder={nameSuggestion || "Acme ServiceNow"} maxLength={80} />
            )}
          </Field>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-navy">How the app signs in to ServiceNow</p>
            {!methodsVisible ? (
              <button type="button" onClick={() => setShowMethods(true)} className="text-[13px] font-medium text-azure hover:underline">
                Use an OAuth client or API key instead
              </button>
            ) : null}
          </div>
          {methodsVisible ? (
            <ChoiceCards
              name="authType"
              label="Sign-in method"
              columns={3}
              value={form.authType}
              onChange={(value) => set("authType", value)}
              options={(["basic", "oauth", "apikey"] as const).map((type) => ({
                value: type,
                label: AUTH_TYPES[type].label,
                description: type === "basic" ? "Simplest" : type === "oauth" ? "Client ID and secret" : "Washington DC or later",
                icon: AUTH_ICONS[type],
              }))}
            />
          ) : null}
          <AuthHelp type={form.authType} />
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
          <Field label="API key" hint={secretHint} error={fieldError("auth.apiKey")}>
            {(props) => (
              <Input {...props} type="password" value={form.apiKey} onChange={(event) => set("apiKey", event.target.value)} autoComplete="new-password" placeholder={keepsSecret ? "••••••••" : ""} />
            )}
          </Field>
        )}

        <p className="flex items-center gap-1.5 text-xs text-navy/50">
          <Lock className="size-3.5" aria-hidden /> Passwords, secrets and keys are stored encrypted and never shown again.
        </p>
      </form>
    </Dialog>
  );
}
