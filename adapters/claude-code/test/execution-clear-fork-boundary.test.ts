/**
 * E12 Closure Amendment (E12C) — /clear + fork writable-authority semantics.
 *
 * The amendment's core invariant: conversation-operation identity must not be
 * collapsed into ClaudeSessionID identity when the Host authoritatively proves
 * a clear/fork boundary. source=clear converges the session's ownership to
 * detached (generation unchanged — clear is a detach, not a takeover); the
 * boundary detach lives in SessionStart(source=clear) and SessionEnd(reason=
 * clear) is a structural no-op, so a reordered/late pre-clear SessionEnd can
 * never detach a context that explicitly reacquired ownership. source=fork
 * never inherits and never mutates the original owner — even under the
 * contract-violating reused-session-id case the classifier returns
 * fork_non_inheriting, never same_owner_attached.
 *
 * Host contract pinned (E12C-T11, amendment §3/§10): the installed Claude Code
 * runtime (2.1.259, runtime probe) fires SessionStart with source=fork for a
 * NEW session id (probe: --resume <id> --fork-session → distinct
 * session_id + distinct transcript_path; official hooks docs: "a new session
 * forked from an existing one"; phase-17 live TUI matrix recorded the same).
 * The adapter additionally treats the parse-layer SESSION_START_SOURCES enum
 * as the vendored contract surface under test.
 */
import { describe, expect, it } from "vitest";

import { handlePreToolUse, handleSessionEnd, handleSessionStart } from "../src/hooks/handlers.js";
import { classifyExecutionSessionStartInTx } from "../src/application/execution-session-recovery.js";
import { SESSION_START_SOURCES } from "../src/hooks/parse.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { makeAcceptanceWorld, codeOf, supervisorCall } from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import type { AcceptanceWorld } from "./acceptance-helpers.js";
import {
  bindingOf,
  contextOf,
  depsOf,
  directiveProbeBusiness,
  executionFingerprintOf,
  explicitExecutionTakeover,
  sessionStartInput,
  supervisorCallAs,
} from "./session-recovery-helpers.js";

/** The launch_token_hash of the run's prepared-unclaimed invocation, if any. */
function preparedHashOf(world: AcceptanceWorld): string | null {
  return world.ctx.store.withRead((tx) => {
    const row = tx
      .prepare(
        "SELECT launch_token_hash FROM execution_worker_invocations WHERE execution_run_id = ? AND state = 'prepared' AND worker_session_id IS NULL ORDER BY created_at LIMIT 1",
      )
      .get(world.executionRunId) as { launch_token_hash: string } | undefined;
    return row?.launch_token_hash ?? null;
  });
}

/** The execution fingerprint without the binding row (the ONLY legal clear change). */
function fingerprintWithoutBinding(world: AcceptanceWorld): string {
  const parsed = JSON.parse(executionFingerprintOf(world)) as Record<string, unknown>;
  delete parsed.binding;
  return JSON.stringify(parsed);
}

/** The main-session host-guard probe (E12C §16): deny ordinary mutation tools. */
async function guardDenial(world: AcceptanceWorld, sessionId: string, tool: string, toolInput: Record<string, unknown>) {
  const out = await handlePreToolUse(
    depsOf(world),
    {
      sessionId,
      cwd: world.f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "PreToolUse",
      toolName: tool,
      toolInput,
      toolUseId: `TU-E12C-${tool}-${sessionId}`,
    } as never,
  );
  return JSON.stringify(out);
}

describe("E12C /clear (amendment §4–§8/§19)", () => {
  it("E12C-T1: clear with a DIFFERENT session id transfers nothing — old owner stays attached, newcomer read-only", async () => {
    const world = await makeAcceptanceWorld("S1");
    const out = await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S2-CLEAR", source: "clear" }) as never);
    const context = contextOf(out);
    expect(context).toContain("NO writable supervision authority");
    expect(context).toContain("Session relation: clear");
    // The old execution ownership is NOT transferred and NOT detached by
    // another session's clear boundary (the boundary destroys only ITS OWN
    // conversation context).
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1, sessionId: "S1" });
  });

  it("E12C-T2: clear with the SAME session id detaches the binding — no authority survives the boundary", async () => {
    const world = await makeAcceptanceWorld("S1");
    const out = await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S1", source: "clear" }) as never);
    // The reused session id does NOT retain authority: binding detached,
    // generation UNCHANGED (amendment §7 — clear is a detach, not a takeover).
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation: 1, sessionId: "S1" });
    const context = contextOf(out);
    expect(context).toContain("ownership class: cleared");
    expect(context).not.toContain("execution session restored");
    expect(context).toContain("takeover_run");
    // The cleared same-session context cannot sign supervisor mutations: its
    // binding is detached, which is the SUPERVISOR_BINDING_REQUIRED branch
    // ("reattach or take over") — the takeover path this context must use.
    expect(
      codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S1")),
    ).toBe("SUPERVISOR_BINDING_REQUIRED");
  });

  it("E12C-T3: the clear boundary mutates ONLY binding rows — execution state fingerprint is identical", async () => {
    const world = await makeAcceptanceWorld("S1");
    // §18 — a prepared Worker credential exists while the owner is attached;
    // the plain detach must NOT revoke it.
    const directive = issueDirective(world, { directiveId: "DIR-E12C-T3", kind: "inspection" });
    world.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: "S1",
          workspaceId: world.f.workspaceId,
          generation: 1,
          directiveId: directive.directiveId,
          directiveRevision: directive.revision,
          directiveHash: directive.hash,
          workerRole: "executor",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const hashBefore = preparedHashOf(world);
    expect(hashBefore).not.toBeNull();
    const before = fingerprintWithoutBinding(world);
    await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S1", source: "clear" }) as never);
    expect(fingerprintWithoutBinding(world)).toBe(before);
    expect(preparedHashOf(world)).toBe(hashBefore);
  });

  it("E12C-T4: the cleared context cannot mutate — direct repo tools and supervisor mutations are denied", async () => {
    const world = await makeAcceptanceWorld("S1");
    await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S1", source: "clear" }) as never);
    for (const [tool, toolInput] of [
      ["Write", { file_path: "src/x.ts" }],
      ["Edit", { file_path: "src/x.ts" }],
      ["Bash", { command: "rm -rf build" }],
      ["Agent", { subagent_type: "general-purpose" }],
    ] as const) {
      const payload = await guardDenial(world, "S1", tool, toolInput as Record<string, unknown>);
      expect(payload, tool).toContain("EXECUTION_SESSION_NOT_OWNER");
    }
    expect(
      codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S1")),
    ).toBe("SUPERVISOR_BINDING_REQUIRED");
  });

  it("E12C-T5: explicit reacquisition after clear goes through the canonical takeover — generation N+1, credentials fenced", async () => {
    const world = await makeAcceptanceWorld("S1");
    const directive = issueDirective(world, { directiveId: "DIR-E12C-T5", kind: "inspection" });
    world.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: "S1",
          workspaceId: world.f.workspaceId,
          generation: 1,
          directiveId: directive.directiveId,
          directiveRevision: directive.revision,
          directiveHash: directive.hash,
          workerRole: "executor",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S1", source: "clear" }) as never);
    const hashAfterClear = preparedHashOf(world);
    // The SAME (cleared) session reacquires through the EXISTING explicit
    // user-authorized takeover path — no third ownership system (§6).
    const result = explicitExecutionTakeover(world, { newSessionId: "S1", expectedGeneration: 1 });
    expect(result.supervisor!).toMatchObject({ generation: 2, state: "attached" });
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 2, sessionId: "S1" });
    // §18 — the takeover's generation change fences the prepared credential
    // the detach preserved.
    expect(result.supervisor!.revokedLaunchCredentials.length).toBe(1);
    expect(preparedHashOf(world)).not.toBe(hashAfterClear);
    // The reacquired owner proceeds under the CURRENT generation.
    const listing = supervisorCallAs(world, {
      sessionId: "S1",
      generation: 2,
      tool: "get_execution_acceptance_context",
    }) as Record<string, unknown>;
    expect(listing).not.toHaveProperty("error");
  });

  it("E12C-T6: a late/reordered clear SessionEnd can never detach a reacquired owner — and genuine exits still do", async () => {
    // (a) End(clear) BEFORE the boundary: a no-op — the detach belongs to the
    // clear SessionStart, so either host ordering converges to the same state.
    const early = await makeAcceptanceWorld("S1");
    handleSessionEnd(depsOf(early), { sessionId: "S1", hookEventName: "SessionEnd", reason: "clear" } as never);
    expect(bindingOf(early)).toMatchObject({ state: "attached", generation: 1 });
    await handleSessionStart(depsOf(early), sessionStartInput(early, { sessionId: "S1", source: "clear" }) as never);
    expect(bindingOf(early)).toMatchObject({ state: "detached", generation: 1 });
    // (b) End(clear) AFTER explicit reacquisition: the structural no-op keeps
    // the newly authorized owner intact (amendment §8/D).
    explicitExecutionTakeover(early, { newSessionId: "S1", expectedGeneration: 1 });
    handleSessionEnd(depsOf(early), { sessionId: "S1", hookEventName: "SessionEnd", reason: "clear" } as never);
    expect(bindingOf(early)).toMatchObject({ state: "attached", generation: 2, sessionId: "S1" });
    // (c) A GENUINE exit of the reacquired context still detaches normally.
    handleSessionEnd(depsOf(early), { sessionId: "S1", hookEventName: "SessionEnd", reason: "prompt_input_exit" } as never);
    expect(bindingOf(early)).toMatchObject({ state: "detached", generation: 2, sessionId: "S1" });
  });
});

describe("E12C fork (amendment §9–§12/§20)", () => {
  it("E12C-T7: a fork with a DIFFERENT session id reads the run read-only — original owner stays attached", async () => {
    const world = await makeAcceptanceWorld("S1");
    const out = await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S2-FORK", source: "fork" }) as never);
    const context = contextOf(out);
    expect(context).toContain("NO writable supervision authority");
    expect(context).toContain("Session relation: fork");
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1, sessionId: "S1" });
  });

  it("E12C-T8: fork creation NEVER detaches or mutates the original owner's binding", async () => {
    const world = await makeAcceptanceWorld("S1");
    const before = executionFingerprintOf(world);
    await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S2-FORK", source: "fork" }) as never);
    expect(executionFingerprintOf(world)).toBe(before);
  });

  it("E12C-T9: the fork context cannot mutate — direct repo tools and supervisor mutations are denied", async () => {
    const world = await makeAcceptanceWorld("S1");
    await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S2-FORK", source: "fork" }) as never);
    for (const [tool, toolInput] of [
      ["Write", { file_path: "src/x.ts" }],
      ["Edit", { file_path: "src/x.ts" }],
      ["Bash", { command: "rm -rf build" }],
      ["Agent", { subagent_type: "general-purpose" }],
    ] as const) {
      const payload = await guardDenial(world, "S2-FORK", tool, toolInput as Record<string, unknown>);
      expect(payload, tool).toContain("EXECUTION_SESSION_NOT_OWNER");
    }
    expect(
      codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S2-FORK")),
    ).toBe("STALE_SUPERVISOR_BINDING");
  });

  it("E12C-T10: the authorized fork takeover advances the generation and permanently fences the fork source", async () => {
    const world = await makeAcceptanceWorld("S1");
    await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S2-FORK", source: "fork" }) as never);
    const result = explicitExecutionTakeover(world, { newSessionId: "S2-FORK", expectedGeneration: 1 });
    expect(result.supervisor!).toMatchObject({ generation: 2, state: "attached" });
    expect(
      codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S1")),
    ).toBe("STALE_SUPERVISOR_BINDING");
  });

  it("E12C-T11: same-session-id fork is structurally non-inheriting (defensive) and the Host contract is pinned", async () => {
    // Contract pin (amendment §3/§10): the vendored parse enum carries the
    // boundary sources; the installed runtime probe proved a fork mints a NEW
    // session id, so the identity branch below is the fail-closed fallback for
    // a contract violation — it must NEVER report inheritance.
    expect(SESSION_START_SOURCES).toContain("fork");
    expect(SESSION_START_SOURCES).toContain("clear");
    const world = await makeAcceptanceWorld("S1");
    // Simulate the contract-violating reused id: source=fork for the OWNER's
    // own session id. The classifier must refuse same_owner_attached and the
    // handler must not mutate the original owner's binding.
    const classification = world.ctx.store.withRead((tx) =>
      classifyExecutionSessionStartInTx(tx, { sessionId: "S1", workspaceId: world.f.workspaceId, source: "fork" }),
    );
    expect(classification.outcome).toBe("fork_non_inheriting");
    expect(classification.ownership).toBe("none");
    const before = executionFingerprintOf(world);
    const out = await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S1", source: "fork" }) as never);
    expect(executionFingerprintOf(world)).toBe(before);
    const context = contextOf(out);
    expect(context).toContain("ownership class: fork");
    expect(context).toContain("never inherits");
    // The original owner's authority is untouched: it still supervises under
    // generation 1 (fork boundaries never detach the original owner, §9).
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1, sessionId: "S1" });
  });
});
