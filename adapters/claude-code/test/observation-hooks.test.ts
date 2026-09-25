/**
 * PostToolUse hook behavior (Phase 9 §9/§11–§13/§59/§60/§64; E3/E8/E9).
 */

import { describe, expect, it } from "vitest";

import { handlePostToolUse, type HookHandlerDeps } from "../src/hooks/handlers.js";
import { runHook } from "../src/hooks/run.js";
import type { BlobStore } from "../src/store/blob-store.js";
import { listObservationsRecord } from "../src/store/observations.js";
import { memoryCounts } from "./proposal-helpers.js";
import { getHeadSnapshotRecord } from "../src/store/plan-memory.js";
import { loadHostSecret } from "../src/host/secret.js";
import { makePhase9Fixture, sourceEvent, writeSourceFile } from "./phase9-helpers.js";
import { fixedClock } from "./store-helpers.js";

function depsWith(fixture: Awaited<ReturnType<typeof makePhase9Fixture>>, blobs?: BlobStore): HookHandlerDeps {
  return {
    store: fixture.store,
    secret: loadHostSecret(fixture.root).key,
    clock: fixedClock({ ids: ["obs", "obs2", "obs3"] }),
    ...(blobs === undefined ? {} : { blobs }),
  };
}

function postInput(fixture: Awaited<ReturnType<typeof makePhase9Fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: fixture.sessionId,
    hookEventName: "PostToolUse",
    toolName: "Read",
    toolUseId: "call_hook1",
    toolInput: { file_path: "whatever" },
    toolResponse: { type: "text", file: { filePath: "whatever", content: "content" } },
    cwd: fixture.workspaceRoot,
    permissionMode: "plan",
    ...overrides,
  };
}

describe("PostToolUse capture wiring (§11–§13, E3)", () => {
  it("captures an evidence-capable result when an active run is attached; stdout stays clean", async () => {
    const f = await makePhase9Fixture();
    try {
      const output = await handlePostToolUse(depsWith(f), postInput(f));
      expect(output).toEqual({ kind: "empty" });
      const rows = listObservationsRecord(f.store, f.runId, { limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ toolName: "Read", observationClass: "source", promotable: true });
    } finally {
      f.close();
    }
  });

  it("never captures without an attached active run — not a global tool logger (§12)", async () => {
    const f = await makePhase9Fixture();
    try {
      const output = await handlePostToolUse(depsWith(f), postInput(f, { sessionId: "S-other" }));
      expect(output).toEqual({ kind: "empty" });
      expect(listObservationsRecord(f.store, f.runId, { limit: 10 })).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("skips unsupported tools without guessing (§8, E7)", async () => {
    const f = await makePhase9Fixture();
    try {
      for (const toolName of ["Edit", "Write", "Task", "mcp__plugin_phase-plan_phase-plan__start_or_resume"]) {
        const output = await handlePostToolUse(depsWith(f), postInput(f, { toolName, toolUseId: `call_${toolName}` }));
        expect(output).toEqual({ kind: "empty" });
      }
      expect(listObservationsRecord(f.store, f.runId, { limit: 10 })).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("does not gate on permission_mode alone — attribution decides (§13)", async () => {
    const f = await makePhase9Fixture();
    try {
      // mode != plan but an attributable active run + evidence-capable tool:
      // capture still happens (A1 recovery readability of the ledger).
      const output = await handlePostToolUse(depsWith(f), postInput(f, { permissionMode: "default" }));
      expect(output).toEqual({ kind: "empty" });
      expect(listObservationsRecord(f.store, f.runId, { limit: 10 })).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it("skips tools executed outside the bound workspace", async () => {
    const f = await makePhase9Fixture();
    try {
      const output = await handlePostToolUse(depsWith(f), postInput(f, { cwd: "D:\\some\\other\\tree" }));
      expect(output).toEqual({ kind: "empty" });
      expect(listObservationsRecord(f.store, f.runId, { limit: 10 })).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("capture failure is fail-VISIBLE but never fails the tool (§60)", async () => {
    const f = await makePhase9Fixture();
    try {
      const explodingBlobs: BlobStore = {
        root: "unused",
        putBytes: () => {
          throw new Error("disk full injected");
        },
        readBytes: () => Buffer.alloc(0),
        exists: () => false,
      };
      const output = await handlePostToolUse(depsWith(f, explodingBlobs), postInput(f));
      expect(output.kind).toBe("json");
      const payload = (output as { kind: "json"; payload: Record<string, unknown> }).payload;
      const context = (payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(context).toContain("Phase Plan observation capture failed (OBSERVATION_CAPTURE_FAILED).");
      expect(context).toContain("cannot be promoted as Evidence");
      expect(context).not.toContain("failed tool");
      expect(listObservationsRecord(f.store, f.runId, { limit: 10 })).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("a hook-level parse failure degrades silently (exit 0, nothing on stdout)", async () => {
    const f = await makePhase9Fixture();
    try {
      const result = await runHook({
        event: "PostToolUse",
        raw: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "S" }), // no tool fields
        pluginDataRoot: f.root,
      });
      expect(result).toEqual({ exitCode: 0, stdout: "" });
    } finally {
      f.close();
    }
  });

  it("end-to-end through runHook: captured row exists, stdout stays protocol-clean", async () => {
    const f = await makePhase9Fixture();
    try {
      writeSourceFile(f, "hook.txt", "hook captured\n");
      const event = sourceEvent(f, "hook.txt");
      const result = await runHook({
        event: "PostToolUse",
        raw: JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: f.sessionId,
          cwd: f.workspaceRoot,
          tool_name: "Read",
          tool_use_id: event.toolUseId,
          tool_input: event.toolInput,
          tool_response: event.toolResponse,
          permission_mode: "plan",
        }),
        pluginDataRoot: f.root,
      });
      expect(result).toEqual({ exitCode: 0, stdout: "" });
      const rows = listObservationsRecord(f.store, f.runId, { limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.toolUseId).toBe(event.toolUseId);
    } finally {
      f.close();
    }
  });

  it("hook retry of the same tool use is idempotent at the ledger level (§40)", async () => {
    const f = await makePhase9Fixture();
    try {
      const input = postInput(f);
      await handlePostToolUse(depsWith(f), input);
      await handlePostToolUse(depsWith(f), input);
      expect(listObservationsRecord(f.store, f.runId, { limit: 10 })).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it("capture and hook never mutate Plan Memory or the run (E35)", async () => {
    const f = await makePhase9Fixture();
    try {
      const before = {
        head: getHeadSnapshotRecord(f.store, f.runId),
        memory: memoryCounts(f.store),
        revision: f.runs.getPlanningRun(f.runId)?.revision,
      };
      await handlePostToolUse(depsWith(f), postInput(f));
      expect(getHeadSnapshotRecord(f.store, f.runId)).toEqual(before.head);
      expect(memoryCounts(f.store)).toEqual(before.memory);
      expect(f.runs.getPlanningRun(f.runId)?.revision).toBe(before.revision);
    } finally {
      f.close();
    }
  });
});
