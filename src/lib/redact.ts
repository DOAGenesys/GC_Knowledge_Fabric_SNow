/**
 * Redaction shared by the server logger, the browser logger and error serialization.
 * Anything that reaches a log line passes through here first.
 */

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /passw(or)?d|passphrase|^pass$|^pwd$|secret|token|authorization|cookie|api[-_]?key|apikey|credential|code_?verifier|private[-_]?key|signature|bearer|session[-_]?(id|token)|connection[-_]?string|database[-_]?url|^dsn$|^oauth[-_]?(code|state)$/i;

const STRING_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  [
    /([?&;\s]|^)((?:access|refresh|id)_token|client_secret|password|code_verifier|code|state|api[_-]?key|sig|signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|token)=([^&\s"';]+)/gi,
    `$1$2=${REDACTED}`,
  ],
  [
    /"(access_token|refresh_token|id_token|client_secret|password|apiKey|api_key|secret|clientSecret|token)"\s*:\s*"[^"]*"/gi,
    `"$1":"${REDACTED}"`,
  ],
  [/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, `postgres://${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
];

const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

export function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}… (${out.length - MAX_STRING} more chars)`;
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  status?: number;
  stack?: string;
  cause?: SerializedError;
}

const MAX_CAUSE_DEPTH = 3;

export function serializeError(error: unknown, options: { stack?: boolean } = {}, causeDepth = 0): SerializedError {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown; status?: unknown };
    const serialized: SerializedError = {
      name: error.name || "Error",
      message: redactString(error.message || ""),
    };
    if (typeof withCode.code === "string") serialized.code = withCode.code;
    if (typeof withCode.status === "number") serialized.status = withCode.status;
    if (options.stack && error.stack) {
      serialized.stack = redactString(error.stack.split("\n").slice(0, 10).join("\n"));
    }
    if (error.cause !== undefined && causeDepth < MAX_CAUSE_DEPTH) {
      serialized.cause = serializeError(error.cause, {}, causeDepth + 1);
    }
    return serialized;
  }
  return { name: "NonError", message: redactString(typeof error === "string" ? error : safeStringify(error)) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (value instanceof URL) return redactString(value.toString());
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1, seen));
    if (value.length > MAX_ARRAY) items.push(`… ${value.length - MAX_ARRAY} more`);
    return items;
  }
  if (value instanceof Map || value instanceof Set) return `[${value.constructor.name} size=${value.size}]`;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = inner === undefined || inner === null || inner === "" || typeof inner === "boolean" ? inner : REDACTED;
      continue;
    }
    const redacted = redactValue(inner, depth + 1, seen);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}
