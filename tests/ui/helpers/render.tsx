import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { SWRConfig } from "swr";
import { ToastProvider } from "@/components/ui/toast";

/** Renders with a fresh SWR cache (no retries, no focus revalidation) and the toast provider. */
export function renderUi(ui: ReactElement) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false, revalidateOnFocus: false }}>
      <ToastProvider>{ui}</ToastProvider>
    </SWRConfig>,
  );
}
