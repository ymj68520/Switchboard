import { describe, expect, it } from "vitest";

import { createBindingService } from "../src/session/binding-service.js";
import { discoverWorkspace, registerWorkspace } from "../src/workspace/identity.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";
import { fixedClock, makeTempPluginDataRoot } from "./store-helpers.js";
import * as fs from "node:fs";
import * as path from "node:path";

async function makeRegisteredWorkspace(root: string): Promise<{ workspaceId: string }> {
  const store = await initializePlanStore({ pluginDataRoot: root });
  try {
    const dir = path.join(root, "project");
    fs.mkdirSync(dir, { recursive: true });
    const registration = registerWorkspace(store, await discoverWorkspace(dir), fixedClock({ ids: ["r", "w"] }));
    return { workspaceId: registration.workspace.workspaceId };
  } finally {
    store.close();
  }
}

async function makeService(root: string) {
  const store = await initializePlanStore({ pluginDataRoot: root });
  return { store, bindings: createBindingService(store, fixedClock({ nowIso: "2026-03-03T00:00:00.000Z", ids: ["x"] })) };
}

describe("session binding semantics (E9–E15/§16–§29)", () => {
  it("initial attach is attached with generation exactly 1 (E13)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        const binding = bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        expect(binding).toMatchObject({
          runId: "RUN-X",
          workspaceId,
          sessionId: "S1",
          state: "attached",
          generation: 1,
        });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("one run has at most one binding; a second bind is RUN_ALREADY_BOUND (E9/SB-01)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        expect(() => bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S2" })).toThrowError(
          expect.objectContaining({ code: "RUN_ALREADY_BOUND" }),
        );
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("one session owns at most one attached run; no silent detach+attach (E10/SB-02/§28)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-A", workspaceId, sessionId: "S1" });
        expect(() => bindings.bind({ runId: "RUN-B", workspaceId, sessionId: "S1" })).toThrowError(
          expect.objectContaining({ code: "SESSION_ALREADY_BOUND" }),
        );
        // RUN-A still attached to S1 — ownership change never happens implicitly.
        expect(bindings.getBinding("RUN-A")?.state).toBe("attached");
        expect(bindings.getBinding("RUN-B")).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("multiple runs in the same workspace are allowed for different sessions (E11/§29)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-A", workspaceId, sessionId: "S1" });
        bindings.bind({ runId: "RUN-B", workspaceId, sessionId: "S2" });
        bindings.bind({ runId: "RUN-C", workspaceId, sessionId: "S3" });
        const list = bindings.listBindingsForWorkspace(workspaceId);
        expect(list.map((b) => b.runId).sort()).toEqual(["RUN-A", "RUN-B", "RUN-C"]);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("bind into an unregistered workspace fails with WORKSPACE_NOT_FOUND", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { bindings, store } = await makeService(root);
      try {
        expect(() => bindings.bind({ runId: "RUN-X", workspaceId: "ws_missing", sessionId: "S1" })).toThrowError(
          expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }),
        );
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("detach keeps identity rows, flips state, and bumps the generation (E14/§18/§19)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        const detached = bindings.detach({ runId: "RUN-X", sessionId: "S1" });
        expect(detached).toMatchObject({ state: "detached", generation: 2, sessionId: "S1", workspaceId });
        expect(bindings.getBinding("RUN-X")).toMatchObject({
          runId: "RUN-X",
          workspaceId,
          sessionId: "S1",
          state: "detached",
        });
        // Old-generation authority is dead after the epoch change (SB-06):
        // the detached state rejects the write before anything else matters.
        expect(() =>
          bindings.assertWritable({ runId: "RUN-X", workspaceId, sessionId: "S1", generation: 1 }),
        ).toThrowError(expect.objectContaining({ code: "BINDING_DETACHED" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("detach by a non-owner is rejected (STALE_SESSION_BINDING)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        expect(() => bindings.detach({ runId: "RUN-X", sessionId: "S9" })).toThrowError(
          expect.objectContaining({ code: "STALE_SESSION_BINDING" }),
        );
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("exact-session reattach on the same workspace re-attaches with a new generation (E15/§20)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        bindings.detach({ runId: "RUN-X", sessionId: "S1" });
        const reattached = bindings.reattach({ runId: "RUN-X", sessionId: "S1", workspaceId });
        expect(reattached).toMatchObject({ state: "attached", generation: 3, sessionId: "S1" });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("reattach with a different workspace is WORKSPACE_MISMATCH, never auto-rebind (§20/§32)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        bindings.detach({ runId: "RUN-X", sessionId: "S1" });
        expect(() =>
          bindings.reattach({ runId: "RUN-X", sessionId: "S1", workspaceId: "ws_other" }),
        ).toThrowError(expect.objectContaining({ code: "WORKSPACE_MISMATCH" }));
        // Still detached at the original workspace.
        expect(bindings.getBinding("RUN-X")).toMatchObject({ state: "detached", workspaceId });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("reattach by a different session is rejected — no similarity-based attach (E20/§32)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        bindings.detach({ runId: "RUN-X", sessionId: "S1" });
        expect(() =>
          bindings.reattach({ runId: "RUN-X", sessionId: "S2", workspaceId }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("assertWritable passes only on the full exact match (§24)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        const snapshot = bindings.assertWritable({ runId: "RUN-X", workspaceId, sessionId: "S1", generation: 1 });
        expect(snapshot.generation).toBe(1);

        expect(() =>
          bindings.assertWritable({ runId: "RUN-X", workspaceId: "ws_other", sessionId: "S1", generation: 1 }),
        ).toThrowError(expect.objectContaining({ code: "WORKSPACE_MISMATCH" }));
        expect(() =>
          bindings.assertWritable({ runId: "RUN-Y", workspaceId, sessionId: "S1", generation: 1 }),
        ).toThrowError(expect.objectContaining({ code: "BINDING_NOT_FOUND" }));
        expect(() =>
          bindings.assertWritable({ runId: "RUN-X", workspaceId, sessionId: "S2", generation: 1 }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
        expect(() =>
          bindings.assertWritable({ runId: "RUN-X", workspaceId, sessionId: "S1", generation: 2 }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("takeover swaps owner and increments generation atomically (E16/§22)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        const taken = bindings.takeover({
          runId: "RUN-X",
          newSessionId: "S2",
          workspaceId,
          expectedGeneration: 1,
        });
        expect(taken).toMatchObject({ sessionId: "S2", state: "attached", generation: 2 });
        // The old owner's authority is permanently gone.
        expect(() =>
          bindings.assertWritable({ runId: "RUN-X", workspaceId, sessionId: "S1", generation: 1 }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("takeover with a wrong expected generation is STALE_SESSION_BINDING", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        expect(() =>
          bindings.takeover({ runId: "RUN-X", newSessionId: "S2", workspaceId, expectedGeneration: 99 }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("takeover into a different workspace is WORKSPACE_MISMATCH (E12/§31)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        expect(() =>
          bindings.takeover({ runId: "RUN-X", newSessionId: "S2", workspaceId: "ws_other", expectedGeneration: 1 }),
        ).toThrowError(expect.objectContaining({ code: "WORKSPACE_MISMATCH" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("takeover to a session that already owns another run is SESSION_ALREADY_BOUND", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-A", workspaceId, sessionId: "S1" });
        bindings.bind({ runId: "RUN-B", workspaceId, sessionId: "S2" });
        expect(() =>
          bindings.takeover({ runId: "RUN-A", newSessionId: "S2", workspaceId, expectedGeneration: 1 }),
        ).toThrowError(expect.objectContaining({ code: "SESSION_ALREADY_BOUND" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("operations on an unknown run are BINDING_NOT_FOUND", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        expect(() => bindings.detach({ runId: "GHOST", sessionId: "S1" })).toThrowError(
          expect.objectContaining({ code: "BINDING_NOT_FOUND" }),
        );
        expect(() =>
          bindings.takeover({ runId: "GHOST", newSessionId: "S1", workspaceId, expectedGeneration: 1 }),
        ).toThrowError(expect.objectContaining({ code: "BINDING_NOT_FOUND" }));
        expect(bindings.getBinding("GHOST")).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("detached bindings reject writable assertions (BINDING_DETACHED)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        bindings.detach({ runId: "RUN-X", sessionId: "S1" });
        expect(() =>
          bindings.assertWritable({ runId: "RUN-X", workspaceId, sessionId: "S1", generation: 2 }),
        ).toThrowError(expect.objectContaining({ code: "BINDING_DETACHED" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("generation never decreases or resets (SB-04)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { workspaceId } = await makeRegisteredWorkspace(root);
      const { store, bindings } = await makeService(root);
      try {
        bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
        bindings.detach({ runId: "RUN-X", sessionId: "S1" });
        bindings.reattach({ runId: "RUN-X", sessionId: "S1", workspaceId });
        bindings.detach({ runId: "RUN-X", sessionId: "S1" });
        bindings.reattach({ runId: "RUN-X", sessionId: "S1", workspaceId });
        expect(bindings.getBinding("RUN-X")?.generation).toBe(5);
        // DB-level CHECK: no row can ever hold generation < 1.
        const raw = rawConnection(storePathsFor(root).databasePath, 500);
        expect(() =>
          raw.exec("UPDATE session_bindings SET generation = 0 WHERE run_id = 'RUN-X'"),
        ).toThrowError();
        raw.close();
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
