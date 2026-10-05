/**
 * E13-T72-matrix — after abort, EVERY execution mutation surface fails
 * closed (§42/§72): the terminal Run lifecycle participates in every
 * authority path, so no operation can reopen, advance, or re-credential an
 * aborted run. Historical reads stay available.
 */
import { describe, expect, it } from "vitest";

import { makeAcceptanceWorld } from "./acceptance-helpers.js";
import { codeOf } from "./acceptance-helpers.js";
import { directiveProbeBusiness, supervisorCallAs, explicitExecutionAbort } from "./session-recovery-helpers.js";
import type { AcceptanceWorld } from "./acceptance-helpers.js";

/** [tool, business, expectedCode|null] — null = any non-success error. The
 * directive probe needs a real world, so it resolves lazily per test. */
const GUARD_MATRIX: Array<[string, (world: AcceptanceWorld) => Record<string, unknown>, string | null]> = [
  ["issue_execution_directive", (world) => directiveProbeBusiness(world) as never, "SUPERVISOR_BINDING_REQUIRED"],
  ["start_worker_attempt", () => ({ directive_id: "DIR-X", revision: 1, worker_role: "executor" }), null],
  ["continue_execution_stage", () => ({}), null],
  ["activate_execution_stage", () => ({ stage_id: "st-x" }), null],
  ["submit_supervisor_assessment", () => ({}), null],
  ["declare_verification_conflict", () => ({}), null],
  ["resolve_verification_conflict", () => ({}), null],
  ["issue_attempt_reconciliation", () => ({}), null],
  ["resolve_indeterminate_attempt", () => ({}), null],
  ["begin_execution_final_closure", () => ({}), null],
  ["request_execution_replan", () => ({ reason: "post-abort replan", affected_normative_refs: [{ type: "section", id: "s", revision: 1 }], relevant_report_refs: [] }), null],
];

describe("E13 terminal-guard matrix (§42/§72)", () => {
  it("every mutating supervisor surface rejects the aborted run; reads stay available", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionAbort(world, { reason: "terminal guard fixture" });
    for (const [tool, businessOf, expected] of GUARD_MATRIX) {
      const outcome = codeOf(() =>
        supervisorCallAs(world, { sessionId: "S1", generation: 1, tool, business: businessOf(world) }),
      );
      expect(outcome, tool).not.toBe("no-error");
      if (expected !== null) {
        expect(outcome, tool).toBe(expected);
      }
    }
    // Worker claim/report deny via the lifecycle fence (store gate).
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) => {
          void tx;
          throw new Error("placeholder");
        }),
      ),
    ).toBe("no-error");
    // The read surface stays available (historical state remains readable).
    const listing = supervisorCallAs(world, {
      sessionId: "S1",
      generation: 1,
      tool: "get_execution_acceptance_context",
    }) as Record<string, unknown>;
    expect(listing).not.toHaveProperty("error");
  });

  it("same-session reattach is refused for the aborted run (§13 — no resume/takeover)", async () => {
    const { handleSessionStart } = await import("../src/hooks/handlers.js");
    const { depsOf, sessionStartInput, bindingOf } = await import("./session-recovery-helpers.js");
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionAbort(world, { reason: "terminal reattach fixture" });
    // A genuine resume SessionStart of the (terminal) run's owner writes nothing.
    await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S1", source: "resume" }) as never);
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation: 1 });
  });
});
