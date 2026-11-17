"use client";

import { ArrowRight, ChevronDown } from "lucide-react";
import Image from "next/image";
import { type FormEvent, useEffect, useState } from "react";
import { clientLogger } from "@/lib/client-log";
import { GENESYS_REGIONS } from "@/lib/regions";
import { Button } from "../ui/button";
import { Callout } from "../ui/callout";
import { CopyButton } from "../ui/copy-button";
import { Field, Input, Select } from "../ui/field";

const STORAGE_KEY = "kf:login";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AREAS = ["Americas", "EMEA", "Asia Pacific"] as const;
const log = clientLogger("login");

export interface LoginNotice {
  tone: "info" | "danger";
  title: string;
  message: string;
  hint?: string;
}

export function LoginForm({
  notice,
  returnTo,
  redirectUri,
  defaultRegion,
  defaultClientId,
}: {
  notice: LoginNotice | null;
  returnTo: string;
  redirectUri: string;
  defaultRegion: string;
  defaultClientId: string;
}) {
  const [region, setRegion] = useState(defaultRegion);
  const [clientId, setClientId] = useState(defaultClientId);
  const [clientIdError, setClientIdError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as { region?: string; clientId?: string } | null;
      if (saved?.region && GENESYS_REGIONS.some((item) => item.host === saved.region)) setRegion(saved.region);
      if (saved?.clientId && UUID.test(saved.clientId)) setClientId(saved.clientId);
    } catch {
      // Nothing remembered yet.
    }
    if (notice?.tone === "danger") log.warn(`Sign-in problem shown: ${notice.title}`);
  }, [notice]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const value = clientId.trim();
    if (!UUID.test(value)) {
      event.preventDefault();
      setClientIdError("Enter the OAuth client ID: a GUID like 1a2b3c4d-1234-5678-9abc-def012345678.");
      return;
    }
    setClientIdError(undefined);
    setSubmitting(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ region, clientId: value }));
    } catch {
      // Remembering is a convenience only.
    }
  }

  return (
    <div className="w-full max-w-[420px] animate-fade-in">
      <div className="rounded-3xl bg-white p-8 shadow-raised ring-1 ring-navy/5 sm:p-10">
        <Image src="/brand/genesys-cloud-mark.svg" alt="" width={46} height={30} unoptimized />
        <h2 className="mt-5 text-2xl font-semibold tracking-tight text-navy">Sign in with Genesys Cloud</h2>
        <p className="mt-1.5 text-sm text-navy/60">Use your Genesys Cloud account. You&apos;ll come straight back here.</p>

        {notice ? (
          <Callout tone={notice.tone} title={notice.title} className="mt-6">
            <p>{notice.message}</p>
            {notice.hint ? <p className="text-navy/65">{notice.hint}</p> : null}
          </Callout>
        ) : null}

        <form method="get" action="/api/auth/login" onSubmit={onSubmit} className="mt-7 space-y-5" noValidate>
          {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
          <Field label="Region">
            {(props) => (
              <Select {...props} name="region" value={region} onChange={(event) => setRegion(event.target.value)}>
                {AREAS.map((area) => (
                  <optgroup key={area} label={area}>
                    {GENESYS_REGIONS.filter((item) => item.area === area).map((item) => (
                      <option key={item.host} value={item.host}>
                        {item.label} · {item.host}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
          <Field label="OAuth client ID" hint="The Code Authorization (PKCE) client registered for this app." error={clientIdError}>
            {(props) => (
              <Input
                {...props}
                name="clientId"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-[14px]"
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
            Continue to Genesys Cloud {submitting ? null : <ArrowRight className="size-4" aria-hidden />}
          </Button>
        </form>

        <details className="group mt-7 rounded-xl bg-nimbus px-4 py-3 text-sm text-navy/70 open:pb-4">
          <summary className="flex list-none items-center justify-between font-medium text-navy [&::-webkit-details-marker]:hidden">
            First time here? Set up the OAuth client
            <ChevronDown className="size-4 text-navy/50 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <ol className="mt-3 list-decimal space-y-2 pl-5 leading-relaxed marker:text-navy/40">
            <li>
              In Genesys Cloud, open <strong className="font-medium text-navy">Admin → Integrations → OAuth</strong> and add a client.
            </li>
            <li>
              Grant type: <strong className="font-medium text-navy">Code Authorization (PKCE)</strong>.
            </li>
            <li>
              Authorized redirect URI:
              <span className="mt-1.5 flex items-center gap-1 rounded-lg bg-white py-1 pr-1 pl-2.5 ring-1 ring-navy/10">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-navy">{redirectUri}</code>
                <CopyButton value={redirectUri} label="Copy redirect URI" />
              </span>
            </li>
            <li>
              Scopes: <code className="font-mono text-[12px]">users:readonly</code> and <code className="font-mono text-[12px]">organization:readonly</code>. Sign-in only
              confirms who you are; syncs use separate credentials you add later.
            </li>
          </ol>
        </details>
      </div>
      <p className="mt-6 text-center text-xs text-navy/45">Genesys Cloud and ServiceNow credentials are never shown again after you save them.</p>
    </div>
  );
}
