import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Opt-in smoke test against a real ServiceNow instance and a Genesys Cloud test org.
 * Credentials come only from the environment (inject them with a secret manager), and the
 * output is limited to pass/fail per step: console output and app logs are silenced.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: { "server-only": fileURLToPath(new URL("./tests/helpers/empty-module.ts", import.meta.url)) },
  },
  test: {
    name: "live",
    environment: "node",
    include: ["tests/live/**/*.live.test.ts"],
    setupFiles: ["tests/setup/live.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 2 * 60_000,
    fileParallelism: false,
    bail: 1,
    silent: true,
    reporters: ["verbose"],
  },
});
