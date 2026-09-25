/**
 * Phase 8 hook integration: SessionStart Recovery Capsule injection for
 * startup/resume/compact (§29), compaction independence (§31/§53, E20/E21),
 * the §47 failure policy, and the UserPromptSubmit normal-turn delta marker
 * (§34). A1 wording compatibility is owned by amendment-a1-recovery.test.ts.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  handleSessionStart,
  handleUserPromptSubmit,
  type HookHandlerDeps,
} from "../src/hooks/handlers.js";
import { DRIFT_GUARD_REASON } from "../src/hooks/output.js";
import { loadHostSecret } from "../src/host/secret.js";
import { commitCheckpoint, makeContextFixture, type ContextFixture } from "./context-helpers.js";
import { CONSTRAINT_1 } from "./proposal-helpers.js";
import { fixedClock } from "./store-helpers.js";

async function withFixture(fn: (fixture: ContextFixture, deps: HookHandlerDeps) => void | Promise<void>): Promise<void> {
  const fixture = await makeContextFixture();
  try {
    const deps: HookHandlerDeps = { store: fixture.store, secret: loadHostSecret(fixture.root).key, clock: fixedClock() };
    await fn(fixture, deps);
  } finally {
    fixture.close();
  }
}

function additionalContext(output: Awaited<ReturnType<typeof handleSessionStart>>): string {
  expect(output.kind).toBe("json");
  return ((output as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
}

function sessionStartInput(fixture: ContextFixture, source: "startup" | "resume" | "compact", permissionMode?: string) {
  return {
    sessionId: fixture.sessionId,
    hookEventName: "SessionStart",
    source,
    cwd: path.join(fixture.root, "project"),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

describe("SessionStart Recovery Capsule (§29, E17/E18)", () => {
  it("startup injects the full capsule with run/HEAD/constraints/epoch for an attached active run", async () => {
    await withFixture(async (fixture, deps) => {
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1 committed" }]);
      const context = additionalContext(await handleSessionStart(deps, sessionStartInput(fixture, "startup", "plan")));
      expect(context).toContain("Phase Plan active:");
      expect(context).toContain("[Phase Plan Recovery v1]");
      expect(context).toContain(`id=${fixture.runId}`);
      expect(context).toContain("stage=architecture");
      expect(context).toContain("goal=proposal fixture");
      expect(context).toContain("snapshot=snap_");
      expect(context).toContain("- CONST-1@1 (user): No network access at runtime");
      expect(context).toContain("context_epoch=");
      // plan mode → no A1 line
      expect(context).not.toContain("Phase Plan run recovered.");
    });
  });

  it("compact source injects the SAME capsule as startup for identical Store state (E20, §52)", async () => {
    await withFixture(async (fixture, deps) => {
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1 committed" }]);
      const startup = additionalContext(await handleSessionStart(deps, sessionStartInput(fixture, "startup", "plan")));
      const compact = additionalContext(await handleSessionStart(deps, sessionStartInput(fixture, "compact", "plan")));
      expect(compact).toBe(startup);
      // E21: the store was not touched by either injection.
      expect(fixture.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM plan_commits").get())).toEqual({ n: 1 });
    });
  });

  it("resume in non-plan mode keeps the exact A1 wording appended to the capsule (E19)", async () => {
    await withFixture(async (fixture, deps) => {
      const context = additionalContext(await handleSessionStart(deps, sessionStartInput(fixture, "resume", "default")));
      expect(context).toContain("[Phase Plan Recovery v1]");
      expect(context).toContain("Phase Plan run recovered.");
      expect(context).toContain("Claude Plan Mode must be restored by invoking /phase-plan.");
    });
  });

  it("a capsule construction failure is fail-visible, never silent (§47)", async () => {
    await withFixture(async (fixture, deps) => {
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1 committed" }]);
      // planning_runs rows are the run's own mutable state: an oversized goal
      // is a realistic failure that makes the P0 capsule budget overflow, so
      // buildRecoveryCapsule throws CONTEXT_BUDGET_EXCEEDED.
      const oversizedGoal = "G".repeat(13_000);
      fixture.store.withWrite((tx) => {
        tx.prepare("UPDATE planning_runs SET goal = ? WHERE run_id = ?").run(oversizedGoal, fixture.runId);
      });
      const context = additionalContext(await handleSessionStart(deps, sessionStartInput(fixture, "startup", "plan")));
      expect(context).toContain("CONTEXT_RECOVERY_FAILED");
      expect(context).toContain("error=CONTEXT_BUDGET_EXCEEDED");
      expect(context).toContain("Do not continue planning on stale context; invoke /phase-plan.");
      expect(context).not.toContain("[Phase Plan Recovery v1]");
    });
  });

  it("a session without an attached run injects nothing", async () => {
    await withFixture(async (fixture, deps) => {
      const output = await handleSessionStart(deps, { ...sessionStartInput(fixture, "startup", "plan"), sessionId: "S2-CLEAR-NONE" });
      expect(output.kind).toBe("empty");
    });
  });
});

describe("UserPromptSubmit delta context (§34, E5)", () => {
  it("injects the short epoch marker for normal plan-mode prompts", async () => {
    await withFixture(async (fixture, deps) => {
      const before = handleUserPromptSubmit(deps, {
        sessionId: fixture.sessionId,
        hookEventName: "UserPromptSubmit",
        prompt: "continue planning",
        permissionMode: "plan",
      });
      expect(before.kind).toBe("json");
      const marker = ((before as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(marker).toMatch(/^Phase Plan context epoch: [0-9a-f]{64}\nUse phase_plan\.get_context if context appears stale\.$/);

      // After a commit the epoch marker changes (E5).
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1 committed" }]);
      const after = handleUserPromptSubmit(deps, {
        sessionId: fixture.sessionId,
        hookEventName: "UserPromptSubmit",
        prompt: "continue planning",
        permissionMode: "plan",
      });
      const marker2 = ((after as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(marker2).not.toBe(marker);
      // The marker never carries the full capsule.
      expect(marker2).not.toContain("[Phase Plan Recovery v1]");
    });
  });

  it("the entry prompt and drift cases keep their Phase 7 behavior", async () => {
    await withFixture(async (fixture, deps) => {
      // Entry prompt: unchanged, no marker.
      expect(
        handleUserPromptSubmit(deps, {
          sessionId: fixture.sessionId,
          hookEventName: "UserPromptSubmit",
          prompt: "/phase-plan",
          permissionMode: "plan",
        }).kind,
      ).toBe("empty");
      // Drift: still blocked with the frozen A1 wording.
      expect(
        handleUserPromptSubmit(deps, {
          sessionId: fixture.sessionId,
          hookEventName: "UserPromptSubmit",
          prompt: "continue planning",
          permissionMode: "default",
        }),
      ).toEqual({ kind: "json", payload: { decision: "block", reason: DRIFT_GUARD_REASON } });
      // Run-less session: nothing.
      expect(
        handleUserPromptSubmit(deps, {
          sessionId: "S2-CLEAR-NONE",
          hookEventName: "UserPromptSubmit",
          prompt: "hello",
          permissionMode: "plan",
        }).kind,
      ).toBe("empty");
    });
  });
});
