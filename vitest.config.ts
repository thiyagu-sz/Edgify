import { defineConfig } from "vitest/config";

// `@/x` → `<root>/x`, matching tsconfig `paths`.
const alias = { "@": import.meta.dirname };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["lib/**/*.test.ts", "app/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
          setupFiles: ["./test/setup-env.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "component",
          // React + DOM assertions: the UI acceptance criteria (sanitisation in the rendered
          // DOM, quiz degradation, quota copy, the spinner-always-resolves invariant).
          environment: "jsdom",
          include: ["components/**/*.test.tsx", "app/**/*.test.tsx"],
          exclude: ["**/node_modules/**"],
          setupFiles: ["./test/setup-component.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["**/*.integration.test.ts"],
          exclude: ["**/node_modules/**"],
          // One shared container; keep DB tests serial so they never race on shared rows.
          globalSetup: ["./test/global-setup.ts"],
          setupFiles: ["./test/setup-db.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          // First run may pull the postgres image.
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
