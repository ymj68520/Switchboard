/**
 * PlanningContextState — the snapshot-consistent read boundary for context
 * assembly (R2 brief §5).
 *
 * Context assembly must never stitch one prompt together from many unrelated
 * "latest" reads: a concurrent PlanCommit between two reads could produce L1
 * from HEAD A and Architecture from HEAD B. Durable publication is
 * whole-document atomic (memory/durable-store.ts), so the smallest consistent
 * read boundary is ONE refresh of the durable document followed by reads of
 * every family from that single hydrated state — no writer lock is held, and
 * the resulting view is immutable.
 *
 * `capturePlanningContextState` lives on the PlanStore boundary (read-only,
 * no mutation path) precisely so the durable store can implement the
 * one-refresh semantics; the in-memory store is trivially consistent.
 *
 * The view resolves the CURRENT artifacts from the HEAD Snapshot's exact
 * revision pointers (never from registry "latest" guesses): current
 * Architecture = the snapshot's architectureRevision, current SectionRevision
 * per Section = the snapshot's sectionRevisions pointer, current Decision
 * revisions = the snapshot's decisionRevisions map. Evidence has no snapshot
 * representation (separate trust domain, spec §25), so the newest revision of
 * each Evidence id is the current Evidence state — that is the exact state the
 * finalization fingerprint audits.
 */
import type {
  CommitID,
  EvidenceID,
  PlanID,
  SectionID,
} from "../core/ids.js";
import type { DecisionRef } from "../core/refs.js";
import type {
  Architecture,
  Decision,
  FinalPlan,
  OpenQuestion,
  PlanningRun,
  Section,
  SectionRevision,
  Conflict,
  Constraint,
} from "../core/types.js";
import type { Evidence } from "../repository/evidence.js";
import type { Proposal } from "../transaction/types.js";
import type { SynthesisInput, SynthesisManifest } from "../synthesis/types.js";
import type { ValidationReport } from "../validation/types.js";
import type {
  EvidenceAuditSnapshot,
  FinalPlanCandidate,
} from "../finalization/types.js";
import type { ExecutionHandoff } from "../handoff/types.js";
import type { Snapshot } from "../memory/snapshots.js";

/**
 * The CURRENT derived-artifact identity set of the synthesis workflow (R2
 * brief §30): latest frozen input → its latest manifest revision → the CURRENT
 * semantic-validation report for that exact identity → the current Evidence
 * Audit → the current FinalPlanCandidate. Every member records its own
 * HEAD-currency (`baseSnapshot.id === run.headSnapshot`); deeper gate currency
 * (evidence fingerprints) is intentionally NOT re-derived here — the
 * Finalization Gate remains the only currency authority (R2 brief §94).
 */
export interface SynthesisContextState {
  input?: SynthesisInput;
  manifest?: SynthesisManifest;
  report?: ValidationReport;
  audit?: EvidenceAuditSnapshot;
  candidate?: FinalPlanCandidate;
  /** The current final_plan Proposal (ready/awaiting), when one exists. */
  finalProposal?: Proposal;
}

/** One immutable, internally consistent read view of planning state. */
export interface PlanningContextState {
  planID: PlanID;
  /** The full run header (working state: goal, constraints, questions, conflicts, pointers). */
  run: PlanningRun;

  headCommit?: CommitID;
  headSnapshot?: Snapshot;

  /** CURRENT Architecture (resolved at the snapshot's architectureRevision). */
  architecture?: Architecture;

  /** The run's CURRENT committed Section roots, resolved records, canonical run.sections order. */
  sections: Section[];
  /** CURRENT SectionRevision content per Section id (snapshot pointer; undefined = revisionless). */
  sectionRevisions: Map<SectionID, SectionRevision | undefined>;

  /** CURRENT committed Decision revisions (snapshot pointers), keyed by exact ref string "DEC-001@2". */
  decisions: Map<string, Decision>;
  decisionRefs: DecisionRef[];

  /** Newest revision of each Evidence record (current Evidence state). */
  evidence: Map<EvidenceID, Evidence>;

  proposals: Proposal[];

  synthesis: SynthesisContextState;

  finalPlan?: FinalPlan;
  executionHandoff?: ExecutionHandoff;

  // -- Convenience accessors over the run header (single source: run) --------
  constraints: Constraint[];
  openQuestions: OpenQuestion[];
  conflicts: Conflict[];
}

/** Inputs the stores hand to the shared builder (their raw family state). */
export interface PlanningContextCaptureInput {
  run: PlanningRun;
  headSnapshot?: Snapshot;
  architecture?: Architecture;
  sections: Section[];
  /** Exact-revision SectionRevision read (the snapshot pointer is normative). */
  sectionRevisions: (ref: { id: SectionID; revision: number }) => SectionRevision | undefined;
  /** All committed decision revisions, keyed "DEC-001@2". */
  decisions: Map<string, Decision>;
  evidence: Evidence[];
  proposals: Proposal[];
  synthesisInputs: SynthesisInput[];
  synthesisManifests: SynthesisManifest[];
  validationReports: ValidationReport[];
  evidenceAudits: EvidenceAuditSnapshot[];
  finalPlanCandidates: FinalPlanCandidate[];
  finalPlans: FinalPlan[];
  executionHandoffs: ExecutionHandoff[];
}

/** Resolve the newest revision of each evidence id (insertion order preserved). */
export function latestEvidenceById(evidence: Evidence[]): Map<EvidenceID, Evidence> {
  const byId = new Map<EvidenceID, Evidence>();
  for (const record of evidence) {
    const existing = byId.get(record.id);
    if (!existing || record.revision > existing.revision) byId.set(record.id, record);
  }
  return byId;
}

/** The SEMANTIC_VALIDATION_PROTOCOL constant, re-imported to avoid a cycle. */
let cachedValidationProtocol: string | undefined;
/** Set once by the context module entry (avoids an import cycle with validation/protocol). */
export function setValidationProtocolForContext(protocol: string): void {
  cachedValidationProtocol = protocol;
}

/**
 * Build the immutable read view from raw family state. Both store
 * implementations call this with data read from ONE coherent state, so the
 * result is snapshot-consistent by construction.
 */
export function buildPlanningContextState(input: PlanningContextCaptureInput): PlanningContextState {
  const { run, headSnapshot } = input;
  const state = headSnapshot?.state;

  // CURRENT artifacts resolve through the HEAD snapshot's exact pointers —
  // never registry "latest". A missing pointer means the artifact family is
  // legitimately absent at this HEAD (absence is meaningful, never backfilled).
  const architecture =
    input.architecture && state?.architectureRevision !== undefined && input.architecture.revision === state.architectureRevision
      ? input.architecture
      : undefined;

  const sections = run.sections
    .map((ref) => input.sections.find((section) => section.id === ref.id))
    .filter((section): section is Section => section !== undefined);

  const sectionRevisions = new Map<SectionID, SectionRevision | undefined>();
  for (const section of sections) {
    const pointer = state?.sectionRevisions[section.id];
    sectionRevisions.set(
      section.id,
      pointer === undefined ? undefined : input.sectionRevisions({ id: section.id, revision: pointer }),
    );
  }

  // Current decision revisions: the snapshot's decisionRevisions map IS the
  // exact HEAD binding (the SynthesisInput payload uses the same resolution).
  const decisions = new Map<string, Decision>();
  const decisionRefs: DecisionRef[] = [];
  if (state) {
    for (const [id, revision] of Object.entries(state.decisionRevisions)) {
      const key = `${id}@${revision}`;
      const decision = input.decisions.get(key);
      if (decision) {
        decisions.set(key, decision);
        decisionRefs.push({ id: decision.id, revision: decision.revision });
      }
    }
  }

  // -- Current synthesis identity set (latest input → its latest manifest →
  //    the CURRENT report/audit/candidate for that exact identity) ------------
  const latestInput = input.synthesisInputs.at(-1);
  const manifest = latestInput
    ? input.synthesisManifests
        .filter((candidate) => candidate.input.id === latestInput.id)
        .reduce<SynthesisManifest | undefined>(
          (latest, candidate) => (latest === undefined || candidate.revision > latest.revision ? candidate : latest),
          undefined,
        )
    : undefined;
  const report =
    latestInput && manifest
      ? input.validationReports.find(
          (candidate) =>
            candidate.input.id === latestInput.id &&
            candidate.inputHash === latestInput.hash &&
            candidate.manifest.id === manifest.id &&
            candidate.manifest.revision === manifest.revision &&
            candidate.manifestHash === manifest.hash &&
            (cachedValidationProtocol === undefined || candidate.validatorProtocol === cachedValidationProtocol),
        )
      : undefined;
  const audit =
    latestInput && manifest
      ? input.evidenceAudits.find(
          (candidate) =>
            candidate.synthesisInput.id === latestInput.id &&
            candidate.synthesisInput.hash === latestInput.hash &&
            candidate.synthesisManifest.id === manifest.id &&
            candidate.synthesisManifest.revision === manifest.revision &&
            candidate.synthesisManifest.hash === manifest.hash,
        )
      : undefined;
  const candidate = latestInput
    ? input.finalPlanCandidates
        .filter((entry) => entry.synthesisInput.id === latestInput.id && entry.synthesisInput.hash === latestInput.hash)
        .reduce<FinalPlanCandidate | undefined>(
          (latest, entry) => (latest === undefined || entry.revision > latest.revision ? entry : latest),
          undefined,
        )
    : undefined;
  const finalProposal = input.proposals
    .filter((proposal) => proposal.type === "final_plan" && (proposal.status === "ready" || proposal.status === "awaiting_approval"))
    .at(-1);

  const synthesis: SynthesisContextState = {
    ...(latestInput ? { input: latestInput } : {}),
    ...(manifest ? { manifest } : {}),
    ...(report ? { report } : {}),
    ...(audit ? { audit } : {}),
    ...(candidate ? { candidate } : {}),
    ...(finalProposal ? { finalProposal } : {}),
  };

  return {
    planID: run.id,
    run,
    ...(run.headCommit !== undefined ? { headCommit: run.headCommit } : {}),
    ...(headSnapshot ? { headSnapshot } : {}),
    ...(architecture ? { architecture } : {}),
    sections,
    sectionRevisions,
    decisions,
    decisionRefs,
    evidence: latestEvidenceById(input.evidence),
    proposals: input.proposals,
    synthesis,
    ...(input.finalPlans.at(-1) ? { finalPlan: input.finalPlans.at(-1)! } : {}),
    ...(input.executionHandoffs.at(-1) ? { executionHandoff: input.executionHandoffs.at(-1)! } : {}),
    constraints: run.constraints,
    openQuestions: run.openQuestions,
    conflicts: run.conflicts,
  };
}

/** Convenience: exact-ref map key for a decision. */
export function decisionKey(ref: DecisionRef): string {
  return `${ref.id}@${ref.revision}`;
}
