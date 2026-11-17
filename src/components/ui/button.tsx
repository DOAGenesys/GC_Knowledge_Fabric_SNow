import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "subtle" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap select-none transition-[background-color,color,box-shadow,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white shadow-[0_8px_20px_-8px_rgb(255_69_26/0.6)] hover:bg-brand-hover",
  secondary: "bg-white text-navy ring-1 ring-inset ring-navy/15 hover:bg-nimbus hover:ring-navy/25",
  ghost: "text-navy hover:bg-navy/5",
  subtle: "bg-azure-soft text-azure hover:bg-azure/15",
  danger: "bg-danger text-white hover:bg-danger/90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-[15px]",
};

const ICON_ONLY: Record<ButtonSize, string> = { sm: "size-8", md: "size-10", lg: "size-12" };

export function buttonClasses(options: { variant?: ButtonVariant; size?: ButtonSize; iconOnly?: boolean; className?: string } = {}): string {
  const size = options.size ?? "md";
  return cn(BASE, VARIANTS[options.variant ?? "secondary"], options.iconOnly ? ICON_ONLY[size] : SIZES[size], options.className);
}

interface ButtonOwnProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
  /** Icon-only buttons must still describe themselves via aria-label. */
  iconOnly?: boolean;
}

export function Button({ variant, size, icon, loading, iconOnly, className, children, disabled, type = "button", ...rest }: ComponentProps<"button"> & ButtonOwnProps) {
  return (
    <button type={type} className={buttonClasses({ variant, size, iconOnly, className })} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}

export function ButtonLink({ variant, size, icon, iconOnly, className, children, ...rest }: ComponentProps<typeof Link> & Omit<ButtonOwnProps, "loading">) {
  return (
    <Link className={buttonClasses({ variant, size, iconOnly, className })} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
