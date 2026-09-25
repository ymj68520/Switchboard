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
import { createInternalPlanMemoryWriter } from "../../src/store/plan-memory.js";
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
    } else if (mode === "memory-revision") {
      // Internal write primitive driven from a second process to prove the
      // same-next-revision race serializes through SQLite (frozen plan §55).
      const runId = process.argv[4] ?? "";
      const artifactId = process.argv[5] ?? "";
      const explicitRevision = Number(process.argv[6] ?? "0");
      const title = process.argv[7] ?? `decision from ${process.pid}`;
      const memory = createInternalPlanMemoryWriter(store, {
        nowIso: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      });
      const ref = memory.insertMemoryRevision({
        runId,
        kind: "decision",
        artifactId,
        ...(explicitRevision > 0 ? { revision: explicitRevision } : {}),
        content: {
          title,
          statement: "raced revision",
          rationale: "concurrency test",
          alternatives: [],
          consequences: [],
          scope: "test",
          supportingRefs: [],
        },
        compactProjection: `${artifactId} r${explicitRevision}`,
      });
      out({ ok: true, revision: ref.revision });
    } else if (mode === "prepare") {
      // Prepare a proposal from a real process (§95 concurrent prepare race).
      // argv: prepare <root> <runId> <workspaceId> <sessionId> <gen> <rev> <prepareRequestId> <busyMs>
      const { createProposalService } = await import("../../src/application/proposal-service.js");
      const runId = process.argv[4] ?? "";
      const workspaceId = process.argv[5] ?? "";
      const sessionId = process.argv[6] ?? "";
      const bindingGeneration = Number(process.argv[7] ?? "1");
      const expectedRunRevision = Number(process.argv[8] ?? "1");
      const prepareRequestId = process.argv[9] ?? `PREP-${process.pid}`;
      const proposals = createProposalService(store, {
        nowIso: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      });
      const { proposal } = proposals.prepareProposal({
        runId,
        workspaceId,
        sessionId,
        bindingGeneration,
        expectedRunRevision,
        type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: `checkpoint from ${process.pid}`,
        summary: "raced prepare",
        changes: [
          {
            op: "ADD_DECISION",
            content: {
              title: `decision from ${process.pid}`,
              statement: "raced prepare",
              rationale: "concurrency test",
              alternatives: [],
              consequences: [],
              scope: "test",
              supportingRefs: [],
            },
            compactProjection: `DEC from ${process.pid}`,
          },
        ],
        prepareRequestId,
      });
      out({ ok: true, proposalId: proposal.proposalId, revision: proposal.revision, hash: proposal.proposalHash });
    } else if (mode === "approve") {
      // Commit an authorized proposal from a real process (§64/§65 races).
      // argv: approve <root> <runId> <workspaceId> <sessionId> <gen> <authReqId> <proposalId> <revision> <hash> <busyMs>
      const { createPlanCommitEngine } = await import("../../src/application/plan-commit-engine.js");
      const runId = process.argv[4] ?? "";
      const workspaceId = process.argv[5] ?? "";
      const sessionId = process.argv[6] ?? "";
      const bindingGeneration = Number(process.argv[7] ?? "1");
      const authorization = {
        authorizationRequestId: process.argv[8] ?? `AUTH-${process.pid}`,
        proposalId: process.argv[9] ?? "",
        proposalRevision: Number(process.argv[10] ?? "1"),
        proposalHash: process.argv[11] ?? "",
      };
      const engine = createPlanCommitEngine(store, {
        nowIso: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      });
      const result = engine.commitAuthorizedProposal({ runId, workspaceId, sessionId, bindingGeneration, authorization });
      out({
        ok: true,
        idempotent: result.idempotent,
        approvalId: result.approvalId,
        commitId: result.commitId,
        snapshotId: result.snapshotId,
        sequence: result.sequence,
      });
    } else {
      fail(new Error(`unknown mode: ${mode}`));
    }
  } finally {
    store.close();
  }
} catch (err) {
  fail(err);
}
