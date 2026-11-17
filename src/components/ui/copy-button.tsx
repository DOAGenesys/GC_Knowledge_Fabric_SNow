"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "./cn";

export function CopyButton({ value, label = "Copy", size = "sm", className }: { value: string; label?: string; size?: "xs" | "sm"; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md text-navy/50 transition-colors hover:bg-navy/5 hover:text-navy",
        size === "xs" ? "size-6" : "size-8",
        copied && "text-patina-ink",
        className,
      )}
    >
      <Icon className={size === "xs" ? "size-3.5" : "size-4"} aria-hidden />
    </button>
  );
}
