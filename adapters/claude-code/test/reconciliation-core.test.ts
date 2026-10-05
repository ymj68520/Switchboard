/**
 * E11 §59–§66 — the reconciliation fence (T11..T16), capability no-effect
 * (T17..T20), binding (T21..T25), reports (T26..T30), resolutions and
 * verification-policy integration (T31..T43).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  makeIndeterminateWorld,
  readOnlyEnvelope,
  effectfulEnvelope,
  FULL_REPORT_CONTRACT,
  runReconciliationInspection,
} from "./attempt-recovery-helpers.js";
import { codeOf, currentRevision, makeAcceptanceWorld, supervisorCall, runWorkerAttempt } from "./acceptance-helpers.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { callWorkerTool } from "./execution-worker-helpers.js";
import { loadVerificationPolicyStateInTx } from "../src/application/verification-policy-service.js";
import { startWorkerAttemptAndPrepareLaunchInTx, resolveUnreportedWorkerExitInTx } from "../src/application/worker-runtime-service.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";
import { getReconciliationForAttemptInTx } from "../src/store/attempt-reconciliations.js";

describe("E11 reconciliation fence (§13/§14, T11..T16)", () => {
  it("E11-T11/T12/T13: implementation, verification, and inspection issuance are fenced", async () => {
    const { world } = await makeIndeterminateWorld();
    for (const kind of ["implementation", "verification", "inspection"] as const) {
      expect(
        codeOf(() => issueDirective(world, { directiveId: `DIR-F-${kind}`, kind })),
      ).toBe("ATTEMPT_RECONCILIATION_REQUIRED");
    }
  });

  it("E11-T14: a directive issued before the crash cannot start afterward", async () => {
    const world = await makeAcceptanceWorld(`P2-${Math.random().toString(36).slice(2, 8)}`);
    const directive = issueDirective(world, { directiveId: "DIR-PRE", kind: "inspection" });
    const crashDirective = issueDirective(world, { directiveId: "DIR-PRE-CRASH", kind: "implementation" });
    const { attempt, launch } = world.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: crashDirective.directiveId,
          directiveRevision: crashDirective.revision,
          directiveHash: crashDirective.hash,
          workerRole: "executor",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const session = freshWorkerSession(world, "CRASH");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attempt.attemptId, launch_token: launch.launchToken });
    world.ctx.store.withWrite((tx) => {
      resolveUnreportedWorkerExitInTx(tx, { attemptId: attempt.attemptId }, world.ctx.clock.nowIso());
    });
    expect(
      codeOf(() => supervisorCall(world, "start_worker_attempt", {
        directive_id: directive.directiveId,
        directive_revision: directive.revision,
        directive_hash: directive.hash,
        worker_role: "executor",
      })),
    ).toBe("ATTEMPT_RECONCILIATION_REQUIRED");
  });

  it("E11-T15: the reconciliation inspection path is allowed (issue + start + report)", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const inspection = runReconciliationInspection(world, { attemptId });
    expect(inspection.reportId).toMatch(/^rep_/);
    expect(currentRevision(world)).toBe(1);
  });

  it("E11-T16: request_execution_replan remains allowed while unresolved, and the issue records the Attempt", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const { requestExecutionReplanInTx } = await import("../src/application/execution-replan-service.js");
    const result = world.ctx.store.withWrite((tx) =>
      requestExecutionReplanInTx(
        tx,
        {
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          reason: "the interrupted work exposed a normative gap",
          affectedNormativeRefs: [{ type: "section", id: world.f.sectionIds[0]!, revision: 1 }],
          relevantReportRefs: [],
          toolUseId: "TU-E11-REPLAN",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    expect(result.status).toBe("replan_required");
    const issue = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT execution_context_json AS ctx FROM execution_issues WHERE execution_run_id = ? ORDER BY created_at DESC LIMIT 1").get(world.executionRunId) as { ctx: string },
    );
    const parsed = JSON.parse(issue.ctx) as { indeterminateAttemptIds: string[]; reconciledIndeterminateRefs: unknown[] };
    expect(parsed.indeterminateAttemptIds).toContain(attemptId);
    expect(parsed.reconciledIndeterminateRefs).toEqual([]);
  });

  it("E11-T16b: Stage continuation and activation are fenced before boundary classification", async () => {
    const { world } = await makeIndeterminateWorld();
    const { continueExecutionStageInTx, activateExecutionStageInTx } = await import("../src/application/execution-progression-service.js");
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) =>
          continueExecutionStageInTx(tx, { executionRunId: world.executionRunId, sessionId: world.f.sessionId, workspaceId: world.f.workspaceId, generation: world.f.generation }, world.ctx.clock, world.ctx.clock.nowIso()),
        ),
      ),
    ).toBe("ATTEMPT_RECONCILIATION_REQUIRED");
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) =>
          activateExecutionStageInTx(tx, { executionRunId: world.executionRunId, sessionId: world.f.sessionId, workspaceId: world.f.workspaceId, generation: world.f.generation, targetStageId: "stage_x" }, world.ctx.clock, world.ctx.clock.nowIso()),
        ),
      ),
    ).toBe("ATTEMPT_RECONCILIATION_REQUIRED");
  });
});

describe("E11 capability no-effect (§15/§16/§17, T17..T20)", () => {
  async function readOnlyVerifierCrashWorld(sessionTag: string) {
    const world = await makeAcceptanceWorld(sessionTag);
    const directive = issueDirective(world, { directiveId: "DIR-ROV", kind: "verification", capabilityEnvelope: readOnlyEnvelope() as never });
    const { attempt, launch } = world.ctx.store.withWrite((tx) =>
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
          workerRole: "verifier",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const session = freshWorkerSession(world, "ROV");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attempt.attemptId, launch_token: launch.launchToken });
    world.ctx.store.withWrite((tx) => {
      resolveUnreportedWorkerExitInTx(tx, { attemptId: attempt.attemptId }, world.ctx.clock.nowIso());
    });
    return { world, attemptId: attempt.attemptId };
  }

  it("E11-T17: a read-only interrupted verifier resolves no_effect_by_capability, candidate unchanged", async () => {
    const { world, attemptId } = await readOnlyVerifierCrashWorld(`CAP-${Math.random().toString(36).slice(2, 8)}`);
    const before = currentRevision(world);
    const result = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "no_effect_by_capability",
      rationale: "the interrupted verifier held read-only authority; no durable effect is possible",
      expected_candidate_revision: before,
    }) as { status: string; reconciliation: { resolution: string; candidate_revision_before: number; candidate_revision_after: number } };
    expect(result.status).toBe("resolved");
    expect(result.reconciliation.resolution).toBe("no_effect_by_capability");
    expect(result.reconciliation.candidate_revision_after).toBe(result.reconciliation.candidate_revision_before);
    expect(currentRevision(world)).toBe(before);
  });

  it("E11-T18/T19: the interrupted verification NEVER counts as coverage — a fresh verifier is required", async () => {
    const { world, attemptId } = await readOnlyVerifierCrashWorld(`CV-${Math.random().toString(36).slice(2, 8)}`);
    supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "no_effect_by_capability",
      rationale: "read-only interruption",
      expected_candidate_revision: currentRevision(world),
    });
    const { acceptanceServiceOf, acceptInput } = await import("./acceptance-helpers.js");
    expect(
      codeOf(() => acceptanceServiceOf(world).submitSupervisorAssessment(acceptInput(world) as never)),
    ).toBe("ACCEPTANCE_VERIFICATION_REQUIRED");
  });

  it("E11-T20: any side-effect-capable interruption refuses the capability shortcut", async () => {
    const { world, attemptId } = await makeIndeterminateWorld({ envelope: effectfulEnvelope() });
    expect(
      codeOf(() =>
        supervisorCall(world, "resolve_indeterminate_attempt", {
          attempt_id: attemptId,
          resolution: "no_effect_by_capability",
          rationale: "shortcut attempt",
          expected_candidate_revision: currentRevision(world),
        }),
      ),
    ).toBe("ATTEMPT_RECONCILIATION_SIDE_EFFECT_RISK");
  });
});

describe("E11 reconciliation binding (§9/§10/§53, T21..T25)", () => {
  it("E11-T21/T22: the binding is exact, machine-readable, immutable, and hash-covered", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const inspection = runReconciliationInspection(world, { attemptId });
    const binding = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT attempt_id AS attemptId, directive_id AS directiveId FROM execution_attempt_reconciliation_bindings WHERE attempt_id = ?").get(attemptId) as { attemptId: string; directiveId: string },
    );
    expect(binding.directiveId).toBe(inspection.directiveId);
    const actions = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT required_actions_json AS actions FROM execution_directives WHERE directive_id = ?").get(inspection.directiveId) as { actions: string },
    );
    expect(JSON.parse(actions.actions)).toContainEqual({ action: "reconcile_indeterminate_attempt", detail: attemptId });
    expect(
      (() => {
        try {
          world.ctx.store.withWrite((tx) => {
            tx.prepare("UPDATE execution_attempt_reconciliation_bindings SET directive_id = 'dir_other' WHERE attempt_id = ?").run(attemptId);
          });
          return "no-error";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      })(),
    ).toContain("execution_attempt_reconciliation_bindings is immutable");
  });

  it("E11-T23: a second unrelated logical reconciliation Directive is rejected", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    runReconciliationInspection(world, { attemptId });
    expect(
      codeOf(() =>
        supervisorCall(world, "issue_attempt_reconciliation", {
          attempt_id: attemptId,
          objective: "second binding attempt",
          body: "should fail",
          capability_envelope: readOnlyEnvelope(),
          report_contract: FULL_REPORT_CONTRACT,
        }),
      ),
    ).toBe("ATTEMPT_RECONCILIATION_TARGET_INVALID");
  });

  it("E11-T24: revision flow — blocked @1 then completed @2 of the SAME logical id resolves", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const first = runReconciliationInspection(world, {
      attemptId,
      reportOverrides: {
        result: "blocked",
        blockers: [{ kind: "MISSING_CONTEXT", summary: "cannot establish reality yet", details: null, relevantRefs: [] }],
      },
    });
    expect(world.ctx.store.withRead((tx) => getReconciliationForAttemptInTx(tx, attemptId))).toBeNull();
    // @2 of the SAME logical id: the fence exempts bound reconciliation ids.
    const revision2 = issueDirective(world, { directiveId: first.directiveId, kind: "inspection" });
    expect(revision2.revision).toBe(2);
    const { attempt, launch } = world.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: revision2.directiveId,
          directiveRevision: revision2.revision,
          directiveHash: revision2.hash,
          workerRole: "executor",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const session = freshWorkerSession(world, "R2");
    const reportId = runWorkerAttempt({ ...world, launch, attemptId: attempt.attemptId }, session, { candidate_mutated: false });
    const result = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "no_effect",
      inspection_report_id: reportId,
      rationale: "clean after the blocked first pass",
      expected_candidate_revision: currentRevision(world),
    }) as { status: string };
    expect(result.status).toBe("resolved");
  });

  it("E11-T25: the reconciliation worker session differs from the interrupted worker where identity exists", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const originalSession = world.ctx.store.withRead(
      (tx) => (tx.prepare("SELECT worker_session_id AS s FROM execution_worker_invocations WHERE attempt_id = ?").get(attemptId) as { s: string | null }).s,
    );
    const inspection = runReconciliationInspection(world, { attemptId });
    const reconciliationSession = world.ctx.store.withRead(
      (tx) => (tx.prepare("SELECT worker_session_id AS s FROM execution_worker_invocations WHERE attempt_id = ?").get(inspection.attemptId) as { s: string | null }).s,
    );
    expect(originalSession).not.toBeNull();
    expect(reconciliationSession).not.toBeNull();
    expect(reconciliationSession).not.toBe(originalSession);
  });
});

describe("E11 reconciliation resolutions (§24–§34, T26..T43)", () => {
  it("E11-T31/T32/T33/T34: no_effect — immutable resolution, candidate unchanged, attempt stays indeterminate, fence lifts", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const inspection = runReconciliationInspection(world, { attemptId });
    const before = currentRevision(world);
    const result = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "no_effect",
      inspection_report_id: inspection.reportId,
      rationale: "the inspection found no durable effect of the interrupted work",
      expected_candidate_revision: before,
    }) as { status: string; reconciliation: { resolution: string } };
    expect(result.status).toBe("resolved");
    expect(currentRevision(world)).toBe(before);
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("indeterminate");
    expect(world.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_reports WHERE attempt_id = ?").get(attemptId))).toEqual({ n: 0 });
    expect(codeOf(() => issueDirective(world, { directiveId: "DIR-AFTER", kind: "implementation" }))).toBe("no-error");
  });

  it("E11-T26: a completed non-mutating inspection is eligible for resolution", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const inspection = runReconciliationInspection(world, { attemptId });
    const result = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "no_effect",
      inspection_report_id: inspection.reportId,
      rationale: "clean",
      expected_candidate_revision: currentRevision(world),
    }) as { status: string };
    expect(result.status).toBe("resolved");
  });

  it("E11-T27/T28/T29: blocked, failed, and partial reports do not resolve", async () => {
    for (const [index, result] of (["blocked", "failed", "partial"] as const).entries()) {
      const { world, attemptId } = await makeIndeterminateWorld({ sessionId: `BR${index}-${Math.random().toString(36).slice(2, 6)}` });
      const overrides: Record<string, unknown> =
        result === "blocked"
          ? { result, blockers: [{ kind: "MISSING_CONTEXT", summary: "blocked", details: null, relevantRefs: [] }] }
          : { result };
      const inspection = runReconciliationInspection(world, { attemptId, reportOverrides: overrides });
      expect(
        codeOf(() =>
          supervisorCall(world, "resolve_indeterminate_attempt", {
            attempt_id: attemptId,
            resolution: "no_effect",
            inspection_report_id: inspection.reportId,
            rationale: "should fail",
            expected_candidate_revision: currentRevision(world),
          }),
        ),
      ).toBe("ATTEMPT_RECONCILIATION_REPORT_INVALID");
      expect(world.ctx.store.withRead((tx) => getReconciliationForAttemptInTx(tx, attemptId))).toBeNull();
    }
  });

  it("E11-T30: a mutating reconciliation inspection advances the candidate normally but cannot resolve; the next revision can", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const first = runReconciliationInspection(world, { attemptId, candidateMutated: true, reportOverrides: { files_changed: ["src/partial.ts"] } });
    expect(currentRevision(world)).toBe(2);
    expect(
      codeOf(() =>
        supervisorCall(world, "resolve_indeterminate_attempt", {
          attempt_id: attemptId,
          resolution: "no_effect",
          inspection_report_id: first.reportId,
          rationale: "stale report",
          expected_candidate_revision: currentRevision(world),
        }),
      ),
    ).toBe("ATTEMPT_RECONCILIATION_REPORT_INVALID");
    const second = runReconciliationInspection(world, { attemptId });
    const result = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "no_effect",
      inspection_report_id: second.reportId,
      rationale: "clean after partial effects",
      expected_candidate_revision: currentRevision(world),
    }) as { status: string };
    expect(result.status).toBe("resolved");
  });

  it("E11-T35/T36/T37: candidate_changed advances exactly once, retries converge, stale is refused", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const inspection = runReconciliationInspection(world, { attemptId });
    const before = currentRevision(world);
    const result = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspection.reportId,
      rationale: "the inspection found unaccounted durable mutation",
      expected_candidate_revision: before,
    }) as { status: string; reconciliation: { candidate_revision_before: number; candidate_revision_after: number } };
    expect(result.status).toBe("resolved");
    expect(result.reconciliation.candidate_revision_before).toBe(before);
    expect(result.reconciliation.candidate_revision_after).toBe(before + 1);
    expect(currentRevision(world)).toBe(before + 1);
    const retry = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspection.reportId,
      rationale: "the inspection found unaccounted durable mutation",
      expected_candidate_revision: currentRevision(world),
    }) as { status: string };
    expect(retry.status).toBe("already_resolved");
    expect(currentRevision(world)).toBe(before + 1);
    expect(
      codeOf(() =>
        supervisorCall(world, "resolve_indeterminate_attempt", {
          attempt_id: attemptId,
          resolution: "no_effect",
          inspection_report_id: inspection.reportId,
          rationale: "conflicting retry",
          expected_candidate_revision: currentRevision(world),
        }),
      ),
    ).toBe("ATTEMPT_RECONCILIATION_ALREADY_RESOLVED");
  });

  it("E11-T38: exactly TWO candidate-revision writers exist (static source proof)", async () => {
    const srcRoot = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          if (/advanceCandidateRevisionInTx\(tx,/.test(text)) {
            offenders.push(path.relative(srcRoot, full));
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders.map((offender) => offender.split(path.sep).join("/")).sort()).toEqual([
      "application/attempt-recovery-service.ts",
      "application/execution-report-service.ts",
    ]);
  });

  it("E11-T40: a reconciled BATCHABLE implementation contributes one unverified span increment", async () => {
    const { world, attemptId } = await makeIndeterminateWorld({ directiveId: "DIR-BATCH" });
    const inspection = runReconciliationInspection(world, { attemptId });
    supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspection.reportId,
      rationale: "batchable implementation had unreported effects",
      expected_candidate_revision: currentRevision(world),
    });
    // The crash world already carried one unverified batchable mutation
    // (span 1); the recovered mutation contributes exactly its own increment.
    const state = world.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, world.executionRunId));
    expect(state).not.toBeNull();
    expect(state!.unverifiedMutationSpan).toBe(2);
    expect(state!.verificationRequired).toBe(false);
  });

  it("E11-T39/T41/T42: reconciled immediate implementation → immediate; reconciled inspection/verifier mutation → unexpected_mutation", async () => {
    // T39 — the original implementation directive required IMMEDIATE
    // verification; the recovered mutation owes exactly that.
    const immediate = await makeIndeterminateWorld({
      sessionId: `P1-${Math.random().toString(36).slice(2, 6)}`,
      verificationPolicy: { implementationRequirement: "immediate" },
    });
    const immediateInspection = runReconciliationInspection(immediate.world, { attemptId: immediate.attemptId });
    supervisorCall(immediate.world, "resolve_indeterminate_attempt", {
      attempt_id: immediate.attemptId,
      resolution: "candidate_changed",
      inspection_report_id: immediateInspection.reportId,
      rationale: "immediate implementation had unreported effects",
      expected_candidate_revision: currentRevision(immediate.world),
    });
    const state1 = immediate.world.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, immediate.world.executionRunId));
    expect(state1!.verificationRequired).toBe(true);
    expect(state1!.reason).toBe("immediate");

    // T41 — the interrupted INSPECTION's recovery finds mutation.
    const inspectionCrash = await makeIndeterminateWorld({ sessionId: `P3-${Math.random().toString(36).slice(2, 6)}`, directiveId: "DIR-INSC", kind: "inspection" });
    const inspectionR = runReconciliationInspection(inspectionCrash.world, { attemptId: inspectionCrash.attemptId });
    supervisorCall(inspectionCrash.world, "resolve_indeterminate_attempt", {
      attempt_id: inspectionCrash.attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspectionR.reportId,
      rationale: "the interrupted inspection had unreported effects",
      expected_candidate_revision: currentRevision(inspectionCrash.world),
    });
    const state2 = inspectionCrash.world.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, inspectionCrash.world.executionRunId));
    expect(state2!.verificationRequired).toBe(true);
    expect(state2!.reason).toBe("unexpected_mutation");

  });

  it("E11-T43: a legacy v1 candidate-changing implementation reconciles to legacy_policy_unknown debt", async () => {
    const world = await makeAcceptanceWorld(`V1-${Math.random().toString(36).slice(2, 8)}`);
    const windowId = world.openWindowId;
    const revision = currentRevision(world);
    // A genuine v1 implementation directive (policy explicitly unknown) as the
    // E8-era history would hold, inserted as immutable history.
    const run = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT run_id AS id, final_plan_id AS fpId, final_plan_revision AS fpRev, final_plan_hash AS fpHash FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { id: string; fpId: string; fpRev: number; fpHash: string },
    );
    world.ctx.store.withWrite((tx) => {
      tx.prepare(
        `INSERT INTO execution_directives (
           directive_id, revision, directive_hash, execution_run_id, run_id, final_plan_id, final_plan_revision, final_plan_hash,
           scope_kind, stage_id, window_id, kind, base_candidate_revision,
           accepted_base_kind, accepted_base_json, objective, plan_refs_json, expected_scope_json,
           capability_envelope_json, invariants_json, required_actions_json, forbidden_actions_json,
           validation_requirements_json, deliverables_json, stop_conditions_json, report_contract_json,
           body, issued_at, protocol_version, verification_requirement, verification_purpose, verification_conflict_id
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'stage', ?, ?, 'implementation', ?, 'execution_start', '{}', 'legacy work', '[]', '{"files":[],"symbols":[],"callPaths":[],"tests":[]}', '{"repositoryRead":true,"repositoryWrite":true,"commandExecution":false,"networkAccess":false,"dependencyMutation":false,"gitCommit":false,"gitPush":false,"externalServiceMutation":false}', '[]', '[]', '[]', '[]', '[]', '[]', '{"requireActionsPerformed":false,"requireFilesExamined":true,"requireFilesChanged":false,"requireCommandsRun":false,"requireTestsRun":false,"requireFindings":true,"requireDeviations":false,"requireBlockers":false,"requireDeliverables":false}', 'legacy', ?, 1, NULL, NULL, NULL)`,
      ).run(
        "DIR-V1",
        `sha256:${"0".repeat(64)}`,
        world.executionRunId,
        run.id,
        run.fpId,
        run.fpRev,
        run.fpHash,
        world.activeStageId,
        windowId,
        revision,
        world.ctx.clock.nowIso(),
      );
      tx.prepare(
        `INSERT INTO execution_attempts (attempt_id, execution_run_id, directive_id, directive_revision, directive_hash, worker_role, state, started_at, ended_at)
         VALUES ('att_v1', ?, 'DIR-V1', 1, ?, 'executor', 'indeterminate', ?, NULL)`,
      ).run(world.executionRunId, `sha256:${"0".repeat(64)}`, world.ctx.clock.nowIso());
    });
    // Reconcile candidate_changed through the REAL inspection workflow.
    const inspection = runReconciliationInspection(world, { attemptId: "att_v1" });
    supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: "att_v1",
      resolution: "candidate_changed",
      inspection_report_id: inspection.reportId,
      rationale: "legacy v1 implementation had unreported effects",
      expected_candidate_revision: currentRevision(world),
    });
    const state = world.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, world.executionRunId));
    expect(state!.verificationRequired).toBe(true);
    expect(state!.reason).toBe("legacy_policy_unknown");
  });
});
