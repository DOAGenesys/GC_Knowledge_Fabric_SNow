import Image from "next/image";
import { cn } from "./ui/cn";

export const APP_NAME = "Knowledge Sync";
export const APP_TAGLINE = "for ServiceNow";

/** Full-colour Genesys logo, for light backgrounds only. */
export function GenesysLogo({ className, width = 112 }: { className?: string; width?: number }) {
  return <Image src="/brand/genesys-logo.svg" alt="Genesys" width={width} height={Math.round((width * 121) / 655)} className={cn("h-auto", className)} priority unoptimized />;
}

export function AppWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-baseline gap-1.5 leading-none", className)}>
      <span className="text-[15px] font-semibold tracking-tight text-navy">{APP_NAME}</span>
      <span className="text-[13px] font-normal text-navy/55">{APP_TAGLINE}</span>
    </span>
  );
}

/** Small illustrative brand icon (light-background variant). */
export function BrandIcon({ name, size = 40, className }: { name: "connect" | "clock" | "shield" | "cloud" | "gear" | "linked" | "end-to-end" | "search"; size?: number; className?: string }) {
  return <Image src={`/brand/icon-${name}.svg`} alt="" width={size} height={size} className={className} unoptimized />;
}
