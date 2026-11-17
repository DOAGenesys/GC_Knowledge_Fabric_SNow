import type { ReactNode } from "react";
import type { Tone } from "@/lib/ui-text";
import { cn } from "./cn";

const TONES: Record<Tone, { pill: string; dot: string }> = {
  success: { pill: "bg-patina-soft text-patina-ink", dot: "bg-patina" },
  warning: { pill: "bg-amber-soft text-amber-ink", dot: "bg-amber" },
  danger: { pill: "bg-danger-soft text-danger", dot: "bg-danger" },
  info: { pill: "bg-azure-soft text-azure", dot: "bg-azure" },
  active: { pill: "bg-azure-soft text-azure", dot: "bg-azure animate-soft-pulse" },
  neutral: { pill: "bg-nimbus-shade text-navy/70", dot: "bg-navy/35" },
};

export function StatusBadge({ tone, children, className, size = "md" }: { tone: Tone; children: ReactNode; className?: string; size?: "sm" | "md" }) {
  const style = TONES[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        style.pill,
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} aria-hidden />
      {children}
    </span>
  );
}

export function Chip({ children, className, icon }: { children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md bg-arctic-soft px-2 py-0.5 text-xs font-medium text-navy/80", className)}>
      {icon}
      {children}
    </span>
  );
}
