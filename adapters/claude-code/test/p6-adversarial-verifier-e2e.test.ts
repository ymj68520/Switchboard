/**
 * P6 E2E Test Suite — Formal Verifier Adversarial Quality & Falsification.
 *
 * Requirements verified:
 * 1. Verifier independently seeks counterexamples and checks invariants, not merely rubber-stamping executor tests.
 * 2. Stage 1 establishes a critical invariant (e.g. non-negative balance / state consistency).
 * 3. Subsequent stage injects a boundary defect that executor self-check missed.
 * 4. Verifier detects the invariant violation with evidence-backed findings and blockers.
 * 5. Acceptance gate rejects commit when blocking verifier evidence exists.
 * 6. Supervisor triggers rework, executor fixes defect, and fresh verification passes.
 * 7. Candidate commit is only permitted once fresh adversarial verification passes.
 * 8. Pure mechanical changes succeed without forcing unnecessary new test files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  boundariesOf,
  completeStageViaGate,
  currentRevision,
  freshWorkerSession,
  getExecutionStageInTx,
  deriveStageCompletionValidationRequirement,
  makeAcceptanceWorld,
  runImplementation,
  runFreshVerifier,
  supervisorCall,
  callWorkerTool,
  startWorkerAttemptAndPrepareLaunchInTx,
} from "./v020-e2e-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";

describe("P6: Formal Verifier Adversarial Quality & Falsification E2E", () => {
  it("rejects ExecutionCommit on adversarial counterexample, triggers rework, and accepts only after fix", async () => {
    const world = await makeAcceptanceWorld("P6-E2E");
    const wsRoot = world.f.workspaceRoot;

    // -------------------------------------------------------------------------
    // 1. Stage 1: Establish account invariant (balance can never be negative)
    // -------------------------------------------------------------------------
    const accountFile = path.join(wsRoot, "src", "account.ts");
    fs.mkdirSync(path.dirname(accountFile), { recursive: true });
    fs.writeFileSync(accountFile, "export class Account { balance = 1000; deposit(n: number) { this.balance += n; } }\n");

    const st1 = completeStageViaGate(world);
    expect(st1.commitId).toBeTruthy();

    // -------------------------------------------------------------------------
    // 2. Stage 2: Executor implements transfer, but injects boundary defect
    //    Executor missed: withdraw without balance check allowed negative balance!
    // -------------------------------------------------------------------------
    const boundsAfterSt1 = boundariesOf(world);
    const st2Id = boundsAfterSt1.stages[1]!.id;

    // Activate Stage 2
    const act2 = supervisorCall(world, "activate_execution_stage", {
      target_stage_id: st2Id,
    }) as { window: { id: string } };
    world.activeStageId = st2Id;
    world.openWindowId = act2.window.id;

    // Executor writes buggy withdraw/transfer logic
    fs.writeFileSync(
      accountFile,
      "export class Account {\n"
      + "  balance = 1000;\n"
      + "  deposit(n: number) { this.balance += n; }\n"
      + "  withdraw(n: number) { this.balance -= n; return true; } // BUG: No balance >= n check!\n"
      + "}\n",
    );

    // Executor runs only happy path test (1000 - 200 = 800) and reports complete
    runImplementation(world, {
      directiveId: "DIR-P6-ST2-IMPL",
      candidateMutated: true,
      reportOverrides: {
        actions_performed: [{ action: "code", detail: "added withdraw method" }],
        tests_run: [{ name: "test_happy_path_withdraw_200", outcome: "pass", detail: "balance 800" }],
        findings: [{ summary: "Withdraw method implemented and verified on test case 200", details: null }],
        files_changed: ["src/account.ts"],
      },
    });

    const candidateWithBug = currentRevision(world);

    // -------------------------------------------------------------------------
    // 3. Verifier independently tests adversarial boundary conditions
    //    Tries to withdraw 5000 from account with 1000 (overdraft scenario)
    // -------------------------------------------------------------------------
    const verDirective = issueDirective(world, {
      directiveId: "DIR-P6-VER-ADVERSARIAL",
      kind: "verification",
      invariants: [{ statement: "Account balance must never be negative (balance >= 0)" }],
      validationRequirements: [{ requirement: "adversarial_overdraft_falsification", detail: "assert overdraft is rejected" }],
    });

    const { attempt: verAttempt, launch: verLaunch } = world.ctx.store.withWrite((tx: any) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: verDirective.directiveId,
          directiveRevision: verDirective.revision,
          directiveHash: verDirective.hash,
          workerRole: "verifier",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );

    const verSession = freshWorkerSession(world, "V-P6-ADVERSARIAL");
    callWorkerTool(world, verSession, "worker_claim", {
      attempt_id: verAttempt.attemptId,
      launch_token: verLaunch.launchToken,
    });

    // Verifier executes overdraft test, discovers balance became -4000, violating invariant!
    const verReport = callWorkerTool(world, verSession, "worker_submit_report", {
      result: "blocked",
      candidate_mutated: false,
      files_examined: ["src/account.ts"],
      tests_run: [
        { name: "adversarial_overdraft_test", outcome: "fail", detail: "withdraw(5000) allowed balance to become -4000" },
      ],
      findings: [
        {
          summary: "Invariant violation: balance became negative (-4000) on overdraft",
          details: "Account.withdraw does not guard against withdrawing more than current balance",
        },
      ],
      blockers: [
        {
          kind: "CONFLICTING_REQUIREMENTS",
          summary: "Implementation violates Stage 1 invariant balance >= 0",
          details: "Overdraft boundary test failed with negative balance",
          relevantRefs: [],
        },
      ],
    }) as { report_id: string };

    // -------------------------------------------------------------------------
    // 4. Acceptance Gate: Commits are strictly blocked by verifier findings
    // -------------------------------------------------------------------------
    // 4a. If supervisor tries to falsely classify the failed verifier as supporting:
    let falseSupportingErr = "no-error";
    try {
      supervisorCall(world, "submit_supervisor_assessment", {
        disposition: "accept",
        rationale: "Trying to force accept despite defect",
        expected_candidate_revision: candidateWithBug,
        report_judgments: [
          { report_id: verReport.report_id, disposition: "supporting" },
        ],
      });
    } catch (err: any) {
      falseSupportingErr = err.code ?? "no-error";
    }
    expect(falseSupportingErr).toBe("ASSESSMENT_REPORT_INVALID");

    // 4b. If supervisor correctly classifies the failed verifier as blocking on accept:
    let blockedErr = "no-error";
    try {
      supervisorCall(world, "submit_supervisor_assessment", {
        disposition: "accept",
        rationale: "Attempting accept with blocking report",
        expected_candidate_revision: candidateWithBug,
        report_judgments: [
          { report_id: verReport.report_id, disposition: "blocking" },
        ],
      });
    } catch (err: any) {
      blockedErr = err.code ?? "no-error";
    }
    expect(blockedErr).toBe("ACCEPTANCE_BLOCKED");

    // Verify NO commit was created
    const boundsBeforeFix = boundariesOf(world);
    expect(boundsBeforeFix.acceptedHead).toBe(st1.commitId);
    expect(boundsBeforeFix.commits).toHaveLength(1);

    // -------------------------------------------------------------------------
    // 5. Supervisor triggers rework, executor fixes defect, and candidate advances
    // -------------------------------------------------------------------------
    const reworkResult = supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "rework",
      rationale: "Rework required: add guard in withdraw to prevent negative balance",
      expected_candidate_revision: candidateWithBug,
      report_judgments: [
        { report_id: verReport.report_id, disposition: "blocking" },
      ],
    }) as { status: string };
    expect(reworkResult.status).toBe("recorded");

    // Executor applies fix
    fs.writeFileSync(
      accountFile,
      "export class Account {\n"
      + "  balance = 1000;\n"
      + "  deposit(n: number) { this.balance += n; }\n"
      + "  withdraw(n: number) {\n"
      + "    if (n > this.balance) throw new Error('insufficient_funds');\n"
      + "    this.balance -= n;\n"
      + "    return true;\n"
      + "  }\n"
      + "}\n",
    );

    // Executor runs implementation at new candidate revision
    runImplementation(world, {
      directiveId: "DIR-P6-FIX-IMPL",
      candidateMutated: true,
      reportOverrides: {
        actions_performed: [{ action: "fix", detail: "added overdraft guard" }],
        files_changed: ["src/account.ts"],
      },
    });

    const fixedCandidate = currentRevision(world);
    expect(fixedCandidate).toBe(candidateWithBug + 1);

    // -------------------------------------------------------------------------
    // 6. Fresh Verifier tests adversarial condition again at fixed candidate
    // -------------------------------------------------------------------------
    const stage = world.ctx.store.withRead((tx: any) => getExecutionStageInTx(tx, world.activeStageId))!;
    const stageReq = deriveStageCompletionValidationRequirement(stage);

    const freshVer = runFreshVerifier(world, {
      directiveId: "DIR-P6-VER-CLEAN",
      validationRequirements: [stageReq],
      reportOverrides: {
        tests_run: [
          { name: "adversarial_overdraft_test", outcome: "pass", detail: "withdraw(5000) throws insufficient_funds, balance remains 1000" },
        ],
        findings: [
          { summary: "Invariant verified: balance >= 0 holds under all overdraft attempts", details: null },
        ],
      },
    });

    // -------------------------------------------------------------------------
    // 7. Successful Acceptance: commit created and stage completed
    // -------------------------------------------------------------------------
    const cleanAccept = supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "Fix verified: overdraft guard prevents negative balance under all adversarial inputs",
      expected_candidate_revision: fixedCandidate,
      complete_stage: true,
      report_judgments: [
        { report_id: freshVer.reportId, disposition: "supporting" },
      ],
    }) as { status: string; commit: { id: string }; stage_completed: boolean };

    expect(cleanAccept.status).toBe("accepted");
    expect(cleanAccept.stage_completed).toBe(true);

    const boundsAfterFix = boundariesOf(world);
    expect(boundsAfterFix.acceptedHead).toBe(cleanAccept.commit.id);
    expect(boundsAfterFix.stages[1]!.status).toBe("completed");
    expect(boundsAfterFix.commits).toHaveLength(2);
  });

  it("permits pure mechanical changes without forcing unnecessary new test files", async () => {
    const world = await makeAcceptanceWorld("P6-MECH");
    const wsRoot = world.f.workspaceRoot;

    // Pure mechanical change: add a code comment and formatting
    const docFile = path.join(wsRoot, "src", "feature.ts");
    fs.mkdirSync(path.dirname(docFile), { recursive: true });
    fs.writeFileSync(docFile, "/** Formatted feature documentation */\nexport const Feature = 100;\n");

    const impl = runImplementation(world, {
      directiveId: "DIR-P6-MECH-IMPL",
      candidateMutated: true,
      reportOverrides: {
        actions_performed: [{ action: "format", detail: "formatted comments" }],
        files_changed: ["src/feature.ts"],
      },
    });

    // Verifier runs typecheck/lint check (0 new test files created)
    const ver = runFreshVerifier(world, {
      directiveId: "DIR-P6-MECH-VER",
      reportOverrides: {
        tests_run: [{ name: "typecheck", outcome: "pass", detail: "0 errors" }],
        commands_run: [{ command: "tsc --noEmit", detail: "clean exit" }],
        findings: [{ summary: "Mechanical formatting verified with clean typecheck", details: null }],
      },
    });

    // Core accepts the mechanical change cleanly
    const accept = supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "Mechanical change typechecked cleanly; no interface semantics changed",
      expected_candidate_revision: currentRevision(world),
      report_judgments: [
        { report_id: ver.reportId, disposition: "supporting" },
      ],
    }) as { status: string; commit: any };

    expect(accept.status).toBe("accepted");
    expect(accept.commit).toBeDefined();
  });
});
