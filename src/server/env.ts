import { AppError } from "@/lib/errors";

type SecretName = "APP_SESSION_SECRET" | "APP_ENCRYPTION_KEY" | "CRON_SECRET" | "DATABASE_URL";

const MIN_LENGTH: Record<SecretName, number> = {
  APP_SESSION_SECRET: 32,
  APP_ENCRYPTION_KEY: 32,
  CRON_SECRET: 16,
  DATABASE_URL: 10,
};

/**
 * Reads a required secret from the environment. Failures name the variable, never its value.
 */
export function requireEnv(name: SecretName): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError("CONFIG_MISSING", { detail: `Environment variable ${name} is not set` });
  }
  if (value.length < MIN_LENGTH[name]) {
    throw new AppError("CONFIG_MISSING", {
      detail: `Environment variable ${name} is too short (minimum ${MIN_LENGTH[name]} characters)`,
    });
  }
  return value;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function appVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.npm_package_version ?? "dev";
}

/** Optional allowlist of Genesys Cloud organization IDs. Null means every organization may sign in. */
export function allowedOrgIds(): Set<string> | null {
  const raw = process.env.APP_ALLOWED_ORG_IDS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/** Reports which required variables are present, for the health endpoint. Names and booleans only. */
export function configStatus(): Record<SecretName, boolean> {
  const names: SecretName[] = ["APP_SESSION_SECRET", "APP_ENCRYPTION_KEY", "CRON_SECRET", "DATABASE_URL"];
  return Object.fromEntries(
    names.map((name) => [name, Boolean(process.env[name] && process.env[name]!.length >= MIN_LENGTH[name])]),
  ) as Record<SecretName, boolean>;
}
