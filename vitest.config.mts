import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "server-only": fileURLToPath(new URL("./tests/helpers/empty-module.ts", import.meta.url)),
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          include: ["tests/unit/**/*.test.{ts,tsx}", "tests/flows/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "node_modules/**"],
          setupFiles: ["tests/setup/unit.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "happy-dom",
          environmentOptions: { happyDOM: { url: "http://localhost:3000/" } },
          include: ["tests/ui/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/setup/ui.tsx"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/server/**/*.ts", "src/lib/**/*.ts", "src/workflows/**/*.ts", "src/components/**/*.{ts,tsx}", "src/instrumentation-client.ts"],
      exclude: ["src/server/auth/server-session.ts", "**/*.d.ts"],
      reporter: ["text-summary", "text", "html"],
      thresholds: { lines: 85, functions: 85, statements: 85, branches: 75 },
    },
  },
});
