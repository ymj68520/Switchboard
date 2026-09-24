import { describe, expect, it } from "vitest";

import { checkFinalization, type FinalizationFailure } from "../src/core/invariants.js";
import { ConflictIDs, EvidenceIDs, QuestionIDs, SectionIDs } from "../src/core/ids.js";
import type { Conflict, OpenQuestion, Section } from "../src/core/types.js";
import { approvedArchitecture, evidence, finalizationInput, section } from "./helpers.js";

describe("finalization predicate", () => {
  it("accepts a fully approved, valid, unblocked, evidence-fresh plan", () => {
    const input = finalizationInput();
    expect(checkFinalization(input)).toEqual({ ok: true, failures: [] });
  });

  it("reports every failure in deterministic order", () => {
    const input = finalizationInput({
      architecture: undefined,
      sections: [
        section({ id: SectionIDs.from(1), status: "pending", validation: "needs_review" }),
      ],
      openQuestions: [
        {
          id: QuestionIDs.from(1),
          question: "Which storage backend?",
          blocking: true,
          scope: { id: "ARCH", revision: 1 },
          status: "open",
        },
      ],
      conflicts: [
        {
          id: ConflictIDs.from(1),
          type: "decision",
          refs: [],
          description: "Contradictory decisions",
          severity: "blocking",
          status: "open",
        },
      ],
      evidence: [evidence({ id: EvidenceIDs.from(1), criticality: "critical", freshness: "stale" })],
    });

    expect(checkFinalization(input).failures).toEqual([
      "architecture_not_approved",
      "sections_not_approved",
      "sections_not_valid",
      "blocking_questions_open",
      "blocking_conflicts_open",
      "critical_evidence_not_fresh",
    ] satisfies FinalizationFailure[]);
  });

  it("blocks on open blocking questions but ignores non-blocking ones", () => {
    const question: OpenQuestion = {
      id: QuestionIDs.from(7),
      question: "Canonical memory location?",
      blocking: true,
      scope: { id: SectionIDs.from(3) },
      status: "open",
    };

    const blocked = finalizationInput({ openQuestions: [question] });
    expect(checkFinalization(blocked)).toEqual({
      ok: false,
      failures: ["blocking_questions_open"],
    });

    // Non-blocking open questions do not prevent finalization.
    expect(
      checkFinalization(finalizationInput({ openQuestions: [{ ...question, blocking: false }] })).ok,
    ).toBe(true);

    // Resolved blocking questions do not prevent finalization.
    const resolved = finalizationInput({
      openQuestions: [{ ...question, status: "resolved", resolution: "use plugin storage" }],
    });
    expect(checkFinalization(resolved).ok).toBe(true);
  });

  it("blocks on open blocking conflicts but ignores warnings and resolved conflicts", () => {
    const conflict: Conflict = {
      id: ConflictIDs.from(1),
      type: "decision",
      refs: [],
      description: "Two approved decisions contradict each other",
      severity: "blocking",
      status: "open",
    };

    expect(checkFinalization(finalizationInput({ conflicts: [conflict] }))).toEqual({
      ok: false,
      failures: ["blocking_conflicts_open"],
    });

    expect(
      checkFinalization(finalizationInput({ conflicts: [{ ...conflict, severity: "warning" }] })).ok,
    ).toBe(true);
    expect(
      checkFinalization(finalizationInput({ conflicts: [{ ...conflict, status: "resolved" }] })).ok,
    ).toBe(true);
  });

  it("blocks when critical evidence is not fresh, but not for supporting evidence", () => {
    const staleCritical = evidence({
      id: EvidenceIDs.from(101),
      criticality: "critical",
      freshness: "needs_validation",
    });

    expect(checkFinalization(finalizationInput({ evidence: [staleCritical] }))).toEqual({
      ok: false,
      failures: ["critical_evidence_not_fresh"],
    });

    // Invalidated critical evidence also blocks even if freshness field lags.
    const invalidated = evidence({
      id: EvidenceIDs.from(102),
      criticality: "critical",
      status: "invalidated",
    });
    expect(checkFinalization(finalizationInput({ evidence: [invalidated] })).failures).toContain(
      "critical_evidence_not_fresh",
    );

    // Fresh critical evidence passes...
    const freshCritical = evidence({ id: EvidenceIDs.from(103), criticality: "critical" });
    expect(checkFinalization(finalizationInput({ evidence: [freshCritical] })).ok).toBe(true);

    // ...while stale merely-supporting evidence does not block.
    const staleSupporting = evidence({
      id: EvidenceIDs.from(104),
      criticality: "supporting",
      freshness: "stale",
      status: "stale",
    });
    expect(checkFinalization(finalizationInput({ evidence: [staleSupporting] })).ok).toBe(true);
  });

  it("requires an approved architecture and approved+valid sections", () => {
    const noArchitecture = finalizationInput({ architecture: undefined });
    expect(checkFinalization(noArchitecture).failures).toEqual(["architecture_not_approved"]);

    const draftArchitecture = finalizationInput({
      architecture: { ...approvedArchitecture(), status: "draft" },
    });
    expect(checkFinalization(draftArchitecture).failures).toEqual(["architecture_not_approved"]);

    const pending: Section = section({ id: SectionIDs.from(1) });
    const pendingSections = finalizationInput({ sections: [pending] });
    expect(checkFinalization(pendingSections).failures).toContain("sections_not_approved");

    const invalid: Section = section({
      id: SectionIDs.from(1),
      status: "approved",
      validation: "needs_review",
    });
    const invalidSections = finalizationInput({ sections: [invalid] });
    expect(checkFinalization(invalidSections).failures).toEqual(["sections_not_valid"]);

    // Zero sections is not a plan: decomposition must have happened (spec §6).
    const noSections = finalizationInput({ sections: [] });
    expect(checkFinalization(noSections).failures).toContain("sections_not_approved");
  });
});
