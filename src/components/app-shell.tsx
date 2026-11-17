"use client";

import { Bug, ChevronDown, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { SWRConfig } from "swr";
import { isApiError, swrFetcher } from "@/lib/api-client";
import { clientLogger, isDebugEnabled, setDebug } from "@/lib/client-log";
import { AppWordmark, GenesysLogo } from "./brand";
import { cn } from "./ui/cn";
import { Switch } from "./ui/field";
import { ToastProvider } from "./ui/toast";

const log = clientLogger("shell");

const NAV = [
  { href: "/", label: "Syncs", isActive: (path: string) => path === "/" || path.startsWith("/syncs") },
  { href: "/connections", label: "Connections", isActive: (path: string) => path.startsWith("/connections") },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

function UserMenu({ user, org }: { user: { name: string }; org: { name: string; region: string } }) {
  const [open, setOpen] = useState(false);
  const [debug, setDebugState] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setDebugState(isDebugEnabled()), []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch (error) {
      log.warn("Sign-out request failed", { err: error });
    }
    window.location.assign("/login");
  }

  function toggleDebug(enabled: boolean) {
    setDebug(enabled);
    setDebugState(enabled);
    log.info(enabled ? "Verbose logging turned on" : "Verbose logging turned off");
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2.5 rounded-full py-1 pr-2 pl-1 transition-colors hover:bg-navy/5"
      >
        <span className="grid size-8 place-items-center rounded-full bg-navy text-xs font-semibold text-white">{initials(user.name)}</span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-[13px] font-medium text-navy">{user.name}</span>
          <span className="block max-w-44 truncate text-[11px] text-navy/55">{org.name}</span>
        </span>
        <ChevronDown className={cn("size-4 text-navy/50 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-72 animate-fade-in rounded-2xl bg-white p-2 shadow-raised ring-1 ring-navy/10">
          <div className="px-3 pt-2 pb-3">
            <p className="text-sm font-semibold text-navy">{user.name}</p>
            <p className="text-[13px] text-navy/60">{org.name}</p>
            <p className="text-xs text-navy/45">{org.region}</p>
          </div>
          <div className="border-t border-navy/[0.07] px-3 py-3">
            <Switch
              checked={debug}
              onChange={toggleDebug}
              label={
                <span className="flex items-center gap-1.5">
                  <Bug className="size-3.5" aria-hidden /> Verbose logging
                </span>
              }
              description="Detailed logs in the browser console and server logs, for troubleshooting."
            />
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            disabled={signingOut}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-navy transition-colors hover:bg-navy/5 disabled:opacity-50"
          >
            <LogOut className="size-4" aria-hidden /> {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({ user, org, version, children }: { user: { name: string }; org: { name: string; region: string }; version: string; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <SWRConfig
      value={{
        fetcher: swrFetcher,
        shouldRetryOnError: (error) => !(isApiError(error) && error.status >= 400 && error.status < 500),
        errorRetryCount: 3,
        dedupingInterval: 2_000,
        focusThrottleInterval: 10_000,
      }}
    >
      <ToastProvider>
        <div className="flex min-h-dvh flex-col">
          <header className="sticky top-0 z-30 border-b border-navy/[0.07] bg-white/85 backdrop-blur-md">
            <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
              <Link href="/" className="flex shrink-0 items-center gap-3" aria-label="Knowledge Sync home">
                <GenesysLogo width={92} />
                <span className="hidden h-5 w-px bg-navy/15 sm:block" aria-hidden />
                <AppWordmark className="hidden sm:flex" />
              </Link>
              <nav className="ml-2 flex items-center gap-1" aria-label="Main">
                {NAV.map((item) => {
                  const active = item.isActive(pathname);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "rounded-full px-3.5 py-2 text-sm font-medium transition-colors",
                        active ? "bg-navy text-white" : "text-navy/65 hover:bg-navy/5 hover:text-navy",
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
              <div className="ml-auto">
                <UserMenu user={user} org={org} />
              </div>
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
          <footer className="border-t border-navy/[0.06]">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-xs text-navy/45 sm:px-6">
              <span>ServiceNow knowledge → Genesys Cloud Knowledge</span>
              <span>Version {version}</span>
            </div>
          </footer>
        </div>
      </ToastProvider>
    </SWRConfig>
  );
}
