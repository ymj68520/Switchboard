import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createBindingService } from "../src/session/binding-service.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { insertAttachedBindingInTx } from "../src/store/session-bindings.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

function clock() {
  return fixedClock({ nowIso: "2026-05-05T00:00:00.000Z", ids: ["run-1", "bind-1"] });
}

async function makeWorkspace(root: string): Promise<{ workspaceId: string }> {
  const store = await initializePlanStore({ pluginDataRoot: root });
  try {
    const dir = path.join(root, "project");
    fs.mkdirSync(dir, { recursive: true });
    const { registration } = await discoverAndRegisterWorkspace(store, dir, clock());
    return { workspaceId: registration.workspace.workspaceId };
  } finally {
    store.close();
  }
}

async function makeService(root: string) {
  const store = await initializePlanStore({ pluginDataRoot: root });
  return {
    store,
    runs: createPlanningRunService(store, clock()),
    bindings: createBindingService(store, clock()),
  };
}

describe("createPlanningRun (E4/E20/§25/§26)", () => {
  it("creates run + attached binding atomically: active/discovery/revision 1, generation 1", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "Build a router" });
        expect(run).toMatchObject({
          workspaceId,
          lifecycle: "active",
          stage: "discovery",
          revision: 1,
          goal: "Build a router",
        });
        expect(run.runId.startsWith("plan_")).toBe(true);
        expect(binding).toMatchObject({ runId: run.runId, sessionId: "S1", state: "attached", generation: 1 });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rejects empty/whitespace goals (INVALID_RUN_GOAL)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        for (const goal of ["", "   "]) {
          expect(() => runs.createPlanningRun({ workspaceId, sessionId: "S1", goal })).toThrowError(
            expect.objectContaining({ code: "INVALID_RUN_GOAL" }),
          );
        }
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rejects unregistered workspaces (WORKSPACE_NOT_FOUND)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { store, runs } = await makeService(root);
      try {
        expect(() => runs.createPlanningRun({ workspaceId: "ws_ghost", sessionId: "S1", goal: "x" })).toThrowError(
          expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }),
        );
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("one session owns at most one attached run — including legacy opaque bindings (§41)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "first" });
        expect(() => runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "second" })).toThrowError(
          expect.objectContaining({ code: "SESSION_ALREADY_BOUND" }),
        );

        // Legacy schema-2 opaque binding (no planning run) also blocks —
        // fail-closed, never silently cleaned.
        store.withWrite((tx) => {
          insertAttachedBindingInTx(
            tx,
            { runId: "LEGACY-OPAQUE-RUN", workspaceId, sessionId: "S9" },
            "2026-01-01T00:00:00.000Z",
          );
        });
        expect(() => runs.createPlanningRun({ workspaceId, sessionId: "S9", goal: "x" })).toThrowError(
          expect.objectContaining({ code: "SESSION_ALREADY_BOUND" }),
        );
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("multiple runs in one workspace under different sessions (E22/§28)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs, bindings } = await makeService(root);
      try {
        for (const [i, session] of ["S1", "S2", "S3"].entries()) {
          const { run } = runs.createPlanningRun({ workspaceId, sessionId: session, goal: `goal ${i}` });
          expect(run).toMatchObject({ lifecycle: "active", stage: "discovery", revision: 1 });
        }
        expect(runs.listPlanningRunsForWorkspace(workspaceId, { lifecycle: "active" })).toHaveLength(3);
        expect(bindings.listBindingsForWorkspace(workspaceId)).toHaveLength(3);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("transitionRun (E11/E14–E19/§22–§24/§55)", () => {
  async function makeRun(root: string) {
    const { workspaceId } = await makeWorkspace(root);
    const { store, runs } = await makeService(root);
    const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "goal" });
    return { store, runs, workspaceId, run, generation: binding.generation };
  }

  it("advances discovery → architecture on DISCOVERY_COMPLETE with revision 2", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { store, runs, workspaceId, run, generation } = await makeRun(root);
      try {
        const updated = runs.transitionRun({
          runId: run.runId,
          workspaceId,
          sessionId: "S1",
          bindingGeneration: generation,
          expectedRevision: 1,
          event: "DISCOVERY_COMPLETE",
        });
        expect(updated).toMatchObject({ stage: "architecture", revision: 2, lifecycle: "active" });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("walks the full forward path through the service", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { store, runs, workspaceId, run, generation } = await makeRun(root);
      try {
        const steps: [string, string][] = [
          ["DISCOVERY_COMPLETE", "architecture"],
          ["ARCHITECTURE_APPROVED", "detail"],
          ["DETAIL_COMPLETE", "synthesis"],
          ["SYNTHESIS_SUBMITTED", "validation"],
          ["VALIDATION_CLEAN", "final"],
        ];
        let revision = 1;
        let current = run.stage;
        for (const [event, expectedStage] of steps) {
          const updated = runs.transitionRun({
            runId: run.runId,
            workspaceId,
            sessionId: "S1",
            bindingGeneration: generation,
            expectedRevision: revision,
            event: event as never,
          });
          expect(updated.stage).toBe(expectedStage);
          revision += 1;
          expect(updated.revision).toBe(revision);
          current = updated.stage;
        }
        expect(current).toBe("final");
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("stale binding generation wins precedence over stale revision (§46/§55)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { store, runs, workspaceId, run, generation } = await makeRun(root);
      try {
        expect(() =>
          runs.transitionRun({
            runId: run.runId,
            workspaceId,
            sessionId: "S1",
            bindingGeneration: generation + 5, // stale ownership
            expectedRevision: 999, // also stale revision
            event: "DISCOVERY_COMPLETE",
          }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("current generation + stale revision → STALE_RUN_REVISION (E17/§47)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { store, runs, workspaceId, run, generation } = await makeRun(root);
      try {
        expect(() =>
          runs.transitionRun({
            runId: run.runId,
            workspaceId,
            sessionId: "S1",
            bindingGeneration: generation,
            expectedRevision: 42,
            event: "DISCOVERY_COMPLETE",
          }),
        ).toThrowError(expect.objectContaining({ code: "STALE_RUN_REVISION" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("invalid stage/event combinations fail closed (E14/§48)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        const invalid: [string, string][] = [
          ["discovery", "VALIDATION_CLEAN"],
          ["discovery", "SYNTHESIS_SUBMITTED"],
          ["architecture", "DETAIL_COMPLETE"],
          ["architecture", "SYNTHESIS_SUBMITTED"],
        ];
        for (const [, event] of invalid) {
          expect(() =>
            runs.transitionRun({
              runId: run.runId,
              workspaceId,
              sessionId: "S1",
              bindingGeneration: binding.generation,
              expectedRevision: 1,
              event: event as never,
            }),
          ).toThrowError(expect.objectContaining({ code: "INVALID_RUN_TRANSITION" }));
        }
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("wrong workspace is WORKSPACE_MISMATCH even with same repository family (E19/§24)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { store, runs, run, generation } = await makeRun(root);
      try {
        expect(() =>
          runs.transitionRun({
            runId: run.runId,
            workspaceId: "ws_sibling",
            sessionId: "S1",
            bindingGeneration: generation,
            expectedRevision: run.revision,
            event: "DISCOVERY_COMPLETE",
          }),
        ).toThrowError(expect.objectContaining({ code: "WORKSPACE_MISMATCH" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("reviseDiscoveryGoal (§14)", () => {
  it("revises the goal at discovery with revision bump", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "v1" });
        const revised = runs.reviseDiscoveryGoal({
          runId: run.runId,
          workspaceId,
          sessionId: "S1",
          bindingGeneration: binding.generation,
          expectedRevision: 1,
          goal: "v2 clarified",
        });
        expect(revised).toMatchObject({ goal: "v2 clarified", revision: 2, stage: "discovery" });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("refuses goal revision after discovery (INVALID_RUN_TRANSITION)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "v1" });
        runs.transitionRun({
          runId: run.runId,
          workspaceId,
          sessionId: "S1",
          bindingGeneration: binding.generation,
          expectedRevision: 1,
          event: "DISCOVERY_COMPLETE",
        });
        expect(() =>
          runs.reviseDiscoveryGoal({
            runId: run.runId,
            workspaceId,
            sessionId: "S1",
            bindingGeneration: binding.generation,
            expectedRevision: 2,
            goal: "v2",
          }),
        ).toThrowError(expect.objectContaining({ code: "INVALID_RUN_TRANSITION" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("abort (E25/E26/§32–§35)", () => {
  it("aborts atomically: lifecycle flipped, revision+1, binding detached with generation+1", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        runs.transitionRun({
          runId: run.runId,
          workspaceId,
          sessionId: "S1",
          bindingGeneration: binding.generation,
          expectedRevision: 1,
          event: "DISCOVERY_COMPLETE",
        });
        const aborted = runs.abortPlanningRun({
          runId: run.runId,
          workspaceId,
          sessionId: "S1",
          bindingGeneration: binding.generation,
          expectedRevision: 2,
        });
        expect(aborted).toMatchObject({ lifecycle: "aborted", stage: "architecture", revision: 3 });
        const bindingAfter = store.withRead((tx) =>
          tx.prepare("SELECT state, generation FROM session_bindings WHERE run_id = ?").get(run.runId),
        ) as { state: string; generation: number };
        expect(bindingAfter).toEqual({ state: "detached", generation: binding.generation + 1 });
        // The old owner can no longer assert (stale epoch + terminal run).
        expect(() =>
          runs.transitionRun({
            runId: run.runId,
            workspaceId,
            sessionId: "S1",
            bindingGeneration: binding.generation,
            expectedRevision: 3,
            event: "ARCHITECTURE_APPROVED",
          }),
        ).toThrowError();
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("abort retry with the same fencing input is RUN_TERMINAL, never double-applied (E26-idempotency/§35)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        runs.abortPlanningRun({
          runId: run.runId,
          workspaceId,
          sessionId: "S1",
          bindingGeneration: binding.generation,
          expectedRevision: 1,
        });
        expect(() =>
          runs.abortPlanningRun({
            runId: run.runId,
            workspaceId,
            sessionId: "S1",
            bindingGeneration: binding.generation + 1,
            expectedRevision: 2,
          }),
        ).toThrowError(expect.objectContaining({ code: "RUN_TERMINAL" }));
        const after = runs.getPlanningRun(run.runId);
        expect(after).toMatchObject({ lifecycle: "aborted", revision: 2 });
        const gen = store.withRead((tx) =>
          tx.prepare("SELECT generation FROM session_bindings WHERE run_id = ?").get(run.runId),
        ) as { generation: number };
        expect(gen.generation).toBe(binding.generation + 1);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("aborted runs can never reattach or transition (E26)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        runs.abortPlanningRun({
          runId: run.runId,
          workspaceId,
          sessionId: "S1",
          bindingGeneration: binding.generation,
          expectedRevision: 1,
        });
        expect(() => runs.reattachActiveRun({ runId: run.runId, workspaceId, sessionId: "S1" })).toThrowError(
          expect.objectContaining({ code: "RUN_TERMINAL" }),
        );
        expect(() =>
          runs.takeoverActiveRun({ runId: run.runId, workspaceId, newSessionId: "S2", expectedGeneration: 2 }),
        ).toThrowError(expect.objectContaining({ code: "RUN_TERMINAL" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("abort on unknown run → RUN_NOT_FOUND; stale revision → STALE_RUN_REVISION", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        expect(() =>
          runs.abortPlanningRun({ runId: "plan_ghost", workspaceId, sessionId: "S1", bindingGeneration: 1, expectedRevision: 1 }),
        ).toThrowError(expect.objectContaining({ code: "RUN_NOT_FOUND" }));
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        expect(() =>
          runs.abortPlanningRun({
            runId: run.runId,
            workspaceId,
            sessionId: "S1",
            bindingGeneration: binding.generation,
            expectedRevision: 9,
          }),
        ).toThrowError(expect.objectContaining({ code: "STALE_RUN_REVISION" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("reattach / takeover integration (E23/E24/§30/§31)", () => {
  it("exact-session reattach works for active runs and creates a new generation", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs, bindings } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        bindings.detach({ runId: run.runId, sessionId: "S1" });
        const reattached = runs.reattachActiveRun({ runId: run.runId, workspaceId, sessionId: "S1" });
        // detach already moved the epoch to gen+1; reattach adds one more.
        expect(reattached).toMatchObject({ state: "attached", generation: binding.generation + 2 });
        expect(runs.getPlanningRun(run.runId)).toMatchObject({ lifecycle: "active", revision: 1 });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("takeover through the run service requires the active run", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        const taken = runs.takeoverActiveRun({
          runId: run.runId,
          workspaceId,
          newSessionId: "S2",
          expectedGeneration: binding.generation,
        });
        expect(taken).toMatchObject({ sessionId: "S2", generation: binding.generation + 1, state: "attached" });
        // Old owner fenced even with correct run revision.
        expect(() =>
          runs.transitionRun({
            runId: run.runId,
            workspaceId,
            sessionId: "S1",
            bindingGeneration: binding.generation,
            expectedRevision: 1,
            event: "DISCOVERY_COMPLETE",
          }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("reads and row mapping (E29/§29/§39/§56)", () => {
  it("terminal runs remain fully readable; workspace listing is exact-scoped", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        runs.abortPlanningRun({
          runId: run.runId,
          workspaceId,
          sessionId: "S1",
          bindingGeneration: binding.generation,
          expectedRevision: 1,
        });
        expect(runs.getPlanningRun(run.runId)).toMatchObject({ lifecycle: "aborted", goal: "g" });
        expect(runs.listPlanningRunsForWorkspace(workspaceId)).toHaveLength(1);
        expect(runs.listPlanningRunsForWorkspace("ws_other")).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("maps rows through validation and rejects corrupt vocabulary (STORE_SCHEMA_INVALID)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        const { getPlanningRunRecord } = await import("../src/store/planning-runs.js");
        expect(getPlanningRunRecord(store, run.runId)?.stage).toBe("discovery");
        const { parsePlanningRunRow } = await import("../src/core/planning-run.js");
        expect(() =>
          parsePlanningRunRow({
            runId: "plan_x",
            workspaceId,
            lifecycle: "zombie",
            stage: "discovery",
            revision: 1,
            goal: "g",
            createdAt: "t",
            updatedAt: "t",
          }),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_INVALID" }));
        expect(() =>
          parsePlanningRunRow({
            runId: "plan_x",
            workspaceId,
            lifecycle: "completed",
            stage: "detail",
            revision: 1,
            goal: "g",
            createdAt: "t",
            updatedAt: "t",
          }),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_INVALID" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("runs are never deleted by lifecycle operations (E27/§57)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeWorkspace(root);
      const { store, runs } = await makeService(root);
      try {
        const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: "S1", goal: "g" });
        runs.abortPlanningRun({
          runId: run.runId,
          workspaceId,
          sessionId: "S1",
          bindingGeneration: binding.generation,
          expectedRevision: 1,
        });
        const count = store.withRead((tx) =>
          tx.prepare("SELECT count(*) AS n FROM planning_runs").get(),
        ) as { n: number };
        expect(count.n).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
