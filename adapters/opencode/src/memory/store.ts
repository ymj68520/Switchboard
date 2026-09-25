/**
 * Storage boundary for Plan Memory — spec §12 + Phase 2B1 transaction engine.
 *
 * The boundary is deliberately narrow:
 *
 * - Committed Plan Memory (architecture/section/decision revisions, approvals,
 *   commits, snapshots) is READ-ONLY through this interface. Its single
 *   mutation path is `commitTransaction`, which validates the entire
 *   transaction (proposal, approval, base snapshot, dependencies, conflicts,
 *   evidence, resulting state) against a STAGED clone and publishes atomically
 *   (spec §9.4). A generic `save*` mutation API is intentionally absent.
 * - The PlanningRun header (stage/lifecycle/activeWork/goal/questions/
 *   conflicts/constraints) is working state and mutates via `saveRun`; the
 *   commit-gated fields are protected by an invariant check inside saveRun and
 *   are advanced ONLY by the transaction engine.
 * - Evidence is a separate trust domain (spec §21/§25): immutable revisions
 *   that do NOT require approval, hence the explicit narrow `putEvidence`.
 * - Approvals are immutable authorization records: no update method exists.
 *   An exact duplicate delivery returns the existing record (idempotent);
 *   a conflicting one is rejected.
 *
 * ATOMICITY MODEL (in-memory, single-threaded): commitTransaction gathers all
 * inputs with awaits, then runs validate → stage-on-clones → validate-staged →
 * publish as ONE synchronous block. JavaScript cannot interleave it, so a
 * failure before publication leaves every byte of state — registries, run
 * header, events, snapshot chain, commits, HEAD, proposal status — exactly
 * unchanged. `publishTransaction` is the single protected publication seam
 * (subclass/override point for fault-injection tests).
 *
 * Async signatures stay so the durable Phase 2B2 store drops in without an
 * interface migration.
 */
import {
  assertAcyclicSections,
  assertCommittedRunFieldsUnchanged,
  assertRevisionMonotonic,
  assertSectionCanComplete,
  propagateNeedsReview,
  sectionValidationFromDependencyContracts,
  stableStringify,
} from "../core/invariants.js";
import type {
  ApprovalID,
  CommitID,
  PlanID,
  ProposalID,
  QuestionID,
  SectionID,
} from "../core/ids.js";
import { CommitIDs, SnapshotIDs, nextSequence } from "../core/ids.js";
import { isActiveRun } from "../core/state-machine.js";
import { UltraPlanError } from "../core/errors.js";
import type {
  Architecture,
  Constraint,
  Decision,
  OpenQuestion,
  PlanningRun,
  Section,
  SectionRevision,
} from "../core/types.js";
import type { WorkRef } from "../core/refs.js";
import type {
  ArchitectureRef,
  DecisionRef,
  EvidenceRef,
  FinalPlanRef,
  MemoryRef,
  SectionRevisionRef,
  Timestamp,
} from "../core/refs.js";
import { computeProposalHash } from "../transaction/hash.js";
import {
  computeSynthesisInputHash,
  computeSynthesisManifestHash,
} from "../synthesis/hash.js";
import { assertSynthesisEntryReady } from "../synthesis/entry.js";
import { validateManifestDraft } from "../synthesis/validate.js";
import type {
  SynthesisInput,
  SynthesisInputPayload,
  SynthesisManifest,
  SynthesisManifestDraft,
} from "../synthesis/types.js";
import type {
  EvidenceAuditID,
  FinalPlanCandidateID,
  SynthesisInputID,
  SynthesisManifestID,
  ValidationReportID,
} from "../core/ids.js";
import { SynthesisInputIDs, SynthesisManifestIDs, FinalPlanCandidateIDs } from "../core/ids.js";
import { computeValidationReportHashFromRecord } from "../validation/hash.js";
import { validateValidatorOutput } from "../validation/validate.js";
import { SEMANTIC_VALIDATION_PROTOCOL } from "../validation/protocol.js";
import type {
  SemanticValidationAdmission,
  ValidationIdentity,
  ValidationReport,
} from "../validation/types.js";
import { validationIdentityKey } from "../validation/types.js";
import {
  assertEvidenceAuditInternallyConsistent,
  computeCurrentEvidenceStateHash,
  computeEvidenceStateHashFromRecords,
  evidenceAuditIdentity,
  type ReachabilityRecords,
  type ResolvedEvidenceCitation,
} from "../finalization/audit.js";
import {
  computeEvidenceAuditHashFromRecord,
  computeFinalPlanCandidateHash,
  computeFinalPlanCandidateHashFromRecord,
} from "../finalization/hash.js";
import { candidateRecordIdentity } from "../finalization/candidate.js";
import { evaluateFinalizationGate } from "../finalization/gate.js";
import {
  buildFinalPlanFromCandidate,
  computeFinalPlanHashFromContent,
  finalizationIdentityMatchesCandidate,
} from "../finalization/plan.js";
import type {
  EvidenceAuditIdentity,
  EvidenceAuditSnapshot,
  FinalPlanCandidate,
  FinalPlanCandidateDraft,
  FinalPlanCandidateIdentity,
} from "../finalization/types.js";
import type { FinalizationGateDeps } from "../finalization/gate.js";
import type { FinalPlan } from "../core/types.js";
import type { ExecutionHandoff, HandoffDelivery } from "../handoff/types.js";
import { computeExecutionHandoffHashFromRecord } from "../handoff/hash.js";
import type { HandoffID } from "../core/ids.js";
import type {
  Approval,
  CommittedChange,
  PlanCommit,
  Proposal,
  ProposalChange,
} from "../transaction/types.js";
import type { Evidence } from "../repository/evidence.js";
import type { PlanEvent, PlanEventDetail } from "./events.js";
import type { Snapshot, SnapshotState } from "./snapshots.js";

export interface CommitTransactionInput {
  planID: PlanID;
  /** The proposal being committed; must be `awaiting_approval` with an exact Approval. */
  proposalID: ProposalID;
  approvalID: ApprovalID;
  // parentCommit is DERIVED from the run's current HEAD by the engine — the
  // caller can never supply (or falsify) commit-chain structure.
}

export interface PlanStore {
  // -- PlanningRun ----------------------------------------------------------
  /** The run blocking the session, if any (active or handoff_pending). */
  findActiveRunBySession(sessionID: string): Promise<PlanningRun | undefined>;
  /** Most recent run for the session regardless of lifecycle (for reads). */
  findLatestRunBySession(sessionID: string): Promise<PlanningRun | undefined>;
  getRun(planID: PlanID): Promise<PlanningRun | undefined>;
  /** Next monotonically increasing plan sequence number (PLAN-001, ...). */
  nextPlanSequence(): Promise<number>;
  /**
   * Create a run. Throws `multiple_active_runs` if the session already has an
   * active run — the controller checks first, the store enforces the
   * invariant. Also materializes the initial HEAD snapshot (commit=null) so
   * proposals always have a base to bind to.
   */
  createRun(run: PlanningRun): Promise<PlanningRun>;
  /**
   * Persist a run-header mutation. Bumps `revision` and `updatedAt`.
   * Throws `commit_gated_run_field` if a commit-gated field changed — those
   * advance only through commitTransaction.
   */
  saveRun(run: PlanningRun): Promise<PlanningRun>;

  // -- Event log ------------------------------------------------------------
  appendEvent(planID: PlanID, detail: PlanEventDetail): Promise<PlanEvent>;
  listEvents(planID: PlanID): Promise<PlanEvent[]>;

  // -- Committed Plan Memory (read-only outside commitTransaction) -----------
  getHeadSnapshot(planID: PlanID): Promise<Snapshot | undefined>;
  getArchitecture(planID: PlanID, revision?: number): Promise<Architecture | undefined>;
  getSection(planID: PlanID, sectionID: SectionID): Promise<Section | undefined>;
  listSections(planID: PlanID): Promise<Section[]>;
  getSectionRevision(planID: PlanID, ref: SectionRevisionRef): Promise<SectionRevision | undefined>;
  getDecision(planID: PlanID, ref: DecisionRef): Promise<Decision | undefined>;
  /** Newest revision of each committed decision (read-only). */
  listDecisions(planID: PlanID): Promise<Decision[]>;
  getProposal(planID: PlanID, proposalID: ProposalID): Promise<Proposal | undefined>;
  getCommit(planID: PlanID, commitID: CommitID): Promise<PlanCommit | undefined>;
  listCommits(planID: PlanID): Promise<PlanCommit[]>;

  // -- Approval records (immutable; no update method exists) -----------------
  /**
   * Persist a user approval. Idempotent for the exact same proposal binding
   * (returns the existing record); a conflicting authorization for an
   * already-approved proposal, or a reused approval id, is rejected.
   */
  saveApproval(planID: PlanID, approval: Approval): Promise<Approval>;
  getApproval(planID: PlanID, approvalID: ApprovalID): Promise<Approval | undefined>;
  /** The (single) authorization for a proposal, if one was recorded. */
  findApprovalForProposal(planID: PlanID, proposalID: ProposalID): Promise<Approval | undefined>;
  listApprovals(planID: PlanID): Promise<Approval[]>;

  // -- Repository Evidence (separate trust domain) ---------------------------
  /**
   * Record an immutable Evidence revision. Throws `duplicate_revision` /
   * `non_monotonic_revision` on violations. Does not require user approval
   * (spec §25).
   */
  putEvidence(planID: PlanID, evidence: Evidence): Promise<void>;
  /** Newest revision of each evidence record for the run. */
  listEvidence(planID: PlanID): Promise<Evidence[]>;
  /**
   * Exact-revision evidence read. With `ref.revision` set, a missing revision
   * is an error-free miss (callers surface `unknown_reference`); without it,
   * the newest revision is returned.
   */
  getEvidence(planID: PlanID, ref: EvidenceRef): Promise<Evidence | undefined>;

  // -- Proposal intent (Harness-assigned; frozen at creation in Phase 2A) ----
  /**
   * Persist a proposal. Proposals are content-addressed intent records: an id
   * may never be reused with different content (`proposal_immutable`).
   */
  saveProposal(planID: PlanID, proposal: Proposal): Promise<Proposal>;
  listProposals(planID: PlanID): Promise<Proposal[]>;
  /**
   * Harness-controlled lifecycle transition (`ready → awaiting_approval`,
   * `awaiting_approval → rejected`, `awaiting_approval → approved` by the
   * engine). ONLY the status field may change; wrong current status is
   * `proposal_status_invalid`.
   */
  transitionProposalStatus(
    planID: PlanID,
    proposalID: ProposalID,
    from: Proposal["status"],
    to: Proposal["status"],
  ): Promise<Proposal>;

  // -- The only committed-memory mutation path (Phase 2B1 engine) ------------
  /**
   * Proposal → Approval → PlanCommit (spec §9.4). Validates the FULL
   * transaction — run active, proposal awaiting approval, approval binding
   * exact, hash recomputes, base snapshot matches HEAD (createdFrom), change
   * targets resolve, conflicts, evidence — against a STAGED clone of committed
   * state, then publishes atomically: immutable revisions, question effects,
   * events, Snapshot, PlanCommit, proposal → approved, HEAD movement.
   *
   * Failure at ANY point before publication leaves committed Plan Memory,
   * HEAD, events, and proposal status exactly unchanged; the Approval remains
   * valid for retry. Repeating an already-successful exact transaction returns
   * the existing PlanCommit (idempotent).
   */
  commitTransaction(input: CommitTransactionInput): Promise<PlanCommit>;

  /**
   * Phase 2E2 — the ONE sanctioned Harness workflow-focus transition.
   * `activeWork` remains a commit-gated run field (generic saveRun mutation
   * stays forbidden and there is no set_active_work tool); this narrow
   * operation is Harness-owned and revalidates the EXPECTED current focus,
   * the run state, and the target Section authoritatively INSIDE the mutation
   * block (for the durable store: under the write lock, after rehydration —
   * cross-instance stale transitions fail closed with `stale_active_work`).
   * Appends `run.active_work_changed` (workflow state, not a PlanCommit).
   */
  transitionActiveWork(planID: PlanID, expected: WorkRef | undefined, next: WorkRef): Promise<PlanningRun>;

  // -- Derived synthesis artifacts (Phase 2F; durable, immutable, NOT
  //    committed Plan Memory — their creation never touches PlanCommit/HEAD) --
  /**
   * Freeze the Harness-built authority payload as the canonical SynthesisInput.
   * The STORE assigns the id/createdAt/hash and enforces idempotency: an
   * identical payload (same canonical hash) returns the existing input —
   * "same Plan, same HEAD Snapshot, same canonical input" (brief §17). Entry
   * preconditions are revalidated INSIDE this mutation block (for the durable
   * store: under the write lock after rehydration), and the payload must bind
   * the run's CURRENT HEAD snapshot (`head_snapshot_mismatch` otherwise) so a
   * racing design change can never be frozen silently.
   */
  freezeSynthesisInput(planID: PlanID, payload: SynthesisInputPayload): Promise<SynthesisInput>;
  /** Exact-read; a missing id is an error-free miss (callers surface unknown_reference). */
  getSynthesisInput(planID: PlanID, inputID: SynthesisInputID): Promise<SynthesisInput | undefined>;
  /** All frozen inputs for the run, in freeze order (historical inputs stay readable). */
  listSynthesisInputs(planID: PlanID): Promise<SynthesisInput[]>;
  /** The most recently frozen input — the CURRENT active input for submit/status (§24). */
  getLatestSynthesisInput(planID: PlanID): Promise<SynthesisInput | undefined>;
  /**
   * Persist a structurally VALIDATED manifest draft as the next immutable
   * revision. The store resolves the input, assigns identity (one stable
   * manifest id per input), derives the revision number, stamps the copied
   * input refs, and enforces idempotency: an exact-content resubmission
   * returns the existing revision (brief §36/§37). The manifest bound by
   * draft.inputID must be CURRENT (its input's baseSnapshot == run HEAD —
   * `synthesis_input_stale` otherwise, revalidated under the durable write
   * lock), and structural validation re-runs inside the block (brief §33).
   */
  saveSynthesisManifest(planID: PlanID, draft: SynthesisManifestDraft): Promise<SynthesisManifest>;
  /**
   * Manifest read. With `revision`, an exact historical read — a missing
   * revision is an error-free miss and NEVER resolves to latest (brief §41);
   * without it, the newest revision of that manifest id.
   */
  getSynthesisManifest(planID: PlanID, manifestID: SynthesisManifestID, revision?: number): Promise<SynthesisManifest | undefined>;
  /** The most recently saved manifest revision (the current output, if any). */
  getLatestSynthesisManifest(planID: PlanID): Promise<SynthesisManifest | undefined>;
  listSynthesisManifests(planID: PlanID): Promise<SynthesisManifest[]>;

  // -- Semantic validation (Phase 2G; durable derived artifacts, immutable,
  //    NOT committed Plan Memory — saving one never touches PlanCommit/HEAD) --
  /**
   * Persist a Harness-built ValidationReport (identity/finding ids/hash
   * already assigned). IMMUTABLE — no update/replace method exists. The store
   * revalidates everything INSIDE the mutation block (durable: under the write
   * lock): the input/manifest pair must exist and mirror the report exactly,
   * the report hash must recompute, findings must resolve exactly against the
   * input, the identity must still be CURRENT (input non-stale, still the
   * latest, manifest still its latest revision), and the anti-laundering rule
   * (§25) holds: an existing successful report with the same exact identity is
   * returned unchanged — a report can never be re-rolled.
   */
  saveValidationReport(planID: PlanID, report: ValidationReport): Promise<{ report: ValidationReport; created: boolean }>;
  /** Exact read; a missing id is an error-free miss (callers surface unknown_reference). */
  getValidationReport(planID: PlanID, reportID: ValidationReportID): Promise<ValidationReport | undefined>;
  /** The most recently persisted report for the run (insertion order). */
  getCurrentValidationReport(planID: PlanID): Promise<ValidationReport | undefined>;
  listValidationReports(planID: PlanID): Promise<ValidationReport[]>;
  /** Anti-laundering lookup: the successful report for an EXACT validation identity, if any. */
  findValidationReportByIdentity(planID: PlanID, identity: ValidationIdentity): Promise<ValidationReport | undefined>;
  /**
   * Single-flight admission for ONE validation execution (brief §30/§31/§32):
   * checked+registered under the mutation lock (durable: write lock after
   * rehydration) so two instances converge; the model inference itself runs
   * UNLOCKED. An existing successful report wins immediately. A same-owner
   * live admission refuses (`validation_already_running`); a DEAD process's
   * admission (different pid) or an expired one is RECLAIMED — never a wedge,
   * never treated as a clean result.
   */
  admitSemanticValidation(
    planID: PlanID,
    identity: ValidationIdentity & { inputID: SynthesisInputID; manifestID: SynthesisManifestID; manifestRevision: number },
    options: { now: Timestamp; ttlMs: number },
  ): Promise<{ kind: "admitted"; admission: SemanticValidationAdmission } | { kind: "completed"; report: ValidationReport }>;
  /** Release the caller's admission (finally-block); idempotent. */
  releaseSemanticValidation(planID: PlanID, identityKey: string): Promise<void>;
  /** Admission state for status rendering ("Semantic validation: running"). */
  getSemanticValidationAdmission(planID: PlanID, identityKey: string): Promise<SemanticValidationAdmission | undefined>;

  // -- Finalization (Phase 2H; durable derived artifacts, immutable, NOT
  //    committed Plan Memory — saving one never touches PlanCommit/HEAD) -----
  /**
   * Persist a Harness-built EvidenceAuditSnapshot (brief §5/§46/§48). IMMUTABLE
   * — no update/replace method exists. The store revalidates INSIDE the
   * mutation block (durable: under the write lock): the audit hash must
   * recompute, the bound input/manifest/report must exist and mirror it
   * exactly, every entry must resolve against the evidence family at its exact
   * revision, HEAD must be unchanged, and the reachable-evidence fingerprint
   * must STILL match (§48: the audit corresponds to exact current state — a
   * racing evidence write fails `finalization_stale`). Blocked audits persist
   * deliberately (§46): they are the auditable explanation of the evidence
   * term. A same-identity audit is returned unchanged (brief §17).
   */
  saveEvidenceAudit(planID: PlanID, audit: EvidenceAuditSnapshot): Promise<{ audit: EvidenceAuditSnapshot; created: boolean }>;
  /** Exact read; a missing id is an error-free miss (callers surface unknown_reference). */
  getEvidenceAudit(planID: PlanID, auditID: EvidenceAuditID): Promise<EvidenceAuditSnapshot | undefined>;
  /** The most recently persisted audit for the run (insertion order). */
  getCurrentEvidenceAudit(planID: PlanID): Promise<EvidenceAuditSnapshot | undefined>;
  listEvidenceAudits(planID: PlanID): Promise<EvidenceAuditSnapshot[]>;
  /** Identity lookup: the audit for an EXACT audited state, if any (brief §17). */
  findEvidenceAuditByIdentity(planID: PlanID, identity: EvidenceAuditIdentity): Promise<EvidenceAuditSnapshot | undefined>;
  /**
   * Persist a Harness-assembled FinalPlanCandidate DRAFT (brief §30/§48/§63):
   * id/revision/createdAt/hash are assigned IN-LOCK by the store after the
   * identity lookup, so two instances requesting finalization for the exact
   * same state converge on ONE candidate identity/revision (§73). The store
   * revalidates EVERYTHING inside the mutation block (durable: under the
   * write lock after rehydration) so a passing state can never silently
   * diverge between the gate and the freeze: the bound audit/input/manifest/
   * report must exist and mirror the draft exactly; the implementation
   * order/limitations must equal the bound manifest's; the input must be
   * current and non-stale, the manifest the input's latest revision, the
   * report the current clean report, the audit the current passing audit, the
   * reachable-evidence fingerprint must still match, and NO live blocking
   * question/conflict may exist (§49/§50). Any drift fails
   * `finalization_stale` with no partial state. A same-identity request
   * returns the existing candidate unchanged (§38); revisions are never
   * duplicated and old candidates are never overwritten (§39).
   */
  saveFinalPlanCandidate(planID: PlanID, draft: FinalPlanCandidateDraft): Promise<{ candidate: FinalPlanCandidate; created: boolean }>;
  /**
   * Candidate read. With `revision`, an exact historical read — a missing
   * revision is an error-free miss and NEVER resolves to latest (§56);
   * without it, the newest revision of that candidate id.
   */
  getFinalPlanCandidate(planID: PlanID, candidateID: FinalPlanCandidateID, revision?: number): Promise<FinalPlanCandidate | undefined>;
  /** The most recently persisted candidate for the run (insertion order). */
  getCurrentFinalPlanCandidate(planID: PlanID): Promise<FinalPlanCandidate | undefined>;
  listFinalPlanCandidates(planID: PlanID): Promise<FinalPlanCandidate[]>;
  /** Identity lookup: the candidate for an EXACT successful gate identity, if any (§38). */
  findFinalPlanCandidateByIdentity(planID: PlanID, identity: FinalPlanCandidateIdentity): Promise<FinalPlanCandidate | undefined>;

  // -- Runtime handoff (Phase 2J; narrow semantic APIs only — generic
  //    updateHandoff/setDeliveryState/setLifecycle are deliberately ABSENT;
  //    brief §73) -----------------------------------------------------------
  /**
   * Freeze the Harness-built ExecutionHandoff (§6/§16/§17). IMMUTABLE; ONE
   * canonical handoff per plan — recovery reuses it (idempotency by identity,
   * not by call count). Everything is revalidated INSIDE the mutation block
   * (durable: under the write lock): lifecycle handoff_pending, stage final,
   * exact FinalPlan exists + approved + hash match, HEAD == the final
   * PlanCommit, snapshot ref match, exact proposal/approval, session
   * ownership, hash recompute, and the projection equals the FinalPlan.
   * A corrupted/incomplete final state refuses the freeze.
   */
  saveExecutionHandoff(planID: PlanID, handoff: import("../handoff/types.js").ExecutionHandoff): Promise<{ handoff: import("../handoff/types.js").ExecutionHandoff; created: boolean }>;
  /** Exact read; a missing id is an error-free miss. */
  getExecutionHandoff(planID: PlanID, handoffID: import("../core/ids.js").HandoffID): Promise<import("../handoff/types.js").ExecutionHandoff | undefined>;
  /** The plan's canonical handoff (at most one exists), if any. */
  findExecutionHandoffForPlan(planID: PlanID): Promise<import("../handoff/types.js").ExecutionHandoff | undefined>;
  /**
   * §19/§38: create the outbox-like durable delivery intent (state
   * `prepared`) BEFORE any host dispatch. Idempotent: the existing delivery
   * is returned unchanged (§77 reentrancy). One current delivery per handoff.
   */
  prepareHandoffDelivery(
    planID: PlanID,
    input: { handoffID: import("../core/ids.js").HandoffID; handoffHash: string; sessionID: string; deliveryKey: string },
  ): Promise<{ delivery: import("../handoff/types.js").HandoffDelivery; created: boolean }>;
  getHandoffDelivery(planID: PlanID, handoffID: import("../core/ids.js").HandoffID): Promise<import("../handoff/types.js").HandoffDelivery | undefined>;
  /**
   * §39/§41: the single-flight dispatch admission — CAS `prepared →
   * dispatching` (attempt + 1). When another owner already holds
   * `dispatching` (or the delivery is `delivered`), the delivery is returned
   * UNCHANGED with acquired=false: at most one active dispatch owner per
   * planID+handoffHash (§119).
   */
  beginHandoffDispatch(planID: PlanID, handoffID: import("../core/ids.js").HandoffID): Promise<{ delivery: import("../handoff/types.js").HandoffDelivery; acquired: boolean }>;
  /**
   * §43 step 5 / §61: return a `dispatching` delivery to `prepared` so a
   * retry may proceed. The CALLER must have host evidence first (host lookup
   * definitively not-found, or a definite pre-acceptance rejection) — the
   * store deliberately cannot distinguish "not sent" from "ambiguous"; there
   * is no path from dispatching to delivered except a real receipt (§88).
   */
  reclaimHandoffDispatch(planID: PlanID, handoffID: import("../core/ids.js").HandoffID): Promise<import("../handoff/types.js").HandoffDelivery>;
  /**
   * §22/§23/§45: record the host-observed receipt (dispatching/delivered →
   * delivered). The receipt is validated against the delivery: session must
   * equal the delivery's trusted sessionID (`handoff_session_mismatch`) and
   * carry a non-empty message id (`handoff_receipt_invalid`). Idempotent.
   */
  recordHandoffDelivered(
    planID: PlanID,
    handoffID: import("../core/ids.js").HandoffID,
    receipt: import("../runtime/types.js").HostDeliveryReceipt,
  ): Promise<import("../handoff/types.js").HandoffDelivery>;
  /**
   * §46/§47/§48/§121: the narrow Harness-owned lifecycle completion
   * (handoff_pending → completed). NOT committed design mutation: no
   * Proposal/Approval/PlanCommit, no Snapshot, no HEAD movement, no
   * FinalPlan change. Preconditions (in-lock): lifecycle handoff_pending,
   * stage final, exact FinalPlan, handoff exists binding it, delivery
   * `delivered` with a verified receipt whose session == run.sessionID.
   * Idempotent: completing a completed run returns the run unchanged.
   */
  completeHandoffRun(planID: PlanID): Promise<PlanningRun>;

  // -- Committed FinalPlans (Phase 2I; READ-ONLY here — the single writer is
  //    the final_plan transaction inside commitTransaction/publishTransaction;
  //    there is deliberately NO saveFinalPlan method on this boundary) --------
  /**
   * FinalPlan read. With `revision`, an exact historical read — a missing
   * revision is an error-free miss and NEVER resolves to latest (brief §47);
   * without it, the newest revision of that FinalPlan id.
   */
  getFinalPlan(planID: PlanID, finalPlanID: import("../core/ids.js").FinalPlanID, revision?: number): Promise<FinalPlan | undefined>;
  /** The most recently committed FinalPlan for the run (insertion order). */
  getCurrentFinalPlan(planID: PlanID): Promise<FinalPlan | undefined>;
  listFinalPlans(planID: PlanID): Promise<FinalPlan[]>;
}

interface RevisionRegistry<T> {
  readonly byKey: Map<string, T>;
  readonly latest: Map<string, T>;
  readonly highest: Map<string, number>;
}

function createRegistry<T>(): RevisionRegistry<T> {
  return { byKey: new Map(), latest: new Map(), highest: new Map() };
}

function cloneRegistry<T>(registry: RevisionRegistry<T>): RevisionRegistry<T> {
  return {
    byKey: new Map(registry.byKey),
    latest: new Map(registry.latest),
    highest: new Map(registry.highest),
  };
}

function revisionKey(id: string, revision: number): string {
  return `${id}@${revision}`;
}

/**
 * Phase 2E1/2E2 contract identity: the embedded contract projection belongs
 * to exactly this revision — the Harness stamps sectionID/revision at freeze,
 * and the commit refuses a projection claiming another identity.
 */
function validateContractIdentity(revision: SectionRevision): string | undefined {
  if (
    revision.projection.contract.sectionID !== revision.sectionID ||
    revision.projection.contract.revision !== revision.revision
  ) {
    return `The contract projection must be stamped with the revision's own identity (${revision.sectionID}@${revision.revision})`;
  }
  return undefined;
}

/**
 * Phase 2E1 binding sanity over STAGED state: every recorded dependency must
 * be a committed Section (never the section itself); a binding, when present,
 * must point at the dependency's exact approved revision; a dependency
 * without an approved contract must carry no binding. The resulting
 * `validation` verdict is NOT taken from approved content — the engine
 * recomputes it (sectionValidationFromDependencyContracts).
 */
function validateDependencyBindings(
  revision: SectionRevision,
  stagedSections: ReadonlyMap<SectionID, Section>,
): string | undefined {
  for (const dep of revision.dependencies) {
    if (dep.sectionID === revision.sectionID) {
      return `Section ${revision.sectionID} cannot depend on itself`;
    }
    const depSection = stagedSections.get(dep.sectionID);
    if (!depSection) {
      return `Revision dependency ${dep.sectionID} is not a committed Section`;
    }
    if (depSection.approvedRevision !== undefined) {
      if (dep.contractRevision !== depSection.approvedRevision) {
        return `Dependency ${dep.sectionID} is approved at revision ${depSection.approvedRevision}; the frozen binding says ${dep.contractRevision ?? "none"}`;
      }
    } else if (dep.contractRevision !== undefined) {
      return `Dependency ${dep.sectionID} has no approved contract; the frozen binding must not claim one`;
    }
  }
  return undefined;
}

/** A single deterministic transaction-validation failure. */
export interface TransactionFailure {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

/** Committed state the transaction engine stages and publishes together. */
interface StagedState {
  architectures: RevisionRegistry<Architecture>;
  sections: Map<SectionID, Section>;
  sectionRevisions: RevisionRegistry<SectionRevision>;
  decisions: RevisionRegistry<Decision>;
  openQuestions: OpenQuestion[];
  constraints: Constraint[];
  /** Staged run stage — only an architecture_completion commit may move it. */
  stage: PlanningRun["stage"];
  /**
   * Phase 2I: staged run lifecycle — ONLY the Final PlanCommit moves it
   * (active → handoff_pending), in the same atomic publication as the stage.
   */
  lifecycle: PlanningRun["lifecycle"];
  runArchitecture: ArchitectureRef | undefined;
  runSections: SectionRefMirror[];
  runDecisions: DecisionRef[];
  /** Staged PlanningRun.finalPlan — ONLY the Final PlanCommit sets the pointer. */
  runFinalPlan: FinalPlanRef | undefined;
  /** True when the run had NO committed sections before this proposal. */
  sectionsStartedEmpty: boolean;
  /** Staged active-work focus — only the initial decomposition commit sets it. */
  activeWork: WorkRef | undefined;
  addedSections: Section[];
  /** Phase 2I: FinalPlan records published by this transaction (initial-only). */
  addedFinalPlans: FinalPlan[];
  committedChanges: CommittedChange[];
  revised: { kind: "decision" | "section_revision" | "architecture" | "constraint" | "question" | "final_plan"; id: string; revision: number }[];
  resolvedQuestions: QuestionID[];
}

interface SectionRefMirror {
  id: SectionID;
}

function emptyRegistryOr<T>(map: Map<PlanID, RevisionRegistry<T>>, planID: PlanID): RevisionRegistry<T> {
  return map.get(planID) ?? createRegistry<T>();
}

export class InMemoryPlanStore implements PlanStore {
  // State fields are protected (not private) so the DurablePlanStore subclass
  // can hydrate them from durable storage without duplicating engine logic.
  /** Debug/test identity of this store instance. */
  readonly instanceId = Math.random().toString(36).slice(2, 8);
  protected readonly now: () => Timestamp;
  protected readonly runs = new Map<PlanID, PlanningRun>();
  protected readonly runOrder: PlanID[] = [];
  protected readonly events = new Map<PlanID, PlanEvent[]>();
  protected readonly architectures = new Map<PlanID, RevisionRegistry<Architecture>>();
  protected readonly sections = new Map<PlanID, Map<SectionID, Section>>();
  protected readonly sectionRevisions = new Map<PlanID, RevisionRegistry<SectionRevision>>();
  protected readonly decisions = new Map<PlanID, RevisionRegistry<Decision>>();
  protected readonly proposals = new Map<PlanID, Map<ProposalID, Proposal>>();
  protected readonly approvals = new Map<PlanID, Map<ApprovalID, Approval>>();
  protected readonly commits = new Map<PlanID, Map<CommitID, PlanCommit>>();
  /** proposalID → commitID, per plan: the idempotency + already-committed index. */
  protected readonly commitByProposal = new Map<string, CommitID>();
  protected readonly snapshots = new Map<PlanID, Map<string, Snapshot>>();
  protected readonly evidence = new Map<PlanID, RevisionRegistry<Evidence>>();
  /** Derived synthesis artifacts — NOT committed Plan Memory (Phase 2F). */
  protected readonly synthesisInputs = new Map<PlanID, Map<SynthesisInputID, SynthesisInput>>();
  /** Keyed `SYN-###@REV`, insertion-ordered; latest = last inserted. */
  protected readonly synthesisManifests = new Map<PlanID, Map<string, SynthesisManifest>>();
  /** Semantic-validation reports — derived artifacts, NOT committed memory (Phase 2G). */
  protected readonly validationReports = new Map<PlanID, Map<ValidationReportID, ValidationReport>>();
  /** Keyed by validation identity; transient single-flight state (Phase 2G). */
  protected readonly validationAdmissions = new Map<PlanID, Map<string, SemanticValidationAdmission>>();
  /** Evidence audits + FinalPlanCandidates — derived artifacts, NOT committed memory (Phase 2H). */
  protected readonly evidenceAudits = new Map<PlanID, Map<EvidenceAuditID, EvidenceAuditSnapshot>>();
  /** Keyed `FPC-###@REV`, insertion-ordered; latest = last inserted (Phase 2H). */
  protected readonly finalPlanCandidates = new Map<PlanID, Map<string, FinalPlanCandidate>>();
  /**
   * Committed FinalPlans (Phase 2I) — keyed `FINAL-###@REV`, insertion-ordered.
   * COMMITTED Plan Memory: the ONLY writer is publishTransaction inside the
   * final_plan transaction (spec invariant 8; there is deliberately no
   * saveFinalPlan method on this boundary).
   */
  protected readonly finalPlans = new Map<PlanID, Map<string, FinalPlan>>();
  /** Phase 2J — immutable ExecutionHandoffs, keyed HANDOFF-### (one per plan). */
  protected readonly executionHandoffs = new Map<PlanID, Map<HandoffID, ExecutionHandoff>>();
  /** Phase 2J — delivery workflow state, keyed handoff id (one current per handoff). */
  protected readonly handoffDeliveries = new Map<PlanID, Map<HandoffID, HandoffDelivery>>();

  constructor(now: () => Timestamp = () => new Date().toISOString()) {
    this.now = now;
    (this.approvals as unknown as { mapTag: string }).mapTag = `MAP-${this.instanceId}`;
  }

  async findActiveRunBySession(sessionID: string): Promise<PlanningRun | undefined> {
    for (const run of this.runs.values()) {
      if (run.sessionID === sessionID && isActiveRun(run)) return run;
    }
    return undefined;
  }

  async findLatestRunBySession(sessionID: string): Promise<PlanningRun | undefined> {
    for (let i = this.runOrder.length - 1; i >= 0; i--) {
      const id = this.runOrder[i];
      const run = id === undefined ? undefined : this.runs.get(id);
      if (run?.sessionID === sessionID) return run;
    }
    return undefined;
  }

  async getRun(planID: PlanID): Promise<PlanningRun | undefined> {
    return this.runs.get(planID);
  }

  async nextPlanSequence(): Promise<number> {
    return this.runs.size + 1;
  }

  async createRun(run: PlanningRun): Promise<PlanningRun> {
    if (this.runs.has(run.id)) {
      throw new UltraPlanError("duplicate_plan_id", `PlanningRun ${run.id} already exists`, {
        planID: run.id,
      });
    }
    const active = await this.findActiveRunBySession(run.sessionID);
    if (active) {
      throw new UltraPlanError(
        "multiple_active_runs",
        `Session ${run.sessionID} already has an active PlanningRun (${active.id})`,
        { sessionID: run.sessionID, activePlanID: active.id },
      );
    }
    // Initial HEAD snapshot (no commit yet) so every proposal has a base to
    // bind to (spec §9.1 createdFrom, §10).
    const snapshotID = SnapshotIDs.from(1);
    const snapshot: Snapshot = {
      id: snapshotID,
      planID: run.id,
      commit: null,
      state: {
        sectionRevisions: {},
        decisionRevisions: {},
        constraintIDs: [],
        openQuestionIDs: run.openQuestions.map((q) => q.id),
      },
      createdAt: this.now(),
    };
    const snapshots = new Map<string, Snapshot>();
    snapshots.set(snapshot.id, snapshot);
    this.snapshots.set(run.id, snapshots);

    const stored: PlanningRun = { ...run, headSnapshot: snapshotID };
    this.runs.set(run.id, stored);
    this.runOrder.push(run.id);
    return stored;
  }

  async saveRun(run: PlanningRun): Promise<PlanningRun> {
    const before = this.runs.get(run.id);
    if (!before) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${run.id} does not exist`, {
        planID: run.id,
      });
    }
    assertCommittedRunFieldsUnchanged(before, run);
    const saved: PlanningRun = {
      ...run,
      revision: before.revision + 1,
      updatedAt: this.now(),
    };
    this.runs.set(run.id, saved);
    if (before.stage !== saved.stage) {
      await this.appendEvent(saved.id, {
        type: "run.stage_changed",
        from: before.stage,
        to: saved.stage,
      });
    }
    if (before.lifecycle !== saved.lifecycle) {
      await this.appendEvent(saved.id, {
        type: "run.lifecycle_changed",
        from: before.lifecycle,
        to: saved.lifecycle,
      });
    }
    return saved;
  }

  /**
   * Phase 2E2 §19-§23: narrow Harness-owned workflow-focus transition. Every
   * precondition is revalidated INSIDE the mutation block — for the durable
   * subclass this runs under the write lock after rehydration, so a stale
   * expected focus (another instance moved it) fails closed with
   * `stale_active_work` instead of last-writer-wins drift.
   */
  async transitionActiveWork(
    planID: PlanID,
    expected: WorkRef | undefined,
    next: WorkRef,
  ): Promise<PlanningRun> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    if (stableStringify(run.activeWork) !== stableStringify(expected)) {
      throw new UltraPlanError(
        "stale_active_work",
        `Expected active work ${expected ? JSON.stringify(expected) : "none"}, but the run's current focus is ${
          run.activeWork ? JSON.stringify(run.activeWork) : "none"
        }; re-read the status and re-request the transition`,
        { expected, current: run.activeWork ?? null },
      );
    }
    if (run.lifecycle !== "active" || run.stage !== "detail") {
      throw new UltraPlanError(
        "invalid_scope",
        `Focus transitions require an active run in stage=detail (run is ${run.lifecycle}/${run.stage})`,
        { lifecycle: run.lifecycle, stage: run.stage },
      );
    }
    if (next.type !== "section") {
      throw new UltraPlanError("invalid_scope", "Focus transitions target Sections only", { next });
    }
    const target = this.sections.get(planID)?.get(next.id);
    if (!target) {
      throw new UltraPlanError("unknown_reference", `Section ${next.id} is not committed`, {
        sectionID: next.id,
      });
    }
    if (target.status !== "pending" && target.status !== "active") {
      throw new UltraPlanError(
        "invalid_scope",
        `Focus cannot move to Section ${next.id} in status ${target.status} (Phase 2E2 targets pending|active only)`,
        { sectionID: next.id, status: target.status },
      );
    }
    const updated: PlanningRun = {
      ...run,
      activeWork: next,
      revision: run.revision + 1,
      updatedAt: this.now(),
    };
    this.runs.set(planID, updated);
    await this.appendEvent(planID, { type: "run.active_work_changed", from: run.activeWork, to: next });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Derived synthesis artifacts (Phase 2F) — durable workflow artifacts, NOT
  // committed Plan Memory: no PlanCommit, no Snapshot, no HEAD movement.
  // -------------------------------------------------------------------------

  async freezeSynthesisInput(planID: PlanID, payload: SynthesisInputPayload): Promise<SynthesisInput> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    // Revalidate the deterministic entry gate INSIDE the mutation block (for
    // the durable subclass: under the write lock after rehydration) so a
    // racing state change can never be frozen silently, then bind the payload
    // to the run's CURRENT HEAD.
    await assertSynthesisEntryReady(this, run);
    if (payload.baseSnapshot.id !== run.headSnapshot) {
      throw new UltraPlanError(
        "head_snapshot_mismatch",
        `SynthesisInput payload binds ${payload.baseSnapshot.id}, but the run's HEAD is ${run.headSnapshot}; rebuild the payload from current HEAD`,
        { payloadBase: payload.baseSnapshot.id, headSnapshot: run.headSnapshot },
      );
    }
    const hash = computeSynthesisInputHash(payload);
    // Idempotency (brief §17): same canonical input → the SAME frozen record.
    const family = this.synthesisInputs.get(planID);
    if (family) {
      for (const existing of family.values()) {
        if (existing.hash === hash) return existing;
      }
    }
    const id = SynthesisInputIDs.from(
      nextSequenceSynthesisInput([...(family?.keys() ?? [])]),
    );
    const input: SynthesisInput = { ...payload, id, createdAt: this.now(), hash };
    const updated = family ?? new Map<SynthesisInputID, SynthesisInput>();
    updated.set(id, input);
    this.synthesisInputs.set(planID, updated);
    await this.appendEvent(planID, {
      type: "synthesis.input_frozen",
      inputID: id,
      hash,
      baseSnapshot: payload.baseSnapshot.id,
    });
    return input;
  }

  async getSynthesisInput(planID: PlanID, inputID: SynthesisInputID): Promise<SynthesisInput | undefined> {
    return this.synthesisInputs.get(planID)?.get(inputID);
  }

  async listSynthesisInputs(planID: PlanID): Promise<SynthesisInput[]> {
    return [...(this.synthesisInputs.get(planID)?.values() ?? [])];
  }

  async getLatestSynthesisInput(planID: PlanID): Promise<SynthesisInput | undefined> {
    const family = this.synthesisInputs.get(planID);
    if (!family || family.size === 0) return undefined;
    return [...family.values()][family.size - 1];
  }

  async saveSynthesisManifest(planID: PlanID, draft: SynthesisManifestDraft): Promise<SynthesisManifest> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    const input = this.synthesisInputs.get(planID)?.get(draft.inputID);
    if (!input) {
      throw new UltraPlanError("unknown_reference", `SynthesisInput ${draft.inputID} does not exist in run ${planID}`, {
        inputID: draft.inputID,
      });
    }
    // §18/§50: a stale input stays readable for audit but accepts NO new
    // current manifest. Revalidated inside the mutation block (durable: under
    // the write lock) so a racing HEAD movement fails closed.
    if (input.baseSnapshot.id !== run.headSnapshot) {
      throw new UltraPlanError(
        "synthesis_input_stale",
        `SynthesisInput ${input.id} is anchored to ${input.baseSnapshot.id}, but the run's HEAD is ${run.headSnapshot}; the stale input remains readable but accepts no new manifest`,
        { inputID: input.id, baseSnapshot: input.baseSnapshot.id, headSnapshot: run.headSnapshot },
      );
    }
    // §33: structural validation re-runs INSIDE the block (defense beyond the
    // controller check — hostile/direct store calls included).
    validateManifestDraft(draft, input, {
      questions: run.openQuestions,
      conflicts: run.conflicts,
    });
    const hash = computeSynthesisManifestHash(draft, {
      baseSnapshot: input.baseSnapshot,
      inputHash: input.hash,
      architecture: input.architecture,
      sections: input.sections,
    });
    const manifests = this.synthesisManifests.get(planID) ?? new Map<string, SynthesisManifest>();
    // Identity: one stable manifest id per input (brief §36); idempotency:
    // any prior revision of this identity with the same content hash IS the
    // answer (brief §37).
    const identityRevisions = [...manifests.values()].filter((manifest) => manifest.input.id === draft.inputID);
    const exact = identityRevisions.find((manifest) => manifest.hash === hash);
    if (exact) return exact;
    const identity = identityRevisions[0];
    let id: SynthesisManifestID;
    let revision: number;
    if (identity) {
      id = identity.id;
      revision = Math.max(...identityRevisions.map((manifest) => manifest.revision)) + 1;
    } else {
      id = SynthesisManifestIDs.from(
        nextSequenceSynthesisManifest(
          [...manifests.keys()].map((key) => key.slice(0, key.indexOf("@"))),
        ),
      );
      revision = 1;
    }
    const manifest: SynthesisManifest = {
      id,
      revision,
      input: { id: input.id },
      baseSnapshot: input.baseSnapshot,
      inputHash: input.hash,
      architecture: input.architecture,
      sections: input.sections,
      crossSectionLinks: draft.crossSectionLinks,
      implementationOrder: draft.implementationOrder.map((step, index) => ({ ...step, order: index + 1 })),
      limitations: draft.limitations,
      unresolvedFindings: draft.unresolvedFindings,
      createdAt: this.now(),
      hash,
    };
    manifests.set(`${manifest.id}@${manifest.revision}`, manifest);
    this.synthesisManifests.set(planID, manifests);
    await this.appendEvent(planID, {
      type: "synthesis.manifest_saved",
      manifestID: id,
      revision,
      inputID: input.id,
      hash,
    });
    return manifest;
  }

  async getSynthesisManifest(planID: PlanID, manifestID: SynthesisManifestID, revision?: number): Promise<SynthesisManifest | undefined> {
    const manifests = this.synthesisManifests.get(planID);
    if (!manifests) return undefined;
    if (revision !== undefined) {
      // Exact historical read — never resolved to latest (brief §41).
      return manifests.get(`${manifestID}@${revision}`);
    }
    const identity = [...manifests.values()].filter((manifest) => manifest.id === manifestID);
    if (identity.length === 0) return undefined;
    return identity.reduce((latest, manifest) => (manifest.revision > latest.revision ? manifest : latest));
  }

  async getLatestSynthesisManifest(planID: PlanID): Promise<SynthesisManifest | undefined> {
    const manifests = this.synthesisManifests.get(planID);
    if (!manifests || manifests.size === 0) return undefined;
    return [...manifests.values()][manifests.size - 1];
  }

  async listSynthesisManifests(planID: PlanID): Promise<SynthesisManifest[]> {
    return [...(this.synthesisManifests.get(planID)?.values() ?? [])];
  }

  // -------------------------------------------------------------------------
  // Semantic validation (Phase 2G) — durable derived artifacts, NOT committed
  // Plan Memory: no PlanCommit, no Snapshot, no HEAD movement, no stage change.
  // -------------------------------------------------------------------------

  /** The latest manifest revision bound to ONE input (identity-resolved). */
  private latestManifestForInput(planID: PlanID, inputID: SynthesisInputID): SynthesisManifest | undefined {
    const bound = [...(this.synthesisManifests.get(planID)?.values() ?? [])].filter(
      (manifest) => manifest.input.id === inputID,
    );
    if (bound.length === 0) return undefined;
    return bound.reduce((latest, manifest) => (manifest.revision > latest.revision ? manifest : latest));
  }

  /** The current validation identity (latest input + its latest manifest), if any. */
  private currentSynthesisIdentity(planID: PlanID): ValidationIdentity | undefined {
    const inputs = this.synthesisInputs.get(planID);
    const latestInput = inputs && inputs.size > 0 ? [...inputs.values()][inputs.size - 1] : undefined;
    if (!latestInput) return undefined;
    const latestManifest = this.latestManifestForInput(planID, latestInput.id);
    if (!latestManifest) return undefined;
    return { inputHash: latestInput.hash, manifestHash: latestManifest.hash, validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL };
  }

  async saveValidationReport(planID: PlanID, report: ValidationReport): Promise<{ report: ValidationReport; created: boolean }> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    const input = this.synthesisInputs.get(planID)?.get(report.input.id);
    if (!input) {
      throw new UltraPlanError("unknown_reference", `SynthesisInput ${report.input.id} does not exist in run ${planID}`, {
        inputID: report.input.id,
      });
    }
    const manifest = this.synthesisManifests.get(planID)?.get(`${report.manifest.id}@${report.manifest.revision}`);
    if (!manifest) {
      throw new UltraPlanError(
        "unknown_reference",
        `SynthesisManifest ${report.manifest.id}@${report.manifest.revision} does not exist (exact revisions are never resolved to latest)`,
        { manifestID: report.manifest.id, revision: report.manifest.revision },
      );
    }
    // Mirror checks (§12): the report binds exactly this input/manifest pair.
    if (manifest.input.id !== input.id) {
      throw new UltraPlanError("invalid_scope", `Manifest ${manifest.id}@${manifest.revision} does not belong to input ${input.id}`, {
        manifestID: manifest.id,
        inputID: input.id,
      });
    }
    if (report.inputHash !== input.hash || report.manifestHash !== manifest.hash) {
      throw new UltraPlanError(
        "invalid_scope",
        `ValidationReport identity does not match the resolved pair (input hash ${report.inputHash === input.hash ? "ok" : "mismatch"}, manifest hash ${report.manifestHash === manifest.hash ? "ok" : "mismatch"})`,
        { reportID: report.id },
      );
    }
    if (report.baseSnapshot.id !== input.baseSnapshot.id) {
      throw new UltraPlanError(
        "invalid_scope",
        `ValidationReport baseSnapshot ${report.baseSnapshot.id} does not match the input's anchor ${input.baseSnapshot.id}`,
        { reportID: report.id },
      );
    }
    // The stored hash must recompute (fail closed for hostile/direct calls).
    const { id: _id, createdAt: _createdAt, hash: _hash, ...rest } = report;
    void _id;
    void _createdAt;
    void _hash;
    if (computeValidationReportHashFromRecord(rest) !== report.hash) {
      throw new UltraPlanError("invalid_scope", `ValidationReport ${report.id} content does not recompute to its frozen hash`, {
        reportID: report.id,
      });
    }
    // Structural report validation re-runs INSIDE the block (§23 defense).
    validateValidatorOutput({ result: report.result, findings: report.findings }, input, manifest);
    // Anti-laundering (§25): the SAME exact identity already has a successful
    // report — return it unchanged; the identity can never produce a second.
    const identity: ValidationIdentity = {
      inputHash: report.inputHash,
      manifestHash: report.manifestHash,
      validatorProtocol: report.validatorProtocol,
    };
    const existing = await this.findValidationReportByIdentity(planID, identity);
    if (existing) return { report: existing, created: false };
    // Identity must STILL be current (§30): input non-stale + still latest,
    // manifest still the input's latest revision. A moved HEAD or a new
    // manifest revision means the validation ran against a superseded identity.
    if (run.headSnapshot !== input.baseSnapshot.id) {
      throw new UltraPlanError(
        "synthesis_input_stale",
        `SynthesisInput ${input.id} is anchored to ${input.baseSnapshot.id}, but the run's HEAD is ${run.headSnapshot}; a stale identity cannot produce a current report`,
        { inputID: input.id, baseSnapshot: input.baseSnapshot.id, headSnapshot: run.headSnapshot },
      );
    }
    const latestInput = [...(this.synthesisInputs.get(planID)?.values() ?? [])][
      (this.synthesisInputs.get(planID)?.size ?? 1) - 1
    ];
    if (!latestInput || latestInput.id !== input.id) {
      throw new UltraPlanError(
        "validation_identity_changed",
        `The validation identity is no longer current: input ${input.id} has been superseded`,
        { reportID: report.id, inputID: input.id },
      );
    }
    const latestManifest = this.latestManifestForInput(planID, input.id);
    if (!latestManifest || latestManifest.id !== manifest.id || latestManifest.revision !== manifest.revision) {
      throw new UltraPlanError(
        "validation_identity_changed",
        `The validation identity is no longer current: manifest ${manifest.id}@${manifest.revision} has been superseded`,
        { reportID: report.id, manifestID: manifest.id, revision: manifest.revision },
      );
    }
    const family = this.validationReports.get(planID) ?? new Map<ValidationReportID, ValidationReport>();
    if (family.has(report.id)) {
      throw new UltraPlanError(
        "invalid_scope",
        `ValidationReport ${report.id} already exists; reports are immutable and ids are never reused`,
        { reportID: report.id },
      );
    }
    family.set(report.id, report);
    this.validationReports.set(planID, family);
    // The admission (if any) is consumed by completion.
    this.validationAdmissions.get(planID)?.delete(validationIdentityKey(identity));
    await this.appendEvent(planID, {
      type: "validation.report_saved",
      reportID: report.id,
      result: report.result,
      inputID: report.input.id,
      manifestID: report.manifest.id,
      manifestRevision: report.manifest.revision,
      hash: report.hash,
    });
    return { report, created: true };
  }

  async getValidationReport(planID: PlanID, reportID: ValidationReportID): Promise<ValidationReport | undefined> {
    return this.validationReports.get(planID)?.get(reportID);
  }

  async getCurrentValidationReport(planID: PlanID): Promise<ValidationReport | undefined> {
    const family = this.validationReports.get(planID);
    if (!family || family.size === 0) return undefined;
    return [...family.values()][family.size - 1];
  }

  async listValidationReports(planID: PlanID): Promise<ValidationReport[]> {
    return [...(this.validationReports.get(planID)?.values() ?? [])];
  }

  async findValidationReportByIdentity(planID: PlanID, identity: ValidationIdentity): Promise<ValidationReport | undefined> {
    for (const report of this.validationReports.get(planID)?.values() ?? []) {
      if (
        report.inputHash === identity.inputHash &&
        report.manifestHash === identity.manifestHash &&
        report.validatorProtocol === identity.validatorProtocol
      ) {
        return report;
      }
    }
    return undefined;
  }

  async admitSemanticValidation(
    planID: PlanID,
    identity: ValidationIdentity & { inputID: SynthesisInputID; manifestID: SynthesisManifestID; manifestRevision: number },
    options: { now: Timestamp; ttlMs: number },
  ): Promise<{ kind: "admitted"; admission: SemanticValidationAdmission } | { kind: "completed"; report: ValidationReport }> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    const input = this.synthesisInputs.get(planID)?.get(identity.inputID);
    if (!input || input.hash !== identity.inputHash) {
      throw new UltraPlanError("synthesis_input_missing", `SynthesisInput ${identity.inputID} does not exist in run ${planID}`, {
        inputID: identity.inputID,
      });
    }
    const manifest = this.synthesisManifests.get(planID)?.get(`${identity.manifestID}@${identity.manifestRevision}`);
    if (!manifest || manifest.hash !== identity.manifestHash) {
      throw new UltraPlanError(
        "synthesis_manifest_missing",
        `SynthesisManifest ${identity.manifestID}@${identity.manifestRevision} does not exist in run ${planID}`,
        { manifestID: identity.manifestID, revision: identity.manifestRevision },
      );
    }
    // Anti-laundering wins FIRST (§30): an existing successful report for the
    // exact identity is the answer — never a second validation execution.
    const key = validationIdentityKey(identity);
    const completed = await this.findValidationReportByIdentity(planID, identity);
    if (completed) return { kind: "completed", report: completed };
    const family = this.validationAdmissions.get(planID) ?? new Map<string, SemanticValidationAdmission>();
    const existing = family.get(key);
    if (existing) {
      const expired = Date.parse(options.now) >= Date.parse(existing.expiresAt);
      if (existing.ownerPid === process.pid && !expired) {
        throw new UltraPlanError(
          "validation_already_running",
          `Semantic validation of this exact identity is already running in this process; wait for it to finish`,
          { identityKey: key },
        );
      }
      // A different (dead) owner, or an expired lease: reclaimable (§32).
    }
    const admission: SemanticValidationAdmission = {
      identityKey: key,
      inputID: identity.inputID,
      manifestID: identity.manifestID,
      manifestRevision: identity.manifestRevision,
      ownerPid: process.pid,
      admittedAt: options.now,
      expiresAt: new Date(Date.parse(options.now) + options.ttlMs).toISOString(),
    };
    family.set(key, admission);
    this.validationAdmissions.set(planID, family);
    return { kind: "admitted", admission };
  }

  async releaseSemanticValidation(planID: PlanID, identityKey: string): Promise<void> {
    this.validationAdmissions.get(planID)?.delete(identityKey);
  }

  async getSemanticValidationAdmission(planID: PlanID, identityKey: string): Promise<SemanticValidationAdmission | undefined> {
    return this.validationAdmissions.get(planID)?.get(identityKey);
  }

  // -------------------------------------------------------------------------
  // Finalization (Phase 2H) — durable derived artifacts, NOT committed Plan
  // Memory: no PlanCommit, no Snapshot, no HEAD movement, no stage change.
  // -------------------------------------------------------------------------

  async saveEvidenceAudit(planID: PlanID, audit: EvidenceAuditSnapshot): Promise<{ audit: EvidenceAuditSnapshot; created: boolean }> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    // The stored hash must recompute (fail closed for hostile/direct calls).
    const { id: _id, createdAt: _createdAt, hash: _hash, ...auditRest } = audit;
    void _id;
    void _createdAt;
    void _hash;
    if (computeEvidenceAuditHashFromRecord(auditRest) !== audit.hash) {
      throw new UltraPlanError("invalid_scope", `EvidenceAudit ${audit.id} content does not recompute to its frozen hash`, {
        auditID: audit.id,
      });
    }
    // Structural consistency (§62): counts, result/blocker agreement, closed
    // vocabulary, fingerprint recompute from entries.
    assertEvidenceAuditInternallyConsistent(audit);
    // Cross-record mirrors (§6): the exact bound input/manifest/report must
    // exist and carry the exact hashes the audit records.
    const input = this.synthesisInputs.get(planID)?.get(audit.synthesisInput.id);
    if (!input || input.hash !== audit.synthesisInput.hash) {
      throw new UltraPlanError(
        "unknown_reference",
        `EvidenceAudit ${audit.id} references missing SynthesisInput ${audit.synthesisInput.id} (or a mismatched hash)`,
        { auditID: audit.id, inputID: audit.synthesisInput.id },
      );
    }
    const manifest = this.synthesisManifests.get(planID)?.get(`${audit.synthesisManifest.id}@${audit.synthesisManifest.revision}`);
    if (!manifest || manifest.hash !== audit.synthesisManifest.hash || manifest.input.id !== input.id) {
      throw new UltraPlanError(
        "unknown_reference",
        `EvidenceAudit ${audit.id} references missing SynthesisManifest ${audit.synthesisManifest.id}@${audit.synthesisManifest.revision} (or a mismatched hash/binding)`,
        { auditID: audit.id, manifestID: audit.synthesisManifest.id },
      );
    }
    const report = this.validationReports.get(planID)?.get(audit.validationReport.id);
    if (!report || report.hash !== audit.validationReport.hash) {
      throw new UltraPlanError(
        "unknown_reference",
        `EvidenceAudit ${audit.id} references missing ValidationReport ${audit.validationReport.id} (or a mismatched hash)`,
        { auditID: audit.id, reportID: audit.validationReport.id },
      );
    }
    // Head binding: the audit is built over the CURRENT HEAD snapshot.
    if (run.headSnapshot !== audit.headSnapshot.id) {
      throw new UltraPlanError(
        "finalization_stale",
        `EvidenceAudit ${audit.id} is bound to snapshot ${audit.headSnapshot.id}, but the run's HEAD is ${run.headSnapshot ?? "none"}; rebuild the audit from current state`,
        { auditID: audit.id, headSnapshot: run.headSnapshot },
      );
    }
    // Entries exact (§62): every entry resolves at its exact revision with
    // matching immutable state, and reports the record's true newest revision.
    for (const entry of audit.entries) {
      const exact = this.getEvidenceSync(planID, { id: entry.ref.id, revision: entry.ref.revision });
      if (!exact) {
        throw new UltraPlanError(
          "unknown_reference",
          `EvidenceAudit ${audit.id} entry ${entry.ref.id}@${entry.ref.revision} does not resolve`,
          { auditID: audit.id, evidenceID: entry.ref.id },
        );
      }
      if (
        exact.confidence !== entry.confidence ||
        exact.criticality !== entry.criticality ||
        exact.freshness !== entry.freshness ||
        exact.status !== entry.status
      ) {
        throw new UltraPlanError("invalid_scope", `EvidenceAudit ${audit.id} entry ${entry.ref.id}@${entry.ref.revision} state does not match the stored record`, {
          auditID: audit.id,
          evidenceID: entry.ref.id,
        });
      }
      const latest = this.getEvidenceSync(planID, { id: entry.ref.id });
      if ((latest?.revision ?? 0) !== entry.latestRevision) {
        throw new UltraPlanError(
          "finalization_stale",
          `EvidenceAudit ${audit.id} entry ${entry.ref.id} records latest @${entry.latestRevision}, but the record is now at @${latest?.revision ?? 0}; rebuild the audit from current state`,
          { auditID: audit.id, evidenceID: entry.ref.id },
        );
      }
    }
    // §48: the audit corresponds to EXACT current state — the reachable
    // fingerprint recomputed from the live store must still match.
    const snapshot = await this.getHeadSnapshot(planID);
    if (!snapshot || snapshot.id !== audit.headSnapshot.id) {
      throw new UltraPlanError("finalization_stale", `EvidenceAudit ${audit.id} cannot be saved: HEAD snapshot is unavailable or moved`, {
        auditID: audit.id,
      });
    }
    const current = await computeCurrentEvidenceStateHash(this, planID, snapshot);
    if (current.hash !== audit.evidenceStateHash) {
      throw new UltraPlanError(
        "finalization_stale",
        `EvidenceAudit ${audit.id} no longer corresponds to current evidence state (fingerprint moved); rebuild the audit`,
        { auditID: audit.id },
      );
    }
    // Idempotency (§17): the same audited state is the SAME audit.
    const identity = evidenceAuditIdentity(audit);
    const existing = await this.findEvidenceAuditByIdentity(planID, identity);
    if (existing) return { audit: existing, created: false };
    if (this.evidenceAudits.get(planID)?.has(audit.id)) {
      throw new UltraPlanError("invalid_scope", `EvidenceAudit ${audit.id} already exists; audits are immutable and ids are never reused`, {
        auditID: audit.id,
      });
    }
    const family = this.evidenceAudits.get(planID) ?? new Map<EvidenceAuditID, EvidenceAuditSnapshot>();
    family.set(audit.id, audit);
    this.evidenceAudits.set(planID, family);
    await this.appendEvent(planID, {
      type: "finalization.audit_saved",
      auditID: audit.id,
      result: audit.result,
      blockers: audit.blockers.length,
      evidenceStateHash: audit.evidenceStateHash,
      hash: audit.hash,
    });
    return { audit, created: true };
  }

  async getEvidenceAudit(planID: PlanID, auditID: EvidenceAuditID): Promise<EvidenceAuditSnapshot | undefined> {
    return this.evidenceAudits.get(planID)?.get(auditID);
  }

  async getCurrentEvidenceAudit(planID: PlanID): Promise<EvidenceAuditSnapshot | undefined> {
    const family = this.evidenceAudits.get(planID);
    if (!family || family.size === 0) return undefined;
    return [...family.values()][family.size - 1];
  }

  async listEvidenceAudits(planID: PlanID): Promise<EvidenceAuditSnapshot[]> {
    return [...(this.evidenceAudits.get(planID)?.values() ?? [])];
  }

  async findEvidenceAuditByIdentity(planID: PlanID, identity: EvidenceAuditIdentity): Promise<EvidenceAuditSnapshot | undefined> {
    for (const audit of this.evidenceAudits.get(planID)?.values() ?? []) {
      const candidate = evidenceAuditIdentity(audit);
      if (
        candidate.headSnapshot === identity.headSnapshot &&
        candidate.inputHash === identity.inputHash &&
        candidate.manifestHash === identity.manifestHash &&
        candidate.reportHash === identity.reportHash &&
        candidate.evidenceStateHash === identity.evidenceStateHash
      ) {
        return audit;
      }
    }
    return undefined;
  }

  async saveFinalPlanCandidate(planID: PlanID, draft: FinalPlanCandidateDraft): Promise<{ candidate: FinalPlanCandidate; created: boolean }> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    // Idempotency on the exact gate identity FIRST (§38): the same successful
    // finalization identity is always the SAME candidate — concurrent
    // requests converge on one revision instead of racing to duplicate one.
    const draftIdentity = candidateRecordIdentity(draft);
    const existing = await this.findFinalPlanCandidateByIdentity(planID, draftIdentity);
    if (existing) return { candidate: existing, created: false };
    // The canonical hash is STORE-computed from the draft (nothing supplied
    // by a caller can diverge from the hashed content).
    const hash = computeFinalPlanCandidateHash(draft);
    // Bound authority (§63): audit pass + clean report + exact input/manifest.
    const audit = this.evidenceAudits.get(planID)?.get(draft.evidenceAudit.id);
    if (!audit || audit.hash !== draft.evidenceAudit.hash) {
      throw new UltraPlanError(
        "unknown_reference",
        `FinalPlanCandidate references missing EvidenceAudit ${draft.evidenceAudit.id} (or a mismatched hash)`,
        { auditID: draft.evidenceAudit.id },
      );
    }
    if (audit.result !== "pass") {
      throw new UltraPlanError("invalid_scope", `FinalPlanCandidate references a ${audit.result} EvidenceAudit; only a passing audit can back a candidate`, {
        auditID: audit.id,
      });
    }
    const input = this.synthesisInputs.get(planID)?.get(draft.synthesisInput.id);
    if (!input || input.hash !== draft.synthesisInput.hash) {
      throw new UltraPlanError(
        "unknown_reference",
        `FinalPlanCandidate references missing SynthesisInput ${draft.synthesisInput.id} (or a mismatched hash)`,
        { inputID: draft.synthesisInput.id },
      );
    }
    const manifest = this.synthesisManifests.get(planID)?.get(`${draft.synthesisManifest.id}@${draft.synthesisManifest.revision}`);
    if (!manifest || manifest.hash !== draft.synthesisManifest.hash || manifest.input.id !== input.id) {
      throw new UltraPlanError(
        "unknown_reference",
        `FinalPlanCandidate references missing SynthesisManifest ${draft.synthesisManifest.id}@${draft.synthesisManifest.revision} (or a mismatched hash/binding)`,
        { manifestID: draft.synthesisManifest.id },
      );
    }
    const report = this.validationReports.get(planID)?.get(draft.semanticValidation.reportID);
    if (!report || report.hash !== draft.semanticValidation.hash || report.result !== "clean") {
      throw new UltraPlanError(
        "unknown_reference",
        `FinalPlanCandidate references missing ValidationReport ${draft.semanticValidation.reportID} (or a mismatched hash / non-clean result)`,
        { reportID: draft.semanticValidation.reportID },
      );
    }
    // Structural mirrors (§63): the candidate is the EXACT projection of its
    // bound authority objects — never a hand-built variant.
    const mismatch = (what: string): UltraPlanError =>
      new UltraPlanError("invalid_scope", `FinalPlanCandidate draft does not mirror its bound ${what}`, { part: what });
    if (draft.baseSnapshot.id !== input.baseSnapshot.id || draft.baseCommit !== input.baseCommit) {
      throw mismatch("base snapshot/commit");
    }
    if (
      draft.architecture.revision !== input.architecture.revision ||
      stableStringify(draft.decisions) !== stableStringify(input.decisions) ||
      stableStringify(draft.constraints) !== stableStringify(input.constraints) ||
      stableStringify(draft.sections) !== stableStringify(input.sections.map((section) => section.ref)) ||
      draft.synthesisManifest.revision !== manifest.revision ||
      stableStringify(draft.implementationOrder) !== stableStringify(manifest.implementationOrder) ||
      stableStringify(draft.limitations) !== stableStringify(manifest.limitations)
    ) {
      throw mismatch("authority objects");
    }
    if (
      draft.validation.blockingQuestions !== 0 ||
      draft.validation.blockingConflicts !== 0 ||
      draft.validation.invalidSections !== 0 ||
      draft.validation.semanticValidation !== "clean" ||
      draft.validation.evidenceAudit !== "pass"
    ) {
      throw mismatch("validation summary");
    }
    // §48/§49/§50 — full currency revalidation INSIDE the mutation block:
    // HEAD unchanged, input current + non-stale, manifest + report + audit
    // current, reachable evidence fingerprint unchanged, and NO live
    // blocking question/conflict. Any drift = finalization_stale, no partial state.
    if (run.headSnapshot !== draft.baseSnapshot.id) {
      throw new UltraPlanError(
        "finalization_stale",
        `The finalization identity is anchored to ${draft.baseSnapshot.id}, but the run's HEAD is ${run.headSnapshot ?? "none"}; re-run finalization from current state`,
        { headSnapshot: run.headSnapshot },
      );
    }
    const latestInput = [...(this.synthesisInputs.get(planID)?.values() ?? [])][
      (this.synthesisInputs.get(planID)?.size ?? 1) - 1
    ];
    if (!latestInput || latestInput.id !== input.id) {
      throw new UltraPlanError(
        "finalization_stale",
        `The finalization identity binds input ${input.id}, which is no longer the latest frozen input`,
        { inputID: input.id },
      );
    }
    const latestManifest = this.latestManifestForInput(planID, input.id);
    if (!latestManifest || latestManifest.id !== manifest.id || latestManifest.revision !== manifest.revision) {
      throw new UltraPlanError(
        "finalization_stale",
        `The finalization identity binds manifest ${manifest.id}@${manifest.revision}, which is no longer current`,
        {},
      );
    }
    const currentReport = await this.findValidationReportByIdentity(planID, {
      inputHash: input.hash,
      manifestHash: manifest.hash,
      validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
    });
    if (!currentReport || currentReport.id !== report.id) {
      throw new UltraPlanError(
        "finalization_stale",
        `The finalization identity binds ValidationReport ${report.id}, which is no longer the current clean report`,
        {},
      );
    }
    const snapshot = await this.getHeadSnapshot(planID);
    if (!snapshot || snapshot.id !== run.headSnapshot) {
      throw new UltraPlanError("finalization_stale", `The finalization identity cannot be frozen: HEAD snapshot is unavailable`, {});
    }
    const currentEvidence = await computeCurrentEvidenceStateHash(this, planID, snapshot);
    if (currentEvidence.hash !== audit.evidenceStateHash) {
      throw new UltraPlanError(
        "finalization_stale",
        `Evidence changed after audit ${audit.id} was built (fingerprint moved); finalization is stale and no candidate may be frozen`,
        { auditID: audit.id },
      );
    }
    const liveQuestions = run.openQuestions.filter((question) => question.blocking && question.status === "open");
    const liveConflicts = run.conflicts.filter((conflict) => conflict.severity === "blocking" && conflict.status === "open");
    if (liveQuestions.length > 0 || liveConflicts.length > 0) {
      throw new UltraPlanError(
        "finalization_stale",
        `Live blockers appeared after audit ${audit.id} (${liveQuestions.length} blocking question(s), ${liveConflicts.length} blocking conflict(s)); finalization is stale and no candidate may be frozen`,
        { auditID: audit.id },
      );
    }
    // In-lock identity assignment (§39): ONE stable candidate family per plan,
    // contiguous immutable revisions — concurrent saves cannot collide.
    const family = this.finalPlanCandidates.get(planID) ?? new Map<string, FinalPlanCandidate>();
    const familyIDs = [...new Set([...family.values()].map((candidate) => candidate.id))];
    const id: FinalPlanCandidateID =
      familyIDs.length > 0
        ? familyIDs.reduce((a, b) => (a < b ? a : b))
        : FinalPlanCandidateIDs.from(nextSequence(familyIDs, FinalPlanCandidateIDs.prefix));
    const revision =
      [...family.values()]
        .filter((candidate) => candidate.id === id)
        .reduce((max, candidate) => Math.max(max, candidate.revision), 0) + 1;
    const candidate: FinalPlanCandidate = { ...draft, id, revision, createdAt: this.now(), hash };
    family.set(`${candidate.id}@${candidate.revision}`, candidate);
    this.finalPlanCandidates.set(planID, family);
    await this.appendEvent(planID, {
      type: "finalization.candidate_saved",
      candidateID: candidate.id,
      revision: candidate.revision,
      auditID: candidate.evidenceAudit.id,
      hash: candidate.hash,
    });
    return { candidate, created: true };
  }

  async getFinalPlanCandidate(planID: PlanID, candidateID: FinalPlanCandidateID, revision?: number): Promise<FinalPlanCandidate | undefined> {
    const family = this.finalPlanCandidates.get(planID);
    if (!family) return undefined;
    if (revision !== undefined) {
      // Exact historical read — never resolved to latest (§56).
      return family.get(`${candidateID}@${revision}`);
    }
    const identity = [...family.values()].filter((candidate) => candidate.id === candidateID);
    if (identity.length === 0) return undefined;
    return identity.reduce((latest, candidate) => (candidate.revision > latest.revision ? candidate : latest));
  }

  async getCurrentFinalPlanCandidate(planID: PlanID): Promise<FinalPlanCandidate | undefined> {
    const family = this.finalPlanCandidates.get(planID);
    if (!family || family.size === 0) return undefined;
    return [...family.values()][family.size - 1];
  }

  async listFinalPlanCandidates(planID: PlanID): Promise<FinalPlanCandidate[]> {
    return [...(this.finalPlanCandidates.get(planID)?.values() ?? [])];
  }

  async findFinalPlanCandidateByIdentity(planID: PlanID, identity: FinalPlanCandidateIdentity): Promise<FinalPlanCandidate | undefined> {
    for (const candidate of this.finalPlanCandidates.get(planID)?.values() ?? []) {
      const bound = candidateRecordIdentity(candidate);
      if (
        bound.headSnapshot === identity.headSnapshot &&
        bound.inputHash === identity.inputHash &&
        bound.manifestHash === identity.manifestHash &&
        bound.reportHash === identity.reportHash &&
        bound.auditHash === identity.auditHash
      ) {
        return candidate;
      }
    }
    return undefined;
  }

  // -- Committed FinalPlans (Phase 2I; read-only outside the engine) ----------

  async getFinalPlan(planID: PlanID, finalPlanID: import("../core/ids.js").FinalPlanID, revision?: number): Promise<FinalPlan | undefined> {
    const family = this.finalPlans.get(planID);
    if (!family) return undefined;
    if (revision !== undefined) {
      // Exact historical read — never resolved to latest (brief §47).
      return family.get(`${finalPlanID}@${revision}`);
    }
    const matching = [...family.values()].filter((plan) => plan.id === finalPlanID);
    if (matching.length === 0) return undefined;
    return matching.reduce((latest, plan) => (plan.revision > latest.revision ? plan : latest));
  }

  async getCurrentFinalPlan(planID: PlanID): Promise<FinalPlan | undefined> {
    const family = this.finalPlans.get(planID);
    if (!family || family.size === 0) return undefined;
    return [...family.values()][family.size - 1];
  }

  async listFinalPlans(planID: PlanID): Promise<FinalPlan[]> {
    return [...(this.finalPlans.get(planID)?.values() ?? [])];
  }

  // -- Runtime handoff (Phase 2J) ---------------------------------------------

  async saveExecutionHandoff(planID: PlanID, handoff: ExecutionHandoff): Promise<{ handoff: ExecutionHandoff; created: boolean }> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    // §17: freeze is allowed only from a COMPLETE, CONSISTENT final state.
    if (run.lifecycle !== "handoff_pending") {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `ExecutionHandoff requires lifecycle=handoff_pending (run is ${run.lifecycle})`,
        { lifecycle: run.lifecycle },
      );
    }
    if (run.stage !== "final") {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `ExecutionHandoff requires stage=final (run is ${run.stage})`,
        { stage: run.stage },
      );
    }
    // Hash must recompute (fail closed for hostile/direct calls).
    if (computeExecutionHandoffHashFromRecord(handoff) !== handoff.hash) {
      throw new UltraPlanError("invalid_scope", `ExecutionHandoff ${handoff.id} content does not recompute to its frozen hash`, {
        handoffID: handoff.id,
      });
    }
    if (handoff.sessionID !== run.sessionID) {
      throw new UltraPlanError(
        "handoff_session_mismatch",
        `ExecutionHandoff binds session ${handoff.sessionID}, but the run's trusted session is ${run.sessionID}`,
        { handoffID: handoff.id },
      );
    }
    if (!run.finalPlan || run.finalPlan.id !== handoff.finalPlan.id || run.finalPlan.revision !== handoff.finalPlan.revision) {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `ExecutionHandoff binds FINAL@${handoff.finalPlan.revision}, but the run's finalPlan pointer disagrees`,
        { handoffID: handoff.id },
      );
    }
    const finalPlan = (await this.getFinalPlan(planID, run.finalPlan.id, run.finalPlan.revision))!;
    if (!finalPlan || finalPlan.status !== "approved") {
      throw new UltraPlanError("handoff_not_allowed", `ExecutionHandoff requires the exact approved FinalPlan record`, { handoffID: handoff.id });
    }
    if (finalPlan.hash !== handoff.finalPlanHash) {
      throw new UltraPlanError(
        "invalid_scope",
        `ExecutionHandoff ${handoff.id} binds FinalPlan hash ${handoff.finalPlanHash.slice(0, 16)}…, but the committed plan hashes to ${finalPlan.hash.slice(0, 16)}…`,
        { handoffID: handoff.id },
      );
    }
    // HEAD == the final PlanCommit, and the final snapshot carries the plan ref.
    if (run.headCommit !== handoff.finalCommit) {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `ExecutionHandoff binds commit ${handoff.finalCommit}, but the run HEAD is ${run.headCommit ?? "none"}`,
        { handoffID: handoff.id },
      );
    }
    if (run.headSnapshot !== handoff.finalSnapshot.id) {
      throw new UltraPlanError("handoff_not_allowed", `ExecutionHandoff snapshot ref disagrees with the run HEAD snapshot`, { handoffID: handoff.id });
    }
    const headCommitRecord = this.commits.get(planID)?.get(handoff.finalCommit);
    if (!headCommitRecord || !headCommitRecord.changes.some((change) => change.kind === "add_final_plan")) {
      throw new UltraPlanError("handoff_not_allowed", `ExecutionHandoff commit ${handoff.finalCommit} is not the final PlanCommit`, { handoffID: handoff.id });
    }
    const commitProposal = this.proposals.get(planID)?.get(headCommitRecord.proposalID);
    if (!commitProposal || commitProposal.type !== "final_plan" || commitProposal.status !== "approved") {
      throw new UltraPlanError("handoff_not_allowed", `ExecutionHandoff requires the approved final_plan Proposal behind the final commit`, { handoffID: handoff.id });
    }
    const finalApproval = await this.findApprovalForProposal(planID, headCommitRecord.proposalID);
    if (!finalApproval) {
      throw new UltraPlanError("handoff_not_allowed", `ExecutionHandoff requires the durable Final Approval`, { handoffID: handoff.id });
    }
    const snapshot = this.snapshots.get(planID)?.get(run.headSnapshot);
    if (!snapshot || snapshot.state.finalPlanRevision !== run.finalPlan.revision) {
      throw new UltraPlanError("handoff_not_allowed", `ExecutionHandoff requires the final snapshot to carry the exact finalPlan ref`, { handoffID: handoff.id });
    }
    // §86: the projection must equal the deterministic FinalPlan projection.
    const projectionMismatch = (what: string): UltraPlanError =>
      new UltraPlanError("invalid_scope", `ExecutionHandoff ${handoff.id} projection differs from the FinalPlan ${what}`, {
        handoffID: handoff.id,
        part: what,
      });
    if (
      handoff.architecture.revision !== finalPlan.architecture.revision ||
      stableStringify(handoff.sections) !== stableStringify(finalPlan.sections) ||
      stableStringify(handoff.criticalDecisions) !== stableStringify(finalPlan.decisions) ||
      stableStringify(handoff.implementationSteps) !== stableStringify(finalPlan.implementationOrder) ||
      stableStringify(handoff.hardConstraints) !==
        stableStringify(finalPlan.constraints.filter((constraint) => constraint.severity === "hard" && constraint.status === "active")) ||
      stableStringify(handoff.knownLimitations) !== stableStringify(finalPlan.limitations.map((limitation) => limitation.statement))
    ) {
      throw projectionMismatch("content");
    }
    // §16 idempotency: ONE canonical handoff per plan.
    const existing = await this.findExecutionHandoffForPlan(planID);
    if (existing) {
      if (existing.id === handoff.id && existing.hash === handoff.hash) {
        return { handoff: existing, created: false };
      }
      throw new UltraPlanError(
        "invalid_scope",
        `Plan ${planID} already has canonical ExecutionHandoff ${existing.id}; one approved FinalPlan corresponds to exactly one handoff`,
        { handoffID: handoff.id, existingID: existing.id },
      );
    }
    const family = this.executionHandoffs.get(planID) ?? new Map<HandoffID, ExecutionHandoff>();
    family.set(handoff.id, handoff);
    this.executionHandoffs.set(planID, family);
    return { handoff, created: true };
  }

  async getExecutionHandoff(planID: PlanID, handoffID: HandoffID): Promise<ExecutionHandoff | undefined> {
    return this.executionHandoffs.get(planID)?.get(handoffID);
  }

  async findExecutionHandoffForPlan(planID: PlanID): Promise<ExecutionHandoff | undefined> {
    const family = this.executionHandoffs.get(planID);
    if (!family || family.size === 0) return undefined;
    return [...family.values()][family.size - 1];
  }

  async prepareHandoffDelivery(
    planID: PlanID,
    input: { handoffID: HandoffID; handoffHash: string; sessionID: string; deliveryKey: string },
  ): Promise<{ delivery: HandoffDelivery; created: boolean }> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    const handoff = this.executionHandoffs.get(planID)?.get(input.handoffID);
    if (!handoff || handoff.hash !== input.handoffHash) {
      throw new UltraPlanError("unknown_reference", `HandoffDelivery references missing ExecutionHandoff ${input.handoffID}`, { handoffID: input.handoffID });
    }
    const existing = this.handoffDeliveries.get(planID)?.get(input.handoffID);
    if (existing) return { delivery: existing, created: false };
    const delivery: HandoffDelivery = {
      planID,
      handoffID: input.handoffID,
      handoffHash: input.handoffHash,
      sessionID: input.sessionID,
      state: "prepared",
      attempt: 0,
      deliveryKey: input.deliveryKey,
      preparedAt: this.now(),
    };
    const family = this.handoffDeliveries.get(planID) ?? new Map<HandoffID, HandoffDelivery>();
    family.set(input.handoffID, delivery);
    this.handoffDeliveries.set(planID, family);
    // §64/§113/§114: emitted on the actual first durable `prepared` transition
    // only — an idempotent replay appends nothing.
    await this.appendEvent(planID, {
      type: "handoff.prepared",
      handoffID: input.handoffID,
      finalPlan: `${handoff.finalPlan.id}@${handoff.finalPlan.revision}`,
      deliveryKey: input.deliveryKey,
    });
    return { delivery, created: true };
  }

  async getHandoffDelivery(planID: PlanID, handoffID: HandoffID): Promise<HandoffDelivery | undefined> {
    return this.handoffDeliveries.get(planID)?.get(handoffID);
  }

  async beginHandoffDispatch(planID: PlanID, handoffID: HandoffID): Promise<{ delivery: HandoffDelivery; acquired: boolean }> {
    const delivery = this.handoffDeliveries.get(planID)?.get(handoffID);
    if (!delivery) {
      throw new UltraPlanError("unknown_reference", `No HandoffDelivery exists for ${handoffID}; prepare it first`, { handoffID });
    }
    if (delivery.state !== "prepared") {
      return { delivery, acquired: false };
    }
    const updated: HandoffDelivery = {
      ...delivery,
      state: "dispatching",
      attempt: delivery.attempt + 1,
      dispatchStartedAt: this.now(),
    };
    this.handoffDeliveries.get(planID)!.set(handoffID, updated);
    await this.appendEvent(planID, {
      type: "handoff.dispatch_started",
      handoffID,
      attempt: updated.attempt,
      deliveryKey: updated.deliveryKey,
    });
    return { delivery: updated, acquired: true };
  }

  async reclaimHandoffDispatch(planID: PlanID, handoffID: HandoffID): Promise<HandoffDelivery> {
    const delivery = this.handoffDeliveries.get(planID)?.get(handoffID);
    if (!delivery) {
      throw new UltraPlanError("unknown_reference", `No HandoffDelivery exists for ${handoffID}`, { handoffID });
    }
    if (delivery.state !== "dispatching") {
      return delivery;
    }
    const updated: HandoffDelivery = { ...delivery, state: "prepared" };
    this.handoffDeliveries.get(planID)!.set(handoffID, updated);
    return updated;
  }

  async recordHandoffDelivered(
    planID: PlanID,
    handoffID: HandoffID,
    receipt: import("../runtime/types.js").HostDeliveryReceipt,
  ): Promise<HandoffDelivery> {
    const delivery = this.handoffDeliveries.get(planID)?.get(handoffID);
    if (!delivery) {
      throw new UltraPlanError("unknown_reference", `No HandoffDelivery exists for ${handoffID}`, { handoffID });
    }
    if (delivery.state === "delivered") {
      return delivery;
    }
    if (delivery.state !== "dispatching") {
      throw new UltraPlanError(
        "handoff_receipt_invalid",
        `A delivery receipt requires state=dispatching (delivery is ${delivery.state}); recover the dispatch first`,
        { handoffID, state: delivery.state },
      );
    }
    // §47/§127: the receipt must describe THIS delivery in THIS trusted session.
    if (receipt.sessionID !== delivery.sessionID) {
      throw new UltraPlanError(
        "handoff_session_mismatch",
        `Host receipt names session ${receipt.sessionID}, but the handoff targets the trusted session ${delivery.sessionID}; refusing delivery confirmation`,
        { handoffID, receiptSession: receipt.sessionID },
      );
    }
    if (!receipt.messageID || receipt.messageID.length === 0) {
      throw new UltraPlanError("handoff_receipt_invalid", `Host receipt carries no message id; delivered requires real host evidence`, { handoffID });
    }
    const updated: HandoffDelivery = {
      ...delivery,
      state: "delivered",
      hostReceipt: { ...receipt },
      deliveredAt: this.now(),
    };
    this.handoffDeliveries.get(planID)!.set(handoffID, updated);
    await this.appendEvent(planID, {
      type: "handoff.delivered",
      handoffID,
      sessionID: receipt.sessionID,
      messageID: receipt.messageID,
      deliveryKey: delivery.deliveryKey,
    });
    return updated;
  }

  async completeHandoffRun(planID: PlanID): Promise<PlanningRun> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    // §83/§121: idempotent — a completed run completes to itself.
    if (run.lifecycle === "completed") {
      return run;
    }
    if (run.lifecycle !== "handoff_pending" || run.stage !== "final") {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `Lifecycle completion requires lifecycle=handoff_pending + stage=final (run is ${run.lifecycle}/${run.stage})`,
        { lifecycle: run.lifecycle, stage: run.stage },
      );
    }
    // §47 preconditions: exact FinalPlan + handoff + DELIVERED delivery with a
    // verified receipt. No receipt → no completion.
    if (!run.finalPlan) {
      throw new UltraPlanError("handoff_not_allowed", `Lifecycle completion requires a committed FinalPlan pointer`, {});
    }
    const finalPlan = await this.getFinalPlan(planID, run.finalPlan.id, run.finalPlan.revision);
    if (!finalPlan || finalPlan.status !== "approved") {
      throw new UltraPlanError("handoff_not_allowed", `Lifecycle completion requires the exact approved FinalPlan record`, {});
    }
    const handoff = await this.findExecutionHandoffForPlan(planID);
    if (!handoff || handoff.finalPlanHash !== finalPlan.hash) {
      throw new UltraPlanError("handoff_not_allowed", `Lifecycle completion requires an ExecutionHandoff binding the exact FinalPlan`, {});
    }
    const delivery = await this.getHandoffDelivery(planID, handoff.id);
    if (!delivery || delivery.state !== "delivered" || !delivery.hostReceipt) {
      throw new UltraPlanError("handoff_delivery_ambiguous", `Lifecycle completion requires a confirmed delivered handoff`, { handoffID: handoff.id });
    }
    if (delivery.hostReceipt.sessionID !== run.sessionID || delivery.sessionID !== run.sessionID) {
      throw new UltraPlanError("handoff_session_mismatch", `Delivery receipt session disagrees with the run's trusted session`, { handoffID: handoff.id });
    }
    // §48: NO PlanCommit/Snapshot/HEAD/FinalPlan change — a pure workflow-state
    // transition published as one run-header write (engine-free by design).
    const updated: PlanningRun = { ...run, lifecycle: "completed", revision: run.revision + 1, updatedAt: this.now() };
    this.runs.set(planID, updated);
    await this.appendEvent(planID, { type: "run.lifecycle_changed", from: run.lifecycle, to: "completed" });
    return updated;
  }

  /**
   * Synchronous evidence reads for the finalization save-time revalidation
   * (which already runs inside the store's mutation path — the async store
   * boundary is for external callers).
   */
  private getEvidenceSync(planID: PlanID, ref: EvidenceRef): Evidence | undefined {
    const registry = this.evidence.get(planID);
    if (!registry) return undefined;
    if (ref.revision !== undefined) return registry.byKey.get(`${ref.id}@${ref.revision}`);
    return registry.latest.get(ref.id);
  }

  async appendEvent(planID: PlanID, detail: PlanEventDetail): Promise<PlanEvent> {    const list = this.events.get(planID) ?? [];
    const event: PlanEvent = {
      seq: list.length + 1,
      planID,
      at: this.now(),
      detail,
    };
    list.push(event);
    this.events.set(planID, list);
    return event;
  }

  async listEvents(planID: PlanID): Promise<PlanEvent[]> {
    return [...(this.events.get(planID) ?? [])];
  }

  async getHeadSnapshot(planID: PlanID): Promise<Snapshot | undefined> {
    const run = this.runs.get(planID);
    if (!run?.headSnapshot) return undefined;
    return this.snapshots.get(planID)?.get(run.headSnapshot);
  }

  async getArchitecture(planID: PlanID, revision?: number): Promise<Architecture | undefined> {
    const registry = this.architectures.get(planID);
    if (!registry) return undefined;
    if (revision !== undefined) return registry.byKey.get(revisionKey("ARCH", revision));
    const highest = Math.max(...registry.highest.values(), 0);
    return highest === 0 ? undefined : registry.byKey.get(revisionKey("ARCH", highest));
  }

  async getSection(planID: PlanID, sectionID: SectionID): Promise<Section | undefined> {
    return this.sections.get(planID)?.get(sectionID);
  }

  async listSections(planID: PlanID): Promise<Section[]> {
    return [...(this.sections.get(planID)?.values() ?? [])];
  }

  async getSectionRevision(
    planID: PlanID,
    ref: SectionRevisionRef,
  ): Promise<SectionRevision | undefined> {
    return this.sectionRevisions.get(planID)?.byKey.get(revisionKey(ref.id, ref.revision));
  }

  async getDecision(planID: PlanID, ref: DecisionRef): Promise<Decision | undefined> {
    return this.decisions.get(planID)?.byKey.get(revisionKey(ref.id, ref.revision));
  }

  async listDecisions(planID: PlanID): Promise<Decision[]> {
    return [...(this.decisions.get(planID)?.latest.values() ?? [])];
  }

  async getProposal(planID: PlanID, proposalID: ProposalID): Promise<Proposal | undefined> {
    return this.proposals.get(planID)?.get(proposalID);
  }

  async getCommit(planID: PlanID, commitID: CommitID): Promise<PlanCommit | undefined> {
    return this.commits.get(planID)?.get(commitID);
  }

  async listCommits(planID: PlanID): Promise<PlanCommit[]> {
    return [...(this.commits.get(planID)?.values() ?? [])];
  }

  async saveApproval(planID: PlanID, approval: Approval): Promise<Approval> {
    let registry = this.approvals.get(planID);
    if (!registry) {
      registry = new Map<ApprovalID, Approval>();
      this.approvals.set(planID, registry);
    }
    if (registry.has(approval.id)) {
      const existing = registry.get(approval.id) as Approval;
      if (approvalEquals(existing, approval)) return existing;
      throw new UltraPlanError(
        "approval_mismatch",
        `Approval id ${approval.id} is already bound to a different authorization; approval records are immutable`,
        { approvalID: approval.id },
      );
    }
    const existingForProposal = await this.findApprovalForProposal(planID, approval.proposalID);
    if (existingForProposal) {
      if (approvalEquals(existingForProposal, approval)) return existingForProposal;
      throw new UltraPlanError(
        "approval_mismatch",
        `Proposal ${approval.proposalID} already has a conflicting authorization; one proposal has exactly one approval`,
        { proposalID: approval.proposalID },
      );
    }
    registry.set(approval.id, approval);
    await this.appendEvent(planID, {
      type: "approval.recorded",
      approvalID: approval.id,
      proposalID: approval.proposalID,
      proposalHash: approval.proposalHash,
    });
    return approval;
  }

  async getApproval(planID: PlanID, approvalID: ApprovalID): Promise<Approval | undefined> {
    return this.approvals.get(planID)?.get(approvalID);
  }

  async findApprovalForProposal(planID: PlanID, proposalID: ProposalID): Promise<Approval | undefined> {
    for (const approval of this.approvals.get(planID)?.values() ?? []) {
      if (approval.proposalID === proposalID) return approval;
    }
    return undefined;
  }

  async listApprovals(planID: PlanID): Promise<Approval[]> {
    return [...(this.approvals.get(planID)?.values() ?? [])];
  }

  async putEvidence(planID: PlanID, evidence: Evidence): Promise<void> {
    let registry = this.evidence.get(planID);
    if (!registry) {
      registry = createRegistry<Evidence>();
      this.evidence.set(planID, registry);
    }
    const key = revisionKey(evidence.id, evidence.revision);
    if (registry.byKey.has(key)) {
      throw new UltraPlanError(
        "duplicate_revision",
        `Evidence ${evidence.id}@${evidence.revision} already exists; revisions are immutable`,
        { evidenceID: evidence.id, revision: evidence.revision },
      );
    }
    assertRevisionMonotonic(registry.highest.get(evidence.id), evidence.revision, `evidence ${evidence.id}`);
    registry.byKey.set(key, evidence);
    registry.latest.set(evidence.id, evidence);
    registry.highest.set(evidence.id, evidence.revision);
  }

  async listEvidence(planID: PlanID): Promise<Evidence[]> {
    return [...(this.evidence.get(planID)?.latest.values() ?? [])];
  }

  async getEvidence(planID: PlanID, ref: EvidenceRef): Promise<Evidence | undefined> {
    const registry = this.evidence.get(planID);
    if (!registry) return undefined;
    if (ref.revision !== undefined) {
      return registry.byKey.get(revisionKey(ref.id, ref.revision));
    }
    return registry.latest.get(ref.id);
  }

  async saveProposal(planID: PlanID, proposal: Proposal): Promise<Proposal> {
    let registry = this.proposals.get(planID);
    if (!registry) {
      registry = new Map<ProposalID, Proposal>();
      this.proposals.set(planID, registry);
    }
    if (registry.has(proposal.id)) {
      throw new UltraPlanError(
        "proposal_immutable",
        `Proposal ${proposal.id} already exists; proposals are frozen intent records — supersede with a new proposal instead`,
        { proposalID: proposal.id },
      );
    }
    registry.set(proposal.id, proposal);
    return proposal;
  }

  async listProposals(planID: PlanID): Promise<Proposal[]> {
    return [...(this.proposals.get(planID)?.values() ?? [])];
  }

  async transitionProposalStatus(
    planID: PlanID,
    proposalID: ProposalID,
    from: Proposal["status"],
    to: Proposal["status"],
  ): Promise<Proposal> {
    const existing = await this.getProposal(planID, proposalID);
    if (!existing) {
      throw new UltraPlanError("unknown_reference", `Proposal ${proposalID} does not exist`, {
        proposalID,
      });
    }
    if (existing.status !== from) {
      throw new UltraPlanError(
        "proposal_status_invalid",
        `Proposal ${proposalID} is ${existing.status}, expected ${from}`,
        { proposalID, actual: existing.status, expected: from },
      );
    }
    const updated: Proposal = { ...existing, status: to };
    this.proposals.get(planID)?.set(proposalID, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Transaction engine (Phase 2B1) — the single committed-memory authority
  // -------------------------------------------------------------------------

  /**
   * Phase 2I §25/§26: resolve the FinalizationGate's inputs SYNCHRONOUSLY from
   * the registries so the mandatory second gate can run inside the engine's
   * atomic section (no awaits — the atomicity model forbids interleaving
   * points here). Same pure `evaluateFinalizationGate` the controller uses:
   * there is exactly ONE finalization authority. The trio resolution mirrors
   * the controller's (latest input → its latest manifest → the report bound to
   * that identity), so the gate's staleness classification + the exact
   * identity match (§27) are computed over the same objects.
   */
  private resolveGateDepsSync(run: PlanningRun): FinalizationGateDeps {
    const snapshot = run.headSnapshot ? this.snapshots.get(run.id)?.get(run.headSnapshot) : undefined;
    const architectureRevision = snapshot?.state.architectureRevision;
    const architectureRecord =
      architectureRevision !== undefined
        ? this.architectures.get(run.id)?.byKey.get(revisionKey("ARCH", architectureRevision))
        : undefined;
    const sections = (snapshot?.state.sectionRoots ?? []).map((root) => {
      const live = this.sections.get(run.id)?.get(root.id);
      const approvedRevision = root.approvedRevision ?? live?.approvedRevision ?? 0;
      const revisionRecord =
        approvedRevision > 0
          ? this.sectionRevisions.get(run.id)?.byKey.get(revisionKey(root.id, approvedRevision))
          : undefined;
      return { root, live, revision: { approvedRevision, record: revisionRecord } };
    });
    const headDecisions = snapshot
      ? Object.entries(snapshot.state.decisionRevisions)
          .map(([id, revision]) => this.decisions.get(run.id)?.byKey.get(revisionKey(id, revision)))
          .filter((decision): decision is NonNullable<typeof decision> => decision !== undefined)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : [];
    const records: ReachabilityRecords = {
      architecture: architectureRecord,
      sectionRevisions: sections
        .map((section) => section.revision.record)
        .filter((record): record is NonNullable<typeof record> => record !== undefined),
      decisions: headDecisions,
    };
    const currentEvidenceStateHash = snapshot
      ? computeEvidenceStateHashFromRecords(records, snapshot, (ref) => this.resolveEvidenceCitationSync(run.id, ref)).hash
      : undefined;
    const inputs = this.synthesisInputs.get(run.id);
    const input = inputs && inputs.size > 0 ? [...inputs.values()][inputs.size - 1] : undefined;
    const manifest = input ? this.latestManifestForInput(run.id, input.id) : undefined;
    const report =
      input && manifest
        ? this.findValidationReportByIdentitySync(run.id, {
            inputHash: input.hash,
            manifestHash: manifest.hash,
            validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
          })
        : undefined;
    const audit =
      snapshot && input && manifest && report && currentEvidenceStateHash !== undefined
        ? this.findEvidenceAuditByIdentitySync(run.id, {
            headSnapshot: snapshot.id,
            inputHash: input.hash,
            manifestHash: manifest.hash,
            reportHash: report.hash,
            evidenceStateHash: currentEvidenceStateHash,
          }) ?? this.latestEvidenceAuditSync(run.id)
        : this.latestEvidenceAuditSync(run.id);
    return {
      run,
      snapshot,
      architecture: { ref: run.architecture, record: architectureRecord },
      sections,
      input,
      manifest,
      report,
      audit,
      currentEvidenceStateHash,
    };
  }

  /** Synchronous evidence resolution mirroring getEvidence's exact semantics. */
  private resolveEvidenceCitationSync(planID: PlanID, ref: EvidenceRef): ResolvedEvidenceCitation {
    const registry = this.evidence.get(planID);
    if (!registry) return {};
    const exact =
      ref.revision !== undefined ? registry.byKey.get(`${ref.id}@${ref.revision}`) : registry.latest.get(ref.id);
    if (!exact) return {};
    const latest = registry.latest.get(exact.id);
    return { evidence: exact, latestRevision: latest?.revision ?? exact.revision };
  }

  /** Synchronous identity lookup for validation reports (mirror of the async read). */
  private findValidationReportByIdentitySync(
    planID: PlanID,
    identity: { inputHash: string; manifestHash: string; validatorProtocol: string },
  ): ValidationReport | undefined {
    for (const report of this.validationReports.get(planID)?.values() ?? []) {
      if (
        report.inputHash === identity.inputHash &&
        report.manifestHash === identity.manifestHash &&
        report.validatorProtocol === identity.validatorProtocol
      ) {
        return report;
      }
    }
    return undefined;
  }

  /** Synchronous identity lookup for evidence audits (mirror of the async read). */
  private findEvidenceAuditByIdentitySync(
    planID: PlanID,
    identity: { headSnapshot: string; inputHash: string; manifestHash: string; reportHash: string; evidenceStateHash: string },
  ): EvidenceAuditSnapshot | undefined {
    for (const audit of this.evidenceAudits.get(planID)?.values() ?? []) {
      const bound = evidenceAuditIdentity(audit);
      if (
        bound.headSnapshot === identity.headSnapshot &&
        bound.inputHash === identity.inputHash &&
        bound.manifestHash === identity.manifestHash &&
        bound.reportHash === identity.reportHash &&
        bound.evidenceStateHash === identity.evidenceStateHash
      ) {
        return audit;
      }
    }
    return undefined;
  }

  /**
   * The newest audit (insertion order) — the second gate's fallback so a
   * drifted world classifies STALE (the audit is bound to another
   * authoritative state) instead of BLOCKED (audit missing). Refusal is the
   * same; the reason tells the caller to re-resolve, not to re-run finalization
   * blindly (Phase 2I §28: evidence drift after Approval ⇒ finalization stale).
   */
  private latestEvidenceAuditSync(planID: PlanID): EvidenceAuditSnapshot | undefined {
    const family = this.evidenceAudits.get(planID);
    if (!family || family.size === 0) return undefined;
    return [...family.values()][family.size - 1];
  }

  async commitTransaction(input: CommitTransactionInput): Promise<PlanCommit> {
    // Async gather phase — after this, validation → staging → publication run
    // synchronously and cannot be interleaved (in-memory atomicity).
    const run = await this.getRun(input.planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${input.planID} does not exist`, {
        planID: input.planID,
      });
    }
    const proposal = await this.getProposal(input.planID, input.proposalID);
    if (!proposal) {
      throw new UltraPlanError(
        "unknown_reference",
        `Proposal ${input.proposalID} does not exist in run ${input.planID}`,
        { proposalID: input.proposalID },
      );
    }
    const approval = await this.getApproval(input.planID, input.approvalID);
    if (!approval) {
      throw new UltraPlanError(
        "approval_not_found",
        `Approval ${input.approvalID} does not exist in run ${input.planID}`,
        { approvalID: input.approvalID },
      );
    }

    return this.executeTransaction(run, proposal, approval);
  }

  /**
   * Synchronous validate → stage → validate-staged → publish. Any throw leaves
   * state untouched (nothing has been written until publishTransaction).
   */
  private executeTransaction(run: PlanningRun, proposal: Proposal, approval: Approval): PlanCommit {
    // -- Idempotent replay (spec §22 / brief §22) -----------------------------
    const existingCommitID = this.commitByProposal.get(`${run.id}:${proposal.id}`);
    if (existingCommitID !== undefined) {
      const existing = this.commits.get(run.id)?.get(existingCommitID);
      if (existing && existing.approvalID === approval.id) {
        return existing; // exact retry → the same PlanCommit, zero duplicates
      }
      throw new UltraPlanError(
        "already_committed",
        `Proposal ${proposal.id} was already committed with a different approval`,
        { proposalID: proposal.id, committedWith: existing?.approvalID },
      );
    }

    // -- Full validation BEFORE any mutation ----------------------------------
    const failures: TransactionFailure[] = [];
    const addFailure = (code: string, message: string, detail?: Record<string, unknown>): void => {
      failures.push({ code, message, detail });
    };

    if (run.lifecycle !== "active") {
      addFailure(
        "run_not_active",
        `PlanningRun ${run.id} is ${run.lifecycle}; commits require an active run`,
        { lifecycle: run.lifecycle },
      );
    }
    if (proposal.status !== "awaiting_approval") {
      addFailure(
        "proposal_not_awaiting_approval",
        `Proposal ${proposal.id} is ${proposal.status}; only an awaiting_approval proposal can commit`,
        { status: proposal.status },
      );
    }
    if (
      approval.proposalID !== proposal.id ||
      approval.proposalRevision !== proposal.revision ||
      approval.proposalHash !== proposal.hash
    ) {
      addFailure("approval_binding_mismatch", "Approval does not bind the exact proposal revision/hash", {
        approval: { proposalID: approval.proposalID, proposalRevision: approval.proposalRevision },
        proposal: { proposalID: proposal.id, proposalRevision: proposal.revision },
      });
    }
    if (approval.actor !== "user") {
      addFailure("approval_binding_mismatch", "Approval actor must be the user", { actor: approval.actor });
    }
    if (computeProposalHash(proposal) !== proposal.hash) {
      addFailure("proposal_hash_mismatch", "Proposal content no longer recomputes to its frozen hash", {
        proposalID: proposal.id,
      });
    }
    if (proposal.createdFrom.id !== run.headSnapshot) {
      addFailure(
        "head_snapshot_mismatch",
        `Proposal base ${proposal.createdFrom.id} is stale: run HEAD is ${run.headSnapshot}; supersede the proposal and re-approve`,
        { createdFrom: proposal.createdFrom.id, headSnapshot: run.headSnapshot },
      );
    }

    // Phase 2C completion boundary: `complete_architecture` exists ONLY inside
    // an architecture_completion proposal (any other proposal type carrying it
    // is a contract violation), and an architecture_completion proposal must
    // carry at least one.
    const hasCompletionChange = proposal.changes.some((c) => c.kind === "complete_architecture");
    if (proposal.type === "architecture_completion" && !hasCompletionChange) {
      addFailure(
        "completion_missing",
        "architecture_completion proposals must contain a complete_architecture change targeting the resulting Architecture revision",
        { proposalID: proposal.id },
      );
    }
    if (proposal.type !== "architecture_completion" && hasCompletionChange) {
      addFailure(
        "completion_type_invalid",
        `complete_architecture is only valid inside an architecture_completion proposal (got ${proposal.type})`,
        { proposalID: proposal.id, type: proposal.type },
      );
    }

    // Phase 2D decomposition boundary: add_section / select_initial_section
    // belong to the INITIAL detail decomposition only. The commit re-checks
    // everything the freeze validated (hostile/direct engine calls, stale
    // state) — stage, exact architecture scope, initial-only, full DAG.
    const hasDecompositionChanges = proposal.changes.some(
      (c) => c.kind === "add_section" || c.kind === "select_initial_section",
    );
    if (hasDecompositionChanges) {
      if (run.stage !== "detail") {
        addFailure(
          "decomposition_stage_invalid",
          `Section decomposition requires stage=detail (run is in ${run.stage})`,
          { stage: run.stage },
        );
      }
      const scope = proposal.scope;
      const scopeRevision = "revision" in scope ? scope.revision : undefined;
      if (
        scope.id !== "ARCH" ||
        scopeRevision === undefined ||
        !run.architecture ||
        run.architecture.revision !== scopeRevision
      ) {
        addFailure(
          "architecture_scope_mismatch",
          `Decomposition is scoped to ARCH@${String(scopeRevision)}, but the run's committed Architecture is ${run.architecture ? `ARCH@${run.architecture.revision}` : "missing"}`,
          { scope: { id: scope.id, revision: scopeRevision }, architecture: run.architecture },
        );
      }
      if (run.sections.length > 0) {
        addFailure(
          "decomposition_already_committed",
          "An initial Section DAG already exists; decomposition is initial-only — changes require an amendment proposal",
          { sections: run.sections.length },
        );
      }
    }

    // Phase 2E1 checkpoint boundary: `add_section_revision` is the FIRST
    // checkpoint of a revision-less Section only. The commit re-checks
    // everything the freeze validated (hostile/direct engine calls): stage,
    // section-scoped proposal targeting the committed Section, no prior
    // revisions, exactly one section-revision change per proposal.
    const hasFirstCheckpoint = proposal.changes.some((c) => c.kind === "add_section_revision");
    if (hasFirstCheckpoint) {
      if (run.stage !== "detail") {
        addFailure(
          "checkpoint_stage_invalid",
          `Section checkpoints require stage=detail (run is in ${run.stage})`,
          { stage: run.stage },
        );
      }
      if ("revision" in proposal.scope) {
        addFailure(
          "checkpoint_scope_invalid",
          "A Section checkpoint proposal is scoped to the exact SectionRef, not the Architecture",
          { scope: { id: proposal.scope.id, revision: proposal.scope.revision } },
        );
      } else if (!run.sections.some((ref) => ref.id === proposal.scope.id)) {
        addFailure(
          "checkpoint_scope_invalid",
          `Checkpoint scope ${proposal.scope.id} is not a committed Section of run ${run.id}`,
          { sectionID: proposal.scope.id },
        );
      }
      if (proposal.changes.some((c) => c.kind === "amend_section")) {
        addFailure(
          "change_invalid",
          "A checkpoint proposal carries exactly one section-revision change — add_section_revision (first) or amend_section (later), never both",
          { proposalID: proposal.id },
        );
      }
    }
    // §21: the engine independently validates that a checkpoint change
    // targets the Proposal scope (design_checkpoint only — reopen amendments
    // are a separate proposal type), and §7: when the run has an active
    // Section focus, the checkpoint targets activeWork — never another
    // model-chosen section.
    for (const change of proposal.changes) {
      if (
        proposal.type === "design_checkpoint" &&
        (change.kind === "add_section_revision" || change.kind === "amend_section") &&
        !("revision" in proposal.scope)
      ) {
        const targetID = change.kind === "add_section_revision" ? change.revision.sectionID : change.supersedes.id;
        if (targetID !== proposal.scope.id) {
          addFailure(
            "checkpoint_scope_invalid",
            `Checkpoint change targets ${targetID}, but the proposal is scoped to ${proposal.scope.id}`,
            { sectionID: targetID, scope: proposal.scope.id },
          );
        }
        if (run.activeWork?.type === "section" && run.activeWork.id !== targetID) {
          addFailure(
            "checkpoint_scope_invalid",
            `Checkpoint target ${targetID} is not the run's active work (${run.activeWork.id}); the checkpoint targets activeWork`,
            { sectionID: targetID, activeWork: run.activeWork.id },
          );
        }
      }
    }

    // Phase 2E2 section-completion boundary: `complete_section` exists ONLY
    // inside a section_completion proposal, and a section_completion proposal
    // must carry one (mirror of the Phase 2C architecture boundary). The
    // commit re-checks stage + exact scope targeting (hostile/direct engine
    // calls included).
    const hasSectionCompletion = proposal.changes.some((c) => c.kind === "complete_section");
    if (proposal.type === "section_completion" && !hasSectionCompletion) {
      addFailure(
        "section_completion_missing",
        "section_completion proposals must contain a complete_section change targeting the exact current approved checkpoint",
        { proposalID: proposal.id },
      );
    }
    if (proposal.type !== "section_completion" && hasSectionCompletion) {
      addFailure(
        "section_completion_type_invalid",
        `complete_section is only valid inside a section_completion proposal (got ${proposal.type})`,
        { proposalID: proposal.id, type: proposal.type },
      );
    }
    if (hasSectionCompletion) {
      if (run.stage !== "detail") {
        addFailure(
          "section_completion_stage_invalid",
          `Section completion requires stage=detail (run is in ${run.stage})`,
          { stage: run.stage },
        );
      }
      if ("revision" in proposal.scope) {
        addFailure(
          "checkpoint_scope_invalid",
          "A Section completion proposal is scoped to the exact SectionRef, not the Architecture",
          { scope: { id: proposal.scope.id, revision: proposal.scope.revision } },
        );
      }
      for (const change of proposal.changes) {
        if (change.kind === "complete_section" && !("revision" in proposal.scope) && change.target.id !== proposal.scope.id) {
          addFailure(
            "completion_target_mismatch",
            `Section completion targets ${change.target.id}, but the proposal is scoped to ${proposal.scope.id}`,
            { sectionID: change.target.id, scope: proposal.scope.id },
          );
        }
      }
    }

    // Phase 2G reopen boundary: `reopen_section` exists ONLY inside amendment
    // proposals (never the generic proposal vocabulary), from synthesis with a
    // semantic_validation reason or detail with a dependency_review reason.
    // The commit re-checks everything the freeze validated — exact target
    // revision, report binding (id/hash/findings), report identity currency,
    // target section state — so hostile/direct engine calls fail closed.
    const hasReopenChanges = proposal.changes.some((c) => c.kind === "reopen_section");
    if (hasReopenChanges) {
      if (proposal.type !== "amendment") {
        addFailure(
          "reopen_type_invalid",
          `reopen_section is only valid inside an amendment proposal (got ${proposal.type})`,
          { proposalID: proposal.id, type: proposal.type },
        );
      }
      for (const change of proposal.changes) {
        if (change.kind !== "reopen_section") continue;
        if ("revision" in proposal.scope || proposal.scope.id !== change.target.id) {
          addFailure(
            "reopen_scope_invalid",
            `A reopen proposal is scoped to the exact target Section ${change.target.id} (scope is ${proposal.scope.id})`,
            { sectionID: change.target.id, scope: proposal.scope.id },
          );
        }
        if (change.reason.type === "semantic_validation" && run.stage !== "synthesis") {
          addFailure(
            "reopen_stage_invalid",
            `A semantic-validation reopen requires stage=synthesis (run is in ${run.stage})`,
            { stage: run.stage },
          );
        }
        if (change.reason.type === "dependency_review" && run.stage !== "detail") {
          addFailure(
            "reopen_stage_invalid",
            `A dependency-review reopen requires stage=detail (run is in ${run.stage})`,
            { stage: run.stage },
          );
        }
        const section = this.sections.get(run.id)?.get(change.target.id);
        if (!section) {
          addFailure("unknown_reference", `Section ${change.target.id} is not committed`);
        } else if (
          section.status !== "approved" ||
          section.currentRevision === undefined ||
          section.approvedRevision === undefined ||
          section.currentRevision !== section.approvedRevision ||
          change.target.revision !== section.approvedRevision
        ) {
          addFailure(
            "reopen_target_invalid",
            `Section ${change.target.id} must be reopened at its exact current approved revision (status ${section.status}, current ${section.currentRevision ?? "none"}, approved ${section.approvedRevision ?? "none"}, target @${change.target.revision})`,
            { sectionID: change.target.id, target: change.target.revision },
          );
        } else if (change.reason.type === "dependency_review" && section.validation !== "needs_review") {
          addFailure(
            "reopen_target_invalid",
            `A dependency-review reopen requires the target to be validation=needs_review (${change.target.id} is ${section.validation})`,
            { sectionID: change.target.id, validation: section.validation },
          );
        }
        if (change.reason.type === "semantic_validation") {
          const report = this.validationReports.get(run.id)?.get(change.reason.reportID);
          if (!report) {
            addFailure("unknown_reference", `ValidationReport ${change.reason.reportID} does not exist in run ${run.id}`);
          } else {
            if (report.hash !== change.reason.reportHash) {
              addFailure(
                "reopen_report_mismatch",
                `The reopen binds report hash ${change.reason.reportHash.slice(0, 16)}…, but ${report.id} hashes to ${report.hash.slice(0, 16)}…`,
                { reportID: report.id },
              );
            }
            if (report.result !== "findings") {
              addFailure(
                "reopen_reason_invalid",
                `${report.id} is clean; a clean report cannot authorize a reopen`,
                { reportID: report.id },
              );
            }
            const selectedIDs = change.reason.findingIDs;
            const knownFindings = new Set(report.findings.map((finding) => finding.id));
            if (
              selectedIDs.length === 0 ||
              selectedIDs.some((findingID) => !knownFindings.has(findingID))
            ) {
              addFailure(
                "reopen_reason_invalid",
                `The reopen cites findings that do not exist in ${report.id}`,
                { reportID: report.id },
              );
            }
            const affectsTarget = report.findings.some(
              (finding) =>
                selectedIDs.includes(finding.id) &&
                (finding.scope.sections ?? []).some(
                  (scopeSection) => scopeSection.id === change.target.id && scopeSection.revision === change.target.revision,
                ),
            );
            if (!affectsTarget) {
              addFailure(
                "reopen_target_unsupported",
                `No selected finding of ${report.id} affects ${change.target.id}@${change.target.revision}; an Architecture-level finding cannot be resolved through a Section reopen`,
                { reportID: report.id, sectionID: change.target.id, revision: change.target.revision },
              );
            }
            const currentIdentity = this.currentSynthesisIdentity(run.id);
            if (
              !currentIdentity ||
              currentIdentity.inputHash !== report.inputHash ||
              currentIdentity.manifestHash !== report.manifestHash
            ) {
              addFailure(
                "reopen_report_stale",
                `ValidationReport ${report.id} no longer binds the current synthesis identity; rerun semantic validation after the rework cycle`,
                { reportID: report.id },
              );
            }
          }
        }
      }
    }

    // Phase 2I final-plan boundary (brief §5/§16/§25-§33): `add_final_plan`
    // exists ONLY inside a final_plan proposal, and a final_plan proposal
    // carries EXACTLY ONE change — final approval must never smuggle in design
    // changes. The commit re-checks everything the freeze validated, then
    // reruns the MANDATORY SECOND FINALIZATION GATE (§25/§26 — never trusting
    // the pre-Proposal result, and never trusting a merely generic pass: the
    // current identity must EQUAL the user-approved candidate's identity, §27)
    // and proves the frozen payload is the exact candidate projection (§33).
    // A hostile DIRECT commitTransaction fails exactly like the controller path.
    const hasFinalPlanChange = proposal.changes.some((c) => c.kind === "add_final_plan");
    if (proposal.type === "final_plan" || hasFinalPlanChange) {
      if (proposal.type !== "final_plan") {
        addFailure(
          "final_plan_type_invalid",
          `add_final_plan is only valid inside a final_plan proposal (got ${proposal.type})`,
          { proposalID: proposal.id, type: proposal.type },
        );
      } else {
        if (proposal.changes.length !== 1 || !hasFinalPlanChange) {
          addFailure(
            "final_plan_change_invalid",
            "A final_plan proposal carries exactly one add_final_plan change — final user approval must not add decisions, constraints, questions, section amendments, reopens, or architecture changes",
            { proposalID: proposal.id, changes: proposal.changes.length },
          );
        }
        if (run.stage !== "synthesis") {
          addFailure(
            "final_plan_stage_invalid",
            `The Final PlanCommit requires stage=synthesis (run is in ${run.stage}); stage and lifecycle move ONLY in this commit`,
            { stage: run.stage },
          );
        }
        if (run.finalPlan !== undefined || (this.finalPlans.get(run.id)?.size ?? 0) > 0) {
          addFailure(
            "final_plan_already_exists",
            `Run ${run.id} already has a committed FinalPlan; Phase 2I is initial-only — a handoff-pending run is never reopened through finalization`,
            { finalPlan: run.finalPlan },
          );
        }
        const change = proposal.changes.find(
          (c): c is Extract<ProposalChange, { kind: "add_final_plan" }> => c.kind === "add_final_plan",
        );
        if (change) {
          const scope = proposal.scope;
          if (
            !("revision" in scope) ||
            scope.id !== "ARCH" ||
            scope.revision !== change.finalPlan.architecture.revision
          ) {
            addFailure(
              "final_plan_scope_invalid",
              `The final_plan proposal is scoped to the exact candidate Architecture ARCH@${change.finalPlan.architecture.revision}, not ${scope.id}${"revision" in scope ? `@${scope.revision}` : ""}`,
              { proposalID: proposal.id },
            );
          }
          const binding = change.finalPlan.finalPlanCandidate;
          const candidate = this.finalPlanCandidates.get(run.id)?.get(`${binding.id}@${binding.revision}`);
          if (!candidate || candidate.hash !== binding.hash) {
            addFailure(
              "unknown_reference",
              `The final_plan proposal binds FinalPlanCandidate ${binding.id}@${binding.revision}, which does not resolve (or hashes differently)`,
              { candidateID: binding.id, revision: binding.revision },
            );
          } else {
            if (computeFinalPlanCandidateHashFromRecord(candidate) !== candidate.hash) {
              addFailure(
                "invalid_scope",
                `FinalPlanCandidate ${candidate.id}@${candidate.revision} content does not recompute to its frozen hash`,
                { candidateID: candidate.id },
              );
            }
            // §33: the frozen payload must be the EXACT deterministic
            // projection of the bound candidate — the same shared mapping the
            // Proposal freeze used. Any authority-bearing difference (order,
            // limitations, section revisions, constraints, provenance hashes,
            // FinalPlan id/revision) is rejected here.
            const recomputed = buildFinalPlanFromCandidate({
              candidate,
              assign: { id: change.finalPlan.id, revision: change.finalPlan.revision },
            });
            if (stableStringify(recomputed) !== stableStringify(change.finalPlan)) {
              addFailure(
                "final_proposal_stale",
                `The frozen FinalPlan payload is not the exact deterministic projection of candidate ${candidate.id}@${candidate.revision}; a tampered or stale Final Proposal can never commit`,
                { proposalID: proposal.id, candidateID: candidate.id },
              );
            }
            // §25/§26: rerun the deterministic gate against CURRENT state.
            const gate = evaluateFinalizationGate(this.resolveGateDepsSync(run));
            if (gate.result === "stale") {
              addFailure(
                "finalization_stale",
                `The second FinalizationGate is STALE (${gate.stale.map((entry) => entry.code).join(", ")}); approval does not authorize subsequently changed state`,
                { stale: gate.stale },
              );
            } else if (gate.result === "blocked") {
              addFailure(
                "finalization_blocked",
                `The second FinalizationGate BLOCKS (${gate.blockers.map((blocker) => blocker.code).join(", ")}); approval does not bypass live blockers`,
                { blockers: gate.blockers },
              );
            } else if (!finalizationIdentityMatchesCandidate(gate.identity, candidate)) {
              // §27: a generic pass with a DIFFERENT identity never authorizes
              // the old Proposal — new candidate, new Proposal, new Approval.
              addFailure(
                "final_proposal_stale",
                `The current gate identity does not equal the user-approved candidate identity (${candidate.id}@${candidate.revision}); the Final Proposal is stale and requires a new preparation + approval`,
                { proposalID: proposal.id, candidateID: candidate.id },
              );
            }
            // §32: every exact ref the FinalPlan freezes must resolve.
            if (
              this.architectures.get(run.id)?.byKey.get(revisionKey("ARCH", change.finalPlan.architecture.revision)) ===
              undefined
            ) {
              addFailure("unknown_reference", `FinalPlan architecture ARCH@${change.finalPlan.architecture.revision} does not resolve`, {});
            }
            for (const section of change.finalPlan.sections) {
              if (this.sectionRevisions.get(run.id)?.byKey.get(revisionKey(section.id, section.revision)) === undefined) {
                addFailure("unknown_reference", `FinalPlan section ${section.id}@${section.revision} does not resolve`, {
                  sectionID: section.id,
                });
              }
            }
            for (const decision of change.finalPlan.decisions) {
              if (this.decisions.get(run.id)?.byKey.get(revisionKey(decision.id, decision.revision)) === undefined) {
                addFailure("unknown_reference", `FinalPlan decision ${decision.id}@${decision.revision} does not resolve`, {
                  decisionID: decision.id,
                });
              }
            }
          }
        }
        // The dedicated failure codes surface as the TOP-LEVEL error (not
        // buried in transaction_validation_failed) so callers can react to
        // stale-vs-blocked exactly like the controller paths do.
        if (failures.length > 0) {
          const first = failures[0];
          if (first) {
            throw new UltraPlanError(
              first.code as import("../core/errors.js").UltraPlanErrorCode,
              `Final Plan transaction refused: ${first.message}`,
              { failures },
            );
          }
        }
      }
    }

    // Stage on clones; apply each change; collect per-change failures.
    const staged: StagedState = {
      architectures: cloneRegistry(emptyRegistryOr(this.architectures, run.id)),
      sections: new Map(this.sections.get(run.id) ?? []),
      sectionRevisions: cloneRegistry(emptyRegistryOr(this.sectionRevisions, run.id)),
      decisions: cloneRegistry(emptyRegistryOr(this.decisions, run.id)),
      openQuestions: run.openQuestions.map((q) => ({ ...q })),
      constraints: run.constraints.map((c) => ({ ...c })),
      stage: run.stage,
      lifecycle: run.lifecycle,
      runArchitecture: run.architecture,
      runSections: run.sections.map((ref) => ({ id: ref.id })),
      runDecisions: [...run.decisions],
      runFinalPlan: run.finalPlan,
      sectionsStartedEmpty: run.sections.length === 0,
      activeWork: run.activeWork,
      addedSections: [],
      addedFinalPlans: [],
      committedChanges: [],
      revised: [],
      resolvedQuestions: [],
    };

    for (const change of proposal.changes) {
      this.stageChange(staged, change, addFailure, approval);
    }

    // Phase 2C: the architecture_completion commit and the architecture →
    // detail stage transition are ONE atomic publication (spec §4.1). The
    // transition is staged here, validated like every other effect, and
    // published with everything else — never as a separate saveRun.
    if (proposal.type === "architecture_completion" && failures.length === 0) {
      if (run.stage !== "architecture") {
        addFailure(
          "completion_stage_invalid",
          `architecture_completion requires stage=architecture (run is in ${run.stage})`,
          { stage: run.stage },
        );
      } else {
        const completionChange = proposal.changes.find(
          (c): c is Extract<ProposalChange, { kind: "complete_architecture" }> =>
            c.kind === "complete_architecture",
        );
        if (!staged.runArchitecture || staged.runArchitecture.revision !== completionChange?.target.revision) {
          addFailure(
            "completion_target_mismatch",
            `complete_architecture targets ARCH@${completionChange?.target.revision}, but the resulting committed Architecture is ${staged.runArchitecture ? `ARCH@${staged.runArchitecture.revision}` : "missing"}`,
            { target: completionChange?.target.revision, resulting: staged.runArchitecture?.revision },
          );
        } else {
          staged.stage = "detail";
        }
      }
    }

    // Phase 2E2 §24-§28: deterministic work progression INSIDE the same
    // staged transaction. After a successful section completion: pick the
    // next activeWork by dependency eligibility in canonical order (never the
    // model's choice), or — when the completion closed the last Section —
    // clear the focus and move detail → synthesis atomically. Never a
    // separate post-commit saveRun.
    if (proposal.type === "section_completion" && failures.length === 0 && staged.stage === "detail") {
      const stagedSections = [...staged.sections.values()];
      const unfinished = stagedSections.filter((section) => section.status !== "approved");
      if (unfinished.length > 0) {
        const byId = new Map(stagedSections.map((section) => [section.id, section]));
        // Canonical order = the committed Phase 2D Section order.
        const eligible = staged.runSections
          .map((mirror) => byId.get(mirror.id))
          .filter(
            (section): section is Section =>
              section !== undefined &&
              section.status !== "approved" &&
              section.dependencies.every((dep) => byId.get(dep)?.status === "approved"),
          );
        const next = eligible[0];
        if (!next) {
          addFailure(
            "no_eligible_section",
            `Work remains (${unfinished.map((section) => section.id).join(", ")}) but no unfinished Section has all structural dependencies approved — inconsistent state; automatic progression fails closed`,
            { unfinished: unfinished.map((section) => section.id) },
          );
        } else {
          staged.activeWork = { type: "section", id: next.id };
        }
      } else {
        // §28: the last Section completed — synthesis entry requires every
        // Section valid (an approved-but-invalid DAG fails closed instead of
        // entering synthesis).
        const invalid = stagedSections.filter((section) => section.validation !== "valid");
        if (invalid.length > 0) {
          addFailure(
            "sections_not_valid",
            `All Sections are approved but ${invalid.map((section) => section.id).join(", ")} ${invalid.length === 1 ? "is" : "are"} ${invalid.map((s) => s.validation).join("/")}; synthesis entry requires every Section valid`,
            { invalid: invalid.map((section) => section.id) },
          );
        } else {
          staged.activeWork = undefined;
          staged.stage = "synthesis";
        }
      }
    }

    // Phase 2I §34/§36/§37: the Final PlanCommit and BOTH transitions —
    // stage synthesis → final AND lifecycle active → handoff_pending — are ONE
    // atomic publication. While the final Proposal existed (even awaiting or
    // approved-but-uncommitted) the run stayed synthesis/active (brief §3);
    // only the successful commit justifies `final`, because only now does an
    // immutable formally-approved FinalPlan exist. Never a post-commit saveRun.
    if (proposal.type === "final_plan" && failures.length === 0) {
      if (staged.runFinalPlan === undefined) {
        addFailure(
          "final_plan_change_invalid",
          "The add_final_plan change did not stage a FinalPlan pointer; refusing to transition without the committed plan",
          { proposalID: proposal.id },
        );
      } else {
        staged.stage = "final";
        staged.lifecycle = "handoff_pending";
        staged.activeWork = undefined;
      }
    }

    // Resulting-state validation.
    try {
      assertAcyclicSections([...staged.sections.values()]);
    } catch (error) {
      addFailure("section_dependency_cycle", error instanceof Error ? error.message : String(error));
    }

    // Blocking-conflict intersection (conservative: a blocking conflict with no
    // refs is treated as run-global; §15).
    const changedTargets = staged.committedChanges
      .map((change) => change.ref)
      .filter((ref): ref is MemoryRef => ref !== undefined);
    for (const conflict of run.conflicts) {
      if (conflict.status !== "open" || conflict.severity !== "blocking") continue;
      const intersects =
        conflict.refs.length === 0 ||
        conflict.refs.some((ref) => changedTargets.some((target) => refTargetsMatch(ref, target)));
      if (intersects) {
        addFailure(
          "conflict_blocking",
          `Open blocking conflict ${conflict.id} affects this transaction: ${conflict.description}`,
          { conflictID: conflict.id },
        );
      }
    }

    // Critical evidence referenced by committed objects must be fresh (§16).
    // Phase 2E2 §12 extends the deterministic reachability for Section
    // completion: target SectionRevision → its referenced committed Decisions
    // → their Evidence refs. Nothing else is scanned (no repository state, no
    // speculative reachability the domain cannot represent).
    for (const change of proposal.changes) {
      const decisions: Decision[] =
        change.kind === "add_decision" || change.kind === "amend_decision" ? [change.decision] : [];
      if (change.kind === "complete_section") {
        const revisionRecord = this.sectionRevisions.get(run.id)?.byKey.get(
          revisionKey(change.target.id, change.target.revision),
        );
        if (revisionRecord) {
          for (const decisionID of revisionRecord.decisions) {
            const decision = this.decisions.get(run.id)?.latest.get(decisionID);
            if (decision) decisions.push(decision);
          }
        }
      }
      for (const decision of decisions) {
        for (const ref of decision.evidence ?? []) {
          const evidence = this.evidence.get(run.id)?.latest.get(ref.id);
          if (!evidence) {
            addFailure("unknown_reference", `Evidence ${ref.id} referenced by ${decision.id} does not exist`, {
              evidenceID: ref.id,
            });
            continue;
          }
          if (evidence.criticality === "critical" && !(evidence.status === "active" && evidence.freshness === "fresh")) {
            addFailure(
              "evidence_not_fresh",
              `Critical evidence ${evidence.id} is ${evidence.freshness}/${evidence.status}; commit blocked`,
              { evidenceID: evidence.id, freshness: evidence.freshness, status: evidence.status },
            );
          }
        }
      }
    }

    if (failures.length > 0) {
      // Nothing has been written — staged clones are discarded.
      throw new UltraPlanError(
        "transaction_validation_failed",
        `Transaction validation failed: ${failures.map((f) => f.code).join(", ")}`,
        { failures },
      );
    }

    // -- Publication (synchronous; HEAD last) ---------------------------------
    const stagedRun: PlanningRun = {
      ...run,
      openQuestions: staged.openQuestions,
      constraints: staged.constraints,
      stage: staged.stage,
      lifecycle: staged.lifecycle,
      architecture: staged.runArchitecture,
      sections: staged.runSections.map((mirror) => ({ id: mirror.id })),
      decisions: staged.runDecisions,
      ...(staged.runFinalPlan ? { finalPlan: staged.runFinalPlan } : {}),
      activeWork: staged.activeWork,
    };
    return this.publishTransaction(run, stagedRun, staged, proposal, approval);
  }

  /** Stage one approved change onto the cloned state. */
  private stageChange(
    staged: StagedState,
    change: ProposalChange,
    addFailure: (code: string, message: string, detail?: Record<string, unknown>) => void,
    approval: Approval,
  ): void {
    switch (change.kind) {
      case "add_decision": {
        const decision = change.decision;
        if (staged.decisions.latest.has(decision.id)) {
          addFailure("change_invalid", `Decision ${decision.id} already exists; add_decision requires a fresh id`, {
            decisionID: decision.id,
          });
          return;
        }
        this.stagePutRevision(staged.decisions, decision.id, decision.revision, decision, "decision", addFailure);
        if (!staged.runDecisions.some((ref) => ref.id === decision.id)) {
          staged.runDecisions.push({ id: decision.id, revision: decision.revision });
        }
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "decision", id: decision.id, revision: decision.revision },
          resultingRevision: decision.revision,
        });
        staged.revised.push({ kind: "decision", id: decision.id, revision: decision.revision });
        return;
      }
      case "amend_decision": {
        const prior = staged.decisions.byKey.get(revisionKey(change.supersedes.id, change.supersedes.revision));
        if (!prior) {
          addFailure("unknown_reference", `Amend target ${change.supersedes.id}@${change.supersedes.revision} does not exist`);
          return;
        }
        if (change.decision.id !== change.supersedes.id) {
          addFailure("change_invalid", "amend_decision must keep the same decision id", {
            decisionID: change.decision.id,
          });
          return;
        }
        if (change.decision.revision !== change.supersedes.revision + 1) {
          addFailure("change_invalid", `amend_decision revision must be ${change.supersedes.revision + 1}`, {
            decisionID: change.decision.id,
            revision: change.decision.revision,
          });
          return;
        }
        void prior;
        this.stagePutRevision(staged.decisions, change.decision.id, change.decision.revision, change.decision, "decision", addFailure);
        const index = staged.runDecisions.findIndex((ref) => ref.id === change.decision.id);
        if (index >= 0) staged.runDecisions[index] = { id: change.decision.id, revision: change.decision.revision };
        else staged.runDecisions.push({ id: change.decision.id, revision: change.decision.revision });
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "decision", id: change.decision.id, revision: change.decision.revision },
          resultingRevision: change.decision.revision,
        });
        staged.revised.push({ kind: "decision", id: change.decision.id, revision: change.decision.revision });
        return;
      }
      case "add_section_revision": {
        const revision = change.revision;
        const section = staged.sections.get(revision.sectionID);
        if (!section) {
          addFailure("unknown_reference", `Section ${revision.sectionID} is not committed`);
          return;
        }
        // First-checkpoint discipline: a revision-less Section only. Any
        // existing revision means the amend path (amend_section) applies.
        if (revision.revision !== 1 || staged.sectionRevisions.highest.has(revision.sectionID)) {
          addFailure(
            "change_invalid",
            `add_section_revision creates SectionRevision@1 for a revision-less Section (got revision ${revision.revision}; highest existing ${staged.sectionRevisions.highest.get(revision.sectionID) ?? "none"}) — use amend_section for later checkpoints`,
            { sectionID: revision.sectionID, revision: revision.revision },
          );
          return;
        }
        const contractError = validateContractIdentity(revision);
        if (contractError) {
          addFailure("change_invalid", contractError, { sectionID: revision.sectionID });
          return;
        }
        const bindingError = validateDependencyBindings(revision, staged.sections);
        if (bindingError) {
          addFailure("change_invalid", bindingError, { sectionID: revision.sectionID });
          return;
        }
        this.stagePutRevision(staged.sectionRevisions, revision.sectionID, revision.revision, revision, "section_revision", addFailure);
        // §16: the first checkpoint activates the root — at least one approved
        // revision exists, but the Section is NOT complete (completion is
        // Phase 2E2; approvedRevision means "latest approved checkpoint").
        // Validation follows the dependency contracts actually bound (§13).
        staged.sections.set(revision.sectionID, {
          ...section,
          status: "active",
          currentRevision: revision.revision,
          approvedRevision: revision.revision,
          validation: sectionValidationFromDependencyContracts(section.dependencies, staged.sections),
        });
        if (!staged.runSections.some((mirror) => mirror.id === revision.sectionID)) {
          staged.runSections.push({ id: revision.sectionID });
        }
        // A new/changed contract invalidates already-designed downstream
        // revisions (§15) — first-contract appearance included.
        const all = [...staged.sections.values()];
        const propagated = propagateNeedsReview(all, [revision.sectionID]);
        for (const next of propagated) staged.sections.set(next.id, next);
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "section", id: revision.sectionID, revision: revision.revision },
          resultingRevision: revision.revision,
        });
        staged.revised.push({ kind: "section_revision", id: revision.sectionID, revision: revision.revision });
        return;
      }
      case "amend_section": {
        const prior = staged.sectionRevisions.byKey.get(
          revisionKey(change.supersedes.id, change.supersedes.revision),
        );
        if (!prior) {
          addFailure("unknown_reference", `Amend target ${change.supersedes.id}@${change.supersedes.revision} does not exist`);
          return;
        }
        const revision = change.revision;
        if (revision.sectionID !== change.supersedes.id || revision.revision !== change.supersedes.revision + 1) {
          addFailure("change_invalid", "amend_section must target the same section at supersedes.revision + 1", {
            sectionID: revision.sectionID,
            revision: revision.revision,
          });
          return;
        }
        const contractError = validateContractIdentity(revision);
        if (contractError) {
          addFailure("change_invalid", contractError, { sectionID: revision.sectionID });
          return;
        }
        const bindingError = validateDependencyBindings(revision, staged.sections);
        if (bindingError) {
          addFailure("change_invalid", bindingError, { sectionID: revision.sectionID });
          return;
        }
        this.stagePutRevision(staged.sectionRevisions, revision.sectionID, revision.revision, revision, "section_revision", addFailure);
        const section = staged.sections.get(revision.sectionID);
        if (!section) {
          addFailure("unknown_reference", `Section ${revision.sectionID} is not committed`);
          return;
        }
        // Checkpoint/reopen semantics: the new revision is the latest approved
        // checkpoint (§17), previous revisions stay immutable, and an
        // amendment to an APPROVED section reopens it in the SAME commit. A
        // pending root (never reached by real flows — checkpoints activate
        // first) defensively activates, and a REOPENED root (Phase 2G §47)
        // returns to the normal incomplete-design state `active` — the new
        // checkpoint must then pass normal Section completion again.
        // Validation follows the dependency contracts bound into the NEW
        // revision (§17), recomputed from staged state — never copied from
        // the old root.
        const updated: Section = {
          ...section,
          status:
            section.status === "approved"
              ? ("reopened" as const)
              : section.status === "pending" || section.status === "reopened"
                ? ("active" as const)
                : section.status,
          currentRevision: revision.revision,
          approvedRevision: revision.revision,
          validation: sectionValidationFromDependencyContracts(section.dependencies, staged.sections),
        };
        staged.sections.set(revision.sectionID, updated);
        // Downstream needs_review propagation (already-tested semantics).
        const all = [...staged.sections.values()];
        const propagated = propagateNeedsReview(all, [revision.sectionID]);
        for (const next of propagated) staged.sections.set(next.id, next);
        if (!staged.runSections.some((mirror) => mirror.id === revision.sectionID)) {
          staged.runSections.push({ id: revision.sectionID });
        }
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "section", id: revision.sectionID, revision: revision.revision },
          resultingRevision: revision.revision,
        });
        staged.revised.push({ kind: "section_revision", id: revision.sectionID, revision: revision.revision });
        return;
      }
      case "add_architecture": {
        const architecture = change.architecture;
        if (staged.architectures.highest.has("ARCH") || staged.runArchitecture) {
          addFailure(
            "change_invalid",
            "A committed Architecture already exists; add_architecture is the INITIAL path (ARCH@1) and never replaces one",
            { architectureID: "ARCH" },
          );
          return;
        }
        if (architecture.revision !== 1) {
          addFailure("change_invalid", `add_architecture creates ARCH@1 (got revision ${architecture.revision})`, {
            revision: architecture.revision,
          });
          return;
        }
        this.stagePutRevision(staged.architectures, "ARCH", architecture.revision, architecture, "architecture", addFailure);
        staged.runArchitecture = { id: "ARCH", revision: architecture.revision };
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "architecture", revision: architecture.revision },
          resultingRevision: architecture.revision,
        });
        staged.revised.push({ kind: "architecture", id: "ARCH", revision: architecture.revision });
        return;
      }
      case "add_constraint": {
        const constraint = change.constraint;
        if (staged.constraints.some((c) => c.id === constraint.id)) {
          addFailure("change_invalid", `Constraint ${constraint.id} already exists; add_constraint requires a fresh id`, {
            constraintID: constraint.id,
          });
          return;
        }
        staged.constraints.push(constraint);
        staged.committedChanges.push({ kind: change.kind, ref: { kind: "constraint", id: constraint.id } });
        staged.revised.push({ kind: "constraint", id: constraint.id, revision: 1 });
        return;
      }
      case "add_section": {
        const section = change.section;
        if (staged.sections.has(section.id)) {
          addFailure("change_invalid", `Section ${section.id} already exists; decomposition ids must be fresh`, {
            sectionID: section.id,
          });
          return;
        }
        if (section.status !== "pending" || section.validation !== "valid") {
          addFailure(
            "change_invalid",
            `Section ${section.id} must be created pending/valid — decomposition creates design scopes, never designs`,
            { sectionID: section.id, status: section.status, validation: section.validation },
          );
          return;
        }
        for (const dep of section.dependencies) {
          if (dep === section.id) {
            addFailure("change_invalid", `Section ${section.id} cannot depend on itself`, { sectionID: section.id });
            return;
          }
          if (!staged.sections.has(dep)) {
            addFailure(
              "unknown_reference",
              `Section ${section.id} depends on ${dep}, which does not exist in staged state`,
              { sectionID: section.id, dependency: dep },
            );
            return;
          }
        }
        staged.sections.set(section.id, section);
        if (!staged.runSections.some((mirror) => mirror.id === section.id)) {
          staged.runSections.push({ id: section.id }); // canonical order = change order
        }
        staged.addedSections.push(section);
        staged.committedChanges.push({ kind: change.kind, ref: { kind: "section", id: section.id } });
        return;
      }
      case "select_initial_section": {
        const target = change.section;
        if (!staged.sectionsStartedEmpty) {
          addFailure(
            "change_invalid",
            "select_initial_section is valid only at the initial decomposition boundary",
            { sectionID: target.id },
          );
          return;
        }
        if (!staged.sections.has(target.id)) {
          addFailure(
            "unknown_reference",
            `Initial focus ${target.id} does not exist in the staged decomposition`,
            { sectionID: target.id },
          );
          return;
        }
        staged.activeWork = { type: "section", id: target.id };
        staged.committedChanges.push({ kind: change.kind, ref: { kind: "section", id: target.id } });
        return;
      }
      case "raise_question": {
        const question = change.question;
        if (staged.openQuestions.some((q) => q.id === question.id)) {
          addFailure("change_invalid", `Question ${question.id} already exists; raise_question requires a fresh id`, {
            questionID: question.id,
          });
          return;
        }
        staged.openQuestions.push(question);
        staged.committedChanges.push({ kind: change.kind, ref: { kind: "question", id: question.id } });
        staged.revised.push({ kind: "question", id: question.id, revision: 1 });
        return;
      }
      case "resolve_question": {
        const resolution = change.resolution;
        const question = staged.openQuestions.find((q) => q.id === resolution.questionID);
        if (!question) {
          addFailure("unknown_reference", `Question ${resolution.questionID} does not exist`);
          return;
        }
        if (question.status === "resolved") {
          addFailure("change_invalid", `Question ${resolution.questionID} is already resolved`);
          return;
        }
        question.status = "resolved";
        question.resolution = resolution.resolution;
        question.resolvedBy = resolution.resolvedBy;
        staged.resolvedQuestions.push(resolution.questionID);
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "question", id: resolution.questionID },
        });
        return;
      }
      case "complete_architecture": {
        const architecture = staged.architectures.byKey.get(
          revisionKey("ARCH", change.target.revision),
        );
        if (!architecture) {
          addFailure("unknown_reference", `Architecture ${change.target.revision} does not exist`);
          return;
        }
        staged.architectures.byKey.set(revisionKey("ARCH", change.target.revision), {
          ...architecture,
          status: "approved",
        });
        staged.architectures.latest.set("ARCH", { ...architecture, status: "approved" });
        staged.runArchitecture = { id: "ARCH", revision: change.target.revision };
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "architecture", revision: change.target.revision },
          resultingRevision: change.target.revision,
        });
        staged.revised.push({ kind: "architecture", id: "ARCH", revision: change.target.revision });
        return;
      }
      case "complete_section": {
        const target = change.target;
        const section = staged.sections.get(target.id);
        if (!section) {
          addFailure("unknown_reference", `Section ${target.id} is not committed`);
          return;
        }
        // §9: the frozen dependency rule — every structural dependency must be
        // APPROVED (a dependency merely having an approved checkpoint does not
        // count). Reused, not replaced (brief §8).
        try {
          assertSectionCanComplete([...staged.sections.values()], target.id);
        } catch (error) {
          addFailure("dependency_incomplete", error instanceof Error ? error.message : String(error), {
            sectionID: target.id,
          });
          return;
        }
        // §4/§8: completion binds the EXACT current approved checkpoint —
        // status active, both pointers present and equal, target == that
        // revision. No "complete latest" semantics exist.
        if (
          section.status !== "active" ||
          section.currentRevision === undefined ||
          section.approvedRevision === undefined ||
          section.currentRevision !== section.approvedRevision ||
          target.revision !== section.approvedRevision
        ) {
          addFailure(
            "completion_target_mismatch",
            `Section ${target.id} completion must target the exact current approved checkpoint (status ${section.status}, currentRevision ${section.currentRevision ?? "none"}, approvedRevision ${section.approvedRevision ?? "none"}, target ${target.revision})`,
            { sectionID: target.id, target: target.revision },
          );
          return;
        }
        const revisionRecord = staged.sectionRevisions.byKey.get(revisionKey(target.id, target.revision));
        if (!revisionRecord) {
          addFailure("revision_missing", `Section revision ${target.id}@${target.revision} does not exist`);
          return;
        }
        // §11: the completed revision exposes its canonical immutable
        // contract — the projection must be stamped with the revision's own
        // identity, and every dependency binding must still match staged
        // state (stale bindings make the completion stale).
        const contractError = validateContractIdentity(revisionRecord);
        if (contractError) {
          addFailure("change_invalid", contractError, { sectionID: target.id });
          return;
        }
        const bindingError = validateDependencyBindings(revisionRecord, staged.sections);
        if (bindingError) {
          addFailure("change_invalid", bindingError, { sectionID: target.id });
          return;
        }
        // §10: the validation gate — needs_review Sections re-checkpoint
        // first; no bypass flags exist. (The §9 dependency gate above — the
        // frozen rule — takes precedence when both gates fail.)
        if (section.validation !== "valid") {
          addFailure(
            "section_needs_review",
            `Section ${target.id} is ${section.validation}; commit a revalidated checkpoint against the current dependency contracts before completing`,
            { sectionID: target.id, validation: section.validation },
          );
          return;
        }
        // §15: pointers unchanged, no new revision, contract untouched — only
        // the workflow status closes. Downstream revisions are NOT propagated
        // (completion changes no contract).
        staged.sections.set(target.id, {
          ...section,
          status: "approved",
          validation: "valid",
        });
        if (!staged.runSections.some((mirror) => mirror.id === target.id)) {
          staged.runSections.push({ id: target.id });
        }
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "section", id: target.id, revision: target.revision },
          resultingRevision: target.revision,
        });
        return;
      }
      case "reopen_section": {
        const section = staged.sections.get(change.target.id);
        if (!section) {
          addFailure("unknown_reference", `Section ${change.target.id} is not committed`);
          return;
        }
        // §44: reopen binds the exact current approved revision; pointers are
        // unchanged and NO new revision is created (§45 — the approved
        // SectionRevision@n and its contract stay immutable and readable).
        if (
          section.status !== "approved" ||
          section.currentRevision === undefined ||
          section.approvedRevision === undefined ||
          section.currentRevision !== section.approvedRevision ||
          change.target.revision !== section.approvedRevision
        ) {
          addFailure(
            "reopen_target_invalid",
            `Section ${change.target.id} must be reopened at its exact current approved revision (status ${section.status}, current ${section.currentRevision ?? "none"}, approved ${section.approvedRevision ?? "none"}, target @${change.target.revision})`,
            { sectionID: change.target.id, target: change.target.revision },
          );
          return;
        }
        if (change.reason.type === "dependency_review" && section.validation !== "needs_review") {
          addFailure(
            "reopen_target_invalid",
            `A dependency-review reopen requires the target to be validation=needs_review (${change.target.id} is ${section.validation})`,
            { sectionID: change.target.id, validation: section.validation },
          );
          return;
        }
        // §44: status approved → reopened, validation → needs_review; §44:
        // activeWork → the exact target Section; stage synthesis → detail for
        // a semantic-validation reopen (a dependency_review reopen already
        // runs in detail and stays there, §50). Downstream propagation is
        // deliberately NOT done here — needs_review reaches dependents only
        // when the reopened Section's new revision/contract commits (§48).
        staged.sections.set(change.target.id, {
          ...section,
          status: "reopened",
          validation: "needs_review",
        });
        staged.activeWork = { type: "section", id: change.target.id };
        if (change.reason.type === "semantic_validation") {
          staged.stage = "detail";
        }
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "section", id: change.target.id, revision: change.target.revision },
          resultingRevision: change.target.revision,
        });
        return;
      }
      case "add_final_plan": {
        // Phase 2I §34/§39/§40: materialize the committed FinalPlan from the
        // frozen content. approvedAt = the EXACT user Approval's createdAt
        // (system transaction metadata — brief §15's narrow freeze exception);
        // the canonical hash covers the full record INCLUDING approvedAt and
        // body, computed here from the record that will actually be published.
        const content = change.finalPlan;
        if (staged.runFinalPlan !== undefined || staged.addedFinalPlans.length > 0) {
          addFailure(
            "final_plan_already_exists",
            "This transaction already stages a FinalPlan; exactly one add_final_plan change is legal",
          );
          return;
        }
        const record: FinalPlan = {
          ...content,
          status: "approved",
          approvedAt: approval.createdAt,
          hash: computeFinalPlanHashFromContent({ ...content, status: "approved", approvedAt: approval.createdAt }),
        };
        staged.addedFinalPlans.push(record);
        staged.runFinalPlan = { id: record.id, revision: record.revision };
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "final_plan", id: record.id, revision: record.revision },
          resultingRevision: record.revision,
        });
        staged.revised.push({ kind: "final_plan", id: record.id, revision: record.revision });
        return;
      }
    }
  }

  /** Put an immutable revision into a staged registry (monotonic + immutable). */
  private stagePutRevision<T>(
    registry: RevisionRegistry<T>,
    id: string,
    revision: number,
    record: T,
    what: string,
    addFailure: (code: string, message: string, detail?: Record<string, unknown>) => void,
  ): void {
    const key = revisionKey(id, revision);
    if (registry.byKey.has(key)) {
      addFailure("change_invalid", `${what} ${id}@${revision} already exists; revisions are immutable`);
      return;
    }
    const highest = registry.highest.get(id);
    if (highest !== undefined && revision !== highest + 1) {
      addFailure(
        "change_invalid",
        `${what} ${id}: revision ${revision} does not follow highest existing revision ${highest}`,
        { id, revision, highest },
      );
      return;
    }
    registry.byKey.set(key, record);
    registry.latest.set(id, record);
    registry.highest.set(id, revision);
  }

  /**
   * The single publication seam. Everything is validated; this writes staged
   * state atomically (one synchronous block) and moves HEAD last. Protected
   * so fault-injection tests can fail here and prove zero partial mutation.
   */
  protected publishTransaction(
    beforeRun: PlanningRun,
    stagedRun: PlanningRun,
    staged: StagedState,
    proposal: Proposal,
    approval: Approval,
  ): PlanCommit {
    const planID = beforeRun.id;
    const at = this.now();

    // 1. Immutable artifact revisions + question effects.
    this.architectures.set(planID, staged.architectures);
    this.sections.set(planID, staged.sections);
    this.sectionRevisions.set(planID, staged.sectionRevisions);
    this.decisions.set(planID, staged.decisions);
    // Phase 2I: committed FinalPlans (same atomic publication as everything else).
    if (staged.addedFinalPlans.length > 0) {
      const family = this.finalPlans.get(planID) ?? new Map<string, FinalPlan>();
      for (const finalPlan of staged.addedFinalPlans) {
        family.set(`${finalPlan.id}@${finalPlan.revision}`, finalPlan);
      }
      this.finalPlans.set(planID, family);
    }

    // 2. Run header (working + commit-gated pointer fields; engine authority).
    //    Phase 2I: the Final PlanCommit sets the exact finalPlan pointer AND
    //    moves lifecycle active → handoff_pending in this same publication.
    const updatedRun: PlanningRun = {
      ...stagedRun,
      lifecycle: staged.lifecycle,
      revision: beforeRun.revision + 1,
      updatedAt: at,
    };
    this.runs.set(planID, updatedRun);

    // 3. Events with clear audit meaning. A staged stage movement (Phase 2C:
    // architecture → detail on architecture_completion; Phase 2I:
    // synthesis → final on the Final PlanCommit) is recorded in the
    // SAME publication as the commit — never as a follow-up saveRun.
    if (stagedRun.stage !== beforeRun.stage) {
      void this.appendEvent(planID, {
        type: "run.stage_changed",
        from: beforeRun.stage,
        to: stagedRun.stage,
      });
    }
    if (staged.lifecycle !== beforeRun.lifecycle) {
      void this.appendEvent(planID, {
        type: "run.lifecycle_changed",
        from: beforeRun.lifecycle,
        to: staged.lifecycle,
      });
    }
    for (const revised of staged.revised) {
      void this.appendEvent(planID, { type: "artifact.revised", ...revised });
    }
    // Phase 2D: audit the created Section DAG roots (canonical order).
    for (const section of staged.addedSections) {
      void this.appendEvent(planID, {
        type: "section.added",
        sectionID: section.id,
        title: section.title,
        dependencies: section.dependencies,
      });
    }
    for (const questionID of staged.resolvedQuestions) {
      const question = staged.openQuestions.find((q) => q.id === questionID);
      if (question?.resolution) {
        void this.appendEvent(planID, {
          type: "question.resolved",
          questionID,
          resolution: question.resolution,
        });
      }
    }

    // 4. Snapshot of the POST-commit state.
    const snapshotSeq = (this.snapshots.get(planID)?.size ?? 0) + 1;
    const snapshotID = SnapshotIDs.from(snapshotSeq);
    const sectionRevisionsState: SnapshotState["sectionRevisions"] = {};
    for (const section of staged.sections.values()) {
      if (section.currentRevision !== undefined) {
        sectionRevisionsState[section.id] = section.currentRevision;
      }
    }
    const decisionRevisionsState: SnapshotState["decisionRevisions"] = {};
    for (const decision of staged.decisions.latest.values()) {
      decisionRevisionsState[decision.id] = decision.revision;
    }
    // Phase 2D: the committed Section DAG in canonical order — present even
    // though newly decomposed sections have NO revisions yet (design scopes,
    // not designs). Phase 2E1: checkpointed roots additionally carry their
    // current/approved revision pointers (additive, optional).
    const sectionRootsState: SnapshotState["sectionRoots"] = staged.runSections
      .map((mirror) => staged.sections.get(mirror.id))
      .filter((section): section is Section => section !== undefined)
      .map((section) => ({
        id: section.id,
        title: section.title,
        objective: section.objective,
        dependencies: section.dependencies,
        status: section.status,
        validation: section.validation,
        ...(section.currentRevision !== undefined ? { currentRevision: section.currentRevision } : {}),
        ...(section.approvedRevision !== undefined ? { approvedRevision: section.approvedRevision } : {}),
      }));
    const snapshot: Snapshot = {
      id: snapshotID,
      planID,
      commit: null, // patched to the commit id below before publication ends
      state: {
        architectureRevision: staged.runArchitecture?.revision,
        sectionRevisions: sectionRevisionsState,
        decisionRevisions: decisionRevisionsState,
        constraintIDs: stagedRun.constraints.filter((c) => c.status === "active").map((c) => c.id),
        openQuestionIDs: staged.openQuestions.filter((q) => q.status === "open").map((q) => q.id),
        // Phase 2I (brief §42): the committed FinalPlan pointer in snapshot
        // state — the final commit's resulting snapshot carries the same
        // exact ref the run header holds (durable load re-verifies both).
        ...(staged.runFinalPlan ? { finalPlanRevision: staged.runFinalPlan.revision } : {}),
        ...(sectionRootsState.length > 0 ? { sectionRoots: sectionRootsState } : {}),
        // Phase 2E2 (additive, optional): the workflow focus after this
        // commit — next Section after an ordinary completion, or absent when
        // the final completion cleared it (synthesis entry).
        ...(staged.activeWork ? { activeWork: staged.activeWork } : {}),
      },
      createdAt: at,
    };
    const snapshots = this.snapshots.get(planID) ?? new Map<string, Snapshot>();
    snapshots.set(snapshotID, snapshot);
    this.snapshots.set(planID, snapshots);

    // 5. PlanCommit + linear chain index.
    const commitSeq = (this.commits.get(planID)?.size ?? 0) + 1;
    const commitID = CommitIDs.from(commitSeq);
    const commit: PlanCommit = {
      id: commitID,
      proposalID: proposal.id,
      approvalID: approval.id,
      parentCommit: beforeRun.headCommit ?? null,
      changes: staged.committedChanges,
      resultingSnapshot: snapshotID,
      createdAt: at,
    };
    const commits = this.commits.get(planID) ?? new Map<CommitID, PlanCommit>();
    commits.set(commitID, commit);
    this.commits.set(planID, commits);
    this.commitByProposal.set(`${planID}:${proposal.id}`, commitID);
    snapshot.commit = commitID;

    // 6. Proposal → approved (same atomic transaction).
    this.proposals.get(planID)?.set(proposal.id, { ...proposal, status: "approved" });

    // 7. Events that reference the commit, then HEAD last.
    void this.appendEvent(planID, {
      type: "transaction.committed",
      commitID,
      proposalID: proposal.id,
      approvalID: approval.id,
      snapshotID,
    });
    void this.appendEvent(planID, { type: "head.moved", from: beforeRun.headCommit ?? null, to: commitID });
    this.runs.set(planID, { ...updatedRun, headCommit: commitID, headSnapshot: snapshotID });

    return commit;
  }

  /**
   * TEST/FIXTURE ONLY — exists on the concrete in-memory class, NOT on the
   * PlanStore interface. Seeds synthetic committed artifacts so transaction
   * semantics can be exercised before the architecture/section workflows land
   * (they are later-phase work). Production code must never call this.
   */
  seedCommittedState(
    planID: PlanID,
    seed: {
      architecture?: Architecture;
      sections?: Section[];
      sectionRevisions?: SectionRevision[];
      decisions?: Decision[];
      /**
       * TEST-ONLY: corrupt/seed a run-header workflow focus directly (bypasses
       * the commit gate the way no production path can). Used to construct
       * states the real workflow cannot reach (e.g. a checkpointed active
       * section without driving the whole workflow).
       */
      activeWork?: WorkRef;
    },
  ): void {
    const { architecture, sections = [], sectionRevisions = [], decisions = [], activeWork } = seed;
    if (activeWork !== undefined) {
      const run = this.runs.get(planID);
      if (run) this.runs.set(planID, { ...run, activeWork });
    }
    if (architecture) {
      const registry = emptyRegistryOr(this.architectures, planID);
      registry.byKey.set(revisionKey("ARCH", architecture.revision), architecture);
      registry.latest.set("ARCH", architecture);
      registry.highest.set("ARCH", architecture.revision);
      this.architectures.set(planID, registry);
    }
    if (sections.length > 0 || sectionRevisions.length > 0) {
      const map = this.sections.get(planID) ?? new Map<SectionID, Section>();
      for (const section of sections) map.set(section.id, section);
      this.sections.set(planID, map);
    }
    if (sectionRevisions.length > 0) {
      const registry = emptyRegistryOr(this.sectionRevisions, planID);
      for (const revision of sectionRevisions) {
        registry.byKey.set(revisionKey(revision.sectionID, revision.revision), revision);
        registry.latest.set(revision.sectionID, revision);
        registry.highest.set(revision.sectionID, revision.revision);
      }
      this.sectionRevisions.set(planID, registry);
    }
    if (decisions.length > 0) {
      const registry = emptyRegistryOr(this.decisions, planID);
      for (const decision of decisions) {
        registry.byKey.set(revisionKey(decision.id, decision.revision), decision);
        registry.latest.set(decision.id, decision);
        registry.highest.set(decision.id, decision.revision);
      }
      this.decisions.set(planID, registry);
    }
    // Mirror committed refs into the run header (as prior commits would have).
    const run = this.runs.get(planID);
    if (run) {
      const archRef = architecture ? { id: "ARCH" as const, revision: architecture.revision } : undefined;
      this.runs.set(planID, {
        ...run,
        ...(archRef ? { architecture: archRef } : {}),
        sections: [
          ...run.sections,
          ...sections.filter((s) => !run.sections.some((ref) => ref.id === s.id)).map((s) => ({ id: s.id })),
        ],
        decisions: [
          ...run.decisions,
          ...decisions
            .filter((d) => !run.decisions.some((ref) => ref.id === d.id))
            .map((d) => ({ id: d.id, revision: d.revision })),
        ],
      });
    }
  }
}

/** Conservative target intersection: same kind, and same id where the kind carries one. */
function refTargetsMatch(a: MemoryRef, b: MemoryRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "architecture":
      return true;
    case "section":
      return b.kind === "section" && b.id === a.id;
    case "decision":
      return b.kind === "decision" && b.id === a.id;
    case "question":
      return b.kind === "question" && b.id === a.id;
    case "constraint":
      return b.kind === "constraint" && b.id === a.id;
    case "conflict":
      return b.kind === "conflict" && b.id === a.id;
    case "evidence":
      return b.kind === "evidence" && b.id === a.id;
    case "proposal":
      return b.kind === "proposal" && b.id === a.id;
    case "snapshot":
      return b.kind === "snapshot" && b.id === a.id;
    case "commit":
      return b.kind === "commit" && b.id === a.id;
    case "final_plan":
      return b.kind === "final_plan" && b.id === a.id;
  }
}

function approvalEquals(a: Approval, b: Approval): boolean {
  return (
    a.proposalID === b.proposalID &&
    a.proposalRevision === b.proposalRevision &&
    a.proposalHash === b.proposalHash &&
    a.actor === b.actor
  );
}

/**
 * Sequence allocation for the two synthesis id families. Deliberately separate
 * helpers (not nextSequence with a shared prefix): "SYN-IN-001" also starts
 * with "SYN-", so a mixed list would miscount. Input ids sort after manifests
 * alphabetically but never share a registry.
 */
function nextSequenceSynthesisInput(existing: readonly string[]): number {
  return nextSequence(existing, SynthesisInputIDs.prefix);
}

function nextSequenceSynthesisManifest(existing: readonly string[]): number {
  return nextSequence(existing, SynthesisManifestIDs.prefix);
}
