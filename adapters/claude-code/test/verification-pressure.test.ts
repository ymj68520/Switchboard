/**
 * E8 §50/§51 — verification-pressure derivation and the policy gates
 * (E8-T8..T22), plus the §23 policy context.
 *
 * The pressure state is deterministically derived from durable facts on every
 * read (E8 §10): batchable mutations accumulate up to the frozen bound
 * (MAX_UNVERIFIED_MUTATIONS = 3, E8 §14), immediate mutating work requires
 * verification at once (§15), unexpected mutation from inspection/verification
 * fails conservative (§17), legacy v1 mutation has unknown policy (§18), a
 * qualifying NORMAL verification clears the debt without implying acceptance
 * (§19), and both issuance and attempt-start enforce the gates (§21/§22).
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
import { issueDirective, startAttempt } from "./execution-protocol-helpers.js";
import { loadVerificationPolicyStateInTx } from "../src/application/verification-policy-service.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { dropSchema21Objects, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";
import * as path from "node:path";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`VP-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

function policyOf(w: AcceptanceWorld) {
  return w.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, w.executionRunId))!;
}

/** One mutating batchable implementation cycle (the fixture default). */
function mutatingImpl(w: AcceptanceWorld, id: string): void {
  runDirectiveCycle(w, {
    directiveId: id,
    kind: "implementation",
    reportOverrides: { candidate_mutated: true, files_changed: ["src/x.ts"] },
  });
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E8 verification pressure (§14–§20)", () => {
  it("E8-T8/T9: batchable spans 1 and 2 stay clear", async () => {
    const w = await freshWorld();
    expect(policyOf(w).unverifiedMutationSpan).toBe(1);
    expect(policyOf(w).verificationRequired).toBe(false);
    mutatingImpl(w, "DIR-B2");
    const state = policyOf(w);
    expect(state.unverifiedMutationSpan).toBe(2);
    expect(state.verificationRequired).toBe(false);
    expect(state.reason).toBeNull();
  });

  it("E8-T10: span 3 trips max_unverified_span", async () => {
    const w = await freshWorld();
    mutatingImpl(w, "DIR-B2");
    mutatingImpl(w, "DIR-B3");
    const state = policyOf(w);
    expect(state.unverifiedMutationSpan).toBe(3);
    expect(state.verificationRequired).toBe(true);
    expect(state.reason).toBe("max_unverified_span");
    expect(state.maxUnverifiedMutations).toBe(3);
    expect(state.latestVerifiedRevision).toBe(0);
  });

  it("E8-T11: the fourth implementation is refused at issuance AND start", async () => {
    const w = await freshWorld();
    mutatingImpl(w, "DIR-B2");
    mutatingImpl(w, "DIR-B3");
    expect(
      codeOf(() =>
        issueDirective(w, { directiveId: "DIR-B4", verificationPolicy: { implementationRequirement: "batchable" } }),
      ),
    ).toBe("VERIFICATION_REQUIRED");
    // Inspection and verification are never blocked by pressure (E8 §21).
    expect(() => runDirectiveCycle(w, { directiveId: "DIR-INS", kind: "inspection" })).not.toThrow();
  });

  it("E8-T12: an immediate mutating Directive requires verification at once", async () => {
    const w = await freshWorld();
    runDirectiveCycle(w, {
      directiveId: "DIR-IMM",
      kind: "implementation",
      directiveOverrides: { verificationPolicy: { implementationRequirement: "immediate" } },
      reportOverrides: { candidate_mutated: true, files_changed: ["src/x.ts"] },
    });
    const state = policyOf(w);
    expect(state.verificationRequired).toBe(true);
    expect(state.reason).toBe("immediate");
    expect(state.blockingReportRef?.directiveId).toBe("DIR-IMM");
  });

  it("E8-T13: an immediate NON-mutating Directive accrues no verification debt", async () => {
    const w = await freshWorld();
    runDirectiveCycle(w, {
      directiveId: "DIR-IMM2",
      kind: "implementation",
      directiveOverrides: { verificationPolicy: { implementationRequirement: "immediate" } },
      reportOverrides: { candidate_mutated: false },
    });
    const state = policyOf(w);
    expect(state.verificationRequired).toBe(false);
    // The fixture's earlier mutation still counts in the span arithmetic, but
    // the immediate non-mutating Directive added no NEW debt.
    expect(state.unverifiedMutationSpan).toBe(1);
  });

  it("E8-T14: unexpected inspection mutation requires fresh normal verification", async () => {
    const w = await freshWorld();
    runDirectiveCycle(w, {
      directiveId: "DIR-INS-MUT",
      kind: "inspection",
      reportOverrides: { candidate_mutated: true, files_changed: ["src/accident.ts"] },
    });
    const state = policyOf(w);
    expect(state.verificationRequired).toBe(true);
    expect(state.reason).toBe("unexpected_mutation");
  });

  it("E8-T15: a mutating verifier does not clear the debt and cannot self-clear", async () => {
    const w = await freshWorld();
    mutatingImpl(w, "DIR-B2");
    runVerificationCycle(w, {
      directiveOverrides: { verificationPolicy: { verificationPurpose: "normal" } },
      reportOverrides: { candidate_mutated: true, files_changed: ["src/verifier-mutated.ts"] },
    });
    const state = policyOf(w);
    expect(state.verificationRequired).toBe(true);
    expect(state.reason).toBe("unexpected_mutation");
    expect(state.latestVerifiedRevision).toBe(0);
  });

  it("E8-T16: a failed verifier does not clear the debt", async () => {
    const w = await freshWorld();
    mutatingImpl(w, "DIR-B2");
    mutatingImpl(w, "DIR-B3");
    expect(policyOf(w).verificationRequired).toBe(true);
    runVerificationCycle(w, {
      directiveOverrides: { verificationPolicy: { verificationPurpose: "normal" } },
      reportOverrides: { result: "failed" },
    });
    const state = policyOf(w);
    expect(state.verificationRequired).toBe(true);
    expect(state.reason).toBe("max_unverified_span");
    expect(state.unverifiedMutationSpan).toBe(3);
  });

  it("E8-T17: a completed normal verifier at the exact candidate clears the debt — even with findings", async () => {
    const w = await freshWorld();
    mutatingImpl(w, "DIR-B2");
    mutatingImpl(w, "DIR-B3");
    expect(policyOf(w).verificationRequired).toBe(true);
    runVerificationCycle(w, {
      directiveOverrides: { verificationPolicy: { verificationPurpose: "normal" } },
      reportOverrides: {
        findings: [{ kind: "defect", summary: "edge case broken", detail: "detail", relevantRefs: [], severity: "major" }],
      },
    });
    const state = policyOf(w);
    expect(state.verificationRequired).toBe(false);
    expect(state.reason).toBeNull();
    expect(state.unverifiedMutationSpan).toBe(0);
    expect(state.latestVerifiedRevision).toBe(state.candidateRevision);
    expect(state.normalVerificationReports).toContain(w.verReportId);
  });

  it("E8-T18: rework may be issued after a defect-finding verifier — insertion debt cleared, acceptance separate", async () => {
    const w = await freshWorld();
    runVerificationCycle(w, {
      directiveOverrides: { verificationPolicy: { verificationPurpose: "normal" } },
      reportOverrides: {
        findings: [{ kind: "defect", summary: "broken behavior", detail: "detail", relevantRefs: [], severity: "major" }],
      },
    });
    const state = policyOf(w);
    expect(state.verificationRequired).toBe(false);
    // The rework ImplementationDirective is issuable despite the defect
    // finding (insertion debt is cleared; a finding is not a debt).
    const rework = issueDirective(w, {
      directiveId: "DIR-REWORK",
      verificationPolicy: { implementationRequirement: "batchable" },
    });
    // Acceptance remains blocked by the E6 judgment: the mutating executor
    // report is adverse evidence the assessment must classify.
    runVerificationCycle(w);
    const result = acceptanceServiceOf(w).submitSupervisorAssessment(
      acceptInput(w, { disposition: "rework", reportJudgments: [], rationale: "Verifier found a defect; rework next." }) as never,
    );
    expect(result.commit).toBeNull();
    // And the rework starts cleanly once the window is quiet again.
    expect(() => startAttempt(w, rework)).not.toThrow();
  });

  it("E8-T20: a pre-issued implementation Directive cannot start once debt became due", async () => {
    const w = await freshWorld();
    const pre = issueDirective(w, { directiveId: "DIR-PRE", verificationPolicy: { implementationRequirement: "batchable" } });
    mutatingImpl(w, "DIR-B2");
    mutatingImpl(w, "DIR-B3");
    // Fail-closed either way: while the candidate is still at the pre-issued
    // base the policy gate refuses on pressure; once verification moved the
    // candidate past that base, the E4 staleness fence refuses — a pre-issued
    // Directive can never bypass due debt (E8 §22).
    expect(["VERIFICATION_REQUIRED", "DIRECTIVE_NOT_CURRENT"]).toContain(codeOf(() => startAttempt(w, pre)));
    runVerificationCycle(w);
    expect(["VERIFICATION_REQUIRED", "DIRECTIVE_NOT_CURRENT"]).toContain(codeOf(() => startAttempt(w, pre)));
  });

  it("E8-T21/T22: batchable work accumulates without per-Directive verification, and the bound holds", async () => {
    const w = await freshWorld();
    // Fixture mutation (span 1) + one batchable Directive (span 2): two
    // consecutive implementation Directives ran with NO verifier between them.
    mutatingImpl(w, "DIR-B2");
    expect(policyOf(w).verificationRequired).toBe(false);
    const directives = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE kind = 'verification'").get() as { n: number },
    );
    expect(directives.n).toBe(0);
    // The THIRD unverified mutation reaches the frozen bound; the fourth
    // implementation cannot execute (E8-T22).
    mutatingImpl(w, "DIR-B3");
    expect(policyOf(w).verificationRequired).toBe(true);
    expect(
      codeOf(() => issueDirective(w, { directiveId: "DIR-B4", verificationPolicy: { implementationRequirement: "batchable" } })),
    ).toBe("VERIFICATION_REQUIRED");
  });

  it("E8-T19: legacy v1 mutation fails conservative and is cleared by a normal verifier", async () => {
    let w = await freshWorld();
    // Present the genuine post-rewind legacy world: the historical mutating
    // implementation Directive becomes v1-by-definition with NULL policy.
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = storePathsFor(root).databasePath;
    w.ctx.store.close();
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema21Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 21");
      raw.exec("PRAGMA user_version = 20");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    w = { ...w, ctx: { ...w.ctx, store: reopened } };
    const state = policyOf(w);
    expect(state.verificationRequired).toBe(true);
    expect(state.reason).toBe("legacy_policy_unknown");
    expect(state.legacyPolicyPresent).toBe(true);
    // New implementation issuance is blocked...
    expect(
      codeOf(() => issueDirective(w, { directiveId: "DIR-NEXT", verificationPolicy: { implementationRequirement: "batchable" } })),
    ).toBe("VERIFICATION_REQUIRED");
    // ...and a qualifying normal verifier on the current candidate clears it.
    runVerificationCycle(w, { directiveOverrides: { verificationPolicy: { verificationPurpose: "normal" } } });
    const cleared = policyOf(w);
    expect(cleared.verificationRequired).toBe(false);
    expect(cleared.legacyPolicyPresent).toBe(false);
    reopened.close();
    removeTempPluginDataRoot(root);
    world = null;
  });
});

describe("E8 §23 — the policy context", () => {
  it("the context projects the exact derived state", async () => {
    const w = await freshWorld();
    const context = supervisorCall(w, "get_verification_policy_context") as Record<string, unknown>;
    expect(context.status).toBe("ok");
    expect(context.candidate_revision).toBe(1);
    expect(context.latest_verified_revision).toBe(0);
    expect(context.unverified_mutation_span).toBe(1);
    expect(context.max_unverified_mutations).toBe(3);
    expect(context.verification_required).toBe(false);
    expect(context.reason).toBeNull();
    expect(context.legacy_policy_present).toBe(false);
  });
});
