"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "./cn";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  count?: number | null;
  attention?: boolean;
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: ReadonlyArray<TabItem<T>>; value: T; onChange: (id: T) => void; label: string }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = tabs.findIndex((tab) => tab.id === value);
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    if (next) {
      onChange(next.id);
      document.getElementById(`tab-${next.id}`)?.focus();
    }
  }

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-6 overflow-x-auto border-b border-navy/10">
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative -mb-px flex items-center gap-2 border-b-2 pt-1 pb-3 text-sm font-medium whitespace-nowrap transition-colors",
              selected ? "border-brand text-navy" : "border-transparent text-navy/55 hover:text-navy",
            )}
          >
            {tab.label}
            {tab.count !== undefined && tab.count !== null ? (
              <span className={cn("rounded-full px-1.5 py-px text-[11px] font-semibold", tab.attention ? "bg-danger-soft text-danger" : "bg-navy/[0.07] text-navy/60")}>{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="animate-fade-in pt-6">
      {children}
    </div>
  );
}
