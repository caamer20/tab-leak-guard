import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/background/**/*.ts",
        "src/collector/**/*.ts",
        "src/detector/**/*.ts",
        "src/recovery/**/*.ts",
        "src/shared/**/*.ts"
      ],
      exclude: ["src/collector/index.ts"],
      reporter: [["text", { skipFull: false }], "text-summary", "html", "json-summary"],
      skipFull: false,
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
        "src/recovery/transaction.ts": {
          lines: 100,
          functions: 100,
          statements: 100,
          branches: 100
        }
      }
    }
  }
});
