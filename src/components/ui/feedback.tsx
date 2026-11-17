import Image from "next/image";
import type { ReactNode } from "react";
import { cn } from "./cn";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

export function EmptyState({
  illustration,
  title,
  children,
  action,
  className,
}: {
  illustration?: string;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      {illustration ? (
        <div className="bg-gen-gradient mb-5 grid size-24 place-items-center rounded-full">
          <Image src={illustration} alt="" width={56} height={56} unoptimized />
        </div>
      ) : null}
      <h3 className="text-lg font-semibold text-navy">{title}</h3>
      {children ? <div className="mt-1.5 max-w-md text-sm leading-relaxed text-navy/60">{children}</div> : null}
      {action ? <div className="mt-6 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function ProgressBar({ value, active, tone = "azure", className, label }: { value: number | null; active?: boolean; tone?: "azure" | "patina" | "danger"; className?: string; label?: string }) {
  const percent = value === null ? 100 : Math.max(0, Math.min(100, Math.round(value * 100)));
  const fill = tone === "patina" ? "bg-patina" : tone === "danger" ? "bg-danger" : "bg-azure";
  return (
    <div
      className={cn("h-2 w-full overflow-hidden rounded-full bg-navy/[0.07]", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : percent}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out", fill, (active || value === null) && "progress-active", value === null && "opacity-60")} style={{ width: `${Math.max(percent, 4)}%` }} />
    </div>
  );
}
