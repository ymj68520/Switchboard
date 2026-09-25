/**
 * Multi-process binding worker (frozen plan §15/§27/§49 concurrency tests).
 *
 * Bundled to plain ESM by the concurrency test and spawned as real
 * processes:
 *
 *   node binding-worker.mjs register   <pluginDataRoot> <projectDir> <busyMs>
 *   node binding-worker.mjs bind       <pluginDataRoot> <runId> <workspaceId> <sessionId> <busyMs>
 *   node binding-worker.mjs takeover   <pluginDataRoot> <runId> <workspaceId> <newSession> <expectedGen> <busyMs>
 *
 * Prints one JSON line with the outcome.
 */

import { createBindingService } from "../../src/session/binding-service.js";
import { discoverAndRegisterWorkspace } from "../../src/workspace/identity.js";
import { initializePlanStore } from "../../src/store/sqlite-store.js";
import { isRuntimeError } from "../../src/runtime/errors.js";

const mode = process.argv[2] ?? "";
const pluginDataRoot = process.argv[3] ?? "";
const busyTimeoutMs = Number(process.argv[process.argv.length - 1] ?? "5000");

function fail(err: unknown): never {
  const code = isRuntimeError(err) ? err.code : "UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.exit(0);
}

try {
  if (mode === "register") {
    const projectDir = process.argv[4] ?? "";
    const store = await initializePlanStore({ pluginDataRoot, busyTimeoutMs });
    try {
      const { registration } = await discoverAndRegisterWorkspace(store, projectDir, {
        nowIso: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      }, { timeoutMs: busyTimeoutMs });
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          repositoryId: registration.repository.repositoryId,
          workspaceId: registration.workspace.workspaceId,
        })}\n`,
      );
    } finally {
      store.close();
    }
  } else if (mode === "bind") {
    const runId = process.argv[4] ?? "";
    const workspaceId = process.argv[5] ?? "";
    const sessionId = process.argv[6] ?? "";
    const store = await initializePlanStore({ pluginDataRoot, busyTimeoutMs });
    try {
      const bindings = createBindingService(store, {
        nowIso: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      });
      const binding = bindings.bind({ runId, workspaceId, sessionId });
      process.stdout.write(`${JSON.stringify({ ok: true, generation: binding.generation })}\n`);
    } finally {
      store.close();
    }
  } else if (mode === "takeover") {
    const runId = process.argv[4] ?? "";
    const workspaceId = process.argv[5] ?? "";
    const newSessionId = process.argv[6] ?? "";
    const expectedGeneration = Number(process.argv[7] ?? "0");
    const store = await initializePlanStore({ pluginDataRoot, busyTimeoutMs });
    try {
      const bindings = createBindingService(store, {
        nowIso: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      });
      const binding = bindings.takeover({ runId, newSessionId, workspaceId, expectedGeneration });
      process.stdout.write(`${JSON.stringify({ ok: true, generation: binding.generation, sessionId: binding.sessionId })}\n`);
    } finally {
      store.close();
    }
  } else {
    fail(new Error(`unknown mode: ${mode}`));
  }
} catch (err) {
  fail(err);
}
