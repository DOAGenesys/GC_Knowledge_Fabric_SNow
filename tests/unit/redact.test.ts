import { describe, expect, it } from "vitest";
import { isSensitiveKey, redactString, redactValue, serializeError } from "@/lib/redact";

const REDACTED = "[REDACTED]";

describe("redactString", () => {
  it.each([
    ["Authorization: Bearer abc.def-ghi_123", "Authorization: Bearer [REDACTED]"],
    ["header Basic dXNlcjpwYXNz", "header Basic [REDACTED]"],
    ["https://x.test/cb?code=abc123&state=xyz", "https://x.test/cb?code=[REDACTED]&state=[REDACTED]"],
    ["grant_type=client_credentials&client_secret=s3cr3t", "grant_type=client_credentials&client_secret=[REDACTED]"],
    [
      "https://s3.test/f?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA/x",
      "https://s3.test/f?X-Amz-Signature=[REDACTED]&X-Amz-Credential=[REDACTED]",
    ],
    ['{"access_token":"tok123","other":"ok"}', '{"access_token":"[REDACTED]","other":"ok"}'],
    ['{"refresh_token": "r-1", "password":"pw"}', '{"refresh_token":"[REDACTED]", "password":"[REDACTED]"}'],
    ["db at postgres://user:pw@host/db?sslmode=require failed", "db at postgres://[REDACTED] failed"],
    [
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", // gitleaks:allow
      "token [REDACTED_JWT]",
    ],
  ])("redacts %s", (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it.each(["Uploaded 42 articles in 3.2s", "code: GC_AUTH_FAILED", "state of the art (sig not included)", "Bearer"])("leaves %s alone", (text) => {
    expect(redactString(text)).toBe(text);
  });

  it("truncates very long strings and says how much was cut", () => {
    const result = redactString("a".repeat(3000));
    expect(result.startsWith("a".repeat(2000))).toBe(true);
    expect(result).toContain("(1000 more chars)");
  });
});

describe("isSensitiveKey", () => {
  it.each(["password", "clientSecret", "client_secret", "Authorization", "cookie", "set-cookie", "x-sn-apikey", "apiKey", "codeVerifier", "signature", "oauth_state", "sessionToken", "csrfToken", "privateKey", "connectionString", "databaseUrl"])(
    "treats %s as sensitive",
    (key) => expect(isSensitiveKey(key)).toBe(true),
  );

  it.each(["name", "status", "syncId", "detail", "state", "code", "durationMs", "host", "passed", "bypassCache"])("treats %s as safe", (key) =>
    expect(isSensitiveKey(key)).toBe(false),
  );
});

describe("redactValue", () => {
  it("redacts nested sensitive keys but keeps the structure", () => {
    const input = { user: "ada", auth: { password: "x", clientSecret: "y" }, list: [{ token: "t", id: 1 }] };
    expect(redactValue(input)).toEqual({
      user: "ada",
      auth: { password: REDACTED, clientSecret: REDACTED },
      list: [{ token: REDACTED, id: 1 }],
    });
  });

  it("keeps booleans and empty values under sensitive keys (they reveal nothing)", () => {
    expect(redactValue({ hasPassword: true, password: "", token: null })).toEqual({ hasPassword: true, password: "", token: null });
  });

  it("redacts secrets inside string values", () => {
    expect(redactValue({ url: "https://x.test/?code=abc" })).toEqual({ url: "https://x.test/?code=[REDACTED]" });
  });

  it("handles cycles, depth, big arrays and special objects", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;
    expect(redactValue(cyclic)).toEqual({ name: "a", self: "[Circular]" });

    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 8; index += 1) deep = { next: deep };
    expect(JSON.stringify(redactValue(deep))).toContain("[Truncated]");

    const list = redactValue(Array.from({ length: 60 }, (_, index) => index)) as unknown[];
    expect(list).toHaveLength(51);
    expect(list.at(-1)).toBe("… 10 more");

    expect(redactValue(new Map([["a", 1]]))).toBe("[Map size=1]");
    expect(redactValue(new Set([1, 2]))).toBe("[Set size=2]");
    expect(redactValue(new Uint8Array(3))).toBe("[binary 3 bytes]");
    expect(redactValue(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(redactValue(new Date("nope"))).toBe("Invalid Date");
    expect(redactValue(10n)).toBe("10");
    expect(redactValue({ fn: () => 1, keep: 1 })).toEqual({ keep: 1 });
    expect(redactValue(new URL("https://x.test/?state=abc"))).toBe("https://x.test/?state=[REDACTED]");
  });
});

describe("serializeError", () => {
  it("keeps name, message, code and status, redacted", () => {
    const error = Object.assign(new Error("call failed: Bearer abcdefghijk"), { code: "E_FAIL", status: 503 });
    const serialized = serializeError(error);
    expect(serialized).toMatchObject({ name: "Error", message: "call failed: Bearer [REDACTED]", code: "E_FAIL", status: 503 });
    expect(serialized.stack).toBeUndefined();
  });

  it("adds a short stack only when asked", () => {
    const serialized = serializeError(new Error("boom"), { stack: true });
    expect(serialized.stack).toBeDefined();
    expect(serialized.stack!.split("\n").length).toBeLessThanOrEqual(10);
  });

  it("follows causes a few levels deep, redacted and without stacks", () => {
    const error = new Error("outer", { cause: new Error("inner token=abc", { cause: new Error("innermost") }) });
    const serialized = serializeError(error, { stack: true });
    expect(serialized.cause?.message).toBe("inner token=[REDACTED]");
    expect(serialized.cause?.stack).toBeUndefined();
    expect(serialized.cause?.cause?.message).toBe("innermost");

    let chain: Error = new Error("root");
    for (let index = 0; index < 6; index += 1) chain = new Error(`level ${index}`, { cause: chain });
    expect(JSON.stringify(serializeError(chain))).not.toContain("root");
  });

  it("describes non-Error throwables", () => {
    expect(serializeError("plain")).toEqual({ name: "NonError", message: "plain" });
    expect(serializeError({ password: "x" }).message).not.toContain('"x"');
  });
});
