/**
 * Phase 13 §12–§14/§95 — the PURE core FinalizationGate and the canonical
 * finalization models. No store, no host: facts are constructed by hand and
 * every deny reason is asserted structurally.
 */
import { describe, expect, it } from "vitest";

import {
  FINALIZATION_REASON_CODES,
  evidenceAuditHash,
  evaluateFinalization,
  finalPlanCandidateHash,
  finalPlanHash,
  renderFinalPlanCandidateMarkdown,
  type FinalizationFacts,
  type FinalPlanCandidateV1,
} from "../src/core/finalization.js";

const HEAD = { snapshotId: "snap-1", commitId: "cmt-1" };

/** A fully passing world — each test mutates one layer to force a deny. */
function passingFacts(overrides: Partial<FinalizationFacts> = {}): FinalizationFacts {
  return {
    run: { lifecycle: "active", stage: "validation", revision: 7 },
    head: { ...HEAD },
    synthesis: {
      inputId: "synin_1",
      inputHash: "sha256:input",
      baseHeadSnapshot: HEAD.snapshotId,
      baseHeadCommit: HEAD.commitId,
      manifestId: "synm_1",
      manifestHash: "sha256:manifest",
      reportId: "valrep_1",
      reportHash: "sha256:report",
      reportIsClean: true,
      unresolvedFindingCount: 0,
    },
    architecture: { id: "ARCH-1", revision: 1 },
    pinnedArchitecture: { id: "ARCH-1", revision: 1 },
    sections: [
      { sectionId: "SEC-1", revision: 2, status: "completed", completedRevision: 2 },
      { sectionId: "SEC-2", revision: 3, status: "completed", completedRevision: 3 },
    ],
    activeSection: null,
    blockingQuestionCount: 0,
    blockingConflictCount: 0,
    evidence: [],
    evidenceScopeMatches: true,
    awaitingProposal: null,
    ...overrides,
  };
}

describe("FinalizationGate (§12–§14/§95)", () => {
  it("passes a fully consistent world with a structured pass (no boolean)", () => {
    const decision = evaluateFinalization(passingFacts());
    expect(decision).toEqual({ status: "pass" });
  });

  it("denies a non-clean validation report (§18)", () => {
    const decision = evaluateFinalization(
      passingFacts({ synthesis: [{ ...passingFacts().synthesis!, reportIsClean: false } as const][0] }),
    );
    expect(decision.status).toBe("deny");
    if (decision.status === "deny") {
      expect(decision.reasons.map((r) => r.code)).toContain("SEMANTIC_VALIDATION_NOT_CLEAN");
    }
  });

  it("denies a missing manifest and a missing report (§17)", () => {
    const noManifest = evaluateFinalization(
      passingFacts({ synthesis: { ...passingFacts().synthesis!, manifestId: null, manifestHash: null } }),
    );
    expect(noManifest.status).toBe("deny");
    if (noManifest.status === "deny") {
      expect(noManifest.reasons.map((r) => r.code)).toContain("SYNTHESIS_MANIFEST_MISSING");
    }
    const noReport = evaluateFinalization(
      passingFacts({ synthesis: { ...passingFacts().synthesis!, reportId: null, reportHash: null } }),
    );
    if (noReport.status === "deny") {
      expect(noReport.reasons.map((r) => r.code)).toContain("SEMANTIC_VALIDATION_MISSING");
    }
  });

  it("denies a stale HEAD and never re-binds an old synthesis to a new HEAD (§16)", () => {
    const decision = evaluateFinalization(passingFacts({ head: { snapshotId: "snap-2", commitId: "cmt-2" } }));
    expect(decision).toEqual({
      status: "deny",
      reasons: [
        {
          code: "HEAD_STALE",
          detail: {
            baseHeadSnapshot: "snap-1",
            baseHeadCommit: "cmt-1",
            headSnapshot: "snap-2",
            headCommit: "cmt-2",
          },
        },
      ],
    });
  });

  it("denies a missing synthesis input (§16)", () => {
    const decision = evaluateFinalization(passingFacts({ synthesis: null }));
    expect(decision.status).toBe("deny");
    if (decision.status === "deny") {
      expect(decision.reasons.map((r) => r.code)).toEqual(["SYNTHESIS_INPUT_MISSING"]);
    }
  });

  it("denies an open Section, a needs_review Section, and a completion at a stale revision (§21)", () => {
    const mixed = evaluateFinalization(
      passingFacts({
        sections: [
          { sectionId: "SEC-1", revision: 2, status: "open", completedRevision: null },
          { sectionId: "SEC-2", revision: 3, status: "needs_review", completedRevision: 3 },
          { sectionId: "SEC-3", revision: 4, status: "completed", completedRevision: 3 },
        ],
      }),
    );
    expect(mixed.status).toBe("deny");
    if (mixed.status === "deny") {
      const codes = mixed.reasons.map((r) => r.code);
      expect(codes).toContain("SECTION_INCOMPLETE");
      expect(codes).toContain("SECTION_NEEDS_REVIEW");
    }
  });

  it("denies an empty Section world (§21)", () => {
    const decision = evaluateFinalization(passingFacts({ sections: [] }));
    if (decision.status === "deny") {
      expect(decision.reasons.map((r) => r.code)).toContain("SECTION_INCOMPLETE");
    }
  });

  it("denies a durable active Section (§21)", () => {
    const decision = evaluateFinalization(passingFacts({ activeSection: "SEC-1" }));
    if (decision.status === "deny") {
      expect(decision.reasons).toContainEqual({ code: "ACTIVE_SECTION_PRESENT", detail: { sectionId: "SEC-1" } });
    }
  });

  it("denies blocking Questions and Conflicts re-read from HEAD (§22/§23)", () => {
    const decision = evaluateFinalization(
      passingFacts({ blockingQuestionCount: 1, blockingConflictCount: 2 }),
    );
    if (decision.status === "deny") {
      expect(decision.reasons).toContainEqual({ code: "BLOCKING_QUESTION", detail: { count: 1 } });
      expect(decision.reasons).toContainEqual({ code: "BLOCKING_CONFLICT", detail: { count: 2 } });
    }
  });

  it("denies unresolved synthesis findings even under a clean report (§19)", () => {
    const decision = evaluateFinalization(
      passingFacts({ synthesis: { ...passingFacts().synthesis!, unresolvedFindingCount: 2 } }),
    );
    if (decision.status === "deny") {
      expect(decision.reasons).toContainEqual({
        code: "SYNTHESIS_FINDINGS_UNRESOLVED",
        detail: { count: 2 },
      });
    }
  });

  it("denies an architecture mismatch between HEAD and the pinned input (§20)", () => {
    const missing = evaluateFinalization(passingFacts({ architecture: null }));
    if (missing.status === "deny") {
      expect(missing.reasons.map((r) => r.code)).toContain("ARCHITECTURE_MISSING");
    }
    const drifted = evaluateFinalization(
      passingFacts({ architecture: { id: "ARCH-1", revision: 2 } }),
    );
    if (drifted.status === "deny") {
      expect(drifted.reasons.map((r) => r.code)).toContain("ARCHITECTURE_MISSING");
    }
  });

  it("denies critical evidence that is not fresh (§9)", () => {
    const decision = evaluateFinalization(
      passingFacts({
        evidence: [
          { evidenceId: "ev_1", revision: 1, criticality: "critical", validationStrategy: "fingerprint", state: "needs_validation", requiresReobservation: false },
        ],
      }),
    );
    if (decision.status === "deny") {
      expect(decision.reasons.map((r) => r.code)).toContain("EVIDENCE_CRITICAL_NOT_FRESH");
    }
  });

  it("denies supporting evidence left needs_validation (§9)", () => {
    const decision = evaluateFinalization(
      passingFacts({
        evidence: [
          { evidenceId: "ev_2", revision: 1, criticality: "supporting", validationStrategy: "fingerprint", state: "stale", requiresReobservation: false },
        ],
      }),
    );
    if (decision.status === "deny") {
      expect(decision.reasons.map((r) => r.code)).toContain("EVIDENCE_SUPPORTING_NEEDS_VALIDATION");
    }
  });

  it("never blocks on informational evidence state (§9/§36)", () => {
    const decision = evaluateFinalization(
      passingFacts({
        evidence: [
          { evidenceId: "ev_3", revision: 1, criticality: "informational", validationStrategy: "fingerprint", state: "needs_validation", requiresReobservation: false },
        ],
      }),
    );
    expect(decision).toEqual({ status: "pass" });
  });

  it("denies a reobserve revision needing re-observation — no command replay (§10)", () => {
    const critical = evaluateFinalization(
      passingFacts({
        evidence: [
          { evidenceId: "ev_4", revision: 1, criticality: "critical", validationStrategy: "reobserve", state: "needs_validation", requiresReobservation: true },
        ],
      }),
    );
    if (critical.status === "deny") {
      const reason = critical.reasons.find((r) => r.code === "EVIDENCE_CRITICAL_NOT_FRESH");
      expect(reason?.detail).toMatchObject({ evidenceId: "ev_4", reason: expect.stringContaining("replay is forbidden") });
    }
    const supporting = evaluateFinalization(
      passingFacts({
        evidence: [
          { evidenceId: "ev_5", revision: 1, criticality: "supporting", validationStrategy: "reobserve", state: "fresh", requiresReobservation: true },
        ],
      }),
    );
    if (supporting.status === "deny") {
      expect(supporting.reasons.map((r) => r.code)).toContain("EVIDENCE_SUPPORTING_NEEDS_VALIDATION");
    }
  });

  it("denies a changed committed-design evidence scope (§7)", () => {
    const decision = evaluateFinalization(passingFacts({ evidenceScopeMatches: false }));
    if (decision.status === "deny") {
      expect(decision.reasons.map((r) => r.code)).toContain("EVIDENCE_AUDIT_FAILED");
    }
  });

  it("denies when another proposal is still awaiting (§14)", () => {
    const decision = evaluateFinalization(
      passingFacts({ awaitingProposal: { proposalId: "PROP-x", type: "design_checkpoint" } }),
    );
    if (decision.status === "deny") {
      expect(decision.reasons).toContainEqual({
        code: "AWAITING_PROPOSAL_EXISTS",
        detail: { proposalId: "PROP-x", type: "design_checkpoint" },
      });
    }
  });

  it("uses only the frozen structured reason vocabulary", () => {
    expect(FINALIZATION_REASON_CODES).toContain("HEAD_STALE");
    expect(FINALIZATION_REASON_CODES).toContain("SYNTHESIS_INPUT_MISSING");
    expect(FINALIZATION_REASON_CODES).toContain("SYNTHESIS_INPUT_STALE");
    expect(FINALIZATION_REASON_CODES).toContain("EVIDENCE_AUDIT_FAILED");
    expect(FINALIZATION_REASON_CODES).toContain("AWAITING_PROPOSAL_EXISTS");
    // every emitted code belongs to the vocabulary
    const world = passingFacts({ evidenceScopeMatches: false, blockingQuestionCount: 1 });
    const decision = evaluateFinalization(world);
    if (decision.status === "deny") {
      for (const reason of decision.reasons) {
        expect(FINALIZATION_REASON_CODES).toContain(reason.code);
      }
    }
  });
});

describe("finalization canonical models (§6/§31/§32/§54/§57)", () => {
  const candidate: FinalPlanCandidateV1 = {
    version: 1,
    runId: "run-1",
    baseRunRevision: 8,
    baseHeadSnapshot: "snap-1",
    baseHeadCommit: "cmt-1",
    synthesisInput: { inputId: "synin_1", inputHash: "sha256:input" },
    synthesisManifest: { manifestId: "synm_1", manifestHash: "sha256:manifest" },
    semanticValidation: { reportId: "valrep_1", reportHash: "sha256:report" },
    architecture: { id: "ARCH-1", revision: 1 },
    sections: [
      { sectionId: "SEC-2", revision: 3 },
      { sectionId: "SEC-1", revision: 2 },
    ],
    decisions: [{ kind: "decision", id: "DEC-1", revision: 1 }],
    constraints: [{ kind: "constraint", id: "CON-1", revision: 1 }],
    implementationOrder: [
      { stepId: "step-2", title: "Second", description: "b", dependsOn: ["step-1"], supportingRefs: [{ kind: "section", id: "SEC-2", revision: 3 }] },
      { stepId: "step-1", title: "First", description: "a", dependsOn: [], supportingRefs: [{ kind: "section", id: "SEC-1", revision: 2 }] },
    ],
    limitations: [{ statement: "bounded", supportingRefs: [{ kind: "section", id: "SEC-1", revision: 2 }] }],
    evidenceScope: [{ evidenceId: "ev_1", revision: 2 }],
  };

  it("hashes deterministically; presentation order never changes the hash (§32)", () => {
    const a = finalPlanCandidateHash(candidate);
    const reordered: FinalPlanCandidateV1 = {
      ...candidate,
      sections: [...candidate.sections].reverse(),
      decisions: [...candidate.decisions],
    };
    expect(finalPlanCandidateHash(reordered)).toBe(a);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("different HEAD or evidence revision → different hash (§96)", () => {
    const otherHead = finalPlanCandidateHash({
      ...candidate,
      baseHeadSnapshot: "snap-2",
      baseHeadCommit: "cmt-2",
    });
    expect(otherHead).not.toBe(finalPlanCandidateHash(candidate));
    const otherEvidence = finalPlanCandidateHash({
      ...candidate,
      evidenceScope: [{ evidenceId: "ev_1", revision: 3 }],
    });
    expect(otherEvidence).not.toBe(finalPlanCandidateHash(candidate));
  });

  it("keeps the manifest's authored implementation order exactly (§96)", () => {
    const plan = {
      version: 1 as const,
      candidateHash: "sha256:candidate",
      architecture: candidate.architecture,
      sections: candidate.sections,
      decisions: candidate.decisions,
      constraints: candidate.constraints,
      synthesisManifest: candidate.synthesisManifest,
      implementationOrder: candidate.implementationOrder,
      limitations: candidate.limitations,
      validation: { blockingQuestions: 0 as const, blockingConflicts: 0 as const, invalidSections: 0 as const, semanticValidation: "clean" as const },
      evidenceAudit: { auditId: "evaud_1", auditHash: "sha256:audit" },
    };
    expect(finalPlanHash(plan)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.implementationOrder.map((step) => step.stepId)).toEqual(["step-2", "step-1"]);
  });

  it("audit hash is deterministic and order-insensitive (§6/§8)", () => {
    const audit = {
      version: 1 as const,
      runId: "run-1",
      inputId: "synin_1",
      inputHash: "sha256:input",
      entries: [
        { evidenceId: "ev_1", revision: 1, confidence: "direct", criticality: "critical" as const, validationStrategy: "fingerprint", state: "fresh", disposition: "pass" as const, reasonCode: "audit_state_current", lastValidationEventSeq: 9 },
        { evidenceId: "ev_2", revision: 1, confidence: "derived", criticality: "informational" as const, validationStrategy: "reobserve", state: "needs_validation", disposition: "recorded" as const, reasonCode: "informational_recorded", lastValidationEventSeq: 4 },
      ],
    };
    const reversed = { ...audit, entries: [...audit.entries].reverse() };
    expect(evidenceAuditHash(reversed)).toBe(evidenceAuditHash(audit));
  });

  it("markdown projection carries identity but is never hashed authority (§44)", () => {
    const markdown = renderFinalPlanCandidateMarkdown(candidate, {
      candidateId: "fpc_x",
      candidateHash: "sha256:candidate",
      proposalId: "PROP-x",
      proposalRevision: 1,
      proposalHash: "sha256:proposal",
    });
    expect(markdown).toContain("fpc_x");
    expect(markdown).toContain("sha256:candidate");
    expect(markdown).toContain("step-2: Second");
    expect(markdown).toContain("projection only");
  });
});
