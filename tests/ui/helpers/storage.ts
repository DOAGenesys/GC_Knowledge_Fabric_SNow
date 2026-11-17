import { vi } from "vitest";

/** Replaces localStorage with one that throws, like a browser with storage blocked. Undone by vi.unstubAllGlobals(). */
export function blockStorage(): void {
  const fail = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail, clear: fail, key: fail, length: 0 });
}
