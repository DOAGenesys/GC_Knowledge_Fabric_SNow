"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { cn } from "./cn";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-visible rounded-2xl bg-transparent p-0 text-navy backdrop:animate-fade-in open:animate-fade-in",
        size === "sm" ? "max-w-md" : size === "lg" ? "max-w-3xl" : "max-w-xl",
      )}
    >
      {open ? (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col rounded-2xl bg-white shadow-raised">
          <div className="flex items-start gap-4 border-b border-navy/[0.07] px-6 py-5">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
              {description ? <p className="mt-1 text-sm text-navy/60">{description}</p> : null}
            </div>
            <Button variant="ghost" size="sm" iconOnly aria-label="Close" onClick={onClose} icon={<X className="size-4" />} />
          </div>
          {children ? <div className="overflow-y-auto px-6 py-5">{children}</div> : null}
          {footer ? <div className="flex flex-wrap justify-end gap-2 rounded-b-2xl border-t border-navy/[0.07] bg-nimbus/60 px-6 py-4">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  tone = "primary",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<unknown> | void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      // The caller reports the error (toast); keep the dialog open so the user can retry.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={confirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ? <div className="space-y-2 text-sm leading-relaxed text-navy/70">{children}</div> : null}
    </Dialog>
  );
}
