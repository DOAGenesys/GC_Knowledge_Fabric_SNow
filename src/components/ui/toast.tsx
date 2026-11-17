"use client";

import { CircleCheck, CircleExclamationPoint, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { isApiError } from "@/lib/api-client";
import { cn } from "./cn";

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

interface ToastApi {
  success(title: string, message?: string): void;
  info(title: string, message?: string): void;
  /** Shows an API error's title, message and hint; other values show the fallback text. */
  error(error: unknown, fallbackTitle?: string, fallbackMessage?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS = { success: CircleCheck, error: CircleExclamationPoint, info: Info } as const;
const ICON_COLORS = { success: "text-patina", error: "text-danger", info: "text-azure" } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);

  const push = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      const id = nextId.current++;
      setToasts((current) => [...current.filter((item) => item.title !== toast.title || item.message !== toast.message).slice(-3), { ...toast, id }]);
      setTimeout(() => dismiss(id), toast.tone === "error" ? 9000 : 5000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, message) => push({ tone: "success", title, message }),
      info: (title, message) => push({ tone: "info", title, message }),
      error: (error, fallbackTitle = "Something went wrong", fallbackMessage = "Please try again in a moment.") => {
        if (isApiError(error)) {
          if (error.status === 401) return;
          push({ tone: "error", title: error.title, message: [error.message, error.hint].filter(Boolean).join(" ") });
        } else {
          push({ tone: "error", title: fallbackTitle, message: fallbackMessage });
        }
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.tone];
          return (
            <div
              key={toast.id}
              role={toast.tone === "error" ? "alert" : "status"}
              className="pointer-events-auto flex w-full max-w-sm animate-fade-in gap-3 rounded-xl bg-navy p-4 text-white shadow-raised"
            >
              <Icon className={cn("mt-0.5 size-5 shrink-0", ICON_COLORS[toast.tone])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{toast.title}</p>
                {toast.message ? <p className="mt-0.5 text-[13px] leading-snug text-white/75">{toast.message}</p> : null}
              </div>
              <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss" className="-m-1 rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}
