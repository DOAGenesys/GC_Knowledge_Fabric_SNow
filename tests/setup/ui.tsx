import { cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetClientLogState } from "@/lib/client-log";
import { navigation } from "../ui/helpers/navigation";

vi.mock("next/navigation", async () => {
  const { navigation: state } = await import("../ui/helpers/navigation");
  return {
    useRouter: () => state.router,
    usePathname: () => state.pathname,
    useSearchParams: () => new URLSearchParams(),
    redirect: vi.fn(),
    notFound: vi.fn(),
  };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string | { pathname?: string }; children?: ReactNode } & Record<string, unknown>) => {
    const { prefetch, replace, scroll, ...anchorProps } = props;
    void prefetch;
    void replace;
    void scroll;
    return (
      <a href={typeof href === "string" ? href : (href.pathname ?? "")} {...anchorProps}>
        {children}
      </a>
    );
  },
}));

vi.mock("next/image", () => ({
  default: ({ src, alt, ...props }: { src: string | { src: string }; alt: string } & Record<string, unknown>) => {
    const { priority, unoptimized, fill, sizes, placeholder, blurDataURL, quality, loader, ...imageProps } = props;
    void [priority, unoptimized, fill, sizes, placeholder, blurDataURL, quality, loader];
    return <img src={typeof src === "string" ? src : src.src} alt={alt} {...imageProps} />;
  },
}));

beforeEach(() => {
  navigation.reset();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.cookie = "kf_csrf=test-csrf-token; path=/";
  resetClientLogState();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  for (const method of ["warn", "error"] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("%cKF")) return;
      original(...args);
    });
  }
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
