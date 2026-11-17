import crypto from "node:crypto";
import { requireEnv } from "./env";

/**
 * Two independent keys:
 *  - APP_SESSION_SECRET signs and encrypts cookies (rotating it signs everyone out);
 *  - APP_ENCRYPTION_KEY encrypts stored ServiceNow/Genesys secrets (rotating it requires
 *    re-entering them).
 * Each purpose gets its own HKDF-derived subkey.
 */

type KeyPurpose = "cookie-encryption" | "cookie-signing" | "data-encryption";

const keyCache = new Map<string, Buffer>();

function deriveKey(purpose: KeyPurpose): Buffer {
  const secretName = purpose === "data-encryption" ? "APP_ENCRYPTION_KEY" : "APP_SESSION_SECRET";
  const secret = requireEnv(secretName);
  const cacheKey = `${purpose}:${crypto.createHash("sha256").update(secret).digest("base64url")}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = Buffer.from(crypto.hkdfSync("sha256", secret, "gc-kf-snow", purpose, 32));
    keyCache.set(cacheKey, key);
  }
  return key;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function md5Base64(data: Uint8Array): string {
  return crypto.createHash("md5").update(data).digest("base64");
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right) && a.length === b.length;
}

const VERSION = "v1";

function encrypt(plaintext: string, purpose: KeyPurpose, aad: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(purpose), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

function decrypt(token: string, purpose: KeyPurpose, aad: string): string | null {
  const [version, payload] = token.split(".", 2);
  if (version !== VERSION || !payload) return null;
  try {
    const raw = Buffer.from(payload, "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(purpose), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Encrypts a stored secret. `context` is bound as associated data (for example
 * "sn-connection:<id>") so a ciphertext copied to another row fails to decrypt.
 */
export function encryptSecret(value: unknown, context: string): string {
  return encrypt(JSON.stringify(value), "data-encryption", context);
}

export function decryptSecret<T>(token: string, context: string): T | null {
  const plaintext = decrypt(token, "data-encryption", context);
  if (plaintext === null) return null;
  try {
    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}

export function encryptCookie(value: unknown, cookieName: string): string {
  return encrypt(JSON.stringify(value), "cookie-encryption", cookieName);
}

export function decryptCookie<T>(token: string | undefined, cookieName: string): T | null {
  if (!token) return null;
  const plaintext = decrypt(token, "cookie-encryption", cookieName);
  if (plaintext === null) return null;
  try {
    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}

interface SignedEnvelope<T> {
  data: T;
  exp: number;
}

/** `<base64url(json)>.<base64url(hmac)>` with an expiry checked on verification. */
export function signPayload<T>(data: T, ttlSeconds: number, nowMs = Date.now()): string {
  const envelope: SignedEnvelope<T> = { data, exp: Math.floor(nowMs / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", deriveKey("cookie-signing")).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyPayload<T>(token: string | undefined, nowMs = Date.now()): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", deriveKey("cookie-signing")).update(body).digest("base64url");
  if (!timingSafeEqualStrings(signature, expected)) return null;
  try {
    const envelope = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedEnvelope<T>;
    if (typeof envelope.exp !== "number" || envelope.exp * 1000 <= nowMs) return null;
    return envelope.data;
  } catch {
    return null;
  }
}

/** PKCE (RFC 7636). */
export function createPkceVerifier(): string {
  return crypto.randomBytes(64).toString("base64url").slice(0, 96);
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
