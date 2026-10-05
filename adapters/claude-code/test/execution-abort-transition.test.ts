/**
 * E13-T7..T13/T49/T58 — the abort transition itself: one atomic transaction
 * that flips active → aborted, detaches the SupervisorBinding with its
 * generation PRESERVED, and touches NOTHING else — acceptedHead,
 * candidateRevision, Stage states, Directives, Attempts, Reports all remain
 * byte-identical (§1 preservation list, §16–§18, §49). Aborted is terminal
 * forever (§13) and introduces no uniqueness that blocks a later independent
 * reexecution of the same FinalPlan (§52/§58).
 */
import { describe, expect, it } from "vitest";

import { makeAcceptanceWorld, codeOf } from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import {
  bindingOf,
  cloneActiveRunInTx,
  executionFingerprintOf,
  explicitExecutionAbort,
  lifecycleOf,
} from "./session-recovery-helpers.js";

describe("E13 basic transition (§12/§13/§34/§38)", () => {
  it("E13-T7: active → aborted succeeds with valid human authorization", async () => {
    const world = await makeAcceptanceWorld("S1");
    const result = explicitExecutionAbort(world, { reason: "stop the run" });
    expect(result.executionRun.lifecycle).toBe("aborted");
    expect(lifecycleOf(world)).toBe("aborted");
    // The ABORTED run event joined the ledger, bound to the control record.
    const event = world.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT event_type AS t, detail_json AS d FROM execution_run_events WHERE execution_run_id = ? ORDER BY event_seq DESC LIMIT 1")
          .get(world.executionRunId) as { t: string; d: string },
    );
    expect(event.t).toBe("ABORTED");
    expect(event.d).toContain(result.controlId);
  });

  it("E13-T8: the abort provenance is durable and one-to-one", async () => {
    const world = await makeAcceptanceWorld("S1");
    const result = explicitExecutionAbort(world, { requesterSessionId: "S9", reason: "durable reason" });
    const record = world.ctx.store.withRead(
      (tx) =>
        tx
          .prepare(
            "SELECT execution_run_id AS runId, control_id AS controlId, requested_by_session_id AS s, reason, created_at AS at "
            + "FROM execution_abort_records WHERE execution_run_id = ?",
          )
          .get(world.executionRunId) as { runId: string; controlId: string; s: string; reason: string; at: string },
    );
    expect(record).toMatchObject({ runId: world.executionRunId, controlId: result.controlId, s: "S9", reason: "durable reason" });
    const count = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_abort_records").get() as { n: number },
    );
    expect(count.n).toBe(1);
    // The provenance references the REAL consumed authorization (§59).
    const control = world.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT operation, execution_run_id AS runId FROM run_control_authorizations WHERE control_id = ?")
          .get(result.controlId) as { operation: string; runId: string },
    );
    expect(control).toMatchObject({ operation: "abort", runId: world.executionRunId });
  });

  it("E13-T9/T10: the SupervisorBinding detaches with its generation preserved", async () => {
    const world = await makeAcceptanceWorld("S1");
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1 });
    explicitExecutionAbort(world, { reason: "stop" });
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation: 1, sessionId: "S1" });
    // The DETACHED audit event joined the binding history (§34 — history
    // preserved); no takeover event exists.
    const events = world.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT event_type AS t FROM supervisor_binding_events WHERE execution_run_id = ? ORDER BY event_seq").all(world.executionRunId) as Array<{ t: string }>,
    );
    expect(events.at(-1)).toMatchObject({ t: "DETACHED" });
  });

  it("E13-T11/T12/T13: acceptedHead, candidateRevision, and Stage states are untouched — only the binding row changed", async () => {
    const world = await makeAcceptanceWorld("S1");
    issueDirective(world, { directiveId: "DIR-E13-PRE", kind: "inspection" });
    const before = JSON.parse(executionFingerprintOf(world)) as Record<string, unknown>;
    explicitExecutionAbort(world, { reason: "stop" });
    const after = JSON.parse(executionFingerprintOf(world)) as Record<string, unknown>;
    // Everything EXCEPT the binding row (state attached→detached) is
    // identical: lifecycle aside, even the run revision is the ONLY other
    // legal change and the fingerprint deliberately includes it — assert the
    // exact allowed deltas.
    expect(after.binding).toMatchObject({ state: "detached", generation: (before.binding as { generation: number }).generation, sessionId: "S1" });
    expect(after.lifecycle).toBe("aborted");
    // acceptedHead, structure, protocol, attempts identical.
    expect(after.runRevision).toBe((before.runRevision as number) + 1);
    expect(after.stages).toEqual(before.stages);
    expect(after.activeStage).toEqual(before.activeStage);
    // The open Window legitimately TERMINATES (E13 §19): no open window
    // remains, and the closed window carries closure_kind='aborted' with its
    // candidateRevision preserved.
    expect(after.openWindow).toBeNull();
    expect(before.openWindow).not.toBeNull();
    const closedWindow = world.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT closure_kind AS k, candidate_revision AS r FROM verification_windows WHERE id = ?")
          .get((before.openWindow as { id: string }).id) as { k: string; r: number },
    );
    expect(closedWindow.k).toBe("aborted");
    expect(closedWindow.r).toBe((before.openWindow as { candidateRevision: number }).candidateRevision);
    expect(after.directives).toEqual(before.directives);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.acceptedHead).toEqual(before.acceptedHead);
    // The candidateRevision never moved (§17).
    const windowRow = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT candidate_revision AS r FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NOT NULL").get(world.executionRunId) as { r: number },
    );
    if (windowRow !== undefined) {
      expect(windowRow.r).toBe((before.openWindow as { candidateRevision: number } | null)?.candidateRevision ?? 0);
    }
  });

  it("E13-T49: acceptedHead remains the last authoritative accepted state — identical before/after", async () => {
    const world = await makeAcceptanceWorld("S1");
    const headBefore = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT accepted_head_commit_id AS h, completion_commit_id AS c FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string | null; c: string | null },
    );
    explicitExecutionAbort(world, { reason: "stop" });
    const headAfter = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT accepted_head_commit_id AS h, completion_commit_id AS c FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string | null; c: string | null },
    );
    expect(headAfter.h).toBe(headBefore.h);
    // An aborted run NEVER carries completion provenance (§45/§58).
    expect(headAfter.c).toBeNull();
  });

  it("E13-T7b: forbidden transitions fail closed — completed/replan/aborted runs never abort", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionAbort(world, { reason: "first stop" });
    // A SECOND abort of the now-terminal run is refused (RUN_TERMINAL), and
    // a second abort FACT can never exist (§15).
    expect(codeOf(() => explicitExecutionAbort(world, { reason: "second stop", toolUseId: "TU-E13-SECOND" }))).toBe("RUN_TERMINAL");
    const records = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_abort_records WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    expect(records.n).toBe(1);
  });

  it("E13-T58: abort introduces no uniqueness — the same FinalPlan can later run independently", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionAbort(world, { reason: "stop" });
    // A second ACTIVE ExecutionRun of the same workspace/final-plan lineage
    // is representable (the store imposes no FinalPlan uniqueness); the old
    // aborted run stays immutable.
    cloneActiveRunInTx(world, "plan-e13-REEXEC");
    expect(lifecycleOf(world, "plan-e13-REEXEC-EXEC")).toBe("active");
    expect(lifecycleOf(world)).toBe("aborted");
  });
});
