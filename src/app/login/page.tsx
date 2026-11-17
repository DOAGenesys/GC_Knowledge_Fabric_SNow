import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import threads from "@/assets/threads.webp";
import { BrandIcon, GenesysLogo } from "@/components/brand";
import { LoginForm, type LoginNotice } from "@/components/login/login-form";
import { errorSpec } from "@/lib/errors";
import { normalizeRegion } from "@/lib/regions";

export const metadata: Metadata = { title: "Sign in" };

const FEATURES = [
  {
    icon: "connect" as const,
    title: "CSM and ITSM knowledge bases",
    text: "Pick the knowledge bases you need. Only published, current articles reach Genesys Cloud.",
  },
  {
    icon: "clock" as const,
    title: "Scheduled or on demand",
    text: "Sync every 15 minutes, daily or weekly, or whenever you click Sync now.",
  },
  {
    icon: "shield" as const,
    title: "Safe and self-healing",
    text: "Credentials are encrypted. Failed runs retry on their own and tell you exactly what to fix.",
  },
];

const SIGN_IN_CODES = new Set(["GC_LOGIN_FAILED", "ORG_NOT_ALLOWED", "GC_KNOWLEDGE_ACCESS_DENIED", "GC_UNAVAILABLE", "GC_RATE_LIMITED", "CONFIG_MISSING", "INTERNAL"]);

function noticeFor(code: string | null): LoginNotice | null {
  if (!code) return null;
  if (code === "UNAUTHENTICATED") return { tone: "info", title: "Please sign in again", message: "Your session ended. Sign in to pick up where you left off." };
  if (code === "VALIDATION") return { tone: "danger", title: "Check the sign-in details", message: "Pick a region and enter the OAuth client ID of the sign-in client." };
  if (code === "GC_PERMISSION_DENIED") {
    return {
      tone: "danger",
      title: "The sign-in client is missing scopes",
      message: "Genesys Cloud didn't let this app read your user and organization.",
      hint: "Add the users:readonly and organization:readonly scopes to the Code Authorization (PKCE) OAuth client, then sign in again.",
    };
  }
  const spec = errorSpec(SIGN_IN_CODES.has(code) ? code : "GC_LOGIN_FAILED");
  return { tone: "danger", title: spec.title, message: spec.message, hint: spec.hint };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const errorCode = typeof params.error === "string" ? params.error.slice(0, 60) : null;
  const returnTo = typeof params.returnTo === "string" && params.returnTo.startsWith("/") ? params.returnTo.slice(0, 500) : "";

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <section className="relative overflow-hidden bg-nimbus px-6 pt-8 pb-10 sm:px-10 lg:flex lg:w-[54%] lg:flex-col lg:px-16 lg:pt-12 lg:pb-0">
        <GenesysLogo width={124} />
        <div className="relative z-10 mt-10 max-w-xl lg:mt-auto lg:mb-auto lg:pt-8">
          <p className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-medium text-navy/70 shadow-card ring-1 ring-navy/5">
            <span className="size-1.5 rounded-full bg-brand" aria-hidden />
            Knowledge Sync for ServiceNow
          </p>
          <h1 className="mt-5 text-[34px] leading-[1.1] font-medium tracking-tight text-navy sm:text-[44px]">
            ServiceNow knowledge, always in step with <span className="text-brand">Genesys Cloud</span>.
          </h1>
          <p className="mt-4 max-w-lg text-base leading-relaxed text-navy/65">
            Connect your knowledge bases once. Every published article becomes searchable by Genesys Cloud bots, Copilot and agents, and stays current on its own.
          </p>
          <ul className="mt-9 hidden space-y-5 sm:block">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="flex gap-4">
                <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white shadow-card ring-1 ring-navy/5">
                  <BrandIcon name={feature.icon} size={30} />
                </span>
                <span>
                  <span className="block text-[15px] font-semibold text-navy">{feature.title}</span>
                  <span className="block text-sm leading-relaxed text-navy/60">{feature.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div aria-hidden className="pointer-events-none relative mt-10 hidden h-44 lg:block">
          <div className="bg-gen-gradient absolute -left-16 bottom-0 h-40 w-[78%] rounded-tr-full" />
          <Image src={threads} alt="" className="absolute bottom-0 left-0 w-[72%] max-w-[560px]" sizes="(min-width: 1024px) 40vw, 0px" priority />
        </div>
      </section>

      <section className="flex flex-1 items-center justify-center bg-white px-6 py-12 sm:px-10 lg:bg-nimbus-shade/50">
        <LoginForm
          notice={noticeFor(errorCode)}
          returnTo={returnTo}
          redirectUri={`${protocol}://${host}/api/auth/callback`}
          defaultRegion={normalizeRegion(process.env.NEXT_PUBLIC_DEFAULT_GENESYS_REGION) ?? "mypurecloud.com"}
          defaultClientId={process.env.NEXT_PUBLIC_DEFAULT_GENESYS_CLIENT_ID?.trim() ?? ""}
        />
      </section>
    </div>
  );
}
