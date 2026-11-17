"use client";

import { ChevronDown } from "lucide-react";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "./cn";

const CONTROL =
  "w-full rounded-xl bg-white text-[15px] text-navy ring-1 ring-inset ring-navy/15 outline-none transition-shadow placeholder:text-navy/35 hover:ring-navy/25 focus:ring-2 focus:ring-azure disabled:cursor-not-allowed disabled:bg-nimbus disabled:text-navy/50 aria-invalid:ring-2 aria-invalid:ring-danger/70";

export function Field({
  label,
  hint,
  error,
  optional,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  className?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="flex items-baseline justify-between gap-2 text-sm font-medium text-navy">
        <span>{label}</span>
        {optional ? <span className="text-xs font-normal text-navy/45">Optional</span> : null}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p id={errorId} className="text-[13px] font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[13px] text-navy/55">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cn(CONTROL, "h-11 px-3.5", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cn(CONTROL, "min-h-20 px-3.5 py-2.5 font-mono text-[13px]", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentProps<"select">) {
  return (
    <div className="relative">
      <select className={cn(CONTROL, "h-11 appearance-none pr-10 pl-3.5", className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-navy/50" aria-hidden />
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
          checked ? "bg-azure" : "bg-navy/20",
        )}
      >
        <span className={cn("inline-block size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[22px]" : "translate-x-0.5")} />
      </button>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium text-navy">{label}</span>
        {description ? <span className="block text-[13px] text-navy/55">{description}</span> : null}
      </label>
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/** Radio group rendered as selectable cards. */
export function ChoiceCards<T extends string>({
  name,
  value,
  onChange,
  options,
  columns = 2,
  label,
}: {
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<ChoiceOption<T>>;
  columns?: 2 | 3 | 4;
  label: string;
}) {
  const compact = columns === 4;
  const grid = compact ? "grid-cols-2 sm:grid-cols-4" : columns === 3 ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2";
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid gap-2.5", grid)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={cn(
              "group relative flex cursor-pointer rounded-xl bg-white ring-1 transition-all ring-inset has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-azure",
              compact ? "flex-col items-center gap-1.5 px-2 py-3 text-center" : "gap-3 p-3.5",
              selected ? "ring-2 ring-azure shadow-[0_6px_18px_-10px_rgb(34_67_162/0.5)]" : "ring-navy/12 hover:ring-navy/25",
              option.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.icon ? <span className={cn("shrink-0", !compact && "mt-0.5", selected ? "text-azure" : "text-navy/50")}>{option.icon}</span> : null}
            <span className="min-w-0">
              <span className="block text-sm font-medium text-navy">{option.label}</span>
              {option.description ? <span className="mt-0.5 block text-[13px] leading-snug text-navy/55">{option.description}</span> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function Checkbox({ label, description, className, ...rest }: Omit<ComponentProps<"input">, "type"> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", className)}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 rounded accent-azure" {...rest} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-navy">{label}</span>
        {description ? <span className="block text-[13px] text-navy/55">{description}</span> : null}
      </span>
    </label>
  );
}
