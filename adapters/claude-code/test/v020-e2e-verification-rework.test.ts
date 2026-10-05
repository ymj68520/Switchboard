/**
 * E14 §8–§12 — integrated verification-semantics scenarios: staleness
 * (candidateRevision is the staleness authority), ordinary verifier defect →
 * rework, bounded factual conflict (both branches), blocked-worker revision
 * flow, and executor scope adaptation. Every step drives the real worker /
 * supervisor / acceptance surfaces; raw SQL is READ-ONLY projection.
 */
import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  codeOf,
  currentRevision,
  makeAcceptanceWorld,
  runFreshVerifier,
  runImplementation,
  supervisorCall,
  type E14World,
} from "./v020-e2e-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { callWorkerTool, freshWorkerSession } from "./execution-worker-helpers.js";
import { boundariesOf } from "./v020-e2e-helpers.js";

/** The derived verification-pressure state through the real MCP read. */
function policyState(world: E14World): {
  verificationRequired: boolean;
  latestVerifiedRevision: number | null;
  reason: string;
} {
  const out = supervisorCall(world, "get_verification_policy_context") as {
    status: string;
    verification_required: boolean;
    latest_verified_revision: number | null;
    reason: string;
  };
  return {
    verificationRequired: out.verification_required,
    latestVerifiedRevision: out.latest_verified_revision,
    reason: out.reason,
  };
}

/**
 * Classify EVERY current-candidate non-mutating report (E6 §41): the given
 * directive's verifier report supporting, everything else informational.
 */
function classifyAll(world: E14World, supportingDirectiveId: string): Array<{ report_id: string; disposition: string }> {
  return world.ctx.store.withRead((tx) => {
    const windowId = (
      tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(world.executionRunId) as { id: string }
    ).id;
    const rows = tx
      .prepare(
        "SELECT r.report_id AS reportId, d.directive_id AS directiveId FROM execution_reports r "
        + "JOIN execution_attempts a ON a.attempt_id = r.attempt_id "
        + "JOIN execution_directives d ON d.directive_id = r.directive_id AND d.revision = r.directive_revision "
        + "WHERE d.window_id = ? AND d.base_candidate_revision = (SELECT candidate_revision FROM verification_windows WHERE id = ?) "
        + "AND r.candidate_mutated = 0 "
        + "ORDER BY r.report_id",
      )
      .all(windowId, windowId) as Array<{ reportId: string; directiveId: string }>;
    return rows.map((row) => ({
      report_id: row.reportId,
      disposition: row.directiveId === supportingDirectiveId ? "supporting" : "informational",
    }));
  });
}

describe("v020 E2E verification semantics (§8–§12)", () => {
  it("E14-VS1: candidateRevision deterministically stales prior verification (§8)", async () => {
    const world = await makeAcceptanceWorld("E14-VS"); // impl report durable at rev1
    expect(currentRevision(world)).toBe(1);

    // Fresh verifier completes at candidate N (=1).
    const v1 = runFreshVerifier(world, { directiveId: "DIR-VS-V1" });
    expect(policyState(world).verificationRequired).toBe(false);
    expect(policyState(world).latestVerifiedRevision).toBe(1);

    // Later implementation mutations N → N+1 … up to the frozen bound (3).
    runImplementation(world, { directiveId: "DIR-VS-A2" });
    expect(policyState(world).verificationRequired).toBe(false); // span 1 < 3 — batching still legal
    runImplementation(world, { directiveId: "DIR-VS-A3" });
    expect(policyState(world).verificationRequired).toBe(false); // span 2 < 3
    runImplementation(world, { directiveId: "DIR-VS-A4" });
    expect(policyState(world).verificationRequired).toBe(true); // span 3 ≥ bound
    expect(policyState(world).reason).toBe("max_unverified_span");
    expect(policyState(world).latestVerifiedRevision).toBe(1);
    expect(currentRevision(world)).toBe(4);

    // The OLD verifier cannot SUPPORT acceptance of N+1: a supporting judgment
    // on a stale-revision report is refused outright (E6 §41).
    let staleSupportCode = "no-error";
    try {
      acceptViaMcp(world, {
        reportJudgments: [{ report_id: v1.reportId, disposition: "supporting" }],
        rationale: "relying on the stale verifier must fail",
      });
    } catch (err) {
      staleSupportCode = (err as { code?: string }).code ?? "no-error";
    }
    expect(staleSupportCode).toBe("ASSESSMENT_REPORT_INVALID");
    // And the stale verification fact cannot carry the accept gate either:
    // with NO fresh supporting verifier (and no classifiable current report)
    // the accept fails as STALE.
    let staleCode = "no-error";
    try {
      acceptViaMcp(world, {
        reportJudgments: [],
        rationale: "stale verification cannot justify acceptance",
      });
    } catch (err) {
      staleCode = (err as { code?: string }).code ?? "no-error";
    }
    expect(staleCode).toBe("ACCEPTANCE_VERIFICATION_STALE");
    expect(boundariesOf(world).acceptedHead).toBeNull();

    // A stale EXPECTED revision cannot accept either (assessment refused up front).
    let assessmentStaleCode = "no-error";
    try {
      acceptViaMcp(world, { expectedCandidateRevision: 1 });
    } catch (err) {
      assessmentStaleCode = (err as { code?: string }).code ?? "no-error";
    }
    expect(assessmentStaleCode).toBe("SUPERVISOR_ASSESSMENT_STALE");

    // Fresh verification on N+1 is required — and a fresh verifier at N+1
    // restores acceptability.
    runFreshVerifier(world, { directiveId: "DIR-VS-V2" });
    expect(policyState(world).verificationRequired).toBe(false);
    const accept = acceptViaMcp(world, { reportJudgments: classifyAll(world, "DIR-VS-V2") }) as {
      status: string;
      accepted_head: string;
    };
    expect(accept.status).toBe("accepted");
    expect(boundariesOf(world).acceptedHead).toBe(accept.accepted_head);
  });

  it("E14-VS2: ordinary verifier defect triggers rework WITHOUT replanning (§9)", async () => {
    const world = await makeAcceptanceWorld("E14-VS2");
    const issueCountBefore = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE run_id = ?").get(world.executionRunId) as { n: number },
    );
    // Implementation + fresh verifier that finds a real implementation defect.
    runFreshVerifier(world, {
      directiveId: "DIR-RW-V1",
      reportOverrides: {
        result: "completed",
        findings: [{ summary: "the feature mishandles the empty-input case", details: null }],
        tests_run: [{ name: "empty-input", outcome: "fail", detail: null }],
      },
    });
    // SupervisorAssessment = rework persists the judgment ONLY.
    const rework = acceptViaMcp(world, {
      disposition: "rework",
      rationale: "verifier found an implementation defect; ordinary rework suffices",
    }) as { status: string };
    expect(rework.status).toBe("recorded");

    // NO REPLAN_REQUIRED: lifecycle, issues, and acceptedHead all unchanged.
    const afterRework = boundariesOf(world);
    expect(afterRework.lifecycle).toBe("active");
    expect(afterRework.acceptedHead).toBeNull();
    const issueCountAfter = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE run_id = ?").get(world.executionRunId) as { n: number },
    );
    expect(issueCountAfter.n).toBe(issueCountBefore.n);

    // New ImplementationDirective repairs; fresh verification; accept commits.
    runImplementation(world, { directiveId: "DIR-RW-A2" });
    expect(currentRevision(world)).toBe(2);
    runFreshVerifier(world, { directiveId: "DIR-RW-V2" });
    const accept = acceptViaMcp(world) as { status: string; accepted_head: string };
    expect(accept.status).toBe("accepted");
    const after = boundariesOf(world);
    expect(after.acceptedHead).toBe(accept.accepted_head);
    expect(after.lifecycle).toBe("active"); // an ordinary defect never terminates the run
    expect(
      world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE run_id = ?").get(world.executionRunId) as { n: number },
      ).n,
    ).toBe(issueCountBefore.n); // ordinary implementation defect ≠ planning defect
  });

  it("E14-VS3: bounded factual conflict — resolved branch (§10)", async () => {
    const world = await makeAcceptanceWorld("E14-VS3");
    const v1 = runFreshVerifier(world, { directiveId: "DIR-CF-V1" });
    const conflictId = await runConflictScenario(world, v1.reportId);
    expect(conflictId).toBeTruthy();
  });

  it("E14-VS4: bounded factual conflict — verification_blocked branch (§10)", async () => {
    const world = await makeAcceptanceWorld("E14-VS4");
    const v1 = runFreshVerifier(world, { directiveId: "DIR-CB-V1" });
    const inspection = runInspection(world, "DIR-CB-INS", "the acceptance test FAILS on this candidate");
    const declared = supervisorCall(world, "declare_verification_conflict", {
      fact: "whether the acceptance test passes on the current candidate",
      claims: [
        { variant: "A", statement: "the acceptance test passes", source_report_ids: [v1.reportId] },
        { variant: "B", statement: "the acceptance test fails", source_report_ids: [inspection.reportId] },
      ],
    }) as { status: string; conflict: { id: string } };
    expect(declared.status).toBe("declared");
    const conflictId = declared.conflict.id;

    // Commit is blocked while the conflict is open.
    expect(codeOf(() => acceptViaMcp(world))).toBe("ACCEPTANCE_VERIFICATION_CONFLICT");

    // Exactly ONE resolution directive: a second resolver is rejected.
    const resolverDirective = issueDirective(world, {
      directiveId: "DIR-CB-RES",
      kind: "verification",
      verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId } as never,
    });
    expect(
      codeOf(() =>
        issueDirective(world, {
          directiveId: "DIR-CB-RES-2",
          kind: "verification",
          verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId } as never,
        }),
      ),
    ).toBe("VERIFICATION_CONFLICT_RESOLVER_EXISTS");

    // Fresh independent resolver completes its report — on the EXACT bound
    // resolution directive revision.
    const resolver = runFreshVerifier(world, {
      directiveId: "DIR-CB-RES",
      existingDirective: {
        directiveId: resolverDirective.directiveId,
        revision: resolverDirective.revision,
        hash: resolverDirective.hash,
      },
      reportOverrides: { findings: [{ summary: "independent re-run: the acceptance test fails; variant B is factual", details: null }] },
    });

    // Resolution = verification_blocked: no majority vote, no second resolver.
    const blocked = supervisorCall(world, "resolve_verification_conflict", {
      conflict_id: conflictId,
      outcome: "verification_blocked",
      resolution_report_id: resolver.reportId,
      rationale: "the independent resolver confirms variant B; verification cannot pass this candidate",
    }) as { status: string };
    expect(blocked.status).toBe("verification_blocked");

    // Accept remains blocked AFTER the blocked resolution; rework remains
    // possible (a rework judgment records).
    expect(codeOf(() => acceptViaMcp(world))).toBe("ACCEPTANCE_VERIFICATION_CONFLICT");
    const rework = acceptViaMcp(world, {
      disposition: "rework",
      rationale: "verification is blocked on this candidate; directing rework",
      reportJudgments: classifyAll(world, "DIR-CB-V1"),
    }) as { status: string };
    expect(rework.status).toBe("recorded");
    expect(boundariesOf(world).lifecycle).toBe("active");
  });

  it("E14-VS5: blocked Worker revision flow — @1 immutable, @2 new attempt (§11)", async () => {
    const world = await makeAcceptanceWorld("E14-VS5");
    // DIR-X@1 runs and reports BLOCKED with a structured blocker.
    const blocked = runImplementation(world, {
      directiveId: "DIR-X",
      candidateMutated: false,
      reportOverrides: {
        result: "blocked",
        blockers: [{ kind: "MISSING_CONTEXT", summary: "the directive lacks the export surface to integrate with", details: null, relevantRefs: [] }],
      },
    });
    // No mid-attempt clarification mutation: the report is immutable…
    const attemptRow = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT state AS s FROM execution_attempts WHERE attempt_id = ?").get(blocked.attemptId) as { s: string },
    );
    expect(attemptRow.s).toBe("reported");
    let reReportCode = "no-error";
    try {
      callWorkerTool(world, { sessionId: "worker-session-ANY", agentId: "agent-ANY", workspaceId: world.f.workspaceId }, "worker_submit_report", {
        result: "completed",
        candidate_mutated: false,
      });
    } catch (err) {
      reReportCode = (err as { code?: string }).code ?? "no-error";
    }
    // (A fresh tokenless session cannot even reach the attempt — the code is
    // any rejection; the immutability itself is proven by the one-report PK.)
    expect(reReportCode).not.toBe("no-error");
    const reportCount = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_reports WHERE attempt_id = ?").get(blocked.attemptId) as { n: number },
    );
    expect(reportCount.n).toBe(1); // exactly one immutable report

    // One Attempt per revision: a second attempt on @1 is refused.
    const directive = world.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT directive_id AS id, revision AS r, directive_hash AS h FROM execution_directives WHERE directive_id = ?").get("DIR-X") as {
          id: string;
          r: number;
          h: string;
        },
    );
    let secondAttemptCode = "no-error";
    try {
      world.ctx.store.withWrite((tx) =>
        startWorkerAttemptAndPrepareLaunchInTx(
          tx,
          {
            executionRunId: world.executionRunId,
            sessionId: world.f.sessionId,
            workspaceId: world.f.workspaceId,
            generation: world.f.generation,
            directiveId: directive.id,
            directiveRevision: directive.r,
            directiveHash: directive.h,
            workerRole: "executor",
          },
          world.ctx.clock,
          world.ctx.clock.nowIso(),
        ),
      );
    } catch (err) {
      secondAttemptCode = (err as { code?: string }).code ?? "no-error";
    }
    expect(secondAttemptCode).toBe("DIRECTIVE_ALREADY_ATTEMPTED");

    // The Supervisor issues DIR-X@2 — a NEW immutable revision with a NEW
    // logical Attempt, which completes.
    const revised = issueDirective(world, { directiveId: "DIR-X", kind: "implementation" });
    expect(revised.revision).toBe(2);
    expect(revised.hash).not.toBe(directive.h);
    const second = runImplementation(world, {
      directiveId: "DIR-X",
      existingDirective: { directiveId: revised.directiveId, revision: revised.revision, hash: revised.hash },
    });
    expect(second.attemptId).not.toBe(blocked.attemptId);
    const attempts = world.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT attempt_id AS id, directive_revision AS rev FROM execution_attempts WHERE directive_id = 'DIR-X' ORDER BY started_at").all() as Array<{
          id: string;
          rev: number;
        }>,
    );
    expect(attempts.map((a) => a.rev)).toEqual([1, 2]); // one Attempt per revision
  });

  it("E14-DEF1: a structurally invalid report payload is refused BEFORE durability (E14 defect fix regression)", async () => {
    const world = await makeAcceptanceWorld("E14-DEF1");
    const directive = issueDirective(world, { directiveId: "DIR-DEF", kind: "implementation" });
    const started = world.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: directive.directiveId,
          directiveRevision: directive.revision,
          directiveHash: directive.hash,
          workerRole: "executor",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const session = freshWorkerSession(world, "DEF");
    callWorkerTool(world, session, "worker_claim", { attempt_id: started.attempt.attemptId, launch_token: started.launch.launchToken });
    // A blocker WITHOUT the schema-required relevantRefs — pre-fix this was
    // persisted and then rejected by the canonical read parser as a corrupt
    // row on every later read.
    let submitCode = "no-error";
    try {
      callWorkerTool(world, session, "worker_submit_report", {
        result: "blocked",
        candidate_mutated: false,
        blockers: [{ kind: "MISSING_CONTEXT", summary: "malformed", details: null }],
      });
    } catch (err) {
      submitCode = (err as { code?: string }).code ?? "no-error";
    }
    expect(submitCode).toBe("STORE_SCHEMA_INVALID");
    // Nothing durable was written: no report row, attempt still running, no
    // candidate advance, invocation still claimed (retryable by a legal report).
    const state = world.ctx.store.withRead((tx) => ({
      reports: tx.prepare("SELECT count(*) AS n FROM execution_reports").get() as { n: number },
      attempt: tx.prepare("SELECT state AS s FROM execution_attempts WHERE attempt_id = ?").get(started.attempt.attemptId) as { s: string },
      revision: tx.prepare("SELECT candidate_revision AS r FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(world.executionRunId) as { r: number },
    }));
    expect(state.reports.n).toBe(1); // only the fixture's baseline report
    expect(state.attempt.s).toBe("running");
    expect(state.revision.r).toBe(1);
    // A LEGAL report on the same attempt still converges.
    const ack = callWorkerTool(world, session, "worker_submit_report", {
      result: "blocked",
      candidate_mutated: false,
      blockers: [{ kind: "MISSING_CONTEXT", summary: "well-formed", details: null, relevantRefs: [] }],
    }) as { report_id: string };
    expect(ack.report_id).toBeTruthy();
  });

  it("E14-VS6: executor scope adaptation is guidance, not hard path enforcement (§12)", async () => {
    const world = await makeAcceptanceWorld("E14-VS6");
    // A directive whose expected scope OMITS a necessary supporting file.
    issueDirective(world, {
      directiveId: "DIR-SC-A1",
      kind: "implementation",
      expectedExecutionScope: { files: ["src/feature.ts"], symbols: [], callPaths: [], tests: [] } as never,
    });
    const directiveHash = world.ctx.store.withRead(
      (tx) => (tx.prepare("SELECT directive_hash AS h FROM execution_directives WHERE directive_id = 'DIR-SC-A1'").get() as { h: string }).h,
    );
    const { attempt, launch } = world.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: "DIR-SC-A1",
          directiveRevision: 1,
          workerRole: "executor",
          directiveHash,
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const session = freshWorkerSession(world, "SC");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attempt.attemptId, launch_token: launch.launchToken });
    // The executor ALSO changed a supporting file the scope did not list, and
    // reports the deviation factually — the report is ACCEPTED (durable), no
    // hard path-denial anywhere in the pipeline.
    const ack = callWorkerTool(world, session, "worker_submit_report", {
      result: "completed",
      candidate_mutated: true,
      files_changed: ["src/feature.ts", "src/support.ts"],
      deviations: [{ summary: "also updated src/support.ts (unlisted supporting file required by the feature edit)", details: null }],
    }) as { report_id: string };
    expect(ack.report_id).toBeTruthy();
    expect(currentRevision(world)).toBe(2); // the mutation stands
    // The deviation is durably visible in the report.
    const deviations = world.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT deviations_json AS d FROM execution_reports WHERE report_id = ?").get(ack.report_id) as { d: string },
    );
    expect(deviations.d).toContain("src/support.ts");
  });
});

/**
 * One trusted non-mutating current-candidate inspection report (the
 * contradicter side of a conflict declaration).
 */
function runInspection(world: E14World, directiveId: string, finding: string): { reportId: string; attemptId: string } {
  const directive = issueDirective(world, { directiveId, kind: "inspection" });
  const started = world.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: world.executionRunId,
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
        directiveId: directive.directiveId,
        directiveRevision: directive.revision,
        directiveHash: directive.hash,
        workerRole: "executor",
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  const session = freshWorkerSession(world, `I-${directiveId}`);
  callWorkerTool(world, session, "worker_claim", { attempt_id: started.attempt.attemptId, launch_token: started.launch.launchToken });
  const ack = callWorkerTool(world, session, "worker_submit_report", {
    result: "completed",
    candidate_mutated: false,
    files_examined: ["src/feature.ts"],
    findings: [{ summary: finding, details: null }],
  }) as { report_id: string };
  return { reportId: ack.report_id, attemptId: started.attempt.attemptId };
}

/**
 * Resolved-branch scenario: declare the conflict over two REAL current-
 * candidate reports, run the ONE resolver, resolve → resolved, and prove the
 * normal verification requirements still apply (the ORIGINAL supporting
 * verifier satisfies the accept gate).
 */
async function runConflictScenario(world: E14World, verifierReportId: string): Promise<string> {
  // The second trusted current-candidate inspection report (non-mutating).
  const inspection = runInspection(world, "DIR-CF-INS2", "the acceptance test FAILS on this candidate");
  const declared = supervisorCall(world, "declare_verification_conflict", {
    fact: "whether the acceptance test passes on the current candidate",
    claims: [
      { variant: "A", statement: "the acceptance test passes", source_report_ids: [verifierReportId] },
      { variant: "B", statement: "the acceptance test fails", source_report_ids: [inspection.reportId] },
    ],
  }) as { status: string; conflict: { id: string } };
  expect(declared.status).toBe("declared");
  const conflictId = declared.conflict.id;

  // Accept blocked while open.
  expect(codeOf(() => acceptViaMcp(world))).toBe("ACCEPTANCE_VERIFICATION_CONFLICT");

  // The ONE resolver; a second is rejected.
  const resolverDirective = issueDirective(world, {
    directiveId: "DIR-CF-RES",
    kind: "verification",
    verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId } as never,
  });
  expect(
    codeOf(() =>
      issueDirective(world, {
        directiveId: "DIR-CF-RES-2",
        kind: "verification",
        verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId } as never,
      }),
    ),
  ).toBe("VERIFICATION_CONFLICT_RESOLVER_EXISTS");
  const resolver = runFreshVerifier(world, {
    directiveId: "DIR-CF-RES",
    existingDirective: {
      directiveId: resolverDirective.directiveId,
      revision: resolverDirective.revision,
      hash: resolverDirective.hash,
    },
    reportOverrides: { findings: [{ summary: "independent re-run: the acceptance test passes; variant A is factual", details: null }] },
  });
  const resolved = supervisorCall(world, "resolve_verification_conflict", {
    conflict_id: conflictId,
    outcome: "resolved",
    resolution_report_id: resolver.reportId,
    rationale: "the independent resolver confirms variant A",
  }) as { status: string };
  expect(resolved.status).toBe("resolved");

  // Normal verification requirements STILL apply: the ORIGINAL current-
  // candidate supporting verifier satisfies the accept gate; every other
  // current report (inspection, resolver) is classified informational — the
  // resolver's report is not itself acceptance evidence (E8 §34).
  const accept = acceptViaMcp(world, {
    reportJudgments: classifyAll(world, "DIR-CF-V1"),
  }) as { status: string; accepted_head: string };
  expect(accept.status).toBe("accepted");
  expect(boundariesOf(world).acceptedHead).toBe(accept.accepted_head);
  return conflictId;
}
