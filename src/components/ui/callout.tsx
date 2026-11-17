import { CircleCheck, CircleExclamationPoint, Info, TriangleExclamationPoint } from "lucide-react";
import type { ReactNode } from "react";
import { isApiError } from "@/lib/api-client";
import { cn } from "./cn";
import { CopyButton } from "./copy-button";

type CalloutTone = "info" | "success" | "warning" | "danger";

const STYLES: Record<CalloutTone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: "bg-azure-soft/70 ring-azure/15", icon: "text-azure", Icon: Info },
  success: { box: "bg-patina-soft ring-patina/25", icon: "text-patina-ink", Icon: CircleCheck },
  warning: { box: "bg-amber-soft ring-amber/30", icon: "text-amber-ink", Icon: TriangleExclamationPoint },
  danger: { box: "bg-danger-soft ring-danger/20", icon: "text-danger", Icon: CircleExclamationPoint },
};

export function Callout({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const style = STYLES[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex gap-3 rounded-xl p-4 ring-1 ring-inset", style.box, className)}>
      <style.Icon className={cn("mt-0.5 size-5 shrink-0", style.icon)} aria-hidden />
      <div className="min-w-0 flex-1 text-sm text-navy/80">
        {title ? <p className="font-semibold text-navy">{title}</p> : null}
        {children ? <div className={cn(title ? "mt-1" : "", "space-y-1 leading-relaxed")}>{children}</div> : null}
        {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

/** Explains a failed request: what happened, what to do, and the request ID for support. */
export function ErrorCallout({ error, action, className, tone = "danger" }: { error: unknown; action?: ReactNode; className?: string; tone?: "danger" | "warning" }) {
  const apiError = isApiError(error) ? error : null;
  const title = apiError?.title ?? "Something went wrong";
  const message = apiError?.message ?? "An unexpected error occurred. Please try again.";
  return (
    <Callout tone={tone} title={title} action={action} className={className}>
      <p>{message}</p>
      {apiError?.hint ? <p className="text-navy/70">{apiError.hint}</p> : null}
      {apiError?.requestId ? (
        <p className="flex items-center gap-1.5 pt-1 text-xs text-navy/50">
          Request ID <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px]">{apiError.requestId}</code>
          <CopyButton value={apiError.requestId} label="Copy request ID" size="xs" />
        </p>
      ) : null}
    </Callout>
  );
}
