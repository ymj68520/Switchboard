/**
 * Synthesis entry gate + HEAD-anchored authority payload construction
 * (Phase 2F brief §7/§8).
 *
 * The EXACT HEAD Snapshot (PlanningRun.headSnapshot) is the authority anchor:
 * every exact ref in a SynthesisInput resolves through it, never through
 * conversational recollection or "whatever happens to be latest". The entry
 * gate is a deterministic STRUCTURAL check — deliberately NOT the Final Plan
 * finalization predicate: blocking questions/conflicts do NOT block synthesis
 * (synthesis is allowed to discover and report unresolved problems, brief
 * §8), and no stage transition happens here.
 *
 * Both the controller (freeze request) and the store (in-lock revalidation,
 * cross-instance race safety) run these functions.
 */
import type { PlanStore } from "../memory/store.js";
import { UltraPlanError } from "../core/errors.js";
import type { PlanningRun } from "../core/types.js";
import type { DecisionRef } from "../core/refs.js";
import { DecisionIDs, EvidenceIDs } from "../core/ids.js";
import type { Snapshot } from "../memory/snapshots.js";
import type { SynthesisInputPayload } from "./types.js";

/**
 * Deterministic structural entry preconditions (brief §8). Throws
 * `synthesis_entry_invalid` for run-state failures, `unknown_reference` for
 * missing committed artifacts, `invalid_scope` for HEAD/identity
 * inconsistencies. Never consults blocking questions/conflicts.
 */
export async function assertSynthesisEntryReady(store: PlanStore, run: PlanningRun): Promise<Snapshot> {
  if (run.lifecycle !== "active" || run.stage !== "synthesis") {
    throw new UltraPlanError(
      "synthesis_entry_invalid",
      `Synthesis entry requires an active run in stage=synthesis (run is ${run.lifecycle}/${run.stage})`,
      { lifecycle: run.lifecycle, stage: run.stage },
    );
  }
  if (run.activeWork !== undefined) {
    throw new UltraPlanError(
      "synthesis_entry_invalid",
      `Synthesis entry requires activeWork to be cleared (the final Section completion clears it); run ${run.id} still focuses ${JSON.stringify(run.activeWork)}`,
      { activeWork: run.activeWork },
    );
  }
  if (!run.headSnapshot) {
    throw new UltraPlanError("synthesis_entry_invalid", `Run ${run.id} has no HEAD snapshot`, { planID: run.id });
  }
  const snapshot = await store.getHeadSnapshot(run.id);
  if (!snapshot) {
    throw new UltraPlanError("unknown_reference", `HEAD snapshot ${run.headSnapshot} does not exist`, {
      snapshotID: run.headSnapshot,
    });
  }
  if (snapshot.state.activeWork !== undefined) {
    throw new UltraPlanError(
      "synthesis_entry_invalid",
      `HEAD snapshot ${snapshot.id} still carries a workflow focus; synthesis entry requires the final completion commit`,
      { snapshotID: snapshot.id },
    );
  }
  // Exact Architecture ref from the SNAPSHOT (the authority anchor), which
  // must resolve and be approved.
  const architectureRevision = snapshot.state.architectureRevision;
  if (architectureRevision === undefined) {
    throw new UltraPlanError(
      "synthesis_entry_invalid",
      `HEAD snapshot ${snapshot.id} binds no Architecture; synthesis cannot begin`,
      { snapshotID: snapshot.id },
    );
  }
  const architecture = await store.getArchitecture(run.id, architectureRevision);
  if (!architecture) {
    throw new UltraPlanError(
      "unknown_reference",
      `Architecture ARCH@${architectureRevision} bound by HEAD snapshot ${snapshot.id} does not exist`,
      { revision: architectureRevision },
    );
  }
  if (architecture.status !== "approved") {
    throw new UltraPlanError(
      "synthesis_entry_invalid",
      `Architecture ARCH@${architectureRevision} is ${architecture.status}; synthesis requires the exact approved Architecture`,
      { revision: architectureRevision, status: architecture.status },
    );
  }
  // Every required Section root: present, approved, valid, with a resolvable
  // exact approvedRevision whose canonical contract is stamped with its own
  // identity (brief §8/§9).
  const roots = snapshot.state.sectionRoots ?? [];
  if (roots.length === 0 || run.sections.length === 0) {
    throw new UltraPlanError(
      "synthesis_entry_invalid",
      `Synthesis requires a committed, fully approved Section DAG; run ${run.id} has none`,
      { sections: run.sections.length },
    );
  }
  for (const root of roots) {
    if (root.status !== "approved") {
      throw new UltraPlanError(
        "synthesis_entry_invalid",
        `Section ${root.id} is ${root.status}; synthesis requires every Section approved`,
        { sectionID: root.id, status: root.status },
      );
    }
    if (root.validation !== "valid") {
      throw new UltraPlanError(
        "synthesis_entry_invalid",
        `Section ${root.id} is ${root.validation}; synthesis requires every Section valid`,
        { sectionID: root.id, validation: root.validation },
      );
    }
    if (root.approvedRevision === undefined) {
      throw new UltraPlanError(
        "synthesis_entry_invalid",
        `Section ${root.id} is approved but carries no approvedRevision`,
        { sectionID: root.id },
      );
    }
    // Hostile-drift defense: the live committed Section root must still agree
    // with the HEAD snapshot (legitimate flows keep them in sync — synthesis
    // grants no design mutation).
    const liveRoot = await store.getSection(run.id, root.id);
    if (
      !liveRoot ||
      liveRoot.status !== root.status ||
      liveRoot.validation !== root.validation ||
      liveRoot.approvedRevision !== root.approvedRevision
    ) {
      throw new UltraPlanError(
        "synthesis_entry_invalid",
        `Section ${root.id} has drifted from HEAD snapshot ${snapshot.id} (live ${liveRoot ? `${liveRoot.status}/${liveRoot.validation}@${String(liveRoot.approvedRevision)}` : "missing"})`,
        { sectionID: root.id, snapshotID: snapshot.id },
      );
    }
    const revision = await store.getSectionRevision(run.id, { id: root.id, revision: root.approvedRevision });
    if (!revision) {
      throw new UltraPlanError(
        "unknown_reference",
        `Approved revision ${root.id}@${root.approvedRevision} does not exist`,
        { sectionID: root.id, revision: root.approvedRevision },
      );
    }
    if (
      revision.projection.contract.sectionID !== root.id ||
      revision.projection.contract.revision !== root.approvedRevision
    ) {
      throw new UltraPlanError(
        "invalid_scope",
        `The contract of ${root.id}@${root.approvedRevision} is not stamped with the revision's own identity`,
        { sectionID: root.id, revision: root.approvedRevision },
      );
    }
  }
  return snapshot;
}

/**
 * Freeze-time authority payload construction from the EXACT HEAD Snapshot
 * (brief §7 algorithm). Assumes assertSynthesisEntryReady has passed.
 *
 * - architecture: the snapshot's exact ArchitectureRef;
 * - sections: every snapshot section root (canonical DAG order) bound at its
 *   exact approvedRevision — never "latest" (brief §9);
 * - decisions: the exact committed revisions HEAD represents (snapshot
 *   decisionRevisions is the authority — brief §12), ordered by id;
 * - constraints: frozen copies of the committed constraint records HEAD
 *   binds, in snapshot order (brief §13 — identity-only domain, no invented
 *   revisions);
 * - questions/conflicts: frozen copies of the current OPEN blocker state
 *   (brief §14 — may be unresolved; that is their purpose);
 * - evidence: only what is structurally reachable through
 *   SectionRevision → Decision → Evidence plus Architecture → basedOn →
 *   Decision → Evidence (brief §15), resolved to exact revisions.
 */
export async function buildSynthesisAuthorityPayload(
  store: PlanStore,
  run: PlanningRun,
  snapshot: Snapshot,
): Promise<SynthesisInputPayload> {
  const architectureRevision = snapshot.state.architectureRevision;
  if (architectureRevision === undefined || !run.architecture) {
    throw new UltraPlanError("synthesis_entry_invalid", `Run ${run.id} has no committed Architecture`, {
      planID: run.id,
    });
  }

  const sections = (snapshot.state.sectionRoots ?? []).map((root) => ({
    ref: { id: root.id, revision: root.approvedRevision as number },
    title: root.title,
    dependencies: root.dependencies,
  }));

  // Decisions: HEAD snapshot carries the exact revisions (brief §12); sort by
  // id for a canonical, round-trip-stable order.
  const decisions: DecisionRef[] = Object.entries(snapshot.state.decisionRevisions)
    .map(([id, revision]) => ({ id: DecisionIDs.cast(id), revision }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const ref of decisions) {
    const decision = await store.getDecision(run.id, ref);
    if (!decision) {
      throw new UltraPlanError("unknown_reference", `Decision ${ref.id}@${ref.revision} bound by HEAD does not exist`, {
        decisionID: ref.id,
        revision: ref.revision,
      });
    }
  }

  // Constraints: frozen copies of the records HEAD binds, in snapshot order.
  const constraintByID = new Map(run.constraints.map((constraint) => [constraint.id, constraint]));
  const constraints = [];
  for (const id of snapshot.state.constraintIDs) {
    const constraint = constraintByID.get(id);
    if (!constraint) {
      throw new UltraPlanError("unknown_reference", `Constraint ${id} bound by HEAD snapshot does not exist`, {
        constraintID: id,
      });
    }
    constraints.push(constraint);
  }

  // Blockers: frozen copies of the current OPEN state (brief §14/§53).
  const questions = run.openQuestions
    .filter((question) => question.status === "open")
    .map((question) => ({
      id: question.id,
      question: question.question,
      blocking: question.blocking,
      status: question.status,
    }));
  const conflicts = run.conflicts
    .filter((conflict) => conflict.status === "open")
    .map((conflict) => ({
      id: conflict.id,
      type: conflict.type,
      description: conflict.description,
      severity: conflict.severity,
      status: conflict.status,
    }));

  // Evidence: the SectionRevision → Decision → Evidence chain (§15), plus the
  // Architecture's basedOn decisions. Exact revisions; no repository scans.
  const evidenceStates: SynthesisInputPayload["evidence"] = [];
  const seenEvidence = new Set<string>();
  const collectDecisionEvidence = async (decisionRef: DecisionRef): Promise<void> => {
    const decision = await store.getDecision(run.id, decisionRef);
    if (!decision) return;
    for (const ref of decision.evidence ?? []) {
      const evidence = await store.getEvidence(run.id, ref);
      if (!evidence) {
        throw new UltraPlanError(
          "unknown_reference",
          `Evidence ${ref.id} referenced by ${decision.id}@${decision.revision} does not exist`,
          { evidenceID: ref.id },
        );
      }
      if (seenEvidence.has(evidence.id)) continue;
      seenEvidence.add(evidence.id);
      evidenceStates.push({
        id: EvidenceIDs.cast(evidence.id),
        revision: evidence.revision,
        confidence: evidence.confidence,
        criticality: evidence.criticality,
        freshness: evidence.freshness,
        status: evidence.status,
      });
    }
  };
  for (const decisionRef of decisions) {
    await collectDecisionEvidence(decisionRef);
  }

  return {
    planID: run.id,
    baseSnapshot: { id: snapshot.id },
    baseCommit: snapshot.commit,
    architecture: { id: "ARCH", revision: architectureRevision },
    sections,
    decisions,
    constraints,
    questions,
    conflicts,
    evidence: evidenceStates,
  };
}
