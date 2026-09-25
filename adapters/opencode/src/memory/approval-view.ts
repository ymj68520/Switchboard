/**
 * Deterministic approval presentation (Phase 2C brief §18/§19).
 *
 * The view presented to the user for an approval decision is a PURE PROJECTION
 * of the frozen Proposal: it is computed from the proposal's structured fields
 * at presentation time and is never model-generated prose. Because the
 * projection is a pure function of the exact hashed content, what the user
 * saw and what was committed cannot diverge — the Proposal remains the single
 * authoritative payload.
 */

import type { ApprovedSectionRevision, Proposal, ProposalChange } from "../transaction/types.js";

/**
 * Full deterministic rendering of an approved SectionRevision checkpoint
 * (Phase 2E1 §24): the user approves full design + compact projection +
 * contract as ONE payload, so the view must show all three. No
 * post-freeze model summarization — this is a pure projection of hashed
 * content.
 */
function renderSectionRevisionBody(
  revision: ApprovedSectionRevision,
  supersedes?: { id: string; revision: number },
): string[] {
  const contract = revision.projection.contract;
  const lines = [
    supersedes
      ? `AMEND SECTION ${revision.sectionID}@${revision.revision} (supersedes ${supersedes.id}@${supersedes.revision})`
      : `ADD SECTION REVISION ${revision.sectionID}@${revision.revision} (first checkpoint)`,
    `  Problem: ${revision.problem}`,
    `  Design: ${revision.design}`,
  ];
  if (revision.interfaces.length > 0) {
    lines.push("  Interfaces:");
    for (const spec of revision.interfaces) {
      lines.push(`    ${spec.name}${spec.signature ? ` (${spec.signature})` : ""}: ${spec.description}`);
    }
  }
  if (revision.invariants.length > 0) {
    lines.push(`  Invariants: ${revision.invariants.join("; ")}`);
  }
  if (revision.failureModes.length > 0) {
    lines.push("  Failure modes:");
    for (const mode of revision.failureModes) {
      lines.push(`    ${mode.description}${mode.mitigation ? ` (mitigation: ${mode.mitigation})` : ""}`);
    }
  }
  if (revision.dependencies.length > 0) {
    lines.push("  Dependency bindings:");
    for (const dep of revision.dependencies) {
      lines.push(
        dep.contractRevision !== undefined
          ? `    ${dep.sectionID}@${dep.contractRevision} contract`
          : `    ${dep.sectionID} unresolved (no contract yet)`,
      );
    }
  }
  if (revision.decisions.length > 0) {
    lines.push(`  Decisions: ${revision.decisions.join(", ")}`);
  }
  if (revision.openQuestions.length > 0) {
    lines.push(`  Open questions: ${revision.openQuestions.join(", ")}`);
  }
  if (revision.impacts.length > 0) {
    lines.push(`  Impacts: ${revision.impacts.join(", ")}`);
  }
  lines.push(`  Compact projection: ${revision.projection.compact}`);
  lines.push("  Contract:");
  lines.push(`    provides: ${contract.provides.join(", ") || "—"}`);
  lines.push(`    requires: ${contract.requires.join(", ") || "—"}`);
  lines.push(`    invariants: ${contract.invariants.join("; ") || "—"}`);
  lines.push(`    interfaces: ${contract.interfaces.map((ref) => ref.name).join(", ") || "—"}`);
  lines.push(`    decisions: ${contract.decisions.map((ref) => `${ref.id}@${ref.revision}`).join(", ") || "—"}`);
  return lines;
}

function renderChange(change: ProposalChange): string[] {
  switch (change.kind) {
    case "add_architecture": {
      const a = change.architecture;
      const lines = [
        `ADD ARCHITECTURE ${a.id}@${a.revision} (status ${a.status})`,
        `  Summary: ${a.summary}`,
      ];
      if (a.components.length > 0) {
        lines.push(`  Components: ${a.components.map((c) => `${c.name} — ${c.summary}`).join("; ")}`);
      }
      if (a.boundaries.length > 0) {
        lines.push(`  Boundaries: ${a.boundaries.map((b) => `${b.name} — ${b.description}`).join("; ")}`);
      }
      if (a.dataFlows.length > 0) {
        lines.push(`  Data flows: ${a.dataFlows.map((f) => `${f.from} -> ${f.to} (${f.description})`).join("; ")}`);
      }
      if (a.principles.length > 0) {
        lines.push(`  Principles: ${a.principles.map((p) => p.statement).join("; ")}`);
      }
      if (a.basedOn.length > 0) {
        lines.push(`  Based on decisions: ${a.basedOn.join(", ")}`);
      }
      if (a.unresolved.length > 0) {
        lines.push(
          `  Unresolved questions: ${a.unresolved.map((q) => `${q.id}${q.blocking ? " (blocking)" : ""}`).join(", ")}`,
        );
      }
      return lines;
    }
    case "complete_architecture":
      return [`COMPLETE ARCHITECTURE ${change.target.id}@${change.target.revision} (transitions stage architecture -> detail)`];
    case "add_decision":
      return [`ADD DECISION ${change.decision.id}@${change.decision.revision}: ${change.decision.title} — ${change.decision.statement}`];
    case "amend_decision":
      return [
        `AMEND DECISION ${change.decision.id}@${change.decision.revision} (supersedes ${change.supersedes.id}@${change.supersedes.revision}): ${change.decision.title} — ${change.decision.statement}`,
      ];
    case "add_section_revision":
      return renderSectionRevisionBody(change.revision);
    case "amend_section":
      return renderSectionRevisionBody(change.revision, change.supersedes);
    case "add_constraint":
      return [`ADD CONSTRAINT ${change.constraint.id} (${change.constraint.severity}, source ${change.constraint.source}): ${change.constraint.statement}`];
    case "add_section": {
      const s = change.section;
      const deps = s.dependencies.length > 0 ? s.dependencies.join(", ") : "—";
      return [
        `ADD SECTION ${s.id} — ${s.title}`,
        `  objective: ${s.objective}`,
        `  depends on: ${deps}`,
      ];
    }
    case "select_initial_section":
      return [`SELECT INITIAL SECTION ${change.section.id}`];
    case "raise_question":
      return [`RAISE QUESTION ${change.question.id}${change.question.blocking ? " (blocking)" : ""}: ${change.question.question}`];
    case "resolve_question":
      return [`RESOLVE QUESTION ${change.resolution.questionID}: ${change.resolution.resolution}`];
    case "complete_section": {
      // Phase 2E2 §33: a completion approves NO design content — the view
      // communicates what completion means (the exact revision becomes a
      // closed dependency; status/dependency/contract facts are the
      // Harness-captured deterministic projection frozen into the change).
      const target = change.target;
      const lines = [`SECTION COMPLETION ${target.id} (active -> approved)`];
      if (change.completion) {
        lines.push(`  Section: ${target.id} ${change.completion.sectionTitle}`);
      }
      lines.push(`  Completing revision: ${target.id}@${target.revision}`);
      if (change.completion) {
        lines.push(`  Status: active -> approved`);
        lines.push(`  Validation: ${change.completion.validation}`);
        lines.push(
          `  Dependencies: ${
            change.completion.dependencies.map((dep) => `${dep.id} ${dep.status}`).join(", ") || "—"
          }`,
        );
        lines.push(`  Contract: ${target.id}@${target.revision} (immutable, unchanged by completion)`);
      }
      return lines;
    }
    case "reopen_section": {
      // Phase 2G §43: the SECTION REOPEN view — a pure projection of the
      // frozen change (target revision, report binding, findings, effect).
      // No model-generated summary after the freeze.
      const target = change.target;
      const lines = [
        "SECTION REOPEN",
        `  Section: ${target.id} ${change.reopen.sectionTitle}`,
        `  Current approved revision: ${target.id}@${target.revision} (immutable — reopen creates no new revision)`,
      ];
      if (change.reason.type === "semantic_validation") {
        lines.push(`  Semantic validation report: ${change.reason.reportID}`);
        lines.push(`  hash: ${change.reason.reportHash}`);
        lines.push("  Findings:");
        for (const finding of change.reopen.findings ?? change.reason.findingIDs.map((id) => ({ id, category: "", statement: "" }))) {
          lines.push(`    ${finding.id}${finding.category ? ` ${finding.category}` : ""}${finding.statement ? ` — ${finding.statement}` : ""}`);
        }
      } else {
        lines.push(`  Reason: dependency_review (validation ${change.reason.validation})`);
      }
      lines.push("  Effect if approved:");
      lines.push("  Section status: approved -> reopened");
      lines.push("  Section validation: -> needs_review");
      if (change.reopen.fromStage === "synthesis") {
        lines.push("  Stage: synthesis -> detail");
      }
      lines.push(`  Active work: ${target.id}`);
      return lines;
    }
    case "add_final_plan": {
      // Phase 2I §45: the FORMAL FINAL APPROVAL view — a pure deterministic
      // projection of the frozen FinalPlan payload (§75: exact plan ref,
      // candidate, base, architecture, sections, order, constraints,
      // limitations, validation/audit identities, effect, proposal hash).
      // No post-freeze model summary.
      const p = change.finalPlan;
      return [
        "FINAL PLAN APPROVAL",
        `  Final Plan: ${p.id}@${p.revision}`,
        `  Base: ${p.baseSnapshot.id}`,
        `  Architecture: ARCH@${p.architecture.revision}`,
        "  Sections:",
        ...(p.sections.length > 0 ? p.sections.map((section) => `    ${section.id}@${section.revision}`) : ["    (none)"]),
        "  Implementation Order:",
        ...(p.implementationOrder.length > 0
          ? p.implementationOrder.map((step) => `    ${step.order}. ${step.title} — ${step.description}`)
          : ["    (none)"]),
        "  Constraints:",
        ...(p.constraints.length > 0
          ? p.constraints.map((constraint) => `    [${constraint.severity}] ${constraint.statement}`)
          : ["    (none)"]),
        "  Known Limitations:",
        ...(p.limitations.length > 0 ? p.limitations.map((limitation) => `    - ${limitation.statement}`) : ["    (none)"]),
        `  Semantic Validation: ${p.semanticValidation.reportID} clean`,
        `  Evidence Audit: ${p.evidenceAudit.id} pass`,
        `  Final Candidate: ${p.finalPlanCandidate.id}@${p.finalPlanCandidate.revision} hash ${p.finalPlanCandidate.hash}`,
        "  Effect if approved and current gate still passes:",
        "  - commit immutable FinalPlan",
        "  - stage -> final",
        "  - lifecycle -> handoff_pending",
        "  - Build handoff will NOT run in this phase",
        "  Approval authorizes the Final PlanCommit.",
        "  Runtime Build handoff occurs only from handoff_pending in the next workflow.",
      ];
    }
  }
}

/** Render the exact approval payload the user is deciding on. */
export function renderProposalForApproval(proposal: Proposal): string {
  const lines: string[] = [
    `Proposal ${proposal.id} — ${proposal.type} (revision ${proposal.revision})`,
    `Title: ${proposal.title}`,
    `Summary: ${proposal.summary}`,
    // Architecture-scoped proposals (Phase 2C/2D) carry an exact ARCH revision.
    ...("revision" in proposal.scope
      ? [`Architecture scope: ARCH@${proposal.scope.revision}`]
      : []),
    `Base snapshot: ${proposal.createdFrom.id}`,
    "Changes:",
  ];
  for (const change of proposal.changes) {
    lines.push(...renderChange(change));
  }
  lines.push(`Approval hash: ${proposal.hash ?? "(not yet hashed)"}`);
  return lines.join("\n");
}
