/**
 * E8 §54/§55 — conflict outcomes and the acceptance fence (E8-T34..T41).
 *
 * The Supervisor settles a resolving conflict on its ONE dedicated resolver's
 * exact report: resolved | verification_blocked, with non-empty rationale —
 * Core never infers the outcome from findings and refuses premature or wrong
 * resolution. Open/resolving/verification_blocked conflicts at the CURRENT
 * candidate block acceptance (ACCEPTANCE_VERIFICATION_CONFLICT); only
 * `resolved` is non-blocking, and it never authorizes acceptance by itself.
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
import { getVerificationConflictInTx } from "../src/store/verification-conflicts.js";
import { randomUUID } from "node:crypto";

let world: AcceptanceWorld | null = null;

async function freshDeclaredWorld(): Promise<{ w: AcceptanceWorld; conflictId: string; inspectionReportId: string; originalVerifierReportId: string }> {
  const w = await makeAcceptanceWorld(`CG-${Math.random().toString(36).slice(2, 8)}`);
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
  return { w, conflictId: response.conflict.id, inspectionReportId: inspection.reportId, originalVerifierReportId: w.verReportId! };
}

function runResolver(
  w: AcceptanceWorld,
  resolver: { directiveId: string; revision: number; hash: string },
): { reportId: string; attemptId: string } {
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
  const session = freshWorkerSession(w, `RES-${randomUUID().slice(0, 4).toUpperCase()}`);
  callWorkerTool({ ctx: w.ctx }, session, "worker_claim", {
    attempt_id: attempt.attemptId,
    launch_token: launch.launchToken,
  });
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
  return { reportId: ack.report_id, attemptId: attempt.attemptId };
}

function bindResolver(w: AcceptanceWorld, conflictId: string) {
  return issueDirective(w, {
    directiveId: "DIR-RESOLVE",
    kind: "verification",
    verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId },
  });
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E8 conflict outcomes (§35–§37)", () => {
  it("E8-T34: an exact resolver Report settles the conflict as resolved with full provenance", async () => {
    const { w, conflictId } = await freshDeclaredWorld();
    const resolver = bindResolver(w, conflictId);
    const { reportId } = runResolver(w, resolver);
    const response = supervisorCall(w, "resolve_verification_conflict", {
      conflict_id: conflictId,
      outcome: "resolved",
      resolution_report_id: reportId,
      rationale: "the resolver established claim A against the persisted artifact",
    }) as { status: string; conflict_id: string };
    expect(response.status).toBe("resolved");
    const stored = w.ctx.store.withRead((tx) => getVerificationConflictInTx(tx, conflictId))!;
    expect(stored.status).toBe("resolved");
    expect(stored.resolutionReportId).toBe(reportId);
    expect(stored.resolvedAt).not.toBeNull();
    expect(stored.rationale).toBe("the resolver established claim A against the persisted artifact");
  });

  it("E8-T35: the same one-resolver path may end verification_blocked — with rationale", async () => {
    const { w, conflictId } = await freshDeclaredWorld();
    const resolver = bindResolver(w, conflictId);
    const { reportId } = runResolver(w, resolver);
    const response = supervisorCall(w, "resolve_verification_conflict", {
      conflict_id: conflictId,
      outcome: "verification_blocked",
      resolution_report_id: reportId,
      rationale: "the resolver could not establish either claim from the evidence",
    }) as { status: string };
    expect(response.status).toBe("verification_blocked");
    // The ExecutionRun remains active — this is an execution condition, not a
    // lifecycle (E8 §37).
    const run = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as { lifecycle: string },
    );
    expect(run.lifecycle).toBe("active");
  });

  it("E8-T36: no Report / wrong Report cannot resolve", async () => {
    const { w, conflictId } = await freshDeclaredWorld();
    const resolver = bindResolver(w, conflictId);
    // The resolver attempt has not run yet.
    expect(
      codeOf(() =>
        supervisorCall(w, "resolve_verification_conflict", {
          conflict_id: conflictId,
          outcome: "resolved",
          resolution_report_id: "rep_ghost",
          rationale: "premature",
        }),
      ),
    ).toBe("VERIFICATION_CONFLICT_RESOLUTION_INVALID");
    // A real but WRONG report id cannot settle it.
    const { reportId } = runResolver(w, resolver);
    expect(
      codeOf(() =>
        supervisorCall(w, "resolve_verification_conflict", {
          conflict_id: conflictId,
          outcome: "resolved",
          resolution_report_id: `${reportId}x`,
          rationale: "wrong report",
        }),
      ),
    ).toBe("VERIFICATION_CONFLICT_RESOLUTION_INVALID");
  });
});

describe("E8 acceptance fence (§40/§41)", () => {
  it("E8-T38/T39/T40: open, resolving, and verification_blocked conflicts block Commit", async () => {
    // OPEN.
    const open = await freshDeclaredWorld();
    try {
      expect(
        codeOf(() =>
          acceptanceServiceOf(open.w).submitSupervisorAssessment(acceptInput(open.w) as never),
        ),
      ).toBe("ACCEPTANCE_VERIFICATION_CONFLICT");

      // RESOLVING.
      const resolver = bindResolver(open.w, open.conflictId);
      expect(
        codeOf(() =>
          acceptanceServiceOf(open.w).submitSupervisorAssessment(acceptInput(open.w) as never),
        ),
      ).toBe("ACCEPTANCE_VERIFICATION_CONFLICT");

      // VERIFICATION_BLOCKED.
      const { reportId } = runResolver(open.w, resolver);
      supervisorCall(open.w, "resolve_verification_conflict", {
        conflict_id: open.conflictId,
        outcome: "verification_blocked",
        resolution_report_id: reportId,
        rationale: "unresolvable on this candidate",
      });
      expect(
        codeOf(() =>
          acceptanceServiceOf(open.w).submitSupervisorAssessment(acceptInput(open.w) as never),
        ),
      ).toBe("ACCEPTANCE_VERIFICATION_CONFLICT");
    } finally {
      open.w.ctx.store.close();
      world = null;
    }
  });

  it("E8-T41: a resolved conflict does not independently block Commit — full E6 acceptance still applies", async () => {
    const { w, conflictId, inspectionReportId, originalVerifierReportId } = await freshDeclaredWorld();
    const resolver = bindResolver(w, conflictId);
    const { reportId: resolutionReportId } = runResolver(w, resolver);
    supervisorCall(w, "resolve_verification_conflict", {
      conflict_id: conflictId,
      outcome: "resolved",
      resolution_report_id: resolutionReportId,
      rationale: "resolved in favor of claim A",
    });
    // Fresh NORMAL verification at the exact current candidate.
    const verification = runVerificationCycle(w);
    // The accept classifies EVERY current-candidate report and carries the
    // normal-verifier evidence — the fence passes and the full E6 gate commits.
    const result = acceptanceServiceOf(w).submitSupervisorAssessment(
      acceptInput(w, {
        reportJudgments: [
          { report_id: originalVerifierReportId, disposition: "supporting" },
          { report_id: verification.reportId, disposition: "supporting" },
          { report_id: inspectionReportId, disposition: "informational" },
          { report_id: resolutionReportId, disposition: "informational" },
        ],
      }) as never,
    ) as { commit: { commitId: string } | null };
    expect(result.commit).not.toBeNull();
  });
});
