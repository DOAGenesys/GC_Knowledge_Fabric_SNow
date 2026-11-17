import { vi } from "vitest";

/** State behind the next/navigation mock (see tests/setup/ui.tsx). */
export const navigation = {
  pathname: "/",
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  },
  reset() {
    this.pathname = "/";
    for (const fn of Object.values(this.router)) fn.mockReset();
  },
};
