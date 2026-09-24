import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The MCP smoke test drives the built dist/phase-plan-runtime.mjs bundle
    // (produced by the `pretest` build step), not the TS sources.
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
  },
});
