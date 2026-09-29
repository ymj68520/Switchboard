import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The MCP smoke test drives the built dist/phase-plan-runtime.mjs bundle
    // (produced by the `pretest` build step), not the TS sources.
    include: ["test/**/*.test.ts"],
    // 60s: the store-migration suites intentionally wait out real SQLite busy
    // timeouts (multi-second lock contention per test); on slower or
    // parallel-constrained machines (WSL2, 2-worker CI) the old 20s floor
    // tripped on contention, not on behavior. Windows/Linux runs sit well
    // under this in isolation.
    testTimeout: 60000,
  },
});
