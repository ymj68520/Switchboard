/**
 * E8 §53 — the bounded conflict-resolution verifier (E8-T28..T33).
 *
 * Exactly ONE dedicated resolution Directive per conflict (E8 §31/§38); the
 * resolver is a FRESH real E5 worker whose session differs from every source
 * Report's worker session (E8 §33, enforced at claim time); the assignment is
 * identity-blinded to the neutral conflict context (E8 §32); a conflict
 * resolver never clears normal verification debt (E8 §34) and never satisfies
 * the E6 acceptance-verification gate.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptanceServiceOf,
  acceptInput,
  codeOf,
  makeAcceptanceWorld,
  runDirectiveCycle,
  runVerificationCycle,
  supervisorCall,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { callWorkerTool, freshWorkerSession } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { loadWorkerAssignment } from "../src/application/worker-runtime-service.js";
import { getVerificationConflictInTx } from "../src/store/verification-conflicts.js";
import { loadVerificationPolicyStateInTx } from "../src/application/verification-policy-service.js";
import { randomUUID } from "node:crypto";

let world: AcceptanceWorld | null = null;

/** A world with a declared OPEN conflict over two trusted current Reports. */
async function freshDeclaredWorld(): Promise<{ w: AcceptanceWorld; conflictId: string }> {
  const w = await makeAcceptanceWorld(`CR-${Math.random().toString(36).slice(2, 8)}`);
  world = w;
  runVerificationCycle(w);
  const inspection = runDirectiveCycle(w, { directiveId: "DIR-INS-A", kind: "inspection" });
  const response = supervisorCall(w, "declare_verification_conflict", {
    fact: "the acceptance test result is disputed",
    claims: [
      { variant: "A", statement: "the acceptance test passes", source_report_ids: [w.verReportId] },
      { variant: "B", statement: "the acceptance test fails", source_report_ids: [inspection.reportId] },
    ],
  }) as { status: string; conflict: { id: string } };
  if (response.status !== "declared") throw new Error("fixture conflict declaration failed");
  return { w, conflictId: response.conflict.id };
}

interface PreparedResolver {
  attemptId: string;
  launchToken: string;
}

/** Start + prepare the resolver attempt (the ONE attempt of this Directive). */
function prepareResolver(
  w: AcceptanceWorld,
  resolver: { directiveId: string; revision: number; hash: string },
): PreparedResolver {
  const { attempt, launch } = w.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: w.executionRunId,
        sessionId: w.f.sessionId,
        workspaceId: w.f.workspaceId,
        generation: w.f.generation,
        directiveId: resolver.directiveId,
        directiveRevision: resolver.revision,
        directiveHash: resolver.hash,
        workerRole: "verifier",
      },
      w.ctx.clock,
      w.ctx.clock.nowIso(),
    ),
  );
  return { attemptId: attempt.attemptId, launchToken: launch.launchToken };
}

/** Claim with the given (or a fresh) session; a refused claim consumes nothing. */
function claimResolver(
  w: AcceptanceWorld,
  prepared: PreparedResolver,
  overrideSession?: ReturnType<typeof freshWorkerSession>,
): ReturnType<typeof freshWorkerSession> {
  const session = overrideSession ?? freshWorkerSession(w, `RES-${randomUUID().slice(0, 4).toUpperCase()}`);
  callWorkerTool({ ctx: w.ctx }, session, "worker_claim", {
    attempt_id: prepared.attemptId,
    launch_token: prepared.launchToken,
  });
  return session;
}

/** Submit the completed non-mutating resolver report. */
function finishResolver(w: AcceptanceWorld, session: ReturnType<typeof freshWorkerSession>): string {
  const ack = callWorkerTool({ ctx: w.ctx }, session, "worker_submit_report", {
    result: "completed",
    candidate_mutated: false,
    actions_performed: [],
    files_examined: [],
    files_changed: [],
    commands_run: [],
    tests_run: [],
    findings: [],
    deviations: [],
    blockers: [],
    deliverables: [],
  }) as { report_id: string };
  return ack.report_id;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E8 bounded conflict resolution (§31–§34)", () => {
  it("E8-T28: an open conflict accepts exactly one resolution Directive and becomes resolving", async () => {
    const { w, conflictId } = await freshDeclaredWorld();
    const resolver = issueDirective(w, {
      directiveId: "DIR-RESOLVE",
      kind: "verification",
      verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId },
    });
    expect(resolver.verificationPolicy).toEqual({
      verificationPurpose: "conflict_resolution",
      verificationConflictId: conflictId,
    });
    const conflict = w.ctx.store.withRead((tx) => getVerificationConflictInTx(tx, conflictId))!;
    expect(conflict.status).toBe("resolving");
    expect(conflict.resolutionDirectiveId).toBe("DIR-RESOLVE");
    expect(conflict.resolutionDirectiveRevision).toBe(resolver.revision);
  });

  it("E8-T29: a second resolver for the same conflict is rejected", async () => {
    const { w, conflictId } = await freshDeclaredWorld();
    issueDirective(w, {
      directiveId: "DIR-RESOLVE",
      kind: "verification",
      verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId },
    });
    expect(
      codeOf(() =>
        issueDirective(w, {
          directiveId: "DIR-RESOLVE-2",
          kind: "verification",
          verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId },
        }),
      ),
    ).toBe("VERIFICATION_CONFLICT_RESOLVER_EXISTS");
  });

  it("E8-T30: the resolver worker session must be fresh — a source-report session fails closed at claim", async () => {
    const { w, conflictId } = await freshDeclaredWorld();
    const resolver = issueDirective(w, {
      directiveId: "DIR-RESOLVE",
      kind: "verification",
      verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId },
    });
    const prepared = prepareResolver(w, resolver);
    // The verifier session produced a SOURCE report — its claim fails closed
    // BEFORE the token is consumed, so the SAME attempt remains claimable by
    // a genuinely fresh session.
    expect(() => claimResolver(w, prepared, w.verSession!)).toThrow(
      /fresh worker session distinct from all source-report sessions/,
    );
    const session = claimResolver(w, prepared);
    const reportId = finishResolver(w, session);
    expect(reportId).not.toBeNull();
  });

  it("E8-T31: the resolver assignment carries the neutral conflict context and NO worker identities", async () => {
    const { w, conflictId } = await freshDeclaredWorld();
    const resolver = issueDirective(w, {
      directiveId: "DIR-RESOLVE",
      kind: "verification",
      verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId },
    });
    const prepared = prepareResolver(w, resolver);
    const session = claimResolver(w, prepared);
    // The assignment is the claimed worker's view — loadable between claim
    // and report (authority ends when the report finishes the invocation).
    const conflict = w.ctx.store.withRead((tx) => getVerificationConflictInTx(tx, conflictId))!;
    const assignment = loadWorkerAssignment(w.ctx.store, {
      workerSessionId: session.sessionId,
      workspaceId: w.f.workspaceId,
    });
    finishResolver(w, session);
    expect(assignment.conflictContext).not.toBeNull();
    expect(assignment.conflictContext?.conflictId).toBe(conflictId);
    expect(assignment.conflictContext?.fact).toBe(conflict.fact);
    expect(assignment.conflictContext?.claims.map((claim) => claim.variant)).toEqual(["A", "B"]);
    // Blinded: no source report ids, no worker session ids, no raw reports.
    const serialized = JSON.stringify(assignment);
    expect(serialized).not.toContain(w.verReportId!);
    expect(serialized).not.toContain(conflict.claims[0]!.sourceReportIds[0]!);
    expect(serialized).not.toContain('"workerSessionId"');
    expect(serialized).not.toContain("sourceReportIds");
  });

  it("E8-T32: a completed conflict resolver does NOT clear normal verification debt", async () => {
    const w = await makeAcceptanceWorld(`CR-DEBT-${Math.random().toString(36).slice(2, 8)}`);
    world = w;
    // Immediate mutating implementation debt (span 1, reason=immediate)…
    runDirectiveCycle(w, {
      directiveId: "DIR-IMM",
      kind: "implementation",
      directiveOverrides: { verificationPolicy: { implementationRequirement: "immediate" } },
      reportOverrides: { candidate_mutated: true, files_changed: ["src/x.ts"] },
    });
    expect(loadVerificationPolicyStateInTxSafe(w)?.reason).toBe("immediate");
    // …plus two trusted current inspection reports to declare over.
    const a = runDirectiveCycle(w, { directiveId: "DIR-INS-A", kind: "inspection" });
    const b = runDirectiveCycle(w, { directiveId: "DIR-INS-B", kind: "inspection" });
    const declared = supervisorCall(w, "declare_verification_conflict", {
      fact: "inspection outcome disputed",
      claims: [
        { variant: "A", statement: "a", source_report_ids: [a.reportId] },
        { variant: "B", statement: "b", source_report_ids: [b.reportId] },
      ],
    }) as { conflict: { id: string } };
    const resolver = issueDirective(w, {
      directiveId: "DIR-RESOLVE",
      kind: "verification",
      verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: declared.conflict.id },
    });
    const prepared = prepareResolver(w, resolver);
    const session = claimResolver(w, prepared);
    const reportId = finishResolver(w, session);
    supervisorCall(w, "resolve_verification_conflict", {
      conflict_id: declared.conflict.id,
      outcome: "resolved",
      resolution_report_id: reportId,
      rationale: "the fact is established",
    });
    // The conflict is resolved, but the IMMEDIATE debt stands: a narrow fact
    // resolver is not candidate verification (E8 §34).
    const state = loadVerificationPolicyStateInTxSafe(w);
    expect(state?.verificationRequired).toBe(true);
    expect(state?.reason).toBe("immediate");
  });

  it("E8-T33: a conflict resolver alone cannot satisfy the E6 acceptance-verification gate", async () => {
    const w = await makeAcceptanceWorld(`CR-ONLY-${Math.random().toString(36).slice(2, 8)}`);
    world = w;
    // Two trusted current inspection reports — but NO normal verifier anywhere.
    const a = runDirectiveCycle(w, { directiveId: "DIR-INS-A", kind: "inspection" });
    const b = runDirectiveCycle(w, { directiveId: "DIR-INS-B", kind: "inspection" });
    const declared = supervisorCall(w, "declare_verification_conflict", {
      fact: "inspection outcome disputed",
      claims: [
        { variant: "A", statement: "a", source_report_ids: [a.reportId] },
        { variant: "B", statement: "b", source_report_ids: [b.reportId] },
      ],
    }) as { conflict: { id: string } };
    const resolver = issueDirective(w, {
      directiveId: "DIR-RESOLVE",
      kind: "verification",
      verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: declared.conflict.id },
    });
    const prepared = prepareResolver(w, resolver);
    const session = claimResolver(w, prepared);
    const reportId = finishResolver(w, session);
    supervisorCall(w, "resolve_verification_conflict", {
      conflict_id: declared.conflict.id,
      outcome: "resolved",
      resolution_report_id: reportId,
      rationale: "resolved in favor of A",
    });
    // The fence passes (resolved), and the refusal is the E6 verification
    // gate: a conflict resolver is never a general candidate verifier.
    expect(
      codeOf(() =>
        acceptanceServiceOf(w).submitSupervisorAssessment(
          acceptInput(w, {
            reportJudgments: [
              { report_id: a.reportId, disposition: "informational" },
              { report_id: b.reportId, disposition: "informational" },
              { report_id: reportId, disposition: "informational" },
            ],
          }) as never,
        ),
      ),
    ).toBe("ACCEPTANCE_VERIFICATION_REQUIRED");
  });
});

function loadVerificationPolicyStateInTxSafe(w: AcceptanceWorld) {
  return w.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, w.executionRunId));
}
