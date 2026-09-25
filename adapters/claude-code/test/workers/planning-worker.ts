/**
 * Multi-process planning-run worker (frozen plan §27/§45/§61 concurrency
 * tests). Bundled to plain ESM by the concurrency test:
 *
 *   node planning-worker.mjs create     <root> <workspaceId> <sessionId> <busyMs>
 *   node planning-worker.mjs transition <root> <runId> <workspaceId> <sessionId> <gen> <expectedRev> <event> <busyMs>
 *   node planning-worker.mjs abort      <root> <runId> <workspaceId> <sessionId> <gen> <expectedRev> <busyMs>
 *
 * Prints one JSON line with the outcome.
 */

import { createPlanningRunService } from "../../src/application/planning-run-service.js";
import { initializePlanStore } from "../../src/store/sqlite-store.js";
import { isRuntimeError } from "../../src/runtime/errors.js";

const mode = process.argv[2] ?? "";
const root = process.argv[3] ?? "";
const busyMs = Number(process.argv[process.argv.length - 1] ?? "5000");

function out(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

function fail(err: unknown): never {
  out({ ok: false, code: isRuntimeError(err) ? err.code : "UNKNOWN", message: err instanceof Error ? err.message : String(err) });
  throw new Error("unreachable");
}

try {
  const store = await initializePlanStore({ pluginDataRoot: root, busyTimeoutMs: busyMs });
  try {
    const runs = createPlanningRunService(store, {
      nowIso: () => new Date().toISOString(),
      newId: () => crypto.randomUUID(),
    });
    if (mode === "create") {
      const workspaceId = process.argv[4] ?? "";
      const sessionId = process.argv[5] ?? "";
      const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId, goal: "concurrent create" });
      out({ ok: true, runId: run.runId, revision: run.revision, generation: binding.generation });
    } else if (mode === "transition") {
      const runId = process.argv[4] ?? "";
      const workspaceId = process.argv[5] ?? "";
      const sessionId = process.argv[6] ?? "";
      const bindingGeneration = Number(process.argv[7] ?? "1");
      const expectedRevision = Number(process.argv[8] ?? "1");
      const event = process.argv[9] ?? "DISCOVERY_COMPLETE";
      const run = runs.transitionRun({
        runId,
        workspaceId,
        sessionId,
        bindingGeneration,
        expectedRevision,
        event: event as never,
      });
      out({ ok: true, stage: run.stage, revision: run.revision, lifecycle: run.lifecycle });
    } else if (mode === "abort") {
      const runId = process.argv[4] ?? "";
      const workspaceId = process.argv[5] ?? "";
      const sessionId = process.argv[6] ?? "";
      const bindingGeneration = Number(process.argv[7] ?? "1");
      const expectedRevision = Number(process.argv[8] ?? "1");
      const run = runs.abortPlanningRun({ runId, workspaceId, sessionId, bindingGeneration, expectedRevision });
      out({ ok: true, lifecycle: run.lifecycle, revision: run.revision });
    } else {
      fail(new Error(`unknown mode: ${mode}`));
    }
  } finally {
    store.close();
  }
} catch (err) {
  fail(err);
}
