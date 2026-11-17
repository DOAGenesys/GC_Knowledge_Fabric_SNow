import { describe, expect, it } from "vitest";
import { AppError, ERROR_CATALOG, errorSpec, isAppError, isErrorCode, toErrorRecord } from "@/lib/errors";

describe("error catalog", () => {
  it.each(Object.entries(ERROR_CATALOG))("%s is complete and written for people", (code, spec) => {
    expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(spec.status).toBeGreaterThanOrEqual(400);
    expect(spec.status).toBeLessThan(600);
    expect(spec.title.length).toBeGreaterThan(2);
    expect(spec.title).not.toMatch(/[.!]$/);
    expect(spec.message).toMatch(/[.!?]$/);
    expect(spec.message).not.toMatch(/undefined|null|\$\{/);
    if ("hint" in spec && spec.hint) expect(spec.hint).toMatch(/[.!?)]$/);
    expect(typeof spec.retryable).toBe("boolean");
  });

  it("looks codes up safely", () => {
    expect(isErrorCode("GC_AUTH_FAILED")).toBe(true);
    expect(isErrorCode("toString")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(errorSpec("NOPE")).toBe(ERROR_CATALOG.INTERNAL);
    expect(errorSpec("GC_AUTH_FAILED")).toBe(ERROR_CATALOG.GC_AUTH_FAILED);
  });
});

describe("AppError", () => {
  it("takes its defaults from the catalog", () => {
    const error = new AppError("GC_AUTH_FAILED");
    expect(error.message).toBe(ERROR_CATALOG.GC_AUTH_FAILED.message);
    expect(error.status).toBe(ERROR_CATALOG.GC_AUTH_FAILED.status);
    expect(error.retryable).toBe(ERROR_CATALOG.GC_AUTH_FAILED.retryable);
    expect(error.name).toBe("AppError");
    expect(isAppError(error)).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
  });

  it("accepts overrides and keeps the cause", () => {
    const cause = new Error("root");
    const error = new AppError("VALIDATION", { message: "Bad.", hint: "Fix it.", status: 422, retryable: true, cause, detail: "d" });
    expect(error).toMatchObject({ message: "Bad.", hint: "Fix it.", status: 422, retryable: true, detail: "d" });
    expect(error.cause).toBe(cause);
  });

  it("builds a response body without technical detail", () => {
    const error = new AppError("VALIDATION", { detail: "internal context", fields: [{ path: "name", message: "Required." }] });
    const body = error.toBody("req-1");
    expect(body).toEqual({
      error: {
        code: "VALIDATION",
        title: ERROR_CATALOG.VALIDATION.title,
        message: ERROR_CATALOG.VALIDATION.message,
        ...("hint" in ERROR_CATALOG.VALIDATION ? { hint: ERROR_CATALOG.VALIDATION.hint } : {}),
        fields: [{ path: "name", message: "Required." }],
        requestId: "req-1",
      },
    });
    expect(JSON.stringify(body)).not.toContain("internal context");
  });

  it("redacts secrets that slipped into a message", () => {
    const error = new AppError("SN_BAD_RESPONSE", { message: "Upstream said: access_token=abc123" });
    expect(error.toBody().error.message).toBe("Upstream said: access_token=[REDACTED]");
  });
});

describe("toErrorRecord", () => {
  it("keeps everything useful from an AppError, redacted", () => {
    const record = toErrorRecord(new AppError("GC_INGESTION_FAILED", { detail: "url https://s3.test/x?X-Amz-Signature=abc", message: "Failed: Bearer abcdefgh" }));
    expect(record).toEqual({
      code: "GC_INGESTION_FAILED",
      message: "Failed: Bearer [REDACTED]",
      ...("hint" in ERROR_CATALOG.GC_INGESTION_FAILED ? { hint: ERROR_CATALOG.GC_INGESTION_FAILED.hint } : {}),
      detail: "url https://s3.test/x?X-Amz-Signature=[REDACTED]",
      retryable: ERROR_CATALOG.GC_INGESTION_FAILED.retryable,
    });
  });

  it("never copies the message of an unexpected error", () => {
    const record = toErrorRecord(new TypeError("connection string postgres://u:p@h/db leaked"));
    expect(record.code).toBe("INTERNAL");
    expect(record.message).toBe(ERROR_CATALOG.INTERNAL.message);
    expect(record.detail).toBe("TypeError");
    expect(JSON.stringify(record)).not.toContain("postgres");
  });

  it("uses the fallback code for unknown errors", () => {
    expect(toErrorRecord("weird", "SN_UNAVAILABLE")).toMatchObject({ code: "SN_UNAVAILABLE", detail: "Error" });
  });
});
