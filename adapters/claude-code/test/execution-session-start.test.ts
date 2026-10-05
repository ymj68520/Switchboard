/**
 * E12-T1–T4/T52/T58–T60 — the deterministic SessionStart classification
 * (E12 §7/§8/§24/§28/§29/§50/§51/§52): authority comes from Store identity
 * only; exactly one classification may mutate the binding automatically
 * (same_owner_detached_resume, resume relation only); different sessions are
 * read-only; ambiguity is never guessed.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { handleSessionStart } from "../src/hooks/handlers.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { takeoverSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { makeAcceptanceWorld, type AcceptanceWorld } from "./acceptance-helpers.js";
import {
  bindingOf,
  cloneActiveRunInTx,
  contextOf,
  depsOf,
  makeForeignWorkspace,
  sessionStartInput,
} from "./session-recovery-helpers.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof RuntimeError ? err.code : "no-error";
  }
  return "no-error";
}

async function start(world: AcceptanceWorld, overrides: Record<string, unknown> = {}) {
  return handleSessionStart(depsOf(world), sessionStartInput(world, overrides) as never);
}


describe("E12 same-session resume (§7/§8)", () => {
  it("E12-T1: attached same-session resume — generation and binding unchanged, zero mutation", async () => {
    const world = await makeAcceptanceWorld("S1");
    const before = bindingOf(world);
    expect(before).toMatchObject({ state: "attached", generation: 1, sessionId: "S1" });
    const out = await start(world, { source: "resume" });
    const context = contextOf(out);
    expect(context).toContain("Execution Recovery Context");
    expect(context).toContain("ownership: current-session");
    expect(context).toContain("session relation: resume");
    expect(context).toContain("Next legal action: continue supervision");
    expect(bindingOf(world)).toEqual(before);
  });

  it("E12-T2: detached exact-session resume — reattach with the SAME generation", async () => {
    const world = await makeAcceptanceWorld("S1");
    world.ctx.store.withWrite((tx) => {
      tx.prepare("UPDATE supervisor_bindings SET state = 'detached' WHERE execution_run_id = ?").run(world.executionRunId);
    });
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation: 1 });
    await start(world, { source: "resume" });
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1, sessionId: "S1" });
  });

  it("E12-T3: same session id at the wrong WorkspaceIdentity fails closed (no reattach)", async () => {
    const world = await makeAcceptanceWorld("S1");
    const foreign = makeForeignWorkspace();
    world.ctx.store.withWrite((tx) => {
      tx.prepare("UPDATE supervisor_bindings SET state = 'detached' WHERE execution_run_id = ?").run(world.executionRunId);
    });
    await handleSessionStart(
      depsOf(world),
      sessionStartInput(world, { source: "resume", cwd: path.join(foreign.root, "project") }) as never,
    );
    // §28 — the workspace fence: the detached supervision binding can never
    // reattach from a foreign WorkspaceIdentity (the delivered Build contract
    // capsule may still render — Phase 14 recovery — but ownership moved not
    // one bit).
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation: 1, sessionId: "S1" });
    foreign.close();
  });

  it("E12-T4: an old session id at a stale generation cannot use the same-session resume shortcut", async () => {
    const world = await makeAcceptanceWorld("S1");
    world.ctx.store.withWrite((tx) =>
      takeoverSupervisorBindingInTx(
        tx,
        { executionRunId: world.executionRunId, workspaceId: world.f.workspaceId, newSessionId: "S2", expectedGeneration: 1 },
        world.ctx.clock.nowIso(),
      ),
    );
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 2, sessionId: "S2" });
    const out = await start(world, { sessionId: "S1", source: "resume" });
    // S1 owns no supervision binding any more: the recovery capsule renders the
    // other-session ownership read-only, and S2's binding is untouched.
    expect(contextOf(out)).toContain("ownership: other-session");
    expect(contextOf(out)).toContain("writable supervision requires explicit takeover");
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 2, sessionId: "S2" });
  });
});

describe("E12 unbound and ambiguous discovery (§29/§52)", () => {
  it("E12-T52: a second execution world of one planning run is never implicitly selected — legacy resolution is ambiguous", async () => {
    const world = await makeAcceptanceWorld("S1");
    // A1 §28 — a workspace holds at most ONE non-terminal world, so the
    // second execution world of THIS planning run is cloned TERMINAL. The
    // legacy run_id resolution then faces TWO worlds of the same planning run
    // and is refused — never an implicit pick.
    cloneActiveRunInTx(world, "plan-e12-unbound", { lifecycle: "replan_required", samePlanningRun: true });
    const { executePhasePlanTool } = await import("../src/mcp/tools.js");
    const { hostTokenV2 } = await import("./phase12-helpers.js");
    const token = hostTokenV2(
      world.ctx.secret,
      "takeover_run",
      { run_id: world.f.runId, expected_binding_generation: 1 },
      { sessionId: world.f.sessionId, workspaceId: world.f.workspaceId, generation: world.f.generation },
      { toolUseId: "TU-T52-LEGACY" },
    );
    expect(codeOf(() => executePhasePlanTool(world.ctx, "takeover_run", { run_id: world.f.runId, expected_binding_generation: 1, _hostContext: token }))).toBe(
      "EXECUTION_RUN_AMBIGUOUS",
    );
    // Session-start discovery still resolves the single ACTIVE world — and
    // nothing was silently bound by discovery.
    const out = await start(world, { sessionId: "S9" });
    expect(contextOf(out)).not.toContain("EXECUTION_RUN_AMBIGUOUS");
    const bindings = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT COUNT(*) AS n FROM supervisor_bindings").get() as { n: number },
    );
    expect(bindings.n).toBe(1);
  });

  it("E12-T52b: exactly one active unbound run — read-only takeover notice, no fabricated ownership", async () => {
    const world = await makeAcceptanceWorld("S1");
    // Make the CLONE the only ACTIVE run: the original moves to the terminal
    // vocabulary FIRST (the workspace singleton admits one non-terminal
    // world; the E10 completion-shape trigger correctly forbids a lazy
    // 'completed'). The clone carries no binding row (the migrated-v14
    // unbound shape, E2 §16).
    world.ctx.store.withWrite((tx) => {
      tx.prepare("UPDATE execution_runs SET lifecycle = 'aborted' WHERE execution_run_id = ?").run(world.executionRunId);
    });
    cloneActiveRunInTx(world, "plan-e12-only");
    const out = await start(world, { sessionId: "S9" });
    const context = contextOf(out);
    expect(context).toContain("no owner recorded; explicit takeover required");
    expect(context).toContain("NO writable supervision authority");
    expect(context).not.toContain("EXECUTION_RUN_AMBIGUOUS");
  });

  it("E12-T59: multiple candidate execution worlds — no implicit selection (EXECUTION_RUN_AMBIGUOUS)", async () => {
    const world = await makeAcceptanceWorld("S1");
    // A1 §28/§37 — the second execution world of THIS planning run is cloned
    // TERMINAL (the workspace singleton admits one non-terminal world); the
    // legacy run_id resolution then faces TWO worlds and is refused.
    cloneActiveRunInTx(world, "plan-e12-second", { lifecycle: "replan_required", samePlanningRun: true });
    const { executePhasePlanTool } = await import("../src/mcp/tools.js");
    const { hostTokenV2 } = await import("./phase12-helpers.js");
    const token = hostTokenV2(
      world.ctx.secret,
      "takeover_run",
      { run_id: world.f.runId, expected_binding_generation: 1 },
      { sessionId: world.f.sessionId, workspaceId: world.f.workspaceId, generation: world.f.generation },
      { toolUseId: "TU-T59-LEGACY" },
    );
    expect(codeOf(() => executePhasePlanTool(world.ctx, "takeover_run", { run_id: world.f.runId, expected_binding_generation: 1, _hostContext: token }))).toBe(
      "EXECUTION_RUN_AMBIGUOUS",
    );
    // Session-start discovery resolves the single ACTIVE world unambiguously
    // (no implicit selection is even possible at workspace level under A1).
    const out = await start(world, { sessionId: "S9" });
    expect(contextOf(out)).toContain(world.executionRunId);
    expect(contextOf(out)).not.toContain("plan-e12-second-EXEC");
    // Nothing was mutated by either probe.
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1, sessionId: "S1" });
  });

  it("E12-T60: an exact binding disambiguates its own run; an explicit exact target resolves ambiguity", async () => {
    const world = await makeAcceptanceWorld("S1");
    // A1 §28/§38 — the second execution world of THIS planning run is cloned
    // TERMINAL; the legacy run_id alone is ambiguous (T59), but the EXACT
    // execution_run_id selects its world directly.
    cloneActiveRunInTx(world, "plan-e12-third", { lifecycle: "replan_required", samePlanningRun: true });
    // A current exact binding may disambiguate its own Run (§29): S1 still
    // gets its own recovery capsule, not the ambiguity notice.
    const own = await start(world, { sessionId: "S1", source: "startup" });
    expect(contextOf(own)).toContain("Execution Recovery Context");
    // Explicit exact target through the real MCP surface: ONLY the named
    // world moves to S9 at the next generation; the terminal clone is
    // untouched.
    const { executePhasePlanTool } = await import("../src/mcp/tools.js");
    const { hostTokenV2 } = await import("./phase12-helpers.js");
    const token = hostTokenV2(
      world.ctx.secret,
      "takeover_run",
      { execution_run_id: world.executionRunId, expected_binding_generation: 1 },
      { sessionId: "S9", workspaceId: world.f.workspaceId },
      { toolUseId: "TU-T60-EXACT" },
    );
    expect(codeOf(() => executePhasePlanTool(world.ctx, "takeover_run", { execution_run_id: world.executionRunId, expected_binding_generation: 1, _hostContext: token }))).toBe(
      "no-error",
    );
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 2, sessionId: "S9" });
    const cloneBinding = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT COUNT(*) AS n FROM supervisor_bindings WHERE execution_run_id = ?").get("plan-e12-third-EXEC") as { n: number },
    );
    expect(cloneBinding.n).toBe(0);
  });

  it("E12-T58: the same repository at a different WorkspaceIdentity can neither resume nor take over", async () => {
    const world = await makeAcceptanceWorld("S1");
    const foreign = makeForeignWorkspace();
    world.ctx.store.withWrite((tx) => {
      tx.prepare("UPDATE supervisor_bindings SET state = 'detached' WHERE execution_run_id = ?").run(world.executionRunId);
    });
    // Resume from the foreign root never reattaches (workspace fence, §28).
    await handleSessionStart(
      depsOf(world),
      sessionStartInput(world, { source: "resume", cwd: path.join(foreign.root, "project") }) as never,
    );
    expect(bindingOf(world)).toMatchObject({ state: "detached" });
    // Takeover from a foreign workspace fails closed.
    const code = codeOf(() =>
      world.ctx.store.withWrite((tx) =>
        takeoverSupervisorBindingInTx(
          tx,
          {
            executionRunId: world.executionRunId,
            workspaceId: "ws_foreign-not-the-bound-workspace",
            newSessionId: "S9",
            expectedGeneration: 1,
          },
          world.ctx.clock.nowIso(),
        ),
      ),
    );
    expect(code).toBe("WORKSPACE_MISMATCH");
    foreign.close();
  });
});
