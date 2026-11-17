import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPkceVerifier,
  decryptCookie,
  decryptSecret,
  encryptCookie,
  encryptSecret,
  md5Base64,
  pkceChallenge,
  randomToken,
  sha256Hex,
  signPayload,
  timingSafeEqualStrings,
  verifyPayload,
} from "@/server/crypto";
import { allowedOrgIds, appVersion, configStatus, isProduction, requireEnv } from "@/server/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("stored secret encryption", () => {
  it("round-trips structured values", () => {
    const token = encryptSecret({ kind: "basic", username: "svc", password: "pw" }, "sn-connection:1");
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(decryptSecret(token, "sn-connection:1")).toEqual({ kind: "basic", username: "svc", password: "pw" });
  });

  it("uses a fresh IV every time", () => {
    expect(encryptSecret("same", "ctx")).not.toBe(encryptSecret("same", "ctx"));
  });

  it("binds the ciphertext to its context", () => {
    const token = encryptSecret("pw", "sn-connection:1");
    expect(decryptSecret(token, "sn-connection:2")).toBeNull();
  });

  it("rejects tampering, truncation and unknown versions", () => {
    const token = encryptSecret("pw", "ctx");
    const body = token.slice(3);
    const flipped = `v1.${body.slice(0, 20)}${body[20] === "A" ? "B" : "A"}${body.slice(21)}`;
    expect(decryptSecret(flipped, "ctx")).toBeNull();
    expect(decryptSecret("v1.short", "ctx")).toBeNull();
    expect(decryptSecret(`v2.${body}`, "ctx")).toBeNull();
    expect(decryptSecret("garbage", "ctx")).toBeNull();
  });

  it("fails closed after the key is rotated", () => {
    const token = encryptSecret("pw", "ctx");
    vi.stubEnv("APP_ENCRYPTION_KEY", "another-test-encryption-key-not-real-9876543210");
    expect(decryptSecret(token, "ctx")).toBeNull();
  });

  it("keeps cookie and data keys apart", () => {
    const cookie = encryptCookie({ a: 1 }, "kf_oauth");
    expect(decryptCookie(cookie, "kf_oauth")).toEqual({ a: 1 });
    expect(decryptCookie(cookie, "kf_other")).toBeNull();
    expect(decryptSecret(cookie, "kf_oauth")).toBeNull();
    expect(decryptCookie(undefined, "kf_oauth")).toBeNull();
  });
});

describe("signed payloads", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");

  it("verifies until the expiry, then fails", () => {
    const token = signPayload({ userId: "u1" }, 60, now);
    expect(verifyPayload(token, now + 59_000)).toEqual({ userId: "u1" });
    expect(verifyPayload(token, now + 60_000)).toBeNull();
  });

  it("rejects tampered bodies and signatures", () => {
    const token = signPayload({ userId: "u1" }, 60, now);
    const [body, signature] = token.split(".") as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ data: { userId: "admin" }, exp: 9_999_999_999 })).toString("base64url");
    expect(verifyPayload(`${forgedBody}.${signature}`, now)).toBeNull();
    expect(verifyPayload(`${body}.${signature.slice(0, -2)}xx`, now)).toBeNull();
    expect(verifyPayload(body, now)).toBeNull();
    expect(verifyPayload(`.${signature}`, now)).toBeNull();
    expect(verifyPayload(undefined, now)).toBeNull();
  });

  it("stops verifying when the session secret changes", () => {
    const token = signPayload({ userId: "u1" }, 60, now);
    vi.stubEnv("APP_SESSION_SECRET", "rotated-session-secret-not-real-0123456789");
    expect(verifyPayload(token, now)).toBeNull();
  });
});

describe("PKCE and helpers", () => {
  it("matches the RFC 7636 test vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates verifiers within the RFC length limits", () => {
    const verifier = createPkceVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createPkceVerifier()).not.toBe(verifier);
  });

  it("hashes and compares", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(md5Base64(new TextEncoder().encode("abc"))).toBe("kAFQmDzST7DWlj99KOF/cg==");
    expect(timingSafeEqualStrings("same", "same")).toBe(true);
    expect(timingSafeEqualStrings("same", "different")).toBe(false);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("environment", () => {
  it("names missing or short variables without showing values", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(() => requireEnv("CRON_SECRET")).toThrow(expect.objectContaining({ code: "CONFIG_MISSING", detail: "Environment variable CRON_SECRET is not set" }));
    vi.stubEnv("CRON_SECRET", "short-value");
    expect(() => requireEnv("CRON_SECRET")).toThrow(expect.objectContaining({ detail: expect.stringContaining("too short") }));
    try {
      requireEnv("CRON_SECRET");
    } catch (error) {
      expect(JSON.stringify({ ...(error as object), message: (error as Error).message })).not.toContain("short-value");
    }
  });

  it("reports presence as booleans only", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(configStatus()).toEqual({ APP_SESSION_SECRET: true, APP_ENCRYPTION_KEY: true, CRON_SECRET: true, DATABASE_URL: false });
  });

  it("parses the organization allowlist", () => {
    vi.stubEnv("APP_ALLOWED_ORG_IDS", "");
    expect(allowedOrgIds()).toBeNull();
    vi.stubEnv("APP_ALLOWED_ORG_IDS", " AAA-1, bbb-2\nccc-3 ");
    expect([...(allowedOrgIds() ?? [])]).toEqual(["aaa-1", "bbb-2", "ccc-3"]);
    vi.stubEnv("APP_ALLOWED_ORG_IDS", " , ");
    expect(allowedOrgIds()).toBeNull();
  });

  it("knows the runtime mode and version", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isProduction()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.2.3");
    expect(appVersion()).toBe("1.2.3");
  });
});
