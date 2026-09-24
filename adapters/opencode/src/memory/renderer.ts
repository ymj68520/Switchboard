/**
 * Deterministic status rendering — spec §9 of the Phase 1 brief / §14 L1 of
 * the frozen architecture.
 *
 * Status is rendered from structured state only. It is never model-generated
 * prose, so `/ultra-plan status` (or any UI) can rely on byte-stable output
 * for identical state.
 */
import type { Architecture, PlanningRun } from "../core/types.js";

export interface StatusDetails {
  /** Approval status of the committed Architecture artifact, if any. */
  architectureStatus?: Architecture["status"];
  /** How many of the run's sections are approved (resolved from the store). */
  approvedSections?: number;
}

function describeArchitecture(status: Architecture["status"], revision: number): string {
  switch (status) {
    case "approved":
      return `approved @${revision}`;
    case "awaiting_approval":
      return `awaiting approval @${revision}`;
    case "superseded":
      return `superseded @${revision}`;
    case "draft":
      return `draft @${revision}`;
  }
}

export function renderStatus(run: PlanningRun, details?: StatusDetails): string {
  const architecture = run.architecture
    ? describeArchitecture(details?.architectureStatus ?? "draft", run.architecture.revision)
    : "not started";

  const totalSections = run.sections.length;
  const approvedSections = details?.approvedSections ?? 0;
  const sections =
    totalSections === 0 ? "0" : `${totalSections} (${approvedSections} approved)`;

  const blockingQuestions = run.openQuestions.filter(
    (q) => q.blocking && q.status === "open",
  ).length;
  const blockingConflicts = run.conflicts.filter(
    (c) => c.severity === "blocking" && c.status === "open",
  ).length;

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
