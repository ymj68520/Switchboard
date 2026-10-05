/**
 * E8 §52/§54/§56 — conflict declaration, candidate staleness, and the rework
 * escape (E8-T23..T27, T37, T42).
 *
 * Core validates STRUCTURE only: exact current-candidate trusted Report
 * binding, two distinct claim variants, the deterministic duplicate
 * fingerprint. Ordinary verifier-defect evidence never auto-creates a
 * conflict (E8 §27/§41), and a candidate mutation deterministically stales a
 * conflict without rewriting it (E8 §39).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  makeAcceptanceWorld,
  runDirectiveCycle,
  runVerificationCycle,
  supervisorCall,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { codeOf, issueDirective } from "./execution-protocol-helpers.js";
import { freshWorkerSession, callWorkerTool } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { randomUUID } from "node:crypto";
import { getVerificationConflictInTx, listWindowConflictsInTx } from "../src/store/verification-conflicts.js";
import { listBlockingConflictsInTx } from "../src/application/verification-conflict-service.js";
import { verificationConflictFingerprint } from "../src/core/verification-conflict.js";

let world: AcceptanceWorld | null = null;

/** A world holding TWO trusted current-candidate Reports (verifier + inspection). */
async function freshConflictWorld(): Promise<AcceptanceWorld> {
  const w = await makeAcceptanceWorld(`VC-${Math.random().toString(36).slice(2, 8)}`);
  world = w;
  runVerificationCycle(w); // trusted current verifier report (base 1)
  // A second trusted CURRENT report: a completed, non-mutating inspection at
  // the exact same candidate revision (the mutating impl report is historical).
  const inspection = runDirectiveCycle(w, { directiveId: "DIR-INS-A", kind: "inspection" });
  (w as AcceptanceWorld & { insReportId: string }).insReportId = inspection.reportId;
  return w;
}

function secondReportId(w: AcceptanceWorld): string {
  return (w as AcceptanceWorld & { insReportId: string }).insReportId;
}

function declare(w: AcceptanceWorld, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return supervisorCall(w, "declare_verification_conflict", {
    fact: "the module exports exactly one public function",
    claims: [
      { variant: "A", statement: "exports { run } only", source_report_ids: [w.verReportId] },
      { variant: "B", statement: "exports { run, runAll }", source_report_ids: [secondReportId(w)] },
    ],
    ...overrides,
  });
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E8 conflict declaration (§26–§30)", () => {
  it("E8-T23: two trusted current Reports + two claim variants → one durable open conflict", async () => {
    const w = await freshConflictWorld();
    const response = declare(w) as { status: string; conflict: { id: string; status: string; candidate_revision: number; fingerprint: string } };
    expect(response.status).toBe("declared");
    expect(response.conflict.status).toBe("open");
    expect(response.conflict.candidate_revision).toBe(1);
    const stored = w.ctx.store.withRead((tx) => getVerificationConflictInTx(tx, response.conflict.id))!;
    expect(stored.status).toBe("open");
    expect(stored.claims.map((claim) => claim.variant)).toEqual(["A", "B"]);
    // The fingerprint is deterministic over run/window/revision/fact/reports/claims.
    expect(stored.fingerprint).toBe(
      verificationConflictFingerprint({
        executionRunId: w.executionRunId,
        windowId: w.openWindowId,
        candidateRevision: 1,
        fact: "the module exports exactly one public function",
        claims: stored.claims,
      }),
    );
  });

  it("E8-T24: a stale (historical) Report cannot participate in a conflict", async () => {
    const w = await freshConflictWorld();
    // Advance the candidate: the verifier report is now historical.
    runDirectiveCycle(w, {
      directiveId: "DIR-B2",
      kind: "implementation",
      reportOverrides: { candidate_mutated: true, files_changed: ["src/x.ts"] },
    });
    const code = codeOf(() =>
      supervisorCall(w, "declare_verification_conflict", {
        fact: "the module exports exactly one public function",
        claims: [
          { variant: "A", statement: "a", source_report_ids: [w.verReportId] },
          { variant: "B", statement: "b", source_report_ids: [secondReportId(w)] },
        ],
      }),
    );
    expect(code).toBe("VERIFICATION_CONFLICT_INVALID");
    expect(w.ctx.store.withRead((tx) => listWindowConflictsInTx(tx, w.openWindowId))).toHaveLength(0);
  });

  it("E8-T25: a foreign report is rejected", async () => {
    const w = await freshConflictWorld();
    const other = await makeAcceptanceWorld(`VC-OTHER-${Math.random().toString(36).slice(2, 6)}`);
    try {
      const code = codeOf(() =>
        supervisorCall(w, "declare_verification_conflict", {
          fact: "cross-run fact",
          claims: [
            { variant: "A", statement: "a", source_report_ids: [w.verReportId] },
            { variant: "B", statement: "b", source_report_ids: [other.implReportId] },
          ],
        }),
      );
      expect(code).toBe("VERIFICATION_CONFLICT_INVALID");
    } finally {
      other.ctx.store.close();
    }
  });

  it("E8-T26: the identical conflict cannot be declared twice (deterministic fingerprint)", async () => {
    const w = await freshConflictWorld();
    const first = declare(w) as { conflict: { id: string } };
    expect(codeOf(() => declare(w))).toBe("VERIFICATION_CONFLICT_ALREADY_EXISTS");
    expect(
      w.ctx.store.withRead((tx) => listWindowConflictsInTx(tx, w.openWindowId)).map((c) => c.conflictId),
    ).toEqual([first.conflict.id]);
  });

  it("E8-T27: an ordinary verifier defect is NOT automatically a conflict", async () => {
    const w = await makeAcceptanceWorld(`VC-DEFECT-${Math.random().toString(36).slice(2, 8)}`);
    runVerificationCycle(w, {
      reportOverrides: {
        findings: [{ kind: "defect", summary: "edge case broken", detail: "d", relevantRefs: [], severity: "major" }],
      },
    });
    // Ordinary negative verifier evidence: no conflict object exists, and the
    // supervisor's rework judgment flows through the E6 assessment path.
    expect(w.ctx.store.withRead((tx) => listWindowConflictsInTx(tx, w.openWindowId))).toHaveLength(0);
    const result = acceptanceServiceOf(w).submitSupervisorAssessment(
      acceptInput(w, { disposition: "rework", rationale: "Defect found; rework." }) as never,
    );
    expect(result.commit).toBeNull();
  });
});

describe("E8 candidate staleness + rework escape (§39/§42)", () => {
  it("E8-T37: a candidate mutation stales the conflict — it blocks nothing and is never rewritten", async () => {
    const w = await freshConflictWorld();
    const declared = declare(w) as { conflict: { id: string } };
    const blockingNow = w.ctx.store.withRead((tx) => listBlockingConflictsInTx(tx, w.executionRunId));
    expect(blockingNow).toHaveLength(1);
    // A mutating rework creates a new candidate revision.
    runDirectiveCycle(w, {
      directiveId: "DIR-REWORK",
      kind: "implementation",
      reportOverrides: { candidate_mutated: true, files_changed: ["src/rework.ts"] },
    });
    const stored = w.ctx.store.withRead((tx) => getVerificationConflictInTx(tx, declared.conflict.id))!;
    expect(stored.candidateRevision).toBe(1); // never rewritten
    expect(stored.status).toBe("open");
    // The new candidate is unblocked.
    const blockers = w.ctx.store.withRead((tx) => listBlockingConflictsInTx(tx, w.executionRunId));
    expect(blockers).toHaveLength(0);
    // Settling the historical conflict is refused outright.
    const settle = codeOf(() =>
      supervisorCall(w, "resolve_verification_conflict", {
        conflict_id: declared.conflict.id,
        outcome: "resolved",
        resolution_report_id: "rep_anywhere",
        rationale: "too late",
      }),
    );
    expect(settle).toBe("VERIFICATION_CONFLICT_STALE");
  });

  it("E8-T42: verification_blocked does not deadlock — inspection and rework stay available", async () => {
    const w = await freshConflictWorld();
    const declared = declare(w) as { conflict: { id: string } };
    // Bind + run the one dedicated resolver, then settle on verification_blocked.
    const resolver = issueResolver(w, declared.conflict.id);
    const resolverReportId = completeResolver(w, resolver);
    const settled = supervisorCall(w, "resolve_verification_conflict", {
      conflict_id: declared.conflict.id,
      outcome: "verification_blocked",
      resolution_report_id: resolverReportId,
      rationale: "the resolver could not establish either claim",
    }) as { status: string };
    expect(settled.status).toBe("verification_blocked");
    // Inspection still runs…
    expect(() => runDirectiveCycle(w, { directiveId: "DIR-INS-B", kind: "inspection" })).not.toThrow();
    // …and mutating rework creates a new candidate that stales the blocked conflict.
    runDirectiveCycle(w, {
      directiveId: "DIR-REWORK2",
      kind: "implementation",
      reportOverrides: { candidate_mutated: true, files_changed: ["src/rework2.ts"] },
    });
    const blockers = w.ctx.store.withRead((tx) => listBlockingConflictsInTx(tx, w.executionRunId));
    expect(blockers).toHaveLength(0);
  });
});

// --- local helpers -----------------------------------------------------------

/** Issue THE one dedicated conflict-resolution verifier (E8 §31). */
function issueResolver(w: AcceptanceWorld, conflictId: string) {
  return issueDirective(w, {
    directiveId: `DIR-RESOLVE-${randomUUID().slice(0, 6)}`,
    kind: "verification",
    verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: conflictId },
  });
}

/** Run the resolver attempt with a FRESH worker session and return its report id. */
function completeResolver(w: AcceptanceWorld, resolver: { directiveId: string; revision: number; hash: string }): string {
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
  return ack.report_id;
}
