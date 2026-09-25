/**
 * Deterministic status rendering — spec §9 of the Phase 1 brief / §14 L1 of
 * the frozen architecture.
 *
 * Status is rendered from structured state only. It is never model-generated
 * prose, so `/ultra-plan status` (or any UI) can rely on byte-stable output
 * for identical state.
 */
import type { Architecture, PlanningRun, Section } from "../core/types.js";

export interface StatusDetails {
  /** Approval status of the committed Architecture artifact, if any. */
  architectureStatus?: Architecture["status"];
  /** How many of the run's sections are approved (resolved from the store). */
  approvedSections?: number;
  /**
   * Phase 2E1: the committed Section root under run.activeWork, resolved from
   * the store. Detail-stage runs render the focused section's workflow state
   * (root status, revision pointer, validation) deterministically from it.
   */
  activeSection?: Section;
  /**
   * Phase 2E2 §36: deterministic completion state of the checkpointed active
   * Section — "ready", or "blocked" with the first derivable reason.
   */
  completion?: { state: "ready" | "blocked"; reason?: string };
  /**
   * Phase 2F §47 + Phase 2G §57: the synthesis block — latest frozen input /
   * latest saved manifest / current semantic-validation state, resolved from
   * the store. Never renders "Final: ready" (finalization is a later phase).
   */
  synthesis?: {
    input?: { id: string; baseSnapshot: string; hash: string; stale?: boolean };
    manifest?: { id: string; revision: number; hash: string };
    validation?: {
      running?: boolean;
      report?: { id: string; result: "clean" | "findings"; findings: number };
    };
    /**
     * Phase 2H §57: the deterministic finalization state — unavailable
     * (before a current clean report) / not run / blocked (with the exact
     * machine blockers) / passed (with the candidate ref + its currency).
     * NEVER "Final approved" or "Ready for Build" — a candidate is not user
     * authorization and the stage remains synthesis (2H §76).
     */
    finalization?: {
      state: "unavailable" | "not_run" | "blocked" | "passed";
      audit?: { id: string; result: "pass" | "blocked" };
      blockers?: readonly string[];
      candidate?: { ref: string; current: boolean };
    };
    /**
     * Phase 2I §85: the current final_plan Proposal (ready/awaiting) that
     * binds the current candidate, resolved from the store — "none" otherwise.
     */
    finalProposal?: { ref: string; status: "ready" | "awaiting_approval" };
  };
  /**
   * Phase 2I §85: the committed FinalPlan of a final-stage run (status always
   * "approved" — the Proposal represents the pending plan, the committed
   * record is the approved one). Handoff is rendered as PENDING until the
   * Phase 2J runtime handoff exists; never "Build started"/"Run completed".
   */
  finalPlan?: { ref: string; status: "approved" };
  /**
   * Phase 2J §66-§70: the runtime handoff/delivery state of a final-stage
   * run, resolved from the durable handoff + delivery records. Each state
   * renders exactly its brief line set — never claiming Build started unless
   * delivery is confirmed, and `completed` renders the run as terminal.
   */
  handoff?: {
    ref?: string;
    state: "not_prepared" | "prepared" | "dispatching" | "delivered";
    lifecycle: "handoff_pending" | "completed";
  };
}

function describeArchitecture(status: Architecture["status"], revision: number): string {
  switch (status) {
    case "approved":
      return `ARCH@${revision} approved`;
    case "awaiting_approval":
      return `ARCH@${revision} awaiting approval`;
    case "superseded":
      return `ARCH@${revision} superseded`;
    case "draft":
      return `ARCH@${revision} draft`;
  }
}

export function renderStatus(run: PlanningRun, details?: StatusDetails): string {
  // Architecture line (Phase 2C §30): deterministic from run state + the
  // committed artifact's real status. "designing" = in the architecture stage
  // with no committed Architecture yet; a committed Architecture is always
  // some concrete ARCH@n revision.
  const architecture = run.architecture
    ? describeArchitecture(details?.architectureStatus ?? "approved", run.architecture.revision)
    : run.stage === "architecture"
      ? "designing"
      : "not started";

  const totalSections = run.sections.length;
  const approvedSections = details?.approvedSections ?? 0;
  // Phase 2D §35: detail with no committed DAG is "not decomposed" — a
  // structured substate, not model prose. Phase 2E2 §36: a fully approved DAG
  // renders "all approved" (synthesis entry). Other stages keep the count.
  const sections =
    totalSections === 0
      ? run.stage === "detail"
        ? "not decomposed"
        : "0"
      : approvedSections === totalSections
        ? "all approved"
        : `${totalSections} (${approvedSections} approved)`;
  const activeWork = run.activeWork?.type === "section" ? String(run.activeWork.id) : "none";

  // Phase 2E1 §33: the focused Section's workflow state in detail — root
  // status, exact revision pointer, validation. "Revision: none" before the
  // first checkpoint; afterwards `SEC-###@n approved checkpoint`. Completion
  // is never rendered in Phase 2E1 (a checkpoint is not a completion).
  const activeSection = run.stage === "detail" && run.activeWork?.type === "section" ? details?.activeSection : undefined;
  const activeSectionLines = activeSection
    ? [
        `Section: ${activeSection.id} ${activeSection.status}`,
        `Revision: ${
          activeSection.currentRevision !== undefined
            ? `${activeSection.id}@${activeSection.currentRevision} approved checkpoint`
            : "none"
        }`,
        `Validation: ${activeSection.validation}`,
        // Phase 2E2 §36: the checkpointed Section's completion state —
        // "ready", or "blocked" with the first deterministic reason. Never
        // rendered for a revisionless Section (no completion exists there).
        ...(details?.completion && activeSection.currentRevision !== undefined
          ? [
              `Completion: ${details.completion.state}`,
              ...(details.completion.reason ? [`Reason: ${details.completion.reason}`] : []),
            ]
          : []),
      ]
    : [];

  const blockingQuestions = run.openQuestions.filter(
    (q) => q.blocking && q.status === "open",
  ).length;
  const blockingConflicts = run.conflicts.filter(
    (c) => c.severity === "blocking" && c.status === "open",
  ).length;

  // Phase 2F §47 + Phase 2G §57 + Phase 2H §57: the synthesis block renders
  // exactly the validation states — not run / running / findings / clean —
  // plus the deterministic finalization states. A stale input (HEAD moved
  // past its base) is marked deterministically. Finalization is NEVER claimed
  // as user authorization ("Final approved" and "Ready for Build" do not
  // exist in Phase 2H) and the stage remains synthesis (2H §76).
  const validation = details?.synthesis?.validation;
  const finalization = details?.synthesis?.finalization;
  const finalProposal = details?.synthesis?.finalProposal;
  // Phase 2I §85: proposal-ready/awaiting states. "Final approval" describes
  // the REQUEST state only — it never claims authorization that has not been
  // given, and it never implies Build ("Build handoff: pending" is the only
  // handoff phrasing in Phase 2I).
  const finalApprovalLine =
    finalProposal === undefined
      ? "Final approval: not requested"
      : finalProposal.status === "ready"
        ? "Final approval: ready"
        : "Final approval: awaiting user";
  const finalProposalLine = finalProposal ? `Final proposal: ${finalProposal.ref}` : "Final proposal: none";
  const finalizationLines =
    run.stage !== "synthesis"
      ? []
      : !finalization
        ? ["Finalization: unavailable"]
        : finalization.state === "unavailable"
          ? ["Finalization: unavailable"]
          : finalization.state === "not_run"
            ? [
                "Finalization: not run",
                ...(finalization.audit ? [`Evidence audit: ${finalization.audit.id} ${finalization.audit.result}`] : []),
                ...(finalization.candidate ? [`Final candidate: ${finalization.candidate.ref} (${finalization.candidate.current ? "current" : "stale"})`] : []),
              ]
            : finalization.state === "blocked"
              ? [
                  "Finalization: blocked",
                  `Evidence audit: ${finalization.audit?.id ?? "AUD-???"} ${finalization.audit?.result ?? "blocked"}`,
                  `Blockers: ${(finalization.blockers ?? []).join(", ") || "none"}`,
                ]
              : [
                  "Finalization: passed",
                  `Evidence audit: ${finalization.audit?.id ?? "AUD-???"} pass`,
                  `Final candidate: ${finalization.candidate?.ref ?? "FPC-???"}${finalization.candidate?.current ? " current" : ""}`,
                  finalProposalLine,
                  finalApprovalLine,
                  "Stage: synthesis",
                ];
  const synthesisLines =
    run.stage === "synthesis"
      ? [
          `Synthesis input: ${details?.synthesis?.input ? details.synthesis.input.id : "not frozen"}`,
          ...(details?.synthesis?.input
            ? [
                `Base: ${details.synthesis.input.baseSnapshot}`,
                ...(details.synthesis.input.stale
                  ? [`Input status: stale (HEAD moved past ${details.synthesis.input.baseSnapshot})`]
                  : []),
              ]
            : []),
          `Synthesis manifest: ${details?.synthesis?.manifest ? `${details.synthesis.manifest.id}@${details.synthesis.manifest.revision}` : "none"}`,
          ...(details?.synthesis?.manifest
            ? [
                "Manifest status: structurally valid",
                ...(validation
                  ? [
                      ...(validation.report
                        ? [
                            `Semantic validation: ${validation.report.result}`,
                            `Validation report: ${validation.report.id}`,
                            ...(validation.report.result === "findings"
                              ? [`Findings: ${validation.report.findings}`, "Reopen: available"]
                              : []),
                          ]
                        : validation.running
                          ? ["Semantic validation: running"]
                          : ["Semantic validation: not run"]),
                    ]
                  : ["Semantic validation: not run"]),
              ]
            : []),
          ...finalizationLines,
        ]
      : [];
  // Phase 2J §66-§70: the final-stage render — per-state handoff lines and
  // the completed terminal block. NEVER claims Build started before a
  // confirmed delivery, and never renders a completed run as active.
  const finalStageLines =
    run.stage === "final"
      ? [
          `Final Plan: ${details?.finalPlan ? `${details.finalPlan.ref} ${details.finalPlan.status}` : "FINAL-???"}`,
          ...(details?.handoff
            ? details.handoff.lifecycle === "completed"
              ? [
                  `Execution handoff: ${details.handoff.ref ?? "HANDOFF-???"} delivered`,
                  "Build: handoff complete",
                ]
              : details.handoff.state === "not_prepared"
                ? ["Execution handoff: not prepared", "Build: not started"]
                : details.handoff.state === "prepared"
                  ? [`Execution handoff: ${details.handoff.ref ?? "HANDOFF-???"} prepared`, "Build transition: pending"]
                  : details.handoff.state === "dispatching"
                    ? [`Execution handoff: ${details.handoff.ref ?? "HANDOFF-???"} dispatching`, "Build delivery: awaiting confirmation"]
                    : [
                        `Execution handoff: ${details.handoff.ref ?? "HANDOFF-???"} delivered`,
                        "Build delivery: confirmed",
                        "Run completion: pending",
                      ]
            : ["Build handoff: pending"]),
        ]
      : [];

  return [
    "Ultra Plan",
    "",
    `Plan: ${run.id}`,
    `Lifecycle: ${run.lifecycle}`,
    `Stage: ${run.stage}`,
    `Session: ${run.sessionID}`,
    "",
    `Architecture: ${architecture}`,
    `Sections: ${sections}`,
    `Active work: ${activeWork}`,
    ...activeSectionLines,
    ...synthesisLines,
    ...finalStageLines,
    `Open blocking questions: ${blockingQuestions}`,
    `Blocking conflicts: ${blockingConflicts}`,
  ].join("\n");
}

/** Deterministic status for a session without any run. */
export function renderNoRunStatus(sessionID: string): string {
  return [
    "Ultra Plan",
    "",
    `No PlanningRun for session ${sessionID}.`,
    "Invoke /ultra-plan to start one.",
  ].join("\n");
}
