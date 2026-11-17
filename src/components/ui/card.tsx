import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export function Card({ className, ...rest }: ComponentProps<"div">) {
  return <div className={cn("rounded-2xl bg-white shadow-card ring-1 ring-navy/[0.06]", className)} {...rest} />;
}

export function CardHeader({ title, description, action, icon, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-4 px-6 pt-6", className)}>
      {icon}
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold tracking-tight text-navy">{title}</h2>
        {description ? <p className="mt-1 text-sm text-navy/65">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3", className)}>
      <h2 className="text-[13px] font-semibold tracking-[0.08em] text-navy/55 uppercase">{children}</h2>
      {action}
    </div>
  );
}
