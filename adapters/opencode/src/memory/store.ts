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
  ConflictID,
  ExecutionAttemptID,
  ExecutionDirectiveID,
  ExecutionReportID,
  ExecutionCommitID,
  ExecutionIssueID,
  ExecutionRunID,
  ExecutionStageID,
  AttemptReconciliationID,
  ExecutionCompletionID,
  PlanID,
  StageCompletionObligationID,
  SupervisorAssessmentID,
  VerificationConflictID,
  ProposalID,
  QuestionID,
  SectionID,
  VerificationWindowID,
} from "../core/ids.js";
import { AttemptReconciliationIDs, CommitIDs, ExecutionCompletionIDs, ExecutionAttemptIDs, ExecutionCommitIDs, ExecutionDirectiveIDs, ExecutionIssueIDs, ExecutionReportIDs, ExecutionRunIDs, ExecutionStageIDs, SnapshotIDs, StageCompletionObligationIDs, SupervisorAssessmentIDs, VerificationConflictIDs, VerificationWindowIDs, nextSequence } from "../core/ids.js";
import { isActiveRun } from "../core/state-machine.js";
import {
  assertExecutionRunBindingUnchanged,
  canTransitionExecutionLifecycle,
  executionHandoffIndexKey,
  workspaceIdentityEquals,
} from "../core/execution-run.js";
import type {
  ExecutionLifecycle,
  ExecutionRun,
  PlanningBaselineRef,
  WorkspaceIdentity,
} from "../core/execution-run.js";
import { buildExecutionRecoveryContext as buildRecoveryContext } from "../core/execution-recovery.js";
import type { ExecutionRecoveryContext } from "../core/execution-recovery.js";
import {
  assertExecutionSupervisorAuthority,
  assertSupervisorTakeoverAuthorized,
  isSupervisableExecutionRun,
} from "../core/supervisor-binding.js";
import type { SupervisorBinding, SupervisorTakeoverAuthorization } from "../core/supervisor-binding.js";
import type { RepositoryRevision } from "../repository/evidence.js";
import {
  assertAcyclicStages,
  stageEligibilityViolation,
  validateExecutionPlanRefs,
} from "../core/execution-stage.js";
import type { ExecutionPlanRef, ExecutionStage } from "../core/execution-stage.js";
import { assertCurrentCandidateRevision } from "../core/verification-window.js";
import type { AcceptedStateRef, VerificationWindow } from "../core/verification-window.js";
import { currentAcceptedState } from "../core/execution-run.js";
import {
  DIRECTIVE_CANDIDATE_EFFECTS,
  assertCapabilityEnvelope,
  assertEnvelopeWithinCeiling,
  assertExecutionDirectiveKind,
  assertReconciliationCapabilityConstraints,
  assertVerificationPurpose,
  computeExecutionDirectiveHash,
  computeExecutionDirectiveHashFromRecord,
  validateDirectiveBindings,
  verificationPurposeOf,
} from "../core/execution-directive.js";
import type {
  DirectiveCandidateEffect,
  ExecutionCapabilityCeiling,
  ExecutionCapabilityEnvelope,
  ExecutionDirective,
  ExecutionDirectiveHashPayload,
  ExecutionDirectiveKind,
  ExpectedExecutionScope,
  VerificationCoverage,
  VerificationPurpose,
} from "../core/execution-directive.js";
import { executionAttemptIndexKey, workerRoleForDirectiveKind } from "../core/execution-attempt.js";
import {
  assertAssessmentAcceptanceScope,
  assertAssessmentDisposition,
  computeSupervisorAssessmentHash,
  supervisorAssessmentContentEquals,
  supervisorAssessmentHashPayload,
} from "../core/supervisor-assessment.js";
import type {
  AssessmentAcceptanceScope,
  SupervisorAssessment,
  SupervisorAssessmentDisposition,
} from "../core/supervisor-assessment.js";
import type { ExecutionCommit } from "../core/execution-commit.js";
import {
  assertConflictResolutionOutcomeVocabulary,
  assertExecutionReportInternallyConsistent,
  assertReconciliationObservationVocabulary,
  findingAcceptanceImpact,
} from "../core/execution-report.js";
import type { ExecutionReport } from "../core/execution-report.js";
import {
  assertVerificationEvidenceRef,
  effectiveBlockingEvidence,
  enumerateBlockingEvidence,
  neutralizedEvidenceForOutcome,
  verificationEvidenceRefEquals,
} from "../core/verification-conflict.js";
import type {
  VerificationConflict,
  VerificationEvidenceRef,
} from "../core/verification-conflict.js";
import { computeExecutionIssueHash, executionIssueHashPayload, executionIssueContentEquals } from "../core/execution-issue.js";
import type { ExecutionIssue } from "../core/execution-issue.js";
import type { AttemptReconciliation, SuccessfulReconciliationObservation } from "../core/attempt-reconciliation.js";
import { computeExecutionCompletionHashFromRecord } from "../core/execution-completion.js";
import type { ExecutionCompletionRecord } from "../core/execution-completion.js";
import { executionStageKindOf, finalClosureReadinessViolation, isExecutionReadyForFinalClosure } from "../core/execution-stage.js";
import { stageHasExplicitCompletionObligations, stageCompletionObligations } from "../core/execution-stage.js";
import type { ExecutionAttempt } from "../core/execution-attempt.js";
import type { WorkerReportPayload } from "../worker/report-payload.js";
import { UltraPlanError } from "../core/errors.js";
import type {
  Architecture,
  Conflict,
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
import type { PlanningContextState } from "../context/state.js";
import { buildPlanningContextState } from "../context/state.js";

export interface CommitTransactionInput {
  planID: PlanID;
  /** The proposal being committed; must be `awaiting_approval` with an exact Approval. */
  proposalID: ProposalID;
  approvalID: ApprovalID;
  // parentCommit is DERIVED from the run's current HEAD by the engine — the
  // caller can never supply (or falsify) commit-chain structure.
}

/**
 * v0.2.0 Phase 1 — authority-side input for the initial execution handoff
 * (SPEC §8). Everything comes from the Harness/host, never from a model
 * argument: the source PlanningRun, the exact approved FinalPlan binding,
 * the trusted workspace identity, and the observed execution-start baseline.
 * The planning baseline is NOT an input — it is derived ONCE inside the
 * operation from the exact FinalPlan record (its own provenance fields).
 */
export interface PrepareInitialExecutionRunInput {
  planID: PlanID;
  /** Exact FinalPlan binding — never "latest". */
  finalPlan: FinalPlanRef;
  /** The approved FinalPlan's canonical content hash (binding integrity). */
  finalPlanHash: string;
  workspace: WorkspaceIdentity;
  executionStartBaseline: RepositoryRevision;
  /** Deterministic initial-handoff identity (executionInitialHandoffKey or an explicit distinct key). */
  initialHandoffKey: string;
}

/** Authority-side CAS expectation for a validated ExecutionRun transition. */
export interface ExecutionRunTransitionExpectation {
  workspace: WorkspaceIdentity;
  /** The caller's known ExecutionRun.revision — a stale value fails `stale_execution_run`. */
  runRevision: number;
  /** The caller's known exact FinalPlan binding — a mismatch fails `final_plan_binding_mismatch`. */
  finalPlan: FinalPlanRef;
}

// -- v0.2.0 Phase 2 inputs (trusted-boundary identity only) ------------------

export interface AttachExecutionSupervisorInput {
  executionRunID: ExecutionRunID;
  /** Trusted host session identity (OpenCode sessionID) — never model-supplied. */
  sessionID: string;
  workspace: WorkspaceIdentity;
}

export interface DetachExecutionSupervisorInput extends AttachExecutionSupervisorInput {
  /** The caller's known binding generation — fenced. */
  generation: number;
}

export interface TakeoverExecutionSupervisorInput extends AttachExecutionSupervisorInput {
  /** The caller's known current binding generation — a stale value is fenced out. */
  expectedGeneration: number;
  /** Explicit user authorization precondition — never automatic. */
  authorization: SupervisorTakeoverAuthorization;
}

export interface ActivateSupervisedExecutionRunInput {
  executionRunID: ExecutionRunID;
  /** Trusted host session identity — must be the binding's current owner. */
  sessionID: string;
  workspace: WorkspaceIdentity;
  /** The caller's known binding generation — fenced. */
  generation: number;
  /** Phase 1 transition preconditions. */
  runRevision: number;
  finalPlan: FinalPlanRef;
}

// -- v0.2.0 Phase 3 inputs ----------------------------------------------------

/** One Stage decomposition draft (Supervisor-supplied; never model-authority). */
export interface ExecutionStageDraft {
  title: string;
  objective: string;
  /** Exact obligation provenance into the run's bound approved FinalPlan. */
  planRefs: ExecutionPlanRef[];
  /** MANDATORY dependencies — existing Stage ids of the same run or earlier batch drafts. */
  dependsOn: ExecutionStageID[];
  /** When this draft replaces an earlier decomposition decision. */
  supersedes?: ExecutionStageID;
  /** Phase 5 — explicit completion obligations (ids assigned by the store; immutable after creation). */
  completionObligations?: { description: string; planRefs: ExecutionPlanRef[] }[];
}

export interface CreateExecutionStagesInput {
  executionRunID: ExecutionRunID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  drafts: ExecutionStageDraft[];
}

export interface ActivateExecutionStageInput {
  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  expectedRunRevision: number;
  expectedStageRevision: number;
}

export interface SupersedeExecutionStageInput {
  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  expectedStageRevision: number;
}

export interface OpenVerificationWindowInput {
  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  expectedRunRevision: number;
  expectedStageRevision: number;
}

export interface AdvanceCandidateRevisionInput {
  executionRunID: ExecutionRunID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  expectedCandidateRevision: number;
}

// -- v0.2.0 Phase 4 inputs ----------------------------------------------------

/** The Supervisor's structured Directive content (authority fields only — base bindings are copied from the window, never supplied). */
export interface ExecutionDirectiveDraft {
  /** Existing logical id → next immutable revision; absent → new logical id. */
  directiveID?: ExecutionDirectiveID;
  kind: ExecutionDirectiveKind;
  objective: string;
  planRefs: ExecutionPlanRef[];
  expectedExecutionScope: ExpectedExecutionScope;
  capabilityEnvelope: ExecutionCapabilityEnvelope;
  /** Explicit crash-semantics declaration — never derived from kind. */
  candidateEffect: DirectiveCandidateEffect;
  invariants: string[];
  requiredActions: string[];
  forbiddenActions: string[];
  validationRequirements: string[];
  deliverables: string[];
  stopConditions: string[];
  /** Phase 5 — verification-kind only: which Stage obligations this verification intends to close. */
  verificationCoverage?: VerificationCoverage;
  /** Phase 6A §26 — acceptance (legacy default) vs conflict_resolution. */
  verificationPurpose?: VerificationPurpose;
  /** Phase 6A §27 — required iff verificationPurpose=conflict_resolution. */
  conflictID?: VerificationConflictID;
  /** Phase 6A §43 — inspection-kind only; must equal the complete canonical unresolved set while reconciliation is required. */
  reconciliationTargets?: ExecutionAttemptID[];
  reportContract: string;
  body: string;
}

export interface IssueExecutionDirectiveInput {
  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  /** TRUSTED host/user + execution-policy ceiling — never model business payload. */
  ceiling: ExecutionCapabilityCeiling;
  expectedRunRevision: number;
  expectedStageRevision: number;
  expectedWindowRevision: number;
  draft: ExecutionDirectiveDraft;
}

export interface StartExecutionAttemptInput {
  executionRunID: ExecutionRunID;
  directive: { id: ExecutionDirectiveID; revision: number };
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  ceiling: ExecutionCapabilityCeiling;
  /** Runtime correlation metadata only — never authority. */
  workerInvocationRef?: string;
}

export interface MarkExecutionAttemptIndeterminateInput {
  executionRunID: ExecutionRunID;
  attemptID: ExecutionAttemptID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
}

export interface SubmitExecutionReportInput {
  executionRunID: ExecutionRunID;
  attemptID: ExecutionAttemptID;
  /** The Worker's unified report payload (store stamps ids/provenance). */
  report: WorkerReportPayload;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
}

// -- v0.2.0 Phase 5 inputs ----------------------------------------------------

/** The Supervisor's immutable judgment over one exact window candidate. */
export interface SupervisorAssessmentDraft {
  /** Stable retry identity (Harness-supplied) — same id + same content is idempotent. */
  assessmentID?: SupervisorAssessmentID;
  reportRefs: ExecutionReportID[];
  planRefs: ExecutionPlanRef[];
  coveredObligations: StageCompletionObligationID[];
  acceptanceScope: AssessmentAcceptanceScope;
  disposition: SupervisorAssessmentDisposition;
  rationale: string;
}

export interface SubmitSupervisorAssessmentInput {
  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;
  /** The caller's known candidate revision — an exact/current binding. */
  candidateRevision: number;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  draft: SupervisorAssessmentDraft;
}

// -- v0.2.0 Phase 6A inputs ----------------------------------------------------

/** §11 — the atomic replan transition input. */
export interface TransitionExecutionRunToReplanRequiredInput {
  executionRunID: ExecutionRunID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  /** The request_replan SupervisorAssessment authorizing this transition (§7). */
  sourceAssessmentID: SupervisorAssessmentID;
  /** Why the current FinalPlan authority is insufficient. */
  reason: string;
  /** The exact normative re-planning scope — FinalPlan-reachable refs only (§8). */
  affectedPlanRefs: ExecutionPlanRef[];
  /** Optional relevant report provenance from this run. */
  reportRefs?: ExecutionReportID[];
  /** Harness-assigned stable retry identity (§17); allocated when absent. */
  issueID?: ExecutionIssueID;
  summary?: string;
  limitations?: string[];
  repositoryContextSummary?: string;
  /** Exact CAS on the run revision. */
  expectedRunRevision: number;
}

/** §25 — Supervisor-driven creation of one disputed-fact record. */
export interface CreateVerificationConflictInput {
  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;
  /** The caller's known candidate revision — evidence binds exactly this. */
  candidateRevision: number;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  evidenceA: VerificationEvidenceRef;
  evidenceB: VerificationEvidenceRef;
  claimA: string;
  claimB: string;
  resolutionQuestion: string;
  /** Harness-assigned stable retry identity; allocated when absent. */
  conflictID?: VerificationConflictID;
}

/** §50 — durable resolution of the (complete) unresolved indeterminate set. */
export interface RecordAttemptReconciliationInput {
  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  /** MUST equal the complete canonical unresolved set (§43). */
  targetAttemptIDs: ExecutionAttemptID[];
  /** The exact reconciliation inspection Directive revision. */
  inspectionDirective: { id: ExecutionDirectiveID; revision: number };
  /** Harness-assigned stable retry identity (§56); allocated when absent. */
  reconciliationID?: AttemptReconciliationID;
}

/**
 * §12 — prepareFinalClosureStage input: the Supervisor's final integration
 * closure decomposition, gated by full ordinary-Stage readiness.
 */
export interface PrepareFinalClosureStageInput {
  executionRunID: ExecutionRunID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  /** Exact CAS on the run revision. */
  expectedRunRevision: number;
  title: string;
  objective: string;
  /** EXPLICIT, non-empty final closure obligations (§14) — never derivable. */
  completionObligations: { description: string; planRefs: ExecutionPlanRef[] }[];
  /** Harness-assigned stable retry identity (§7 idempotency); allocated when absent. */
  stageID?: ExecutionStageID;
}

/**
 * §33 — the ExecutionCompletionGate input. Core derives the final
 * Stage/Window/Assessment/Commit from canonical state; the caller may pin its
 * belief about the final commit for deterministic conflict detection (§93).
 */
export interface CompleteExecutionRunThroughGateInput {
  executionRunID: ExecutionRunID;
  sessionID: string;
  workspace: WorkspaceIdentity;
  generation: number;
  /** Harness-assigned stable retry identity (§47); allocated when absent. */
  completionID?: ExecutionCompletionID;
  /** Optional caller belief — mismatching the derived final commit is execution_completion_conflict (§93). */
  expectedFinalCommitID?: ExecutionCommitID;
}

/**
 * §15/§16/§66 — the read-only Replan Context projection: everything a future
 * PlanningRun needs, rebuilt from canonical Store records at read time. Never
 * persisted as a second execution truth; never mutates Plan Memory.
 */
export interface ExecutionIssueReplanContext {
  issue: ExecutionIssue;
  /** The old FinalPlan's EXACT identity (id + revision + content hash). */
  finalPlan: { id: import("../core/ids.js").FinalPlanID; revision: number; hash: string };
  sourceAssessment: SupervisorAssessment;
  affectedPlanRefs: ExecutionPlanRef[];
  /** The accepted ExecutionCommit chain at escalation (tip-first). */
  acceptedCommits: ExecutionCommit[];
  /** The candidate context frozen in the issue. */
  candidateContext: {
    activeStageID?: ExecutionStageID;
    openWindowID?: VerificationWindowID;
    candidateRevision?: number;
  };
  relevantReports: ExecutionReport[];
  verificationConflicts: VerificationConflict[];
  unresolvedIndeterminateAttempts: ExecutionAttempt[];
  /** Reconciliations covering (any of) the issue's unresolved Attempts. */
  reconciliations: AttemptReconciliation[];
}

/**
 * §54/§55 — the final-closure/completion projection returned alongside the
 * recovery context; every field is derived from canonical Store state.
 */
export interface FinalClosureProjection {
  finalClosure: "absent" | "pending" | "active" | "completed";
  finalClosureStage?: {
    id: string;
    title: string;
    status: string;
    obligationCount: number;
  };
  finalClosureCommit?: {
    id: string;
    windowID: string;
    candidateRevision: number;
  };
  completionReady: boolean;
  completionBlockers: string[];
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
  /** R1a §16: explicit terminal abort — user-confirmed upstream, state-legal here. */
  abortRun(planID: PlanID): Promise<PlanningRun>;

  // -- Phase 7B: supervised handoff recovery (production cutover) ------------
  /**
   * §9 — every ExecutionRun bound to one PlanningRun, creation order. The
   * recovery state machine uses it to prove "the initial run exists or it
   * does not" without ever guessing by timestamp.
   */
  findExecutionRunsForPlan(planID: PlanID): Promise<ExecutionRun[]>;
  /**
   * Phase 7B §15/§16 — the SUPERVISED handoff completion of the PlanningRun
   * (handoff_pending → completed): the durable statement "the exact approved
   * FinalPlan was handed to a durable ACTIVE supervised ExecutionRun". NOT the
   * legacy Build-delivery completion (completeHandoffRun above, which keeps
   * its legacy delivery preconditions untouched). Preconditions (in-lock):
   * lifecycle handoff_pending, stage final, handoffProtocol supervised_v0_2,
   * exact approved FinalPlan, and at least one ExecutionRun for the plan in
   * lifecycle=active. Idempotent: a completed run completes to itself.
   */
  completePlanningRunForSupervisedHandoff(planID: PlanID): Promise<PlanningRun>;

  // -- ExecutionRun foundation (v0.2.0 Phase 1; SPEC §8-§11) -----------------
  // Durable supervised-execution state, provider-neutral. Every operation
  // validates its full precondition INSIDE the mutation block (durable: under
  // the write lock after rehydration) and publishes atomically — the same
  // narrow-semantic-API discipline as the handoff workflow above. There is
  // deliberately NO generic updateExecutionRun / setLifecycle / rebind API:
  // the FinalPlan binding, workspace, and baselines are immutable after
  // creation, and the lifecycle moves only through these validated
  // transitions. NOT wired into the production v0.1 handoff in Phase 1 and
  // NOT exposed as model-facing tools — callers in this phase are tests only.
  /**
   * SPEC §8.1/§8.2 — create (or idempotently recover) the prepared
   * ExecutionRun for ONE initial handoff of an approved FinalPlan. All inputs
   * are authority-side (the Harness), never model arguments. Idempotent by
   * `initialHandoffKey`: the same handoff retried after a crash returns the
   * SAME prepared run (created=false); a DIFFERENT key under the same
   * FinalPlan is a distinct execution and creates a new run (SPEC §9
   * 0..N cardinality). A key reuse with a DIFFERENT authority binding fails
   * `initial_handoff_conflict`.
   */
  prepareInitialExecutionRun(input: PrepareInitialExecutionRunInput): Promise<{ run: ExecutionRun; created: boolean }>;
  /**
   * SPEC §8.1 — the single atomic prepared → active transition. Validates
   * in-block: run exists, lifecycle prepared, expected workspace matches,
   * expected FinalPlan binding matches (and still resolves to the committed
   * plan with the bound hash), expected run revision matches (CAS).
   */
  activateExecutionRun(executionRunID: ExecutionRunID, expected: ExecutionRunTransitionExpectation): Promise<ExecutionRun>;
  /**
   * Terminal lifecycle primitives (active → completed / replan_required;
   * prepared|active → aborted). STATE-MACHINE/STORAGE CAPABILITY ONLY: no
   * completion gate, no ExecutionIssue transaction, no human-authorization
   * flow lives here (later phases call these above such gates). Internal
   * Core/Application surface — never a model-facing "force" tool.
   */
  /**
   * v0.2.0 Phase 6B §29 — the bare active→completed primitive is REMOVED:
   * completion goes exclusively through completeExecutionRunThroughGate
   * (the ExecutionCompletionGate), so no API can bypass the final-closure
   * provenance requirements.
   */
  prepareFinalClosureStage(input: PrepareFinalClosureStageInput): Promise<{ stage: ExecutionStage; created: boolean }>;
  /** §8/§55 — deterministic readiness projection over canonical state. */
  isExecutionReadyForFinalClosure(executionRunID: ExecutionRunID): Promise<boolean>;
  getExecutionCompletion(completionID: ExecutionCompletionID): Promise<ExecutionCompletionRecord | undefined>;
  findExecutionCompletionForRun(executionRunID: ExecutionRunID): Promise<ExecutionCompletionRecord | undefined>;
  /** §33 — THE ExecutionCompletionGate (the only active → completed path). */
  completeExecutionRunThroughGate(input: CompleteExecutionRunThroughGateInput): Promise<{ record: ExecutionCompletionRecord; run: ExecutionRun; created: boolean }>;
  /**
   * v0.2.0 Phase 6A §11 — THE replan transition. In ONE durable transaction:
   * validate the request_replan source assessment (exact current candidate),
   * persist the immutable ExecutionIssue, transition active → replan_required
   * (terminal), bump the run revision, append audit events. There is
   * deliberately NO bare replan primitive: a replan_required run without a
   * durable issue is unrepresentable (§7/§60).
   */
  transitionExecutionRunToReplanRequired(input: TransitionExecutionRunToReplanRequiredInput): Promise<{ issue: ExecutionIssue; run: ExecutionRun; created: boolean }>;
  abortExecutionRun(executionRunID: ExecutionRunID, expected: ExecutionRunTransitionExpectation): Promise<ExecutionRun>;

  /** Exact read by deterministic id — undefined when absent. */
  getExecutionRun(executionRunID: ExecutionRunID): Promise<ExecutionRun | undefined>;
  /** The run prepared under an EXACT initial-handoff identity, if any. */
  findInitialExecutionRun(planID: PlanID, initialHandoffKey: string): Promise<ExecutionRun | undefined>;
  /** Every ExecutionRun of a plan, in creation order (audit/recovery reads). */
  listExecutionRunsForPlan(planID: PlanID): Promise<ExecutionRun[]>;
  /** Every ExecutionRun bound to an EXACT FinalPlan revision of a plan. */
  listExecutionRunsForFinalPlan(planID: PlanID, ref: FinalPlanRef): Promise<ExecutionRun[]>;
  /** Phase 7A §57 — deterministic prepared/active runs for one trusted workspace (creation order; never a latest-pick). */
  listRecoverableExecutionRuns(workspace: WorkspaceIdentity): Promise<ExecutionRun[]>;

  // -- SupervisorBinding & execution recovery (v0.2.0 Phase 2) ----------------
  // Durable single-writer supervision ownership with generation fencing,
  // ORTHOGONAL to ExecutionRun.lifecycle: attach/detach/takeover mutate ONLY
  // the binding record — never the run lifecycle, FinalPlan binding, workspace,
  // baselines, or execution history. Identity is trusted-boundary state (the
  // host-supplied OpenCode sessionID), never model business payload. There is
  // deliberately NO Worker/Executor/Verifier binding and NO model-facing
  // supervisor tool in this phase (Application/Core surface only).
  /**
   * Attach the FIRST supervisor, or idempotently recover the SAME owner:
   * no binding → generation 1, attached. Same owner + attached → unchanged
   * (same-generation resume, no generation bump). Same owner + detached →
   * re-attach at the SAME generation (no takeover). A DIFFERENT session is
   * refused `supervisor_binding_conflict` — it must take over explicitly.
   */
  attachExecutionSupervisor(input: AttachExecutionSupervisorInput): Promise<{ binding: SupervisorBinding; created: boolean }>;
  /**
   * Explicit detach — changes ONLY the binding's attachment state. Fenced by
   * the recorded owner + current generation + workspace; idempotent when
   * already detached. Never mutates the ExecutionRun.
   */
  detachExecutionSupervisor(input: DetachExecutionSupervisorInput): Promise<SupervisorBinding>;
  /**
   * Explicit AUTHORIZED takeover: new owner + generation N+1 + attached in ONE
   * atomic mutation with an audit event. `unauthorized` authorization fails
   * `takeover_requires_authorization`; a stale expected generation fails
   * `stale_supervisor_binding` — the old generation is dead from the commit
   * point onward, with no dependence on process liveness. Same-owner takeover
   * is an idempotent resume (no generation bump).
   */
  takeoverExecutionSupervisor(input: TakeoverExecutionSupervisorInput): Promise<SupervisorBinding>;
  /**
   * THE reusable authority boundary for every future supervised mutation
   * (Directive/Assessment/Stage/replan all pass through here). Validates run
   * exists, run supervisable (non-terminal), binding exists + attached,
   * owner == trusted session, workspace match, generation current — then
   * returns the checked records. Stable machine-readable errors on every
   * failure; the stale generation failure is `stale_supervisor_binding`.
   */
  authorizeExecutionSupervisor(
    executionRunID: ExecutionRunID,
    authority: { sessionID: string; workspace: WorkspaceIdentity; generation: number },
  ): Promise<{ run: ExecutionRun; binding: SupervisorBinding }>;
  /**
   * Directive §16 — supervised activation: prepared → active ONLY through a
   * valid CURRENT attached binding (one authority check) plus the Phase 1
   * validated transition preconditions (workspace, exact FinalPlan binding,
   * run revision CAS). The low-level Phase 1 `activateExecutionRun` remains
   * internal to the Core/Store boundary; future controller/MCP wiring must
   * use THIS gate so execution can never activate without a supervisor owner.
   */
  activateSupervisedExecutionRun(input: ActivateSupervisedExecutionRunInput): Promise<ExecutionRun>;
  /** The run's binding record, if any (at most one exists per run). */
  findSupervisorBinding(executionRunID: ExecutionRunID): Promise<SupervisorBinding | undefined>;
  /**
   * Deterministic §23 recovery input: every non-terminal ExecutionRun
   * (prepared|active) in creation order. Correctness never depends on a
   * "latest" pick — callers resolve exact run identity from this set.
   */
  listOpenExecutionRuns(): Promise<ExecutionRun[]>;
  /**
   * Directive §21-§23 — rebuild the recovery projection for ONE exact run
   * from canonical store state (never conversation). Undefined when the run
   * does not exist. A projection only — never persisted as authority.
   */
  buildExecutionRecoveryContext(
    executionRunID: ExecutionRunID,
    viewer: { sessionID: string },
  ): Promise<ExecutionRecoveryContext | undefined>;

  // -- ExecutionStage & VerificationWindow (v0.2.0 Phase 3) -------------------
  // The supervised-execution structural layer: durable Stage decomposition of
  // the bound FinalPlan's obligations, the single-active-Stage invariant, and
  // the single-open-Window candidate span. Execution-only: Stage/Window
  // operations NEVER mutate Plan Memory and NEVER advance accepted execution
  // truth (closure/completion is reserved for the future ExecutionCommit).
  // Every mutation runs through the Phase 2 supervisor authority boundary and
  // validates all preconditions inside the mutation block (durable: under the
  // write lock after rehydration). No model-facing tool exists for any of
  // this in Phase 3.
  /**
   * Create a Stage decomposition batch under an ACTIVE run. All drafts are
   * validated against the CANDIDATE DAG (existing stages + batch): self
   * dependency, cycles, and cross-run dependency refs fail closed;
   * `planRefs` must resolve to exact approved FinalPlan reachable refs.
   * DependsOn is MANDATORY dependency only — never derived from the
   * implementationOrder sequencing guidance.
   */
  createExecutionStages(input: CreateExecutionStagesInput): Promise<ExecutionStage[]>;
  /**
   * Directive §13 — the atomic Stage activation transaction: authority check,
   * run active, stage belongs to run, pending, eligible (dependencies
   * completed, no other active Stage, run.activeStage absent, no open
   * Window), run/stage revision CAS — then stage pending→active,
   * run.activeStage set, both revisions bumped, audit event.
   */
  activateExecutionStage(input: ActivateExecutionStageInput): Promise<{ stage: ExecutionStage; run: ExecutionRun }>;
  /**
   * Directive §16 — MINIMAL supersession: pending → superseded only (active
   * Stage split/replace is deferred). The superseded Stage stays durable
   * under its original id forever. Completion (`completed`) has NO Phase 3
   * operation — it is derived by the future ExecutionCommit.
   */
  supersedeExecutionStage(input: SupersedeExecutionStageInput): Promise<ExecutionStage>;
  /**
   * Directive §24 — open the single candidate VerificationWindow for the
   * ACTIVE Stage: run active, named stage IS run.activeStage and active, no
   * open Window exists, run/stage revision CAS — then create the window
   * (candidateRevision 0, anchored to the execution-start accepted state —
   * never a fake ExecutionCommit), set run.openWindow, bump run revision,
   * audit event.
   */
  openVerificationWindow(input: OpenVerificationWindowInput): Promise<{ window: VerificationWindow; run: ExecutionRun }>;
  /**
   * Directive §27 — the deterministic candidate-revision advance primitive
   * (future Attempt completions call this; NO production caller in Phase 3).
   * CAS on expectedCandidateRevision: current=3, advance(expected=3) → 4;
   * advance(expected=3) → `stale_candidate_revision`. Monotonic +1 only —
   * there is no set/decrement/reset operation.
   */
  advanceCandidateRevision(input: AdvanceCandidateRevisionInput): Promise<VerificationWindow>;
  /** Exact Stage read by deterministic id — undefined when absent. */
  getExecutionStage(stageID: ExecutionStageID): Promise<ExecutionStage | undefined>;
  /** Every Stage of an ExecutionRun, in creation order. */
  listExecutionStagesForRun(executionRunID: ExecutionRunID): Promise<ExecutionStage[]>;
  /** Exact Window read by deterministic id — undefined when absent. */
  getVerificationWindow(windowID: VerificationWindowID): Promise<VerificationWindow | undefined>;
  /** Every Window of an ExecutionRun, in creation order. */
  listVerificationWindowsForRun(executionRunID: ExecutionRunID): Promise<VerificationWindow[]>;
  /** The run's open Window (deterministic via run.openWindow), if any. */
  findOpenVerificationWindow(executionRunID: ExecutionRunID): Promise<VerificationWindow | undefined>;

  /** TEST-ONLY: seed Stage records directly (completed-dependency fixtures). Deliberately absent from the durable subclass's sync path. */
  seedExecutionStages(executionRunID: ExecutionRunID, stages: ExecutionStage[]): void;

  // -- Directive / Attempt / Report worker protocol (v0.2.0 Phase 4) ----------
  // The durable Worker transaction protocol: Supervisor intent → bounded
  // Directive → single logical Attempt → unified Report (→ candidate
  // advance). Every transaction is supervisor-authority-gated and validates
  // all preconditions inside the mutation block (durable: under the write
  // lock after rehydration). Immutability is absolute: issued Directive
  // revisions and submitted Reports are never modified; the candidate
  // advance on a mutating report is atomic with the report persistence.
  // No model-facing tool exists; there are no production callers until the
  // Supervisor runtime phase.
  /**
   * Directive §19 — the issuance gate: run active + supervisor authority +
   * stage/window exactly current + FinalPlan binding resolved +
   * baseAcceptedState COPIED from the window + baseCandidateRevision =
   * window candidateRevision + exact planRefs + envelope ≤ trusted ceiling
   * + run/stage/window revision CAS. Idempotent for identical content under
   * the same logical id; new content under the same logical id creates the
   * next immutable revision (old revisions stay durable forever).
   */
  issueExecutionDirective(input: IssueExecutionDirectiveInput): Promise<ExecutionDirective>;
  /**
   * Directive §24 — start the ONE logical Attempt for an exact Directive
   * revision: run active, stage/window still exact/current, directive hash
   * recomputes, baseCandidateRevision == current window candidateRevision
   * (stale directives are never executed), revision not consumed, no
   * running Attempt for the run, envelope ≤ trusted ceiling. Worker role is
   * DERIVED from the directive kind (implementation/inspection → executor,
   * verification → verifier). Never advances candidateRevision.
   */
  startExecutionAttempt(input: StartExecutionAttemptInput): Promise<{ attempt: ExecutionAttempt; directive: ExecutionDirective }>;
  /**
   * Directive §26 — durable unresolved-work fact: the Harness could not
   * determine what the Worker ultimately did. Never pretends failed/completed,
   * never retries, never advances candidateRevision. Terminal state; the
   * future commit gate must refuse Windows carrying unresolved indeterminate
   * Attempts until explicit reconciliation.
   */
  markExecutionAttemptIndeterminate(input: MarkExecutionAttemptIndeterminateInput): Promise<ExecutionAttempt>;
  /**
   * Directive §30 — the report submission transaction: attempt running +
   * exact Directive triple match + role match + one report per attempt +
   * blocked ⇒ ≥1 blocker + base candidate provenance current. ATOMICALLY:
   * persist the immutable Report, attempt running → reported (+endedAt),
   * and — when candidateMutation == changed — advance the window's
   * candidateRevision exactly +1 (a non-mutating directive whose report
   * declares mutation is preserved AND advances, with an
   * unexpected_candidate_mutation event).
   */
  submitExecutionReport(input: SubmitExecutionReportInput): Promise<{ report: ExecutionReport; attempt: ExecutionAttempt; window: VerificationWindow; conflict?: VerificationConflict }>;
  /** Exact historical Directive read by logical id; without revision → newest. */
  getExecutionDirective(directiveID: ExecutionDirectiveID, revision?: number): Promise<ExecutionDirective | undefined>;
  /** Every Directive revision of a run, issuance order. */
  listExecutionDirectivesForRun(executionRunID: ExecutionRunID): Promise<ExecutionDirective[]>;
  /** Exact Attempt read by deterministic id — undefined when absent. */
  getExecutionAttempt(attemptID: ExecutionAttemptID): Promise<ExecutionAttempt | undefined>;
  /** The ONE logical Attempt for an exact Directive revision, if any. */
  findExecutionAttemptForDirective(executionRunID: ExecutionRunID, directive: { id: ExecutionDirectiveID; revision: number }): Promise<ExecutionAttempt | undefined>;
  /** The run's running Attempt, if any (deterministic; never "latest"). */
  findRunningExecutionAttempt(executionRunID: ExecutionRunID): Promise<ExecutionAttempt | undefined>;
  /** Every Attempt of a run, creation order. */
  listExecutionAttemptsForRun(executionRunID: ExecutionRunID): Promise<ExecutionAttempt[]>;
  /** Exact Report read by deterministic id — undefined when absent. */
  getExecutionReport(reportID: ExecutionReportID): Promise<ExecutionReport | undefined>;
  /** The ONE Report for an Attempt, if any. */
  findExecutionReportForAttempt(attemptID: ExecutionAttemptID): Promise<ExecutionReport | undefined>;
  /** Every Report of a run, creation order. */
  listExecutionReportsForRun(executionRunID: ExecutionRunID): Promise<ExecutionReport[]>;

  // -- SupervisorAssessment & ExecutionCommit (v0.2.0 Phase 5) -----------------
  // The acceptance layer: Supervisor PROPOSES, Core DECIDES. A non-accept
  // assessment only persists the immutable judgment; an accept assessment
  // runs the full Core acceptance gate INSIDE one transaction that — on
  // success — persists the assessment, creates the ExecutionCommit, closes
  // the window, advances acceptedHead, and optionally completes the Stage.
  // There is no setAcceptedHead, no closeVerificationWindow, and no
  // completeExecutionStage API: the accept transaction is the only caller.
  /**
   * Directive §28 — submit the Supervisor's immutable judgment. Validates
   * authority, run/stage/window currency, exact candidate revision, no
   * running attempt, exact report/plan refs, obligations subset. Non-accept
   * dispositions only persist + audit. Accept dispositions run the
   * acceptance gate (fresh qualifying verification, no negative current
   * evidence, no indeterminate attempt, coverage proof, parent/linearity,
   * stage-closure completeness) and atomically commit on success.
   * Idempotent by the Harness-supplied assessmentID: same id + same content
   * returns the existing assessment (and its existing commit); same id +
   * different content fails assessment_conflict.
   */
  submitSupervisorAssessment(input: SubmitSupervisorAssessmentInput): Promise<{
    assessment: SupervisorAssessment;
    commit?: ExecutionCommit;
  }>;
  /** Exact assessment read by deterministic id — undefined when absent. */
  getSupervisorAssessment(assessmentID: SupervisorAssessmentID): Promise<SupervisorAssessment | undefined>;
  /** Every assessment of a run, submission order (history, including non-accept). */
  listSupervisorAssessmentsForRun(executionRunID: ExecutionRunID): Promise<SupervisorAssessment[]>;
  /** Exact commit read — undefined when absent. */
  getExecutionCommit(commitID: ExecutionCommitID): Promise<ExecutionCommit | undefined>;
  /** The run's accepted-head commit, if any (deterministic via run.acceptedHead). */
  findAcceptedHeadCommit(executionRunID: ExecutionRunID): Promise<ExecutionCommit | undefined>;
  /** The (single) commit of a window — undefined when the window never committed. */
  findExecutionCommitForWindow(windowID: VerificationWindowID): Promise<ExecutionCommit | undefined>;
  /** Every commit of a run, chain order. */
  listExecutionCommitsForRun(executionRunID: ExecutionRunID): Promise<ExecutionCommit[]>;
  /**
   * §43 — the union of Stage obligations satisfied by the run's ACCEPTED
   * commits, derived from canonical commit records (never a mutable cached
   * second truth).
   */
  acceptedStageObligations(executionRunID: ExecutionRunID, stageID: ExecutionStageID): Promise<StageCompletionObligationID[]>;

  // -- v0.2.0 Phase 6A — escalation / conflict / reconciliation (read + write) --
  getExecutionIssue(issueID: ExecutionIssueID): Promise<ExecutionIssue | undefined>;
  findExecutionIssueForRun(executionRunID: ExecutionRunID): Promise<ExecutionIssue | undefined>;
  /** §15/§16/§66 — read-only Replan Context projection (replan_context_unavailable when absent). */
  buildExecutionIssueReplanContext(issueID: ExecutionIssueID): Promise<ExecutionIssueReplanContext>;
  getVerificationConflict(conflictID: VerificationConflictID): Promise<VerificationConflict | undefined>;
  listVerificationConflictsForRun(executionRunID: ExecutionRunID): Promise<VerificationConflict[]>;
  /** §25 — Supervisor-driven creation of one disputed-fact record. */
  createVerificationConflict(input: CreateVerificationConflictInput): Promise<{ conflict: VerificationConflict; created: boolean }>;
  /** §41 — the canonical unresolved indeterminate set of one window. */
  unresolvedIndeterminateAttempts(executionRunID: ExecutionRunID, windowID: VerificationWindowID): Promise<ExecutionAttempt[]>;
  /** Phase 7A §3 — the reconciliation/commit-blocking (may_mutate) subset of that set. */
  unresolvedSideEffectingAttempts(executionRunID: ExecutionRunID, windowID: VerificationWindowID): Promise<ExecutionAttempt[]>;
  getAttemptReconciliation(reconciliationID: AttemptReconciliationID): Promise<AttemptReconciliation | undefined>;
  listAttemptReconciliationsForRun(executionRunID: ExecutionRunID): Promise<AttemptReconciliation[]>;
  /** §50 — durable resolution of the complete unresolved set (§51 unchanged / §52 changed). */
  recordAttemptReconciliation(input: RecordAttemptReconciliationInput): Promise<{ reconciliation?: AttemptReconciliation; created: boolean; window: VerificationWindow }>;

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

  // -- Snapshot-consistent context read boundary (R2 brief §5) ---------------
  /**
   * ONE coherent read of everything context assembly needs, as one immutable
   * view. Never stitches a prompt from many independent "latest" reads: on
   * the durable store this is one refresh of the atomically-published document
   * followed by reads from that single hydrated state; no writer lock is held.
   * Read-only — it never mutates anything. Undefined when the plan does not
   * exist.
   */
  capturePlanningContextState(planID: PlanID): Promise<PlanningContextState | undefined>;
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
  /** Staged conflicts — R1a: ONLY an approved resolve_conflict change mutates them. */
  conflicts: Conflict[];
  resolvedConflicts: ConflictID[];
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
  /**
   * Phase 7B §6/§8: staged handoff protocol — ONLY the Final PlanCommit sets
   * it (supervised_v0_2), in the same atomic publication as the lifecycle.
   */
  handoffProtocol: PlanningRun["handoffProtocol"];
  /** R1b §50: staged decomposition provenance (set by decomposition, cleared by amendment). */
  sectionDecompositionArchitecture: ArchitectureRef | undefined;
  provenanceTouched: boolean;
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
  /**
   * v0.2.0 Phase 1 — ExecutionRuns, keyed EXEC-### (ids are globally unique;
   * the record carries its planID). Flat like commitByProposal, not per-plan,
   * so an id resolves without knowing the source plan.
   */
  protected readonly executionRuns = new Map<ExecutionRunID, ExecutionRun>();
  /** v0.2.0 Phase 1 — `planID:initialHandoffKey` → EXEC id; the idempotency index. */
  protected readonly executionRunByHandoffKey = new Map<string, ExecutionRunID>();
  /**
   * v0.2.0 Phase 2 — SupervisorBindings, keyed by executionRunID (AT MOST ONE
   * record per run: a second writable owner is unrepresentable).
   */
  protected readonly supervisorBindings = new Map<ExecutionRunID, SupervisorBinding>();
  /**
   * v0.2.0 Phase 3 — ExecutionStages / VerificationWindows, keyed by their
   * own ids (never reused; superseded/completed records stay durable).
   */
  protected readonly executionStages = new Map<ExecutionStageID, ExecutionStage>();
  protected readonly verificationWindows = new Map<VerificationWindowID, VerificationWindow>();
  /**
   * v0.2.0 Phase 4 — the worker transaction protocol families. Directives
   * are keyed "DIR-###@REV" (every revision durable); attempts ATT-###;
   * reports RPT-###; the attempt-by-directive-revision index enforces the
   * one-logical-Attempt-per-exact-revision invariant.
   */
  protected readonly executionDirectives = new Map<string, ExecutionDirective>();
  protected readonly executionAttempts = new Map<ExecutionAttemptID, ExecutionAttempt>();
  protected readonly executionReports = new Map<ExecutionReportID, ExecutionReport>();
  protected readonly executionAttemptByDirective = new Map<string, ExecutionAttemptID>();
  /**
   * v0.2.0 Phase 5 — acceptance layer: assessments (SA-###), the linear
   * commit chain (EC-###), and the deterministic per-window /
   * per-assessment indexes (one commit per window, one per accept
   * assessment).
   */
  protected readonly supervisorAssessments = new Map<SupervisorAssessmentID, SupervisorAssessment>();
  protected readonly executionCommits = new Map<ExecutionCommitID, ExecutionCommit>();
  protected readonly executionCommitByWindow = new Map<VerificationWindowID, ExecutionCommitID>();
  protected readonly executionCommitByAssessment = new Map<SupervisorAssessmentID, ExecutionCommitID>();
  /**
   * v0.2.0 Phase 6A — the abnormal/escalation control plane: ExecutionIssues
   * (ISS-###, one terminal issue per replan_required run via the
   * issueByExecutionRun index), VerificationConflicts (VCF-###, one per
   * disputed fact), AttemptReconciliations (REC-###), and the
   * attempt→reconciliation coverage index backing the canonical
   * unresolved-indeterminate set.
   */
  protected readonly executionIssues = new Map<ExecutionIssueID, ExecutionIssue>();
  protected readonly issueByExecutionRun = new Map<ExecutionRunID, ExecutionIssueID>();
  protected readonly verificationConflicts = new Map<VerificationConflictID, VerificationConflict>();
  protected readonly attemptReconciliations = new Map<AttemptReconciliationID, AttemptReconciliation>();
  protected readonly reconciliationByAttempt = new Map<ExecutionAttemptID, AttemptReconciliationID>();
  /**
   * v0.2.0 Phase 6B — the ExecutionCompletionGate family: CMPL-### records
   * (ONE per completed run via the completionByExecutionRun index) — the
   * durable provenance that makes `completed` more than a bare enum value.
   */
  protected readonly executionCompletions = new Map<ExecutionCompletionID, ExecutionCompletionRecord>();
  protected readonly completionByExecutionRun = new Map<ExecutionRunID, ExecutionCompletionID>();

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

  // -- Snapshot-consistent context read boundary (R2 brief §5) ----------------
  // In-memory consistency is automatic (single-threaded synchronous reads);
  // the durable store overrides this with ONE refreshFromDisk before the same
  // map reads — never per-read refreshes, never a writer lock.

  async capturePlanningContextState(planID: PlanID): Promise<PlanningContextState | undefined> {
    const run = this.runs.get(planID);
    if (!run) return undefined;
    const snapshot = run.headSnapshot ? this.snapshots.get(planID)?.get(run.headSnapshot) : undefined;
    const sectionRegistry = this.sectionRevisions.get(planID);
    const architectureRegistry = this.architectures.get(planID);
    const architecture =
      snapshot?.state.architectureRevision !== undefined
        ? architectureRegistry?.byKey.get(revisionKey("ARCH", snapshot.state.architectureRevision))
        : undefined;
    // Phase 7B §43 — resolve the formal replan initial context for a
    // PlanningRun created from an ExecutionIssue (exact refs + compact
    // durable facts; execution history stays EVIDENCE, never Plan Memory).
    let replan: import("../context/state.js").ReplanPlanningContext | undefined;
    if (run.replanProvenance) {
      const issue = await this.findExecutionIssueForRun(run.replanProvenance.priorExecutionRun);
      const accepted = await this.listExecutionCommitsForRun(run.replanProvenance.priorExecutionRun);
      replan = {
        sourceExecutionIssue: run.replanProvenance.sourceExecutionIssue,
        priorFinalPlan: run.replanProvenance.priorFinalPlan,
        priorExecutionRun: run.replanProvenance.priorExecutionRun,
        ...(issue
          ? {
              issue: {
                reason: issue.reason,
                affectedPlanRefs: issue.affectedPlanRefs.map((ref) => ("id" in ref ? String(ref.id) : JSON.stringify(ref))),
                ...(issue.acceptedHead ? { acceptedHead: issue.acceptedHead } : {}),
                ...(issue.candidateRevision !== undefined ? { candidateRevision: issue.candidateRevision } : {}),
                ...(issue.activeStageID ? { activeStageID: issue.activeStageID } : {}),
              },
            }
          : {
              issue: { reason: "(issue record unavailable)", affectedPlanRefs: [] },
            }),
        acceptedCommitCount: accepted.length,
      };
    }
    return buildPlanningContextState({
      run,
      ...(replan ? { replan } : {}),
      ...(snapshot ? { headSnapshot: snapshot } : {}),
      ...(architecture ? { architecture } : {}),
      sections: [...(this.sections.get(planID)?.values() ?? [])],
      sectionRevisions: (ref) => sectionRegistry?.byKey.get(revisionKey(ref.id, ref.revision)),
      decisions: new Map([...(this.decisions.get(planID)?.byKey ?? [])]),
      evidence: [...(this.evidence.get(planID)?.latest.values() ?? [])],
      proposals: [...(this.proposals.get(planID)?.values() ?? [])],
      synthesisInputs: [...(this.synthesisInputs.get(planID)?.values() ?? [])],
      synthesisManifests: [...(this.synthesisManifests.get(planID)?.values() ?? [])],
      validationReports: [...(this.validationReports.get(planID)?.values() ?? [])],
      evidenceAudits: [...(this.evidenceAudits.get(planID)?.values() ?? [])],
      finalPlanCandidates: [...(this.finalPlanCandidates.get(planID)?.values() ?? [])],
      finalPlans: [...(this.finalPlans.get(planID)?.values() ?? [])],
      executionHandoffs: [...(this.executionHandoffs.get(planID)?.values() ?? [])],
    });
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
    // Phase 7B §17/E4/E94 — the legacy free-Build handoff is RECOVERY-ONLY.
    // A run whose Final Approval durably selected supervised_v0_2 can never
    // grow legacy Build-delivery artifacts: the refusal is HERE (the single
    // durable gateway), not merely in a caller, so no new code path can
    // silently re-enter free Build.
    if (run.handoffProtocol === "supervised_v0_2") {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `PlanningRun ${planID} durably selected the supervised_v0_2 handoff protocol; legacy free-Build handoff artifacts are unreachable`,
        { planID, handoffProtocol: run.handoffProtocol },
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
    // Phase 7B §17 — same recovery-only rule as saveExecutionHandoff: no new
    // legacy Build-delivery state may appear under a supervised_v0_2 run.
    if (run.handoffProtocol === "supervised_v0_2") {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `PlanningRun ${planID} durably selected the supervised_v0_2 handoff protocol; legacy free-Build delivery is unreachable`,
        { planID, handoffProtocol: run.handoffProtocol },
      );
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

  // -- Phase 7B: supervised handoff recovery ----------------------------------

  async findExecutionRunsForPlan(planID: PlanID): Promise<ExecutionRun[]> {
    return [...this.executionRuns.values()]
      .filter((run) => run.planID === planID)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.id < b.id ? -1 : 1)));
  }

  async completePlanningRunForSupervisedHandoff(planID: PlanID): Promise<PlanningRun> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    // Idempotent — a completed run completes to itself (same rule as the
    // legacy completion above).
    if (run.lifecycle === "completed") {
      return run;
    }
    if (run.lifecycle !== "handoff_pending" || run.stage !== "final") {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `Supervised handoff completion requires lifecycle=handoff_pending + stage=final (run is ${run.lifecycle}/${run.stage})`,
        { lifecycle: run.lifecycle, stage: run.stage },
      );
    }
    // §7 — a legacy (pre-marker) run completes only through the legacy
    // delivery workflow; this operation is supervised-only.
    if (run.handoffProtocol !== "supervised_v0_2") {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `Supervised handoff completion requires the supervised_v0_2 protocol marker (run has ${run.handoffProtocol ?? "no marker — legacy_v0_1"})`,
        { planID },
      );
    }
    if (!run.finalPlan) {
      throw new UltraPlanError("handoff_not_allowed", `Supervised handoff completion requires a committed FinalPlan pointer`, { planID });
    }
    const finalPlan = await this.getFinalPlan(planID, run.finalPlan.id, run.finalPlan.revision);
    if (!finalPlan || finalPlan.status !== "approved") {
      throw new UltraPlanError("handoff_not_allowed", `Supervised handoff completion requires the exact approved FinalPlan record`, { planID });
    }
    // §15 — the ExecutionRun must ALREADY be durable-active BEFORE the
    // PlanningRun completes its handoff; this gate is what makes the crash
    // window "active run + handoff_pending PlanningRun" resumable by
    // completion ONLY (never re-preparation, never re-attachment).
    const activeRun = (await this.findExecutionRunsForPlan(planID)).find((candidate) => candidate.lifecycle === "active");
    if (!activeRun) {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `Supervised handoff completion requires a durable ACTIVE ExecutionRun for the plan; none exists`,
        { planID },
      );
    }
    // §48 — pure workflow-state transition: no PlanCommit/Snapshot/HEAD/
    // FinalPlan change, published as one run-header write.
    const updated: PlanningRun = { ...run, lifecycle: "completed", revision: run.revision + 1, updatedAt: this.now() };
    this.runs.set(planID, updated);
    await this.appendEvent(planID, { type: "run.lifecycle_changed", from: run.lifecycle, to: "completed" });
    return updated;
  }

  /**
   * R1a §16 — the explicit terminal abort. A narrow Harness-owned workflow
   * transition (never a Proposal/PlanCommit): lifecycle active → aborted,
   * activeWork cleared, one `run.lifecycle_changed` event. Committed Plan
   * Memory, HEAD, Proposals/Approvals/Commits, Evidence, and the final history
   * are untouched; `aborted` is terminal (a new run requires a fresh
   * /ultra-plan admission). The CALLER must have performed the real one-shot
   * user confirmation (controller beginAbort/confirmAbort) — this operation
   * only enforces the state legality: active runs in
   * discovery/architecture/detail/synthesis.
   */
  async abortRun(planID: PlanID): Promise<PlanningRun> {
    const run = this.runs.get(planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${planID} does not exist`, { planID });
    }
    if (run.lifecycle !== "active" || run.stage === "final") {
      throw new UltraPlanError(
        "abort_not_allowed",
        `A run can only be aborted while lifecycle=active and stage is discovery/architecture/detail/synthesis (run is ${run.lifecycle}/${run.stage})`,
        { planID, lifecycle: run.lifecycle, stage: run.stage },
      );
    }
    const updated: PlanningRun = {
      ...run,
      lifecycle: "aborted",
      activeWork: undefined,
      revision: run.revision + 1,
      updatedAt: this.now(),
    };
    this.runs.set(planID, updated);
    await this.appendEvent(planID, { type: "run.lifecycle_changed", from: run.lifecycle, to: "aborted" });
    return updated;
  }

  // -------------------------------------------------------------------------
  // ExecutionRun foundation (v0.2.0 Phase 1) — durable supervised-execution
  // state with validated lifecycle transitions. NOT wired into the v0.1
  // production handoff (Phase 2 rewires that); NOT exposed as model-facing
  // tools. Every precondition is revalidated inside the mutation block (for
  // the durable subclass: under the write lock after rehydration) so a stale
  // or cross-instance transition fails closed instead of last-writer-wins.
  // -------------------------------------------------------------------------

  async prepareInitialExecutionRun(input: PrepareInitialExecutionRunInput): Promise<{ run: ExecutionRun; created: boolean }> {
    const run = this.runs.get(input.planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${input.planID} does not exist`, { planID: input.planID });
    }
    // SPEC §8.1: the initial ExecutionRun materializes in the recoverable
    // handoff state — the same entry condition as the v0.1 handoff freeze.
    if (run.lifecycle !== "handoff_pending") {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `Initial ExecutionRun preparation requires lifecycle=handoff_pending (run is ${run.lifecycle})`,
        { planID: input.planID, lifecycle: run.lifecycle },
      );
    }
    if (typeof input.initialHandoffKey !== "string" || input.initialHandoffKey.length === 0) {
      throw new UltraPlanError("invalid_scope", "Initial ExecutionRun preparation requires a non-empty initialHandoffKey", {
        planID: input.planID,
      });
    }
    if (typeof input.workspace?.key !== "string" || input.workspace.key.length === 0) {
      throw new UltraPlanError("workspace_mismatch", "ExecutionRun requires a non-empty WorkspaceIdentity", { planID: input.planID });
    }
    if (!run.finalPlan || run.finalPlan.id !== input.finalPlan.id || run.finalPlan.revision !== input.finalPlan.revision) {
      throw new UltraPlanError(
        "final_plan_binding_mismatch",
        `ExecutionRun binds ${input.finalPlan.id}@${input.finalPlan.revision}, but the run's finalPlan pointer is ${
          run.finalPlan ? `${run.finalPlan.id}@${run.finalPlan.revision}` : "none"
        }`,
        { planID: input.planID },
      );
    }
    const finalPlan = this.getFinalPlanSync(input.planID, input.finalPlan);
    if (!finalPlan || finalPlan.status !== "approved") {
      throw new UltraPlanError(
        "handoff_not_allowed",
        `Initial ExecutionRun preparation requires the exact approved FinalPlan record`,
        { planID: input.planID, finalPlan: `${input.finalPlan.id}@${input.finalPlan.revision}` },
      );
    }
    if (finalPlan.hash !== input.finalPlanHash) {
      throw new UltraPlanError(
        "final_plan_binding_mismatch",
        `ExecutionRun binding hash ${input.finalPlanHash.slice(0, 16)}… does not match the committed FinalPlan hash ${finalPlan.hash.slice(0, 16)}…`,
        { planID: input.planID, finalPlan: `${input.finalPlan.id}@${input.finalPlan.revision}` },
      );
    }
    // §8.2 crash consistency — idempotent by handoff identity, NEVER by
    // FinalPlan uniqueness (SPEC §9 allows 0..N runs per FinalPlan).
    const indexKey = executionHandoffIndexKey(input.planID, input.initialHandoffKey);
    const existingID = this.executionRunByHandoffKey.get(indexKey);
    if (existingID !== undefined) {
      const existing = this.executionRuns.get(existingID);
      if (!existing) {
        throw new UltraPlanError("store_corrupt", `ExecutionRun handoff index references missing run ${existingID}`, { indexKey });
      }
      if (
        existing.planID !== input.planID ||
        existing.finalPlan.id !== input.finalPlan.id ||
        existing.finalPlan.revision !== input.finalPlan.revision ||
        existing.finalPlanHash !== input.finalPlanHash ||
        !workspaceIdentityEquals(existing.workspace, input.workspace)
      ) {
        throw new UltraPlanError(
          "initial_handoff_conflict",
          `Initial handoff key "${input.initialHandoffKey}" is already bound to a different authority state (run ${existing.id})`,
          { indexKey, existingID: existing.id },
        );
      }
      // Same handoff retry (crash/retry): the SAME prepared run — baselines
      // keep the values fixed at first materialization.
      return { run: existing, created: false };
    }
    // Planning baseline derived ONCE from the exact FinalPlan provenance.
    const planningBaseline: PlanningBaselineRef = {
      snapshot: finalPlan.baseSnapshot,
      finalCommit: finalPlan.baseCommit,
    };
    const id = ExecutionRunIDs.from(nextSequence([...this.executionRuns.keys()], ExecutionRunIDs.prefix));
    if (this.executionRuns.has(id)) {
      throw new UltraPlanError("duplicate_execution_run_id", `ExecutionRun ${id} already exists`, { executionRunID: id });
    }
    const now = this.now();
    const executionRun: ExecutionRun = {
      id,
      planID: input.planID,
      initialHandoffKey: input.initialHandoffKey,
      workspace: { ...input.workspace },
      finalPlan: { ...input.finalPlan },
      finalPlanHash: input.finalPlanHash,
      planningBaseline,
      executionStartBaseline: {
        ...input.executionStartBaseline,
        ...(input.executionStartBaseline.vcs ? { vcs: { ...input.executionStartBaseline.vcs } } : {}),
      },
      lifecycle: "prepared",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.executionRuns.set(id, executionRun);
    this.executionRunByHandoffKey.set(indexKey, id);
    await this.appendEvent(input.planID, {
      type: "execution.run_prepared",
      executionRunID: id,
      finalPlan: `${input.finalPlan.id}@${input.finalPlan.revision}`,
      initialHandoffKey: input.initialHandoffKey,
    });
    return { run: executionRun, created: true };
  }

  async activateExecutionRun(executionRunID: ExecutionRunID, expected: ExecutionRunTransitionExpectation): Promise<ExecutionRun> {
    const { updated, from } = this.transitionExecutionRunValidated(executionRunID, "active", expected);
    await this.appendEvent(updated.planID, {
      type: "execution.run_lifecycle_changed",
      executionRunID,
      from,
      to: "active",
    });
    return updated;
  }

  /**
   * v0.2.0 Phase 6A §11 — the ONLY path to replan_required. One durable
   * transaction: source-assessment validation → immutable ExecutionIssue
   * persistence → active→replan_required run transition (revision++) → audit
   * events. The crash-safe retry (§17) short-circuits BEFORE the structure
   * checks: a retry arrives after the run already terminalized, so it must
   * return the existing issue + terminal run instead of failing on lifecycle.
   */
  async transitionExecutionRunToReplanRequired(input: TransitionExecutionRunToReplanRequiredInput): Promise<{ issue: ExecutionIssue; run: ExecutionRun; created: boolean }> {
    const run = this.requireExecutionRun(input.executionRunID);
    // Trusted-identity shape + workspace binding come first (cheap, both
    // orders agree with the Phase 2 authority check on non-terminal runs).
    this.assertTrustedSupervisorIdentity(input.sessionID, input.workspace);
    if (!workspaceIdentityEquals(run.workspace, input.workspace)) {
      throw new UltraPlanError("workspace_mismatch", `ExecutionRun ${run.id} is bound to workspace ${JSON.stringify(run.workspace)}, not the caller's ${JSON.stringify(input.workspace)}`, {
        executionRunID: run.id,
      });
    }
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new UltraPlanError("invalid_scope", "An ExecutionIssue requires a non-empty reason", { executionRunID: run.id });
    }
    // §17 idempotency BEFORE the authority/lifecycle gates: the crash-safe
    // retry arrives AFTER the run terminalized (a state the frozen Phase 2
    // authority check refuses), so same issue id + same content must return
    // the existing issue and the terminal run; same id + different content is
    // execution_issue_conflict — never "latest wins".
    const issueID =
      input.issueID ??
      ExecutionIssueIDs.from(nextSequence([...this.executionIssues.keys()], ExecutionIssueIDs.prefix));
    const existingIssue = this.executionIssues.get(issueID);
    if (existingIssue) {
      const retryRecord = this.buildExecutionIssueCandidate(run, input, issueID, "");
      if (executionIssueContentEquals(existingIssue, { ...retryRecord, hash: computeExecutionIssueHash(executionIssueHashPayload(retryRecord)) })) {
        const terminalRun = this.requireExecutionRun(existingIssue.executionRunID);
        return { issue: existingIssue, run: terminalRun, created: false };
      }
      throw new UltraPlanError("execution_issue_conflict", `ExecutionIssue ${issueID} already exists with DIFFERENT content; new escalation requires a new id`, {
        issueID,
      });
    }
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError("invalid_execution_lifecycle", `The replan transition requires an active ExecutionRun (run is ${run.lifecycle})`, {
        executionRunID: run.id,
        lifecycle: run.lifecycle,
      });
    }
    // §7 — a durable semantic judgment authorizes the transition: the source
    // SupervisorAssessment must exist, belong to THIS run, carry disposition
    // request_replan, and bind the exact current Stage/Window/candidate.
    const sourceAssessment = this.supervisorAssessments.get(input.sourceAssessmentID);
    if (!sourceAssessment || sourceAssessment.executionRunID !== run.id) {
      throw new UltraPlanError(
        "replan_assessment_required",
        `The replan transition requires a request_replan SupervisorAssessment in ExecutionRun ${run.id} (assessment ${input.sourceAssessmentID} does not resolve in this run)`,
        { executionRunID: run.id, sourceAssessmentID: input.sourceAssessmentID },
      );
    }
    if (sourceAssessment.disposition !== "request_replan") {
      throw new UltraPlanError(
        "replan_assessment_required",
        `Source assessment ${sourceAssessment.id} carries disposition ${sourceAssessment.disposition}; only request_replan authorizes the replan transition`,
        { assessmentID: sourceAssessment.id, disposition: sourceAssessment.disposition },
      );
    }
    const currentWindow = run.openWindow !== undefined ? this.verificationWindows.get(run.openWindow) : undefined;
    if (
      run.activeStage === undefined ||
      run.openWindow === undefined ||
      !currentWindow ||
      sourceAssessment.stageID !== run.activeStage ||
      sourceAssessment.windowID !== run.openWindow ||
      sourceAssessment.candidateRevision !== currentWindow.candidateRevision
    ) {
      throw new UltraPlanError(
        "replan_assessment_stale",
        `Source assessment ${sourceAssessment.id} no longer binds the run's current Stage/Window/candidate (assessment binds ${sourceAssessment.stageID}/${sourceAssessment.windowID}@${sourceAssessment.candidateRevision}); the candidate has moved — re-assess`,
        { assessmentID: sourceAssessment.id },
      );
    }
    // §12 — the FinalPlan binding must be exactly intact (never rebindable).
    const finalPlan = this.getFinalPlanSync(run.planID, run.finalPlan);
    if (!finalPlan || finalPlan.hash !== run.finalPlanHash) {
      throw new UltraPlanError("final_plan_binding_mismatch", `ExecutionRun ${run.id} FinalPlan binding no longer resolves with the bound hash`, {
        executionRunID: run.id,
      });
    }
    // §12 — exact CAS on the run revision.
    if (run.revision !== input.expectedRunRevision) {
      throw new UltraPlanError(
        "stale_execution_run",
        `ExecutionRun ${run.id} is at revision ${run.revision}, not the expected ${input.expectedRunRevision}; re-read and retry`,
        { executionRunID: run.id, revision: run.revision, expected: input.expectedRunRevision },
      );
    }
    // §8/§E5 — affectedPlanRefs are the normative re-planning scope: every ref
    // must resolve exactly inside the bound FinalPlan.
    validateExecutionPlanRefs(input.affectedPlanRefs ?? [], finalPlan);
    // §12 — no running Attempt; unresolved indeterminate/conflicts do NOT
    // block (they ARE escalation context, §10).
    const running = [...this.executionAttempts.values()].find(
      (attempt) => attempt.executionRunID === run.id && attempt.state === "running",
    );
    if (running) {
      throw new UltraPlanError("active_attempt_conflict", `ExecutionRun ${run.id} has a running Attempt (${running.id}); resolve it before the replan transition`, {
        executionRunID: run.id,
        attemptID: running.id,
      });
    }
    // reportRefs must be provenance from THIS run.
    const attemptIDs = new Set(
      [...this.executionAttempts.values()].filter((attempt) => attempt.executionRunID === run.id).map((attempt) => attempt.id),
    );
    for (const ref of input.reportRefs ?? []) {
      const report = this.executionReports.get(ref);
      if (!report || !attemptIDs.has(report.attemptID)) {
        throw new UltraPlanError("invalid_scope", `ExecutionIssue report ref ${ref} does not belong to ExecutionRun ${run.id}`, { reportID: ref });
      }
    }
    const issue = this.buildExecutionIssueCandidate(run, input, issueID, "");
    issue.hash = computeExecutionIssueHash(executionIssueHashPayload(issue));
    issue.createdAt = this.now();
    // THE SINGLE MUTATION POINT: issue + terminal transition commit together.
    const updated: ExecutionRun = { ...run, lifecycle: "replan_required", revision: run.revision + 1, updatedAt: issue.createdAt };
    assertExecutionRunBindingUnchanged(run, updated);
    this.executionIssues.set(issueID, issue);
    this.issueByExecutionRun.set(run.id, issueID);
    this.executionRuns.set(run.id, updated);
    await this.appendEvent(run.planID, {
      type: "execution.issue_created",
      executionRunID: run.id,
      issueID,
      sourceAssessmentID: issue.sourceAssessmentID,
    });
    await this.appendEvent(run.planID, {
      type: "execution.replan_required",
      executionRunID: run.id,
      issueID,
      from: "active",
    });
    return { issue, run: updated, created: true };
  }

  /**
   * §5/§9/§10 — build the issue record's semantic payload from the run's
   * CURRENT durable state: accepted history (chain tip + full chain), current
   * candidate context, unresolved conflicts and unresolved indeterminate
   * Attempts. Pure context capture — never mutates anything.
   */
  private buildExecutionIssueCandidate(
    run: ExecutionRun,
    input: TransitionExecutionRunToReplanRequiredInput,
    issueID: ExecutionIssueID,
    createdAt: Timestamp,
  ): ExecutionIssue {
    const acceptedCommitRefs = this.acceptedCommitChain(run.id);
    const currentWindow = run.openWindow !== undefined ? this.verificationWindows.get(run.openWindow) : undefined;
    const candidateRevision = currentWindow?.candidateRevision;
    const unresolvedConflicts = [...this.verificationConflicts.values()].filter(
      (conflict) =>
        conflict.executionRunID === run.id &&
        (conflict.status === "open" || conflict.status === "verification_blocked"),
    );
    const unresolvedIndeterminate = this.unresolvedIndeterminateAttemptRefs(run.id);
    const issue: ExecutionIssue = {
      id: issueID,
      executionRunID: run.id,
      finalPlanRef: { id: run.finalPlan.id, revision: run.finalPlan.revision },
      sourceAssessmentID: input.sourceAssessmentID as SupervisorAssessmentID,
      reason: input.reason,
      affectedPlanRefs: (input.affectedPlanRefs ?? []).map((ref) => ({ ...ref })) as ExecutionPlanRef[],
      reportRefs: [...(input.reportRefs ?? [])],
      acceptedCommitRefs,
      verificationConflictRefs: unresolvedConflicts.map((conflict) => conflict.id),
      unresolvedIndeterminateAttemptRefs: unresolvedIndeterminate,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.limitations !== undefined ? { limitations: [...input.limitations] } : {}),
      ...(input.repositoryContextSummary !== undefined ? { repositoryContextSummary: input.repositoryContextSummary } : {}),
      hash: "",
      createdAt,
    };
    if (run.acceptedHead !== undefined) issue.acceptedHead = run.acceptedHead;
    if (run.activeStage !== undefined) issue.activeStageID = run.activeStage;
    if (run.openWindow !== undefined) issue.openWindowID = run.openWindow;
    if (candidateRevision !== undefined) issue.candidateRevision = candidateRevision;
    return issue;
  }

  /** The run's full accepted ExecutionCommit chain, tip-first (deterministic walk of the linear chain). */
  private acceptedCommitChain(executionRunID: ExecutionRunID): ExecutionCommitID[] {
    const byID = new Map<string, import("../core/execution-commit.js").ExecutionCommit>();
    for (const commit of this.executionCommits.values()) {
      if (commit.executionRunID === executionRunID) byID.set(commit.id, commit);
    }
    const run = this.executionRuns.get(executionRunID);
    const chain: ExecutionCommitID[] = [];
    let cursor = run?.acceptedHead;
    while (cursor !== undefined) {
      const commit = byID.get(cursor);
      if (!commit) break;
      chain.push(commit.id);
      cursor =
        commit.parentAcceptedState.kind === "execution_commit" ? commit.parentAcceptedState.executionCommitID : undefined;
    }
    return chain;
  }

  async abortExecutionRun(executionRunID: ExecutionRunID, expected: ExecutionRunTransitionExpectation): Promise<ExecutionRun> {
    const { updated, from } = this.transitionExecutionRunValidated(executionRunID, "aborted", expected);
    await this.appendEvent(updated.planID, {
      type: "execution.run_lifecycle_changed",
      executionRunID,
      from,
      to: "aborted",
    });
    return updated;
  }

  async getExecutionRun(executionRunID: ExecutionRunID): Promise<ExecutionRun | undefined> {
    return this.executionRuns.get(executionRunID);
  }

  async findInitialExecutionRun(planID: PlanID, initialHandoffKey: string): Promise<ExecutionRun | undefined> {
    const id = this.executionRunByHandoffKey.get(executionHandoffIndexKey(planID, initialHandoffKey));
    return id === undefined ? undefined : this.executionRuns.get(id);
  }

  async listExecutionRunsForPlan(planID: PlanID): Promise<ExecutionRun[]> {
    return [...this.executionRuns.values()].filter((run) => run.planID === planID);
  }

  async listExecutionRunsForFinalPlan(planID: PlanID, ref: FinalPlanRef): Promise<ExecutionRun[]> {
    return [...this.executionRuns.values()].filter(
      (run) => run.planID === planID && run.finalPlan.id === ref.id && run.finalPlan.revision === ref.revision,
    );
  }

  /**
   * Phase 7A §57 — the DETERMINISTIC recoverable set for one trusted
   * workspace: prepared/active runs whose workspace identity matches, in
   * creation order. There is deliberately NO "latest by timestamp" pick —
   * with more than one candidate the caller must decide explicitly.
   */
  async listRecoverableExecutionRuns(workspace: WorkspaceIdentity): Promise<ExecutionRun[]> {
    return [...this.executionRuns.values()].filter(
      (run) =>
        (run.lifecycle === "prepared" || run.lifecycle === "active") &&
        stableStringify(run.workspace) === stableStringify(workspace),
    );
  }

  /**
   * Shared validated transition core for the ExecutionRun lifecycle. Checks,
   * in order: existence, expected workspace, expected revision (CAS), exact
   * FinalPlan binding (against the expectation AND the committed plan record
   * with its bound hash), lifecycle legality, binding immutability — then
   * mutates. Never resolves a FinalPlan "latest"; never rebinds anything.
   */
  private transitionExecutionRunValidated(
    executionRunID: ExecutionRunID,
    to: ExecutionLifecycle,
    expected: ExecutionRunTransitionExpectation,
  ): { updated: ExecutionRun; from: ExecutionLifecycle } {
    const run = this.executionRuns.get(executionRunID);
    if (!run) {
      throw new UltraPlanError("execution_run_not_found", `ExecutionRun ${executionRunID} does not exist`, { executionRunID });
    }
    if (!workspaceIdentityEquals(run.workspace, expected.workspace)) {
      throw new UltraPlanError(
        "workspace_mismatch",
        `ExecutionRun ${run.id} is bound to workspace ${JSON.stringify(run.workspace)}, not the expected ${JSON.stringify(expected.workspace)}; runs never migrate workspaces`,
        { executionRunID: run.id },
      );
    }
    if (run.revision !== expected.runRevision) {
      throw new UltraPlanError(
        "stale_execution_run",
        `ExecutionRun ${run.id} is at revision ${run.revision}, not the expected ${expected.runRevision}; re-read and retry`,
        { executionRunID: run.id, revision: run.revision, expected: expected.runRevision },
      );
    }
    if (run.finalPlan.id !== expected.finalPlan.id || run.finalPlan.revision !== expected.finalPlan.revision) {
      throw new UltraPlanError(
        "final_plan_binding_mismatch",
        `ExecutionRun ${run.id} is bound to ${run.finalPlan.id}@${run.finalPlan.revision}, not the expected ${expected.finalPlan.id}@${expected.finalPlan.revision}`,
        { executionRunID: run.id },
      );
    }
    const finalPlan = this.getFinalPlanSync(run.planID, run.finalPlan);
    if (!finalPlan || finalPlan.hash !== run.finalPlanHash) {
      throw new UltraPlanError(
        "final_plan_binding_mismatch",
        `ExecutionRun ${run.id} FinalPlan binding ${run.finalPlan.id}@${run.finalPlan.revision} no longer resolves to the committed plan with the bound hash`,
        { executionRunID: run.id },
      );
    }
    const from = run.lifecycle;
    if (!canTransitionExecutionLifecycle(from, to)) {
      throw new UltraPlanError(
        "invalid_execution_lifecycle",
        `ExecutionRun ${run.id} cannot transition lifecycle ${from} -> ${to}`,
        { executionRunID: run.id, from, to },
      );
    }
    const updated: ExecutionRun = { ...run, lifecycle: to, revision: run.revision + 1, updatedAt: this.now() };
    assertExecutionRunBindingUnchanged(run, updated);
    this.executionRuns.set(executionRunID, updated);
    return { updated, from };
  }

  /** Exact-revision FinalPlan read for in-block validation (already in the mutation path). */
  private getFinalPlanSync(planID: PlanID, ref: FinalPlanRef): FinalPlan | undefined {
    return this.finalPlans.get(planID)?.get(`${ref.id}@${ref.revision}`);
  }

  // -------------------------------------------------------------------------
  // SupervisorBinding & execution recovery (v0.2.0 Phase 2) — durable
  // single-writer supervision ownership with generation fencing, orthogonal
  // to ExecutionRun.lifecycle. Every precondition revalidates inside the
  // mutation block (durable: under the write lock after rehydration). NOT
  // wired into the v0.1 production handoff; NOT exposed as model-facing tools.
  // -------------------------------------------------------------------------

  async attachExecutionSupervisor(input: AttachExecutionSupervisorInput): Promise<{ binding: SupervisorBinding; created: boolean }> {
    const run = this.requireExecutionRun(input.executionRunID);
    if (!isSupervisableExecutionRun(run)) {
      throw new UltraPlanError(
        "invalid_execution_lifecycle",
        `ExecutionRun ${run.id} is terminal (${run.lifecycle}); no supervisor can attach`,
        { executionRunID: run.id, lifecycle: run.lifecycle },
      );
    }
    this.assertTrustedSupervisorIdentity(input.sessionID, input.workspace);
    if (stableStringify(run.workspace) !== stableStringify(input.workspace)) {
      throw new UltraPlanError(
        "workspace_mismatch",
        `ExecutionRun ${run.id} is bound to workspace ${JSON.stringify(run.workspace)}, not the caller's ${JSON.stringify(input.workspace)}`,
        { executionRunID: run.id },
      );
    }
    const existing = this.supervisorBindings.get(input.executionRunID);
    if (existing) {
      if (existing.ownerSessionID === input.sessionID) {
        if (existing.state === "attached") {
          // §11 same-session resume: idempotent, SAME generation.
          return { binding: existing, created: false };
        }
        // The SAME authoritative owner re-attaching after an explicit detach:
        // no takeover occurred, so the generation stays.
        const reattached: SupervisorBinding = { ...existing, state: "attached", updatedAt: this.now() };
        this.supervisorBindings.set(input.executionRunID, reattached);
        await this.appendEvent(run.planID, {
          type: "execution.supervisor_binding_changed",
          executionRunID: input.executionRunID,
          reason: "reattached",
          from: { ownerSessionID: existing.ownerSessionID, generation: existing.generation },
          to: { ownerSessionID: reattached.ownerSessionID, generation: reattached.generation, state: "attached" },
        });
        return { binding: reattached, created: false };
      }
      throw new UltraPlanError(
        "supervisor_binding_conflict",
        `ExecutionRun ${input.executionRunID} already has a supervisor owned by another session; acquire authority through an explicit authorized takeover`,
        { executionRunID: input.executionRunID, ownerSessionID: existing.ownerSessionID },
      );
    }
    const now = this.now();
    const binding: SupervisorBinding = {
      executionRunID: input.executionRunID,
      ownerSessionID: input.sessionID,
      workspace: { ...input.workspace },
      generation: 1,
      state: "attached",
      createdAt: now,
      updatedAt: now,
    };
    this.supervisorBindings.set(input.executionRunID, binding);
    await this.appendEvent(run.planID, {
      type: "execution.supervisor_binding_changed",
      executionRunID: input.executionRunID,
      reason: "attached",
      to: { ownerSessionID: binding.ownerSessionID, generation: binding.generation, state: "attached" },
    });
    return { binding, created: true };
  }

  async detachExecutionSupervisor(input: DetachExecutionSupervisorInput): Promise<SupervisorBinding> {
    const run = this.requireExecutionRun(input.executionRunID);
    if (!isSupervisableExecutionRun(run)) {
      throw new UltraPlanError(
        "invalid_execution_lifecycle",
        `ExecutionRun ${run.id} is terminal (${run.lifecycle}); its binding can no longer change`,
        { executionRunID: run.id, lifecycle: run.lifecycle },
      );
    }
    const binding = this.supervisorBindings.get(input.executionRunID);
    if (!binding) {
      throw new UltraPlanError("supervisor_binding_not_found", `ExecutionRun ${input.executionRunID} has no SupervisorBinding to detach`, {
        executionRunID: input.executionRunID,
      });
    }
    // Fencing applies even to an idempotent re-detach: only the recorded
    // owner at the current generation may act on the binding.
    this.assertBindingFenced(binding, input.sessionID, input.workspace, input.generation);
    if (binding.state === "detached") return binding;
    const detached: SupervisorBinding = { ...binding, state: "detached", updatedAt: this.now() };
    this.supervisorBindings.set(input.executionRunID, detached);
    await this.appendEvent(run.planID, {
      type: "execution.supervisor_binding_changed",
      executionRunID: input.executionRunID,
      reason: "detached",
      from: { ownerSessionID: binding.ownerSessionID, generation: binding.generation },
      to: { ownerSessionID: detached.ownerSessionID, generation: detached.generation, state: "detached" },
    });
    return detached;
  }

  async takeoverExecutionSupervisor(input: TakeoverExecutionSupervisorInput): Promise<SupervisorBinding> {
    const run = this.requireExecutionRun(input.executionRunID);
    if (!isSupervisableExecutionRun(run)) {
      throw new UltraPlanError(
        "invalid_execution_lifecycle",
        `ExecutionRun ${run.id} is terminal (${run.lifecycle}); no takeover is possible`,
        { executionRunID: run.id, lifecycle: run.lifecycle },
      );
    }
    // §14: takeover is an explicitly user-authorized action — never automatic.
    assertSupervisorTakeoverAuthorized(input.authorization);
    this.assertTrustedSupervisorIdentity(input.sessionID, input.workspace);
    if (stableStringify(run.workspace) !== stableStringify(input.workspace)) {
      throw new UltraPlanError(
        "workspace_mismatch",
        `ExecutionRun ${run.id} is bound to workspace ${JSON.stringify(run.workspace)}, not the caller's ${JSON.stringify(input.workspace)}`,
        { executionRunID: run.id },
      );
    }
    const binding = this.supervisorBindings.get(input.executionRunID);
    if (!binding) {
      throw new UltraPlanError(
        "supervisor_binding_not_found",
        `ExecutionRun ${input.executionRunID} has no binding to take over; the first supervisor attaches instead`,
        { executionRunID: input.executionRunID },
      );
    }
    if (binding.ownerSessionID === input.sessionID) {
      // §11: same-session "takeover" is an idempotent resume, never a bump.
      this.assertBindingFenced(binding, input.sessionID, input.workspace, input.expectedGeneration);
      if (binding.state === "attached") return binding;
      const reattached: SupervisorBinding = { ...binding, state: "attached", updatedAt: this.now() };
      this.supervisorBindings.set(input.executionRunID, reattached);
      await this.appendEvent(run.planID, {
        type: "execution.supervisor_binding_changed",
        executionRunID: input.executionRunID,
        reason: "reattached",
        from: { ownerSessionID: binding.ownerSessionID, generation: binding.generation },
        to: { ownerSessionID: reattached.ownerSessionID, generation: reattached.generation, state: "attached" },
      });
      return reattached;
    }
    // §13: the fencing CAS — a stale expected generation fails closed BEFORE
    // anything mutates; the winner commits owner+generation+attachment atomically.
    if (binding.generation !== input.expectedGeneration) {
      throw new UltraPlanError(
        "stale_supervisor_binding",
        `Takeover of ${input.executionRunID} expected generation ${input.expectedGeneration}, but the current generation is ${binding.generation}`,
        { executionRunID: input.executionRunID, currentGeneration: binding.generation, expectedGeneration: input.expectedGeneration },
      );
    }
    const taken: SupervisorBinding = {
      ...binding,
      ownerSessionID: input.sessionID,
      generation: binding.generation + 1,
      state: "attached",
      updatedAt: this.now(),
    };
    this.supervisorBindings.set(input.executionRunID, taken);
    await this.appendEvent(run.planID, {
      type: "execution.supervisor_binding_changed",
      executionRunID: input.executionRunID,
      reason: "taken_over",
      from: { ownerSessionID: binding.ownerSessionID, generation: binding.generation },
      to: { ownerSessionID: taken.ownerSessionID, generation: taken.generation, state: "attached" },
    });
    return taken;
  }

  async authorizeExecutionSupervisor(
    executionRunID: ExecutionRunID,
    authority: { sessionID: string; workspace: WorkspaceIdentity; generation: number },
  ): Promise<{ run: ExecutionRun; binding: SupervisorBinding }> {
    const run = this.requireExecutionRun(executionRunID);
    const binding = this.supervisorBindings.get(executionRunID);
    assertExecutionSupervisorAuthority(run, binding, authority);
    return { run, binding: binding! };
  }

  async activateSupervisedExecutionRun(input: ActivateSupervisedExecutionRunInput): Promise<ExecutionRun> {
    const run = this.requireExecutionRun(input.executionRunID);
    // THE supervised-activation gate (§16): no execution run may go
    // prepared → active without a valid CURRENT attached supervisor binding.
    const binding = this.supervisorBindings.get(input.executionRunID);
    assertExecutionSupervisorAuthority(run, binding, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    // Then the full Phase 1 validated transition (workspace, exact FinalPlan
    // binding, revision CAS, lifecycle legality, binding immutability).
    const { updated } = this.transitionExecutionRunValidated(input.executionRunID, "active", {
      workspace: input.workspace,
      runRevision: input.runRevision,
      finalPlan: input.finalPlan,
    });
    await this.appendEvent(run.planID, {
      type: "execution.run_lifecycle_changed",
      executionRunID: input.executionRunID,
      from: "prepared",
      to: "active",
    });
    return updated;
  }

  async findSupervisorBinding(executionRunID: ExecutionRunID): Promise<SupervisorBinding | undefined> {
    return this.supervisorBindings.get(executionRunID);
  }

  async listOpenExecutionRuns(): Promise<ExecutionRun[]> {
    return [...this.executionRuns.values()].filter((run) => isSupervisableExecutionRun(run));
  }

  async buildExecutionRecoveryContext(
    executionRunID: ExecutionRunID,
    viewer: { sessionID: string },
  ): Promise<ExecutionRecoveryContext | undefined> {
    const run = this.executionRuns.get(executionRunID);
    if (!run) return undefined;
    const stage = run.activeStage !== undefined ? this.executionStages.get(run.activeStage) : undefined;
    const window = run.openWindow !== undefined ? this.verificationWindows.get(run.openWindow) : undefined;
    const base = buildRecoveryContext(run, this.supervisorBindings.get(executionRunID), stage, window, viewer);
    // §50/§51 — Phase 4 recovery decorations: running/indeterminate work and
    // the latest durable artifacts as INFORMATIONAL pointers (never
    // correctness authority; mutations always use exact ids/revisions).
    const attempts = [...this.executionAttempts.values()].filter((attempt) => attempt.executionRunID === executionRunID);
    const running = attempts.find((attempt) => attempt.state === "running");
    const indeterminate = attempts.filter((attempt) => attempt.state === "indeterminate");
    const directives = [...this.executionDirectives.values()].filter((directive) => directive.executionRunID === executionRunID);
    const latestDirective = directives.length > 0 ? directives[directives.length - 1]! : undefined;
    const attemptIDs = new Set(attempts.map((attempt) => attempt.id));
    const reports = [...this.executionReports.values()].filter((report) => attemptIDs.has(report.attemptID));
    const latestReport = reports.length > 0 ? reports[reports.length - 1]! : undefined;
    // §56 — Phase 5 acceptance decorations: acceptedHead/current accepted
    // state/latest commit/Stage obligation progress, all derived from
    // canonical records at read time.
    const stageObligationsList = stage ? stageCompletionObligations(stage) : [];
    const accepted = stage ? await this.acceptedStageObligations(executionRunID, stage.id) : [];
    const acceptedSet = new Set(accepted.map((ref) => ref as string));
    const commit = run.acceptedHead !== undefined ? this.executionCommits.get(run.acceptedHead) : undefined;
    return {
      ...base,
      ...(run.acceptedHead !== undefined ? { acceptedHead: run.acceptedHead } : {}),
      currentAcceptedState: currentAcceptedState(run),
      ...(commit
        ? {
            latestCommit: {
              id: commit.id,
              windowID: commit.windowID,
              candidateRevision: commit.candidateRevision,
              satisfiedObligations: [...commit.satisfiedObligations] as string[],
              stageCompleted: commit.stageCompleted,
            },
          }
        : {}),
      stageAcceptedObligations: accepted as string[],
      stageRemainingObligations: stageObligationsList.filter((obligation) => !acceptedSet.has(obligation.id as string)).map((obligation) => obligation.id as string),
      ...(running
        ? {
            runningAttempt: {
              id: running.id,
              directive: { ...running.directive },
              workerRole: running.workerRole,
              startedAt: running.startedAt,
            },
          }
        : {}),
      indeterminateAttempts: indeterminate.map((attempt) => ({
        id: attempt.id,
        directive: { ...attempt.directive },
        startedAt: attempt.startedAt,
      })),
      // Phase 6A §65 — conflict/reconciliation/replan decorations, all
      // deterministic projections of canonical records. Phase 7A §3 — the
      // unresolved set is split by candidateEffect: only the side-effecting
      // subset forces reconciliation (below); non-mutating interruptions are
      // inert history.
      unresolvedIndeterminateAttempts: indeterminate
        .filter((attempt) => !this.reconciliationByAttempt.has(attempt.id))
        .map((attempt) => ({
          id: attempt.id,
          directive: { ...attempt.directive },
          startedAt: attempt.startedAt,
        })),
      unresolvedSideEffectingAttempts: indeterminate
        .filter((attempt) => attempt.candidateEffect === "may_mutate" && !this.reconciliationByAttempt.has(attempt.id))
        .map((attempt) => ({
          id: attempt.id,
          directive: { ...attempt.directive },
          startedAt: attempt.startedAt,
        })),
      nonMutatingInterruptedAttempts: indeterminate
        .filter((attempt) => attempt.candidateEffect === "non_mutating")
        .map((attempt) => ({
          id: attempt.id,
          directive: { ...attempt.directive },
          startedAt: attempt.startedAt,
        })),
      attemptReconciliations: [...this.attemptReconciliations.values()]
        .filter((reconciliation) => reconciliation.executionRunID === executionRunID)
        .map((reconciliation) => ({
          id: reconciliation.id,
          windowID: reconciliation.windowID,
          targetAttemptIDs: [...reconciliation.targetAttemptIDs] as string[],
          observation: reconciliation.observation,
          baseCandidateRevision: reconciliation.baseCandidateRevision,
          resultingCandidateRevision: reconciliation.resultingCandidateRevision,
        })),
      ...(window !== undefined
        ? {
            currentVerificationConflicts: [...this.verificationConflicts.values()]
              .filter(
                (conflict) =>
                  conflict.executionRunID === executionRunID &&
                  conflict.windowID === window.id &&
                  conflict.candidateRevision === window.candidateRevision,
              )
              .map((conflict) => ({
                id: conflict.id,
                windowID: conflict.windowID,
                candidateRevision: conflict.candidateRevision,
                status: conflict.status,
                claimA: conflict.claimA,
                claimB: conflict.claimB,
                resolutionQuestion: conflict.resolutionQuestion,
              })),
          }
        : {}),
      verificationCondition: (() => {
        if (window === undefined) return "clear" as const;
        const statuses = [...this.verificationConflicts.values()]
          .filter((conflict) => conflict.windowID === window.id && conflict.candidateRevision === window.candidateRevision)
          .map((conflict) => conflict.status);
        if (statuses.includes("verification_blocked")) return "verification_blocked" as const;
        if (statuses.includes("open")) return "conflict_open" as const;
        return "clear" as const;
      })(),
      // Phase 7A §4 — reconciliation mode is forced by unresolved SIDE-EFFECTING indeterminate work only.
      reconciliationRequired: indeterminate.some(
        (attempt) => attempt.candidateEffect === "may_mutate" && !this.reconciliationByAttempt.has(attempt.id),
      ),
      ...(run.lifecycle === "replan_required"
        ? (() => {
            const issueID = this.issueByExecutionRun.get(executionRunID);
            const issue = issueID !== undefined ? this.executionIssues.get(issueID) : undefined;
            return issue !== undefined
              ? {
                  executionIssue: {
                    id: issue.id,
                    reason: issue.reason,
                    sourceAssessmentID: issue.sourceAssessmentID,
                    ...(issue.acceptedHead !== undefined ? { acceptedHead: issue.acceptedHead } : {}),
                    affectedPlanRefs: issue.affectedPlanRefs.map((ref) => ({ ...ref })),
                    unresolvedIndeterminateAttemptRefs: [...issue.unresolvedIndeterminateAttemptRefs] as string[],
                    verificationConflictRefs: [...issue.verificationConflictRefs] as string[],
                  },
                }
              : {};
          })()
        : {}),
      ...(() => {
        // Phase 6B §54/§55 — final-closure/completion projection, derived
        // entirely from canonical records (never correctness authority).
        const closure = this.findFinalClosureStage(executionRunID);
        const closureCommit = closure !== undefined ? this.findFinalClosureCommit(closure.id) : undefined;
        const finalState: FinalClosureProjection = {
          finalClosure: closure === undefined ? "absent" : closure.status === "pending" ? "pending" : closure.status === "active" ? "active" : "completed",
          ...(closure !== undefined
            ? {
                finalClosureStage: {
                  id: closure.id,
                  title: closure.title,
                  status: closure.status,
                  obligationCount: stageCompletionObligations(closure).length,
                },
              }
            : {}),
          ...(closureCommit !== undefined
            ? {
                finalClosureCommit: {
                  id: closureCommit.id,
                  windowID: closureCommit.windowID,
                  candidateRevision: closureCommit.candidateRevision,
                },
              }
            : {}),
          completionReady: false,
          completionBlockers: [],
        };
        // §55 — completionReady is exactly the gate's structural precondition
        // set (without authority); blockers name every failed one.
        if (run.lifecycle === "active" && closure?.status === "completed" && run.acceptedHead !== undefined && run.acceptedHead === closureCommit?.id && run.activeStage === undefined && run.openWindow === undefined) {
          const unresolvedCount = indeterminate.filter(
            (attempt) => attempt.candidateEffect === "may_mutate" && !this.reconciliationByAttempt.has(attempt.id),
          ).length;
          if (unresolvedCount === 0 && this.ordinaryStagesForRun(executionRunID).every((stage) => stage.status === "completed") && !this.issueByExecutionRun.has(executionRunID)) {
            finalState.completionReady = true;
          } else {
            if (unresolvedCount > 0) finalState.completionBlockers.push("reconciliation_required");
            if (!this.ordinaryStagesForRun(executionRunID).every((stage) => stage.status === "completed")) finalState.completionBlockers.push("ordinary_stage_uncompleted");
            if (this.issueByExecutionRun.has(executionRunID)) finalState.completionBlockers.push("execution_issue_present");
          }
        } else {
          if (run.lifecycle !== "active") finalState.completionBlockers.push(`run_${run.lifecycle}`);
          if (closure === undefined) finalState.completionBlockers.push("final_closure_absent");
          else if (closure.status !== "completed") finalState.completionBlockers.push(`final_closure_${closure.status}`);
          if (run.activeStage !== undefined) finalState.completionBlockers.push("active_stage_present");
          if (run.openWindow !== undefined) finalState.completionBlockers.push("open_window_present");
          if (run.acceptedHead === undefined || run.acceptedHead !== closureCommit?.id) finalState.completionBlockers.push("accepted_head_not_final_commit");
        }
        return {
          finalClosure: finalState.finalClosure,
          ...(finalState.finalClosureStage !== undefined ? { finalClosureStage: finalState.finalClosureStage } : {}),
          ...(finalState.finalClosureCommit !== undefined ? { finalClosureCommit: finalState.finalClosureCommit } : {}),
          completionReady: finalState.completionReady,
          completionBlockers: finalState.completionBlockers,
          ...(run.lifecycle === "completed"
            ? (() => {
                const completionID = run.completionRecord ?? this.completionByExecutionRun.get(executionRunID);
                const record = completionID !== undefined ? this.executionCompletions.get(completionID) : undefined;
                return {
                  executionCompletion:
                    record !== undefined
                      ? ({ protocol: "v0.2", id: record.id, completedAt: record.completedAt } as const)
                      : ({ protocol: "legacy" } as const),
                };
              })()
            : {}),
        };
      })(),
      ...(latestDirective
        ? { latestDirective: { id: latestDirective.id, revision: latestDirective.revision, hash: latestDirective.hash, kind: latestDirective.kind } }
        : {}),
      ...(latestReport
        ? {
            latestReport: {
              id: latestReport.id,
              attemptID: latestReport.attemptID,
              result: latestReport.result,
              candidateMutation: latestReport.candidateMutation,
            },
          }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // ExecutionStage & VerificationWindow (v0.2.0 Phase 3) — the structural
  // layer. Execution-only: nothing here mutates Plan Memory or advances
  // accepted execution truth. Every mutation is authority-gated (Phase 2
  // supervisor boundary) and revalidates inside the mutation block (durable:
  // under the write lock after rehydration). Completion/closure are
  // RESERVED for the future ExecutionCommit — no operation produces them.
  // -------------------------------------------------------------------------

  async createExecutionStages(input: CreateExecutionStagesInput): Promise<ExecutionStage[]> {
    const run = this.requireExecutionRun(input.executionRunID);
    // §17: decomposition is prepared under an ACTIVE run (a prepared run has
    // no execution authority yet); the supervisor boundary still applies.
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError(
        "invalid_execution_lifecycle",
        `Stage decomposition requires an active ExecutionRun (run is ${run.lifecycle})`,
        { executionRunID: run.id, lifecycle: run.lifecycle },
      );
    }
    if (!Array.isArray(input.drafts) || input.drafts.length === 0) {
      throw new UltraPlanError("invalid_scope", "Stage decomposition requires at least one Stage draft", { executionRunID: run.id });
    }
    // Phase 6B §6/§12 — final_closure Stages are created ONLY through
    // prepareFinalClosureStage (readiness + uniqueness + derived dependencies
    // live there); the ordinary decomposition API never mint them.
    for (const draft of input.drafts) {
      if ((draft as { kind?: string }).kind !== undefined) {
        throw new UltraPlanError("invalid_scope", "Stage drafts carry no kind — final_closure Stages are created exclusively via prepareFinalClosureStage", {});
      }
    }
    // Phase 6B §10/§27 — once the final closure Stage EXISTS, the ordinary
    // decomposition is frozen (closure means the decomposition ended); once
    // it is COMPLETED, no new execution structure of any kind may be created.
    const existingClosure = this.findFinalClosureStage(run.id);
    if (existingClosure) {
      if (existingClosure.status === "completed") {
        throw new UltraPlanError(
          "invalid_execution_lifecycle",
          `ExecutionRun ${run.id}'s final closure is complete; the only next step is the ExecutionCompletionGate — no new execution structure may be created`,
          { executionRunID: run.id },
        );
      }
      throw new UltraPlanError(
        "ordinary_stage_exists_after_closure_started",
        `ExecutionRun ${run.id}'s final closure Stage (${existingClosure.id}) exists: the ordinary decomposition is frozen. Ordinary defects are reworked INSIDE the final closure Stage; new normative design requires REPLAN_REQUIRED`,
        { executionRunID: run.id, stageID: existingClosure.id },
      );
    }
    // planRefs are exact provenance into the run's BOUND approved FinalPlan.
    const finalPlan = this.getFinalPlanSync(run.planID, run.finalPlan);
    if (!finalPlan || finalPlan.hash !== run.finalPlanHash) {
      throw new UltraPlanError("final_plan_binding_mismatch", `ExecutionRun ${run.id} FinalPlan binding no longer resolves with the bound hash`, {
        executionRunID: run.id,
      });
    }
    const existing = [...this.executionStages.values()].filter((stage) => stage.executionRunID === run.id);
    const now = this.now();
    const created: ExecutionStage[] = [];
    const batchIds: ExecutionStageID[] = [];
    // Assign the batch's ids first so dependencies can reference batch peers
    // (final DAG validation below sees the candidate graph as a whole).
    for (let index = 0; index < input.drafts.length; index++) {
      const seq = nextSequence([...this.executionStages.keys(), ...batchIds], ExecutionStageIDs.prefix);
      batchIds.push(ExecutionStageIDs.from(seq));
    }
    for (let index = 0; index < input.drafts.length; index++) {
      const draft = input.drafts[index]!;
      const id = batchIds[index]!;
      if (typeof draft.title !== "string" || draft.title.trim().length === 0 || typeof draft.objective !== "string" || draft.objective.trim().length === 0) {
        throw new UltraPlanError("invalid_scope", `Stage draft ${index} requires a non-empty title and objective`, { executionRunID: run.id, index });
      }
      validateExecutionPlanRefs(draft.planRefs ?? [], finalPlan);
      for (const dep of draft.dependsOn ?? []) {
        if (dep === id) {
          throw new UltraPlanError("stage_dependency_cycle", `Stage ${id} cannot depend on itself`, { executionRunID: run.id, stageID: id });
        }
        const owner = existing.find((stage) => stage.id === dep)?.executionRunID ?? (batchIds.includes(dep) ? run.id : undefined);
        if (owner !== run.id) {
          throw new UltraPlanError(
            "stage_dependency_unsatisfied",
            `Stage ${id} depends on ${dep}, which is not a Stage of ExecutionRun ${run.id}`,
            { executionRunID: run.id, stageID: id, dependency: dep },
          );
        }
      }
      if (draft.supersedes !== undefined) {
        const target = existing.find((stage) => stage.id === draft.supersedes);
        if (!target || target.executionRunID !== run.id) {
          throw new UltraPlanError(
            "invalid_scope",
            `Stage ${id} supersedes ${String(draft.supersedes)}, which is not a Stage of ExecutionRun ${run.id}`,
            { executionRunID: run.id, stageID: id },
          );
        }
      }
      // §8/§9: obligations are execution-closure units mapped from the
      // approved FinalPlan — their planRefs must resolve exactly.
      const assignedObligationIDs: string[] = [];
      const obligations = (draft.completionObligations ?? []).map((obligation) => {
        if (typeof obligation.description !== "string" || obligation.description.trim().length === 0) {
          throw new UltraPlanError("invalid_scope", `Stage ${id} completion obligations require a description`, {
            executionRunID: run.id,
            stageID: id,
          });
        }
        validateExecutionPlanRefs(obligation.planRefs ?? [], finalPlan);
        const obligationID = StageCompletionObligationIDs.from(
          nextSequence(
            [
              ...[...this.executionStages.values()].flatMap((candidate: ExecutionStage) => (candidate.completionObligations ?? []).map((entry) => entry.id)),
              ...assignedObligationIDs,
            ],
            StageCompletionObligationIDs.prefix,
          ),
        );
        assignedObligationIDs.push(obligationID);
        return {
          id: obligationID,
          description: obligation.description,
          planRefs: (obligation.planRefs ?? []).map((ref) => ({ ...ref })) as ExecutionPlanRef[],
        };
      });
      created.push({
        id,
        executionRunID: run.id,
        title: draft.title,
        objective: draft.objective,
        status: "pending",
        planRefs: (draft.planRefs ?? []).map((ref) => ({ ...ref })) as ExecutionPlanRef[],
        dependsOn: [...(draft.dependsOn ?? [])],
        ...(obligations.length > 0 ? { completionObligations: obligations } : {}),
        ...(draft.supersedes !== undefined ? { supersedes: draft.supersedes } : {}),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    // §18: cycle validation over the FINAL candidate DAG (existing + batch),
    // never line-by-line.
    assertAcyclicStages([...existing, ...created]);
    for (const stage of created) {
      this.executionStages.set(stage.id, stage);
      await this.appendEvent(run.planID, {
        type: "execution.stage_created",
        executionRunID: run.id,
        stageID: stage.id,
        title: stage.title,
        dependsOn: stage.dependsOn,
      });
    }
    return created;
  }

  async activateExecutionStage(input: ActivateExecutionStageInput): Promise<{ stage: ExecutionStage; run: ExecutionRun }> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    // §14: activation belongs to ACTIVE runs only — a prepared run must first
    // go through the Phase 2 supervised activation.
    if (run.lifecycle !== "active") {
      throw new UltraPlanError(
        "invalid_execution_lifecycle",
        `Stage activation requires an active ExecutionRun (run is ${run.lifecycle}); supervise-activate the run first`,
        { executionRunID: run.id, lifecycle: run.lifecycle },
      );
    }
    const stage = this.executionStages.get(input.stageID);
    if (!stage || stage.executionRunID !== input.executionRunID) {
      throw new UltraPlanError("execution_stage_not_found", `ExecutionStage ${input.stageID} does not exist in ExecutionRun ${input.executionRunID}`, {
        executionRunID: input.executionRunID,
        stageID: input.stageID,
      });
    }
    if (run.revision !== input.expectedRunRevision) {
      throw new UltraPlanError(
        "stale_execution_run",
        `ExecutionRun ${run.id} is at revision ${run.revision}, not the expected ${input.expectedRunRevision}; re-read and retry`,
        { executionRunID: run.id, revision: run.revision, expected: input.expectedRunRevision },
      );
    }
    if (stage.revision !== input.expectedStageRevision) {
      throw new UltraPlanError(
        "stale_execution_stage",
        `ExecutionStage ${stage.id} is at revision ${stage.revision}, not the expected ${input.expectedStageRevision}; re-read and retry`,
        { executionRunID: run.id, stageID: stage.id, revision: stage.revision, expected: input.expectedStageRevision },
      );
    }
    const stagesForRun = [...this.executionStages.values()].filter((candidate) => candidate.executionRunID === run.id);
    const violation = stageEligibilityViolation({ run, stage, stagesForRun });
    if (violation) {
      throw new UltraPlanError(violation.code, `${violation.reason} (Stage ${stage.id})`, {
        executionRunID: run.id,
        stageID: stage.id,
      });
    }
    // Phase 6B §17 — kind-aware activation validation. The generic eligibility
    // predicate above already covers pending-only/deps/no-active/no-window;
    // a final_closure activation ADDITIONALLY requires that NO ordinary
    // non-superseded Stage is left pending/active (integration closure runs
    // over a finished decomposition) and that no other final_closure exists.
    if (executionStageKindOf(stage) === "final_closure") {
      const openOrdinary = stagesForRun.filter(
        (candidate) => executionStageKindOf(candidate) === "ordinary" && candidate.status !== "superseded" && candidate.status !== "completed",
      );
      if (openOrdinary.length > 0) {
        throw new UltraPlanError(
          "final_closure_not_ready",
          `The final_closure Stage ${stage.id} cannot activate while ordinary Stage(s) remain open: ${openOrdinary.map((candidate) => `${candidate.id} (${candidate.status})`).join(", ")}`,
          { executionRunID: run.id, stageID: stage.id },
        );
      }
      const secondClosure = stagesForRun.find(
        (candidate) => candidate.id !== stage.id && executionStageKindOf(candidate) === "final_closure",
      );
      if (secondClosure) {
        throw new UltraPlanError("final_closure_already_exists", `ExecutionRun ${run.id} already has a final_closure Stage (${secondClosure.id})`, {
          executionRunID: run.id,
        });
      }
      if (!stageHasExplicitCompletionObligations(stage)) {
        throw new UltraPlanError("invalid_final_closure_obligations", `The final_closure Stage ${stage.id} carries no explicit completion obligations`, {
          stageID: stage.id,
        });
      }
    }
    const now = this.now();
    const activatedStage: ExecutionStage = { ...stage, status: "active", revision: stage.revision + 1, updatedAt: now };
    const updatedRun: ExecutionRun = { ...run, activeStage: stage.id, revision: run.revision + 1, updatedAt: now };
    this.executionStages.set(stage.id, activatedStage);
    this.executionRuns.set(run.id, updatedRun);
    await this.appendEvent(run.planID, {
      type: "execution.stage_activated",
      executionRunID: run.id,
      stageID: stage.id,
      runRevision: updatedRun.revision,
      stageRevision: activatedStage.revision,
    });
    return { stage: activatedStage, run: updatedRun };
  }

  async supersedeExecutionStage(input: SupersedeExecutionStageInput): Promise<ExecutionStage> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    const stage = this.executionStages.get(input.stageID);
    if (!stage || stage.executionRunID !== input.executionRunID) {
      throw new UltraPlanError("execution_stage_not_found", `ExecutionStage ${input.stageID} does not exist in ExecutionRun ${input.executionRunID}`, {
        executionRunID: input.executionRunID,
        stageID: input.stageID,
      });
    }
    if (stage.revision !== input.expectedStageRevision) {
      throw new UltraPlanError(
        "stale_execution_stage",
        `ExecutionStage ${stage.id} is at revision ${stage.revision}, not the expected ${input.expectedStageRevision}; re-read and retry`,
        { executionRunID: run.id, stageID: stage.id, revision: stage.revision, expected: input.expectedStageRevision },
      );
    }
    // Phase 6B §11 — the final_closure Stage can NEVER be superseded or
    // replaced; its failure paths are rework/more verification/reconciliation/
    // conflict handling/REPLAN_REQUIRED/abort — never another closure Stage.
    if (executionStageKindOf(stage) === "final_closure") {
      throw new UltraPlanError(
        "invalid_stage_transition",
        `The final_closure Stage ${stage.id} cannot be superseded; failures are handled by rework, verification, reconciliation, or REPLAN_REQUIRED — never by restarting closure`,
        { executionRunID: run.id, stageID: stage.id, status: stage.status },
      );
    }
    // §16 minimal supersession: pending only. The active-stage split/replace
    // path is deferred to the Supervisor implementation phase.
    if (stage.status !== "pending") {
      throw new UltraPlanError(
        "invalid_stage_transition",
        `Phase 3 supersession is pending -> superseded only (stage ${stage.id} is ${stage.status}); the old Stage stays durable either way`,
        { executionRunID: run.id, stageID: stage.id, status: stage.status },
      );
    }
    const superseded: ExecutionStage = { ...stage, status: "superseded", revision: stage.revision + 1, updatedAt: this.now() };
    this.executionStages.set(stage.id, superseded);
    await this.appendEvent(run.planID, {
      type: "execution.stage_superseded",
      executionRunID: run.id,
      stageID: stage.id,
      stageRevision: superseded.revision,
    });
    return superseded;
  }

  async openVerificationWindow(input: OpenVerificationWindowInput): Promise<{ window: VerificationWindow; run: ExecutionRun }> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError(
        "invalid_execution_lifecycle",
        `A VerificationWindow requires an active ExecutionRun (run is ${run.lifecycle})`,
        { executionRunID: run.id, lifecycle: run.lifecycle },
      );
    }
    const stage = this.executionStages.get(input.stageID);
    if (!stage || stage.executionRunID !== input.executionRunID) {
      throw new UltraPlanError("execution_stage_not_found", `ExecutionStage ${input.stageID} does not exist in ExecutionRun ${input.executionRunID}`, {
        executionRunID: input.executionRunID,
        stageID: input.stageID,
      });
    }
    // §23: the open Window must belong to THE active Stage of the run.
    if (run.activeStage !== stage.id || stage.status !== "active") {
      throw new UltraPlanError(
        "stage_window_mismatch",
        `A VerificationWindow can only open for the run's active Stage (run.activeStage is ${run.activeStage ?? "none"}, stage ${stage.id} is ${stage.status})`,
        { executionRunID: run.id, stageID: stage.id },
      );
    }
    if (run.openWindow !== undefined) {
      throw new UltraPlanError("window_already_open", `ExecutionRun ${run.id} already has an open VerificationWindow (${run.openWindow})`, {
        executionRunID: run.id,
        windowID: run.openWindow,
      });
    }
    if (run.revision !== input.expectedRunRevision) {
      throw new UltraPlanError(
        "stale_execution_run",
        `ExecutionRun ${run.id} is at revision ${run.revision}, not the expected ${input.expectedRunRevision}; re-read and retry`,
        { executionRunID: run.id, revision: run.revision, expected: input.expectedRunRevision },
      );
    }
    if (stage.revision !== input.expectedStageRevision) {
      throw new UltraPlanError(
        "stale_execution_stage",
        `ExecutionStage ${stage.id} is at revision ${stage.revision}, not the expected ${input.expectedStageRevision}; re-read and retry`,
        { executionRunID: run.id, stageID: stage.id, revision: stage.revision, expected: input.expectedStageRevision },
      );
    }
    const id = VerificationWindowIDs.from(nextSequence([...this.verificationWindows.keys()], VerificationWindowIDs.prefix));
    const now = this.now();
    // §6/§20: the anchor is the run's CURRENT accepted state — the
    // executionStartBaseline until the first commit, then the chain tip.
    // Never a fabricated commit.
    const baseAcceptedState: AcceptedStateRef = currentAcceptedState(run);
    const window: VerificationWindow = {
      id,
      executionRunID: run.id,
      stageID: stage.id,
      state: "open",
      candidateRevision: 0,
      baseAcceptedState,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const updatedRun: ExecutionRun = { ...run, openWindow: id, revision: run.revision + 1, updatedAt: now };
    this.verificationWindows.set(id, window);
    this.executionRuns.set(run.id, updatedRun);
    await this.appendEvent(run.planID, {
      type: "execution.window_opened",
      executionRunID: run.id,
      windowID: id,
      stageID: stage.id,
      baseAcceptedState: "execution_start",
    });
    return { window, run: updatedRun };
  }

  async advanceCandidateRevision(input: AdvanceCandidateRevisionInput): Promise<VerificationWindow> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError(
        "invalid_execution_lifecycle",
        `Candidate work requires an active ExecutionRun (run is ${run.lifecycle})`,
        { executionRunID: run.id, lifecycle: run.lifecycle },
      );
    }
    // Deterministic resolution: the run's single open Window — never "latest".
    const window = run.openWindow !== undefined ? this.verificationWindows.get(run.openWindow) : undefined;
    if (!window) {
      throw new UltraPlanError("window_not_found", `ExecutionRun ${run.id} has no open VerificationWindow to advance`, {
        executionRunID: run.id,
      });
    }
    if (window.state !== "open") {
      throw new UltraPlanError("window_not_open", `VerificationWindow ${window.id} is ${window.state}; candidate work requires an open Window`, {
        executionRunID: run.id,
        windowID: window.id,
      });
    }
    // §27/§28: CAS + monotonic +1. No setter, no decrement, no reset exists.
    assertCurrentCandidateRevision(window, input.expectedCandidateRevision);
    const advanced: VerificationWindow = {
      ...window,
      candidateRevision: window.candidateRevision + 1,
      revision: window.revision + 1,
      updatedAt: this.now(),
    };
    this.verificationWindows.set(window.id, advanced);
    await this.appendEvent(run.planID, {
      type: "execution.window_candidate_advanced",
      executionRunID: run.id,
      windowID: window.id,
      from: window.candidateRevision,
      to: advanced.candidateRevision,
    });
    return advanced;
  }

  async getExecutionStage(stageID: ExecutionStageID): Promise<ExecutionStage | undefined> {
    return this.executionStages.get(stageID);
  }

  async listExecutionStagesForRun(executionRunID: ExecutionRunID): Promise<ExecutionStage[]> {
    return [...this.executionStages.values()].filter((stage) => stage.executionRunID === executionRunID);
  }

  async getVerificationWindow(windowID: VerificationWindowID): Promise<VerificationWindow | undefined> {
    return this.verificationWindows.get(windowID);
  }

  async listVerificationWindowsForRun(executionRunID: ExecutionRunID): Promise<VerificationWindow[]> {
    return [...this.verificationWindows.values()].filter((window) => window.executionRunID === executionRunID);
  }

  async findOpenVerificationWindow(executionRunID: ExecutionRunID): Promise<VerificationWindow | undefined> {
    const run = this.executionRuns.get(executionRunID);
    const window = run?.openWindow !== undefined ? this.verificationWindows.get(run.openWindow) : undefined;
    return window?.state === "open" ? window : undefined;
  }

  /**
   * TEST-ONLY (seedCommittedState precedent): seed Stage records directly so
   * fixtures can construct states no Phase 3 API can produce (a `completed`
   * dependency Stage belongs to the future ExecutionCommit). Production code
   * must never call this.
   */
  /**
   * TEST-ONLY fixture seam (Phase 8 §53): seeds PENDING Stage records only.
   * Stage completion is Core-derived from accepted execution progress (§50) —
   * a completed/closed Stage can never enter the store through this seam.
   */
  seedExecutionStages(executionRunID: ExecutionRunID, stages: ExecutionStage[]): void {
    for (const stage of stages) {
      if (stage.status !== "pending") {
        throw new UltraPlanError("invalid_scope", "seedExecutionStages is a test fixture seam: only pending Stages may be seeded — completion is Core-derived from accepted progress", { stageID: stage.id, status: stage.status });
      }
      this.executionStages.set(stage.id, stage);
    }
    void executionRunID;
  }

  // -------------------------------------------------------------------------
  // Directive / Attempt / Report worker protocol (v0.2.0 Phase 4) — durable
  // bounded-authorization transactions. Immutability absolute (Directive
  // revisions, Reports); the candidate advance on a mutating report is
  // ATOMIC with report persistence; the one-attempt-per-directive-revision
  // and one-running-attempt-per-run invariants are enforced in-lock.
  // -------------------------------------------------------------------------

  async issueExecutionDirective(input: IssueExecutionDirectiveInput): Promise<ExecutionDirective> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError("invalid_execution_lifecycle", `Directives require an active ExecutionRun (run is ${run.lifecycle})`, {
        executionRunID: run.id,
        lifecycle: run.lifecycle,
      });
    }
    // Exact current structure: the named stage IS the run's active stage and
    // the named window IS the run's open window.
    const stage = this.executionStages.get(input.stageID);
    const window = this.verificationWindows.get(input.windowID);
    if (!stage || stage.executionRunID !== run.id || run.activeStage !== stage.id || stage.status !== "active") {
      throw new UltraPlanError(
        "directive_not_current",
        `Directives can only be issued against the run's active Stage (run.activeStage is ${run.activeStage ?? "none"}, stage ${input.stageID} is ${stage?.status ?? "missing"})`,
        { executionRunID: run.id, stageID: input.stageID },
      );
    }
    if (!window || window.executionRunID !== run.id || run.openWindow !== window.id || window.stageID !== stage.id || window.state !== "open") {
      throw new UltraPlanError(
        "directive_not_current",
        `Directives can only be issued against the run's open Window (run.openWindow is ${run.openWindow ?? "none"}, window ${input.windowID} is ${window?.state ?? "missing"})`,
        { executionRunID: run.id, windowID: input.windowID },
      );
    }
    if (run.revision !== input.expectedRunRevision || stage.revision !== input.expectedStageRevision || window.revision !== input.expectedWindowRevision) {
      throw new UltraPlanError(
        "stale_execution_run",
        `Directive issuance CAS failed (run ${run.revision}/${input.expectedRunRevision}, stage ${stage.revision}/${input.expectedStageRevision}, window ${window.revision}/${input.expectedWindowRevision}); re-read and retry`,
        { executionRunID: run.id },
      );
    }
    const finalPlan = this.getFinalPlanSync(run.planID, run.finalPlan);
    if (!finalPlan || finalPlan.hash !== run.finalPlanHash) {
      throw new UltraPlanError("final_plan_binding_mismatch", `ExecutionRun ${run.id} FinalPlan binding no longer resolves with the bound hash`, {
        executionRunID: run.id,
      });
    }
    // Phase 6A §42 with the Phase 7A §4 correction — RECONCILIATION MODE: while
    // the canonical unresolved SIDE-EFFECTING indeterminate set is non-empty,
    // the ONLY issuable work is an explicit reconciliation inspection targeting
    // that complete set. A non-mutating interrupted Attempt never triggers the
    // mode: fresh (non-mutating) work may replace it directly.
    const draft = input.draft;
    const unresolvedSet = await this.unresolvedSideEffectingAttempts(run.id, window.id);
    const isReconciliationDraft = draft.kind === "inspection" && draft.reconciliationTargets !== undefined;
    if (unresolvedSet.length > 0 && !isReconciliationDraft) {
      throw new UltraPlanError(
        "reconciliation_required",
        `Window ${window.id} carries unresolved side-effecting indeterminate Attempt(s) ${unresolvedSet.map((attempt) => attempt.id).join(", ")}; only a reconciliation inspection Directive may be issued until repository reality is re-established`,
        { executionRunID: run.id, windowID: window.id, unresolved: unresolvedSet.map((attempt) => attempt.id) },
      );
    }
    assertExecutionDirectiveKind(draft.kind);
    if (typeof draft.objective !== "string" || draft.objective.trim().length === 0) {
      throw new UltraPlanError("invalid_scope", "A directive requires a non-empty objective", { executionRunID: run.id });
    }
    assertCapabilityEnvelope(draft.capabilityEnvelope);
    // §14: the Supervisor narrows within the trusted ceiling — never elevates.
    assertEnvelopeWithinCeiling(draft.capabilityEnvelope, input.ceiling);
    if (!(DIRECTIVE_CANDIDATE_EFFECTS as readonly string[]).includes(draft.candidateEffect)) {
      throw new UltraPlanError("invalid_scope", `Unknown candidateEffect ${String(draft.candidateEffect)}`, {
        known: DIRECTIVE_CANDIDATE_EFFECTS,
      });
    }
    // Phase 5 §11/§12: explicit obligation coverage — verification-kind
    // only, and every referenced obligation must be a real Stage obligation.
    if (draft.verificationCoverage !== undefined) {
      if (draft.kind !== "verification") {
        throw new UltraPlanError("invalid_scope", "verificationCoverage requires a verification-kind Directive", { kind: draft.kind });
      }
      const stageObligationIDs = new Set(
        stageCompletionObligations(stage).map((obligation) => obligation.id as string),
      );
      for (const ref of draft.verificationCoverage.obligationRefs) {
        if (!stageObligationIDs.has(ref as string)) {
          throw new UltraPlanError("invalid_scope", `verificationCoverage references unknown Stage obligation ${String(ref)}`, { ref });
        }
      }
    }
    // Phase 6A §26/§27 — verification purpose: legacy absence = acceptance;
    // a conflict_resolution directive must bind an OPEN current-candidate
    // conflict and claim NO obligation coverage (§28).
    if (draft.verificationPurpose !== undefined) {
      assertVerificationPurpose(draft.verificationPurpose);
    }
    const purpose: VerificationPurpose = draft.verificationPurpose ?? "acceptance";
    if (purpose === "conflict_resolution") {
      if (draft.kind !== "verification") {
        throw new UltraPlanError("invalid_scope", "A conflict_resolution Directive must be verification-kind", { kind: draft.kind });
      }
      if (draft.candidateEffect !== "non_mutating") {
        throw new UltraPlanError("invalid_scope", "A conflict_resolution Directive must be non-mutating", {});
      }
      if (draft.conflictID === undefined) {
        throw new UltraPlanError("invalid_scope", "A conflict_resolution Directive requires a conflictID", {});
      }
      if (draft.verificationCoverage !== undefined && draft.verificationCoverage.obligationRefs.length > 0) {
        throw new UltraPlanError("invalid_scope", "A conflict resolver adjudicates ONE disputed fact — it must NOT claim Stage obligation coverage (§28)", {});
      }
      const conflict = this.verificationConflicts.get(draft.conflictID);
      if (!conflict || conflict.executionRunID !== run.id) {
        throw new UltraPlanError("verification_conflict_not_found", `Conflict ${String(draft.conflictID)} does not resolve in ExecutionRun ${run.id}`, {
          conflictID: draft.conflictID,
        });
      }
      if (conflict.status !== "open") {
        throw new UltraPlanError("invalid_scope", `Conflict ${conflict.id} is ${conflict.status}; only an OPEN conflict accepts a resolver (no recursion, §35)`, {
          conflictID: conflict.id,
          status: conflict.status,
        });
      }
      if (conflict.windowID !== window.id) {
        throw new UltraPlanError("invalid_scope", `Conflict ${conflict.id} belongs to Window ${conflict.windowID}, not the current Window`, {});
      }
      if (conflict.candidateRevision !== window.candidateRevision) {
        throw new UltraPlanError("stale_candidate_revision", `Conflict ${conflict.id} binds candidateRevision ${conflict.candidateRevision}, but the window is at ${window.candidateRevision}`, {
          windowID: window.id,
        });
      }
      if (conflict.resolutionDirectiveRef !== undefined) {
        throw new UltraPlanError(
          "conflict_resolution_already_used",
          `Conflict ${conflict.id} already has its ONE conflict-resolution Directive (${conflict.resolutionDirectiveRef.id}@${conflict.resolutionDirectiveRef.revision}); there is no second resolver, no recursion, no majority vote`,
          { conflictID: conflict.id },
        );
      }
    } else if (draft.conflictID !== undefined) {
      throw new UltraPlanError("invalid_scope", "conflictID requires verificationPurpose=conflict_resolution", {});
    }
    // Phase 6A §43/§45 with the Phase 7A §7 correction — reconciliation
    // targeting: inspection-kind only, non-mutating, capability-constrained,
    // and exactly the canonical SIDE-EFFECTING unresolved set.
    if (draft.reconciliationTargets !== undefined) {
      if (draft.kind !== "inspection") {
        throw new UltraPlanError("invalid_scope", "reconciliationTargets requires an inspection-kind Directive", { kind: draft.kind });
      }
      if (draft.candidateEffect !== "non_mutating") {
        throw new UltraPlanError("invalid_scope", "A reconciliation inspection must be non-mutating", {});
      }
      assertReconciliationCapabilityConstraints(draft.capabilityEnvelope);
      if (draft.reconciliationTargets.length === 0) {
        throw new UltraPlanError("invalid_scope", "reconciliationTargets must name the unresolved Attempts (empty arrays are not a reconciliation)", {});
      }
      const known = new Set(unresolvedSet.map((attempt) => attempt.id as string));
      for (const target of draft.reconciliationTargets) {
        if (!known.has(target as string)) {
          throw new UltraPlanError(
            "invalid_scope",
            `reconciliationTargets reference non-unresolved side-effecting Attempt ${String(target)}; targets must equal the COMPLETE canonical side-effecting unresolved set`,
            { target },
          );
        }
      }
      if (draft.reconciliationTargets.length !== unresolvedSet.length) {
        throw new UltraPlanError(
          "invalid_scope",
          `reconciliationTargets must cover the COMPLETE canonical side-effecting unresolved set (${unresolvedSet.map((attempt) => attempt.id).join(", ")}); partial reconciliation is forbidden (§43)`,
          { targetAttemptIDs: draft.reconciliationTargets },
        );
      }
    }
    // Base bindings are COPIED from the window (§7) — never caller-supplied.
    const baseAcceptedState: AcceptedStateRef =
      window.baseAcceptedState.kind === "execution_start"
        ? { kind: "execution_start", executionRunID: window.baseAcceptedState.executionRunID }
        : { ...window.baseAcceptedState };
    const resolveLogicalId = (): { id: ExecutionDirectiveID; revision: number } => {
      if (draft.directiveID !== undefined) {
        const known = [...this.executionDirectives.values()].some((directive) => directive.id === draft.directiveID);
        if (!known) {
          throw new UltraPlanError("execution_directive_not_found", `Directive ${draft.directiveID} does not exist; a new logical id cannot be declared via revision`, {
            directiveID: draft.directiveID,
          });
        }
        const highest = Math.max(
          ...[...this.executionDirectives.values()]
            .filter((directive) => directive.id === draft.directiveID)
            .map((directive) => directive.revision),
        );
        return { id: draft.directiveID, revision: highest + 1 };
      }
      return { id: ExecutionDirectiveIDs.from(nextSequence([...new Set([...this.executionDirectives.keys()].map((key) => key.slice(0, key.indexOf("@"))))], ExecutionDirectiveIDs.prefix)), revision: 1 };
    };
    const { id, revision } = resolveLogicalId();
    const candidate: ExecutionDirectiveHashPayload = {
      id,
      revision,
      executionRunID: run.id,
      finalPlan: { ...run.finalPlan },
      finalPlanHash: run.finalPlanHash,
      stageID: stage.id,
      windowID: window.id,
      kind: draft.kind,
      baseAcceptedState,
      baseCandidateRevision: window.candidateRevision,
      objective: draft.objective,
      planRefs: draft.planRefs.map((ref) => ({ ...ref })) as ExecutionPlanRef[],
      expectedExecutionScope: structuredClone(draft.expectedExecutionScope ?? {}),
      capabilityEnvelope: { ...draft.capabilityEnvelope },
      candidateEffect: draft.candidateEffect,
      invariants: [...(draft.invariants ?? [])],
      requiredActions: [...(draft.requiredActions ?? [])],
      forbiddenActions: [...(draft.forbiddenActions ?? [])],
      validationRequirements: [...(draft.validationRequirements ?? [])],
      deliverables: [...(draft.deliverables ?? [])],
      stopConditions: [...(draft.stopConditions ?? [])],
      ...(draft.verificationCoverage !== undefined
        ? { verificationCoverage: { obligationRefs: [...draft.verificationCoverage.obligationRefs] } }
        : {}),
      ...(draft.verificationPurpose !== undefined ? { verificationPurpose: draft.verificationPurpose } : {}),
      ...(draft.conflictID !== undefined ? { conflictID: draft.conflictID } : {}),
      ...(draft.reconciliationTargets !== undefined ? { reconciliationTargets: [...draft.reconciliationTargets] } : {}),
      reportContract: draft.reportContract ?? "",
      body: draft.body ?? "",
    };
    const hash = computeExecutionDirectiveHash(candidate);
    // Content idempotency WITHIN one logical id: re-issuing byte-identical
    // content under the same id returns the EXISTING immutable revision,
    // never a duplicate copy. The comparison excludes the revision (the
    // caller's next-revision allocation) — content is what identifies the
    // re-issue. (A fresh issuance WITHOUT the logical id is a NEW directive
    // — the sanctioned path to a fresh, unconsumed authorization.)
    const withoutRevision = (directive: Record<string, unknown>): string => {
      const content = { ...directive };
      delete content.revision;
      delete content.hash;
      delete content.createdAt;
      return stableStringify(content);
    };
    if (draft.directiveID !== undefined) {
      for (const existing of this.executionDirectives.values()) {
        if (existing.id === id && withoutRevision(existing as unknown as Record<string, unknown>) === withoutRevision(candidate as unknown as Record<string, unknown>)) {
          return existing;
        }
      }
    }
    const directive: ExecutionDirective = { ...candidate, hash, createdAt: this.now() };
    // Exact FinalPlan/stage/window binding validation before persistence.
    validateDirectiveBindings({
      directive,
      run: { id: run.id, finalPlan: run.finalPlan, finalPlanHash: run.finalPlanHash },
      stage,
      window,
      finalPlanRecord: finalPlan,
    });
    this.executionDirectives.set(`${id}@${revision}`, directive);
    // Phase 6A §29 — THE one resolver slot is bound at issuance; a second
    // conflict-resolution directive for this conflict is now impossible.
    if (purpose === "conflict_resolution" && draft.conflictID !== undefined) {
      const conflict = this.verificationConflicts.get(draft.conflictID)!;
      conflict.resolutionDirectiveRef = { id: directive.id, revision: directive.revision, hash: directive.hash };
    }
    await this.appendEvent(run.planID, {
      type: "execution.directive_issued",
      executionRunID: run.id,
      directiveID: id,
      revision,
      kind: directive.kind,
      baseCandidateRevision: directive.baseCandidateRevision,
      hash,
    });
    return directive;
  }

  async startExecutionAttempt(input: StartExecutionAttemptInput): Promise<{ attempt: ExecutionAttempt; directive: ExecutionDirective }> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError("invalid_execution_lifecycle", `Attempts require an active ExecutionRun (run is ${run.lifecycle})`, {
        executionRunID: run.id,
        lifecycle: run.lifecycle,
      });
    }
    const directive = this.executionDirectives.get(`${input.directive.id}@${input.directive.revision}`);
    if (!directive || directive.executionRunID !== run.id) {
      throw new UltraPlanError("execution_directive_not_found", `Directive ${input.directive.id}@${input.directive.revision} does not exist in ExecutionRun ${run.id}`, {
        executionRunID: run.id,
        directive: `${input.directive.id}@${input.directive.revision}`,
      });
    }
    if (computeExecutionDirectiveHashFromRecord(directive) !== directive.hash) {
      throw new UltraPlanError("directive_hash_mismatch", `Directive ${directive.id}@${directive.revision} content does not recompute to its canonical hash`, {
        directive: `${directive.id}@${directive.revision}`,
      });
    }
    const stage = this.executionStages.get(directive.stageID);
    const window = this.verificationWindows.get(directive.windowID);
    if (!stage || !window || run.activeStage !== directive.stageID || stage.status !== "active" || run.openWindow !== directive.windowID || window.state !== "open") {
      throw new UltraPlanError(
        "directive_not_current",
        `Directive ${directive.id}@${directive.revision} is bound to structure that is no longer the run's current active Stage/open Window`,
        { executionRunID: run.id, directive: `${directive.id}@${directive.revision}` },
      );
    }
    // §8/§58: a stale base candidate revision is NEVER executed.
    if (directive.baseCandidateRevision !== window.candidateRevision) {
      throw new UltraPlanError(
        "stale_candidate_revision",
        `Directive ${directive.id}@${directive.revision} binds candidateRevision ${directive.baseCandidateRevision}, but the window is at ${window.candidateRevision}; issue a new Directive revision`,
        { directive: `${directive.id}@${directive.revision}`, baseCandidateRevision: directive.baseCandidateRevision, currentCandidateRevision: window.candidateRevision },
      );
    }
    // §22: one exact Directive revision → at most one logical Attempt.
    const consumed = this.executionAttemptByDirective.get(executionAttemptIndexKey(run.id, directive.id, directive.revision));
    if (consumed !== undefined) {
      throw new UltraPlanError("attempt_already_consumed", `Directive ${directive.id}@${directive.revision} is already consumed by Attempt ${consumed}`, {
        executionRunID: run.id,
        attemptID: consumed,
      });
    }
    // §23: one running Attempt per run.
    const running = [...this.executionAttempts.values()].find(
      (attempt) => attempt.executionRunID === run.id && attempt.state === "running",
    );
    if (running) {
      throw new UltraPlanError("active_attempt_conflict", `ExecutionRun ${run.id} already has a running Attempt (${running.id})`, {
        executionRunID: run.id,
        attemptID: running.id,
      });
    }
    // §24/§14: capabilities re-checked against the trusted ceiling at start.
    assertEnvelopeWithinCeiling(directive.capabilityEnvelope, input.ceiling);
    const id = ExecutionAttemptIDs.from(nextSequence([...this.executionAttempts.keys()], ExecutionAttemptIDs.prefix));
    const attempt: ExecutionAttempt = {
      id,
      executionRunID: run.id,
      stageID: directive.stageID,
      windowID: directive.windowID,
      directive: { id: directive.id, revision: directive.revision, hash: directive.hash },
      workerRole: workerRoleForDirectiveKind(directive.kind),
      state: "running",
      candidateEffect: directive.candidateEffect,
      startedAt: this.now(),
      ...(input.workerInvocationRef !== undefined ? { workerInvocationRef: input.workerInvocationRef } : {}),
    };
    this.executionAttempts.set(id, attempt);
    this.executionAttemptByDirective.set(executionAttemptIndexKey(run.id, directive.id, directive.revision), id);
    await this.appendEvent(run.planID, {
      type: "execution.attempt_started",
      executionRunID: run.id,
      attemptID: id,
      directive: `${directive.id}@${directive.revision}`,
      workerRole: attempt.workerRole,
    });
    return { attempt, directive };
  }

  async markExecutionAttemptIndeterminate(input: MarkExecutionAttemptIndeterminateInput): Promise<ExecutionAttempt> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    const attempt = this.executionAttempts.get(input.attemptID);
    if (!attempt || attempt.executionRunID !== input.executionRunID) {
      throw new UltraPlanError("execution_attempt_not_found", `ExecutionAttempt ${input.attemptID} does not exist in ExecutionRun ${input.executionRunID}`, {
        executionRunID: input.executionRunID,
        attemptID: input.attemptID,
      });
    }
    // §25: running → indeterminate only; both terminal states are final.
    if (attempt.state !== "running") {
      throw new UltraPlanError("invalid_attempt_transition", `Only a running Attempt can become indeterminate (attempt is ${attempt.state})`, {
        attemptID: attempt.id,
        state: attempt.state,
      });
    }
    const indeterminate: ExecutionAttempt = { ...attempt, state: "indeterminate", endedAt: this.now() };
    this.executionAttempts.set(attempt.id, indeterminate);
    await this.appendEvent(run.planID, {
      type: "execution.attempt_indeterminate",
      executionRunID: run.id,
      attemptID: attempt.id,
      directive: `${attempt.directive.id}@${attempt.directive.revision}`,
    });
    return indeterminate;
  }

  async submitExecutionReport(input: SubmitExecutionReportInput): Promise<{ report: ExecutionReport; attempt: ExecutionAttempt; window: VerificationWindow }> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    const attempt = this.executionAttempts.get(input.attemptID);
    if (!attempt || attempt.executionRunID !== input.executionRunID) {
      throw new UltraPlanError("execution_attempt_not_found", `ExecutionAttempt ${input.attemptID} does not exist in ExecutionRun ${input.executionRunID}`, {
        executionRunID: input.executionRunID,
        attemptID: input.attemptID,
      });
    }
    if (run.lifecycle !== "active") {
      throw new UltraPlanError("invalid_execution_lifecycle", `Report submission requires an active ExecutionRun (run is ${run.lifecycle}); an attempt on a terminal run is marked indeterminate instead`, {
        executionRunID: run.id,
        lifecycle: run.lifecycle,
      });
    }
    if (attempt.state !== "running") {
      throw new UltraPlanError("invalid_attempt_transition", `Only a running Attempt accepts a report (attempt is ${attempt.state})`, {
        attemptID: attempt.id,
        state: attempt.state,
      });
    }
    const payload = input.report;
    if (
      payload.directive.id !== attempt.directive.id ||
      payload.directive.revision !== attempt.directive.revision ||
      payload.directive.hash !== attempt.directive.hash
    ) {
      throw new UltraPlanError("report_directive_mismatch", `Report binds ${payload.directive.id}@${payload.directive.revision}, but the Attempt consumed ${attempt.directive.id}@${attempt.directive.revision}`, {
        attemptID: attempt.id,
      });
    }
    if (payload.workerRole !== attempt.workerRole) {
      throw new UltraPlanError("invalid_worker_role", `Report role ${payload.workerRole} does not match the Attempt's role ${attempt.workerRole}`, {
        attemptID: attempt.id,
      });
    }
    // One report per Attempt.
    for (const existing of this.executionReports.values()) {
      if (existing.attemptID === attempt.id) {
        throw new UltraPlanError("execution_report_conflict", `Attempt ${attempt.id} already has a durable Report (${existing.id})`, {
          attemptID: attempt.id,
          reportID: existing.id,
        });
      }
    }
    // Provenance: the attempt executed against the window's CURRENT candidate
    // revision (single running attempt per run — nothing else advanced it).
    const window = this.verificationWindows.get(attempt.windowID);
    if (!window || window.state !== "open") {
      throw new UltraPlanError("window_not_found", `Attempt ${attempt.id} window ${attempt.windowID} is not an open Window`, { windowID: attempt.windowID });
    }
    if (payload.baseCandidateRevision !== window.candidateRevision) {
      throw new UltraPlanError(
        "stale_candidate_revision",
        `Report binds baseCandidateRevision ${payload.baseCandidateRevision}, but the window is at ${window.candidateRevision}`,
        { windowID: window.id },
      );
    }
    assertExecutionReportInternallyConsistent({
      result: payload.result,
      blockers: payload.blockers,
      candidateMutation: payload.candidateMutation,
      baseCandidateRevision: payload.baseCandidateRevision,
      resultingCandidateRevision: payload.candidateMutation === "changed" ? payload.baseCandidateRevision + 1 : payload.baseCandidateRevision,
    });
    // Phase 6A — the bound Directive decides which optional report extensions
    // are legal (§32/§47): one unified schema, purpose-scoped fields.
    const boundDirective = this.executionDirectives.get(`${attempt.directive.id}@${attempt.directive.revision}`)!;
    const purpose = verificationPurposeOf(boundDirective);
    if (payload.conflictResolutionOutcome !== undefined) {
      if (purpose !== "conflict_resolution") {
        throw new UltraPlanError("invalid_scope", "conflictResolutionOutcome is only legal on a conflict_resolution Directive (§32)", {});
      }
      assertConflictResolutionOutcomeVocabulary(payload.conflictResolutionOutcome);
    }
    if (purpose === "conflict_resolution" && payload.result === "completed" && payload.conflictResolutionOutcome === undefined) {
      throw new UltraPlanError("invalid_scope", "A completed conflict-resolution report requires a conflictResolutionOutcome (§34)", {});
    }
    if (payload.reconciliationObservation !== undefined) {
      if (boundDirective.reconciliationTargets === undefined) {
        throw new UltraPlanError("invalid_scope", "reconciliationObservation is only legal on a reconciliation inspection Directive (§47)", {});
      }
      assertReconciliationObservationVocabulary(payload.reconciliationObservation);
    }
    if (boundDirective.reconciliationTargets !== undefined && payload.reconciliationObservation === undefined) {
      throw new UltraPlanError("invalid_scope", "A reconciliation inspection report requires a reconciliationObservation (§47)", {});
    }
    // §42 with the Phase 7A §4 correction — while reconciliation is required
    // (unresolved SIDE-EFFECTING indeterminate work only), the only reporting
    // work is the reconciliation inspection itself (a stale non-reconciliation
    // attempt cannot be closed around the mode). A non-mutating interrupted
    // Attempt never imposes the mode.
    const unresolvedAtReport = await this.unresolvedSideEffectingAttempts(run.id, window.id);
    if (unresolvedAtReport.length > 0 && boundDirective.reconciliationTargets === undefined) {
      throw new UltraPlanError(
        "reconciliation_required",
        `Window ${window.id} requires reconciliation of ${unresolvedAtReport.map((attempt) => attempt.id).join(", ")}; only the reconciliation inspection may report`,
        { executionRunID: run.id, windowID: window.id },
      );
    }
    // §32: a non-mutating Directive whose report declares mutation is
    // PRESERVED — the physical-reality fact is never discarded.
    const unexpectedMutation = attempt.candidateEffect === "non_mutating" && payload.candidateMutation === "changed";
    const resultingCandidateRevision =
      payload.candidateMutation === "changed" ? window.candidateRevision + 1 : window.candidateRevision;
    const id = ExecutionReportIDs.from(nextSequence([...this.executionReports.keys()], ExecutionReportIDs.prefix));
    const now = this.now();
    // §31: report persistence + attempt completion + candidate advance are
    // ONE durable transaction — never report-then-bump.
    const report: ExecutionReport = {
      id,
      attemptID: attempt.id,
      directive: { ...attempt.directive },
      workerRole: payload.workerRole,
      result: payload.result,
      actionsPerformed: [...payload.actionsPerformed],
      filesExamined: [...payload.filesExamined],
      filesChanged: [...payload.filesChanged],
      commandsRun: [...payload.commandsRun],
      testsRun: [...payload.testsRun],
      findings: [...payload.findings],
      deviations: payload.deviations.map((deviation) => ({ ...deviation })),
      blockers: payload.blockers.map((blocker) => ({ ...blocker })),
      deliverables: [...payload.deliverables],
      candidateMutation: payload.candidateMutation,
      baseCandidateRevision: payload.baseCandidateRevision,
      resultingCandidateRevision,
      ...(payload.conflictResolutionOutcome !== undefined ? { conflictResolutionOutcome: payload.conflictResolutionOutcome } : {}),
      ...(payload.reconciliationObservation !== undefined ? { reconciliationObservation: payload.reconciliationObservation } : {}),
      createdAt: now,
    };
    const reported: ExecutionAttempt = { ...attempt, state: "reported", endedAt: now };
    const updatedWindow: VerificationWindow =
      payload.candidateMutation === "changed"
        ? { ...window, candidateRevision: resultingCandidateRevision, revision: window.revision + 1, updatedAt: now }
        : window;
    this.executionReports.set(id, report);
    this.executionAttempts.set(attempt.id, reported);
    if (payload.candidateMutation === "changed") {
      this.verificationWindows.set(window.id, updatedWindow);
    }
    await this.appendEvent(run.planID, {
      type: "execution.attempt_reported",
      executionRunID: run.id,
      attemptID: attempt.id,
      reportID: id,
      directive: `${attempt.directive.id}@${attempt.directive.revision}`,
      result: report.result,
      candidateMutation: report.candidateMutation,
      resultingCandidateRevision,
    });
    if (unexpectedMutation) {
      await this.appendEvent(run.planID, {
        type: "execution.unexpected_candidate_mutation",
        executionRunID: run.id,
        attemptID: attempt.id,
        reportID: id,
        candidateEffect: attempt.candidateEffect,
      });
    }
    // Phase 6A §33/§34 — conflict finalization INSIDE the report transaction.
    // A resolver on the exact current candidate either RESOLVES the conflict
    // (completed + non-mutating + supports_a/b/neither) or terminally BLOCKS
    // it (failed/partial/blocked result or outcome=unresolved). A mutating
    // resolver advances the candidate (Phase 4 physical truth) and can never
    // adjudicate — the conflict becomes stale history by revision (§33), and
    // no second resolver can ever be issued (§29 binding at issuance).
    let finalizedConflict: VerificationConflict | undefined;
    if (purpose === "conflict_resolution" && boundDirective.conflictID !== undefined) {
      const conflict = this.verificationConflicts.get(boundDirective.conflictID);
      if (conflict && conflict.status === "open" && conflict.candidateRevision === resultingCandidateRevision) {
        const outcome = payload.conflictResolutionOutcome;
        if (payload.result === "completed" && outcome !== undefined && outcome !== "unresolved") {
          conflict.status = "resolved";
          conflict.resolutionReportRef = id;
          conflict.resolutionOutcome = outcome;
          conflict.neutralizedEvidenceRefs = neutralizedEvidenceForOutcome(outcome, conflict.evidenceA, conflict.evidenceB);
          conflict.resolvedAt = now;
          finalizedConflict = conflict;
          await this.appendEvent(run.planID, {
            type: "execution.verification_conflict_resolved",
            executionRunID: run.id,
            conflictID: conflict.id,
            reportID: id,
            outcome,
          });
        } else {
          conflict.status = "verification_blocked";
          conflict.resolutionReportRef = id;
          conflict.resolutionOutcome = outcome;
          conflict.neutralizedEvidenceRefs = [];
          conflict.resolvedAt = now;
          finalizedConflict = conflict;
          await this.appendEvent(run.planID, {
            type: "execution.verification_blocked",
            executionRunID: run.id,
            conflictID: conflict.id,
            reportID: id,
          });
        }
      }
    }
    return { report, attempt: reported, window: updatedWindow, ...(finalizedConflict !== undefined ? { conflict: finalizedConflict } : {}) };
  }

  async getExecutionDirective(directiveID: ExecutionDirectiveID, revision?: number): Promise<ExecutionDirective | undefined> {
    if (revision !== undefined) {
      return this.executionDirectives.get(`${directiveID}@${revision}`);
    }
    const revisions = [...this.executionDirectives.values()].filter((directive) => directive.id === directiveID);
    if (revisions.length === 0) return undefined;
    return revisions.reduce((latest, directive) => (directive.revision > latest.revision ? directive : latest));
  }

  async listExecutionDirectivesForRun(executionRunID: ExecutionRunID): Promise<ExecutionDirective[]> {
    return [...this.executionDirectives.values()].filter((directive) => directive.executionRunID === executionRunID);
  }

  async getExecutionAttempt(attemptID: ExecutionAttemptID): Promise<ExecutionAttempt | undefined> {
    return this.executionAttempts.get(attemptID);
  }

  async findExecutionAttemptForDirective(
    executionRunID: ExecutionRunID,
    directive: { id: ExecutionDirectiveID; revision: number },
  ): Promise<ExecutionAttempt | undefined> {
    const id = this.executionAttemptByDirective.get(executionAttemptIndexKey(executionRunID, directive.id, directive.revision));
    return id === undefined ? undefined : this.executionAttempts.get(id);
  }

  async findRunningExecutionAttempt(executionRunID: ExecutionRunID): Promise<ExecutionAttempt | undefined> {
    return [...this.executionAttempts.values()].find((attempt) => attempt.executionRunID === executionRunID && attempt.state === "running");
  }

  async listExecutionAttemptsForRun(executionRunID: ExecutionRunID): Promise<ExecutionAttempt[]> {
    return [...this.executionAttempts.values()].filter((attempt) => attempt.executionRunID === executionRunID);
  }

  async getExecutionReport(reportID: ExecutionReportID): Promise<ExecutionReport | undefined> {
    return this.executionReports.get(reportID);
  }

  async findExecutionReportForAttempt(attemptID: ExecutionAttemptID): Promise<ExecutionReport | undefined> {
    for (const report of this.executionReports.values()) {
      if (report.attemptID === attemptID) return report;
    }
    return undefined;
  }

  async listExecutionReportsForRun(executionRunID: ExecutionRunID): Promise<ExecutionReport[]> {
    const attempts = new Set([...this.executionAttempts.values()].filter((attempt) => attempt.executionRunID === executionRunID).map((attempt) => attempt.id));
    return [...this.executionReports.values()].filter((report) => attempts.has(report.attemptID));
  }

  // -------------------------------------------------------------------------
  // SupervisorAssessment & ExecutionCommit (v0.2.0 Phase 5) — the acceptance
  // layer. The Supervisor PROPOSES (disposition=accept); Core DECIDES via
  // the acceptance gate; only the gate-passing transaction creates accepted
  // truth (ExecutionCommit → acceptedHead → Window closed → optional Stage
  // completion) as ONE crash-safe durable mutation.
  // -------------------------------------------------------------------------

  async submitSupervisorAssessment(input: SubmitSupervisorAssessmentInput): Promise<{
    assessment: SupervisorAssessment;
    commit?: ExecutionCommit;
  }> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError("invalid_execution_lifecycle", `Assessments require an active ExecutionRun (run is ${run.lifecycle})`, {
        executionRunID: run.id,
        lifecycle: run.lifecycle,
      });
    }
    // Crash-safe retry FIRST (§49/§57/§76): an explicit assessment id whose
    // content hash matches the durable record returns the existing result
    // (and its commit) even though the window has since closed — the retry
    // arrives after a lost response, not as a new judgment. Same id with
    // different content fails assessment_conflict.
    const draftEarly = input.draft;
    if (draftEarly.assessmentID !== undefined) {
      const prior = this.supervisorAssessments.get(draftEarly.assessmentID);
      if (prior) {
        assertAssessmentDisposition(draftEarly.disposition);
        assertAssessmentAcceptanceScope(draftEarly.acceptanceScope);
        const retryRecord: Record<string, unknown> = {
          id: draftEarly.assessmentID,
          executionRunID: input.executionRunID,
          stageID: input.stageID,
          windowID: input.windowID,
          candidateRevision: input.candidateRevision,
          reportRefs: draftEarly.reportRefs ?? [],
          planRefs: draftEarly.planRefs ?? [],
          coveredObligations: draftEarly.coveredObligations ?? [],
          acceptanceScope: draftEarly.acceptanceScope,
          disposition: draftEarly.disposition,
          rationale: draftEarly.rationale,
        };
        if (stableStringify(retryRecord) === stableStringify(supervisorAssessmentHashPayload(prior))) {
          const commitID = this.executionCommitByAssessment.get(prior.id);
          return { assessment: prior, ...(commitID !== undefined ? { commit: this.executionCommits.get(commitID) } : {}) };
        }
        throw new UltraPlanError("assessment_conflict", `Assessment ${draftEarly.assessmentID} already exists with DIFFERENT content; new judgment requires a new id`, {
          assessmentID: draftEarly.assessmentID,
        });
      }
    }
    // Exact current structure.
    const stage = this.executionStages.get(input.stageID);
    const window = this.verificationWindows.get(input.windowID);
    if (!stage || stage.executionRunID !== run.id || run.activeStage !== stage.id || stage.status !== "active") {
      throw new UltraPlanError(
        "assessment_stale",
        `Assessment structure is not the run's current active Stage (run.activeStage is ${run.activeStage ?? "none"}, stage ${input.stageID} is ${stage?.status ?? "missing"})`,
        { executionRunID: run.id, stageID: input.stageID },
      );
    }
    if (!window || window.executionRunID !== run.id || run.openWindow !== window.id || window.stageID !== stage.id || window.state !== "open") {
      throw new UltraPlanError(
        "assessment_stale",
        `Assessment structure is not the run's current open Window (run.openWindow is ${run.openWindow ?? "none"}, window ${input.windowID} is ${window?.state ?? "missing"})`,
        { executionRunID: run.id, windowID: input.windowID },
      );
    }
    // Exact candidate binding (§22): a stale caller binding is refused outright.
    if (input.candidateRevision !== window.candidateRevision) {
      throw new UltraPlanError(
        "stale_candidate_revision",
        `Assessment binds candidateRevision ${input.candidateRevision}, but the window is at ${window.candidateRevision}`,
        { windowID: window.id },
      );
    }
    // §37: no commit while an Attempt is running.
    const running = [...this.executionAttempts.values()].find(
      (attempt) => attempt.executionRunID === run.id && attempt.state === "running",
    );
    if (running) {
      throw new UltraPlanError("active_attempt_conflict", `ExecutionRun ${run.id} has a running Attempt (${running.id}); resolve it before assessment`, {
        executionRunID: run.id,
        attemptID: running.id,
      });
    }

    const draft = input.draft;
    assertAssessmentDisposition(draft.disposition);
    assertAssessmentAcceptanceScope(draft.acceptanceScope);
    if (typeof draft.rationale !== "string" || draft.rationale.trim().length === 0) {
      throw new UltraPlanError("invalid_scope", "An assessment requires a non-empty rationale", { executionRunID: run.id });
    }
    // §23: every referenced report must exist and belong to THIS window's workset.
    const windowAttempts = [...this.executionAttempts.values()].filter((attempt) => attempt.windowID === window.id);
    const windowAttemptIDs = new Set(windowAttempts.map((attempt) => attempt.id));
    const windowReports = [...this.executionReports.values()].filter((report) => windowAttemptIDs.has(report.attemptID));
    for (const ref of draft.reportRefs) {
      const report = this.executionReports.get(ref);
      if (!report || !windowAttemptIDs.has(report.attemptID)) {
        throw new UltraPlanError("invalid_scope", `Assessment report ref ${ref} does not belong to Window ${window.id}'s workset`, {
          windowID: window.id,
          reportID: ref,
        });
      }
    }
    // Exact planRefs.
    const finalPlan = this.getFinalPlanSync(run.planID, run.finalPlan);
    if (!finalPlan || finalPlan.hash !== run.finalPlanHash) {
      throw new UltraPlanError("final_plan_binding_mismatch", `ExecutionRun ${run.id} FinalPlan binding no longer resolves with the bound hash`, {
        executionRunID: run.id,
      });
    }
    validateExecutionPlanRefs(draft.planRefs ?? [], finalPlan);
    // §24: covered obligations must be EXACT Stage obligations (missing ≠ zero).
    const obligations = stageCompletionObligations(stage);
    const obligationIDs = new Set(obligations.map((obligation) => obligation.id as string));
    for (const ref of draft.coveredObligations ?? []) {
      if (!obligationIDs.has(ref as string)) {
        throw new UltraPlanError("invalid_scope", `Assessment covers unknown Stage obligation ${String(ref)}`, { ref });
      }
    }

    // Idempotency identity (§27/§49).
    const assessmentID =
      draft.assessmentID ??
      SupervisorAssessmentIDs.from(nextSequence([...this.supervisorAssessments.keys()], SupervisorAssessmentIDs.prefix));
    const now = this.now();
    const candidateRecord: SupervisorAssessment = {
      id: assessmentID,
      executionRunID: run.id,
      stageID: stage.id,
      windowID: window.id,
      candidateRevision: window.candidateRevision,
      reportRefs: [...(draft.reportRefs ?? [])],
      planRefs: (draft.planRefs ?? []).map((ref) => ({ ...ref })) as ExecutionPlanRef[],
      coveredObligations: [...(draft.coveredObligations ?? [])],
      acceptanceScope: draft.acceptanceScope,
      disposition: draft.disposition,
      rationale: draft.rationale,
      hash: "",
      createdAt: now,
    };
    candidateRecord.hash = computeSupervisorAssessmentHash(supervisorAssessmentHashPayload(candidateRecord));

    const existing = draft.assessmentID !== undefined ? this.supervisorAssessments.get(draft.assessmentID) : undefined;
    if (existing) {
      if (supervisorAssessmentContentEquals(existing, candidateRecord)) {
        // §49/§57/§76: crash-safe retry — same assessment (and its commit, if any).
        const commitID = this.executionCommitByAssessment.get(existing.id);
        return { assessment: existing, ...(commitID !== undefined ? { commit: this.executionCommits.get(commitID) } : {}) };
      }
      throw new UltraPlanError("assessment_conflict", `Assessment ${assessmentID} already exists with DIFFERENT content; new judgment requires a new id`, {
        assessmentID,
      });
    }

    // ------------------------------------------------------------------
    // Non-accept dispositions (§29): persist the immutable judgment + audit,
    // change NOTHING else (no window close, no candidate move, no lifecycle).
    // ------------------------------------------------------------------
    if (draft.disposition !== "accept") {
      this.supervisorAssessments.set(assessmentID, candidateRecord);
      await this.appendEvent(run.planID, {
        type: "execution.supervisor_assessment_recorded",
        executionRunID: run.id,
        assessmentID,
        windowID: window.id,
        candidateRevision: window.candidateRevision,
        disposition: draft.disposition,
        acceptanceScope: draft.acceptanceScope,
      });
      return { assessment: candidateRecord };
    }

    // ------------------------------------------------------------------
    // THE CORE ACCEPTANCE GATE (§31/§39-§42/§45). Supervisor proposes ACCEPT;
    // Core decides whether accept becomes committed truth. Any failure below
    // aborts the WHOLE transaction — no assessment, no commit, no closure.
    // ------------------------------------------------------------------

    // (a) §33 parent gate: the window must sit on the run's CURRENT accepted state.
    const parent = currentAcceptedState(run);
    if (stableStringify(window.baseAcceptedState) !== stableStringify(parent)) {
      throw new UltraPlanError(
        "stale_execution_head",
        `Window ${window.id} anchors ${JSON.stringify(window.baseAcceptedState)}, but the run's current accepted state is ${JSON.stringify(parent)}; the chain would branch`,
        { executionRunID: run.id, windowID: window.id },
      );
    }

    // (b) Phase 6A §42/§55 with the Phase 7A §6 correction: the canonical
    // unresolved SIDE-EFFECTING set (not "any indeterminate ever") forces
    // reconciliation mode. A historical non-mutating interruption only means
    // "that Attempt produced no acceptance evidence" — it never blocks the
    // commit when a fresh qualifying verifier exists.
    const windowUnresolved = await this.unresolvedSideEffectingAttempts(run.id, window.id);
    if (windowUnresolved.length > 0) {
      throw new UltraPlanError(
        "reconciliation_required",
        `Window ${window.id} carries unresolved side-effecting indeterminate Attempt(s) ${windowUnresolved.map((attempt) => attempt.id).join(", ")}; repository reality must be re-established via reconciliation before acceptance`,
        { executionRunID: run.id, windowID: window.id, unresolved: windowUnresolved.map((attempt) => attempt.id) },
      );
    }

    // (b2) Phase 6A §39 — current-candidate conflict gates: an OPEN conflict
    // or a verification_blocked conflict blocks the commit outright (history
    // on older candidates never blocks — §24).
    const currentConflicts = [...this.verificationConflicts.values()].filter(
      (conflict) => conflict.windowID === window.id && conflict.candidateRevision === window.candidateRevision,
    );
    if (currentConflicts.some((conflict) => conflict.status === "open")) {
      throw new UltraPlanError(
        "verification_conflict_open",
        `Window ${window.id} has OPEN verification conflict(s) ${currentConflicts.filter((conflict) => conflict.status === "open").map((conflict) => conflict.id).join(", ")}; the disputed fact must be adjudicated before acceptance`,
        { executionRunID: run.id, windowID: window.id },
      );
    }
    if (currentConflicts.some((conflict) => conflict.status === "verification_blocked")) {
      throw new UltraPlanError(
        "verification_blocked",
        `Window ${window.id} has verification_blocked conflict(s) ${currentConflicts.filter((conflict) => conflict.status === "verification_blocked").map((conflict) => conflict.id).join(", ")}; the dispute terminated without resolution`,
        { executionRunID: run.id, windowID: window.id },
      );
    }

    // §23/§40: the gate scans CANONICAL window evidence — the Supervisor
    // cannot hide negative reports by omitting them from reportRefs.
    const windowDirectiveLogicalIDs = [...new Set(windowAttempts.map((attempt) => attempt.directive.id))];
    const windowEvidence = windowReports.map((report) => ({
      report,
      attempt: windowAttempts.find((attempt) => attempt.id === report.attemptID)!,
      directive: this.executionDirectives.get(
        `${windowAttempts.find((attempt) => attempt.id === report.attemptID)!.directive.id}@${windowAttempts.find((attempt) => attempt.id === report.attemptID)!.directive.revision}`,
      ),
    }));
    const currentVerifierEvidence = windowEvidence
      .filter(({ attempt }) => attempt.workerRole === "verifier" && attempt.state === "reported")
      .filter(({ report }) => report.baseCandidateRevision === window.candidateRevision);

    // (c) Phase 6A §21/§37 negative-evidence gate UPGRADE: enumerate CANONICAL
    // blocking evidence as exact refs, subtract the neutralized evidence of
    // protocol-valid resolved current-candidate conflicts, and block only on
    // the EFFECTIVE remainder. Original reports stay untouched (§64) — the
    // resolution provenance explains why a specific ref no longer blocks.
    const blockingEvidence = enumerateBlockingEvidence({
      candidateRevision: window.candidateRevision,
      evidence: currentVerifierEvidence,
    });
    const neutralizedEvidence = this.currentCandidateNeutralizedEvidence(window.id, window.candidateRevision);
    const effective = effectiveBlockingEvidence(blockingEvidence, neutralizedEvidence);
    if (effective.length > 0) {
      throw new UltraPlanError(
        "blocking_verification_result",
        `Window ${window.id} still carries effective blocking verification evidence after conflict resolution: ${effective
          .map((ref) => (ref.kind === "report_result" ? `${ref.reportID}#result` : `${ref.reportID}#finding[${ref.findingIndex}]`))
          .join(", ")}`,
        { executionRunID: run.id, windowID: window.id, blockingEvidence: effective },
      );
    }

    // (d) §15/§16/§39/§42 qualifying verification: ≥1 fresh, independent,
    // non-mutating, exact-current-candidate clean verifier report. Phase 6A
    // §38: a conflict_resolution report NEVER counts — the commit still
    // requires an ordinary acceptance-purpose fresh verifier. Phase 6A §79:
    // a report whose evidence a resolved conflict NEUTRALIZED no longer
    // qualifies either — its factual conclusion was overruled.
    const qualifying = currentVerifierEvidence.filter(({ report, attempt }) => {
      if (neutralizedEvidence.some((ref) => ref.reportID === report.id)) return false;
      if (report.result !== "completed" || report.candidateMutation !== "none") return false;
      if (report.resultingCandidateRevision !== window.candidateRevision) return false;
      if (report.workerRole !== "verifier") return false;
      if (attempt.state !== "reported") return false;
      const directive = this.executionDirectives.get(`${attempt.directive.id}@${attempt.directive.revision}`);
      if (!directive || directive.kind !== "verification") return false;
      if (verificationPurposeOf(directive) !== "acceptance") return false;
      if (directive.baseCandidateRevision !== window.candidateRevision) return false;
      if (report.blockers.length > 0) return false;
      return report.findings.every((finding) => findingAcceptanceImpact(finding) === "informational");
    });
    if (qualifying.length === 0) {
      throw new UltraPlanError(
        "verification_required",
        `Acceptance requires at least one qualifying current-candidate verifier Report for Window ${window.id} (execution/inspection/self-check reports do not count)`,
        { executionRunID: run.id, windowID: window.id, candidateRevision: window.candidateRevision },
      );
    }

    // (e) §24/§41 coverage gate: every claimed obligation needs qualifying
    // verifier coverage whose Directive explicitly declared it.
    for (const ref of candidateRecord.coveredObligations) {
      const covered = qualifying.some(({ attempt }) => {
        const directive = this.executionDirectives.get(`${attempt.directive.id}@${attempt.directive.revision}`);
        return directive?.verificationCoverage?.obligationRefs.includes(ref) === true;
      });
      if (!covered) {
        throw new UltraPlanError(
          "verification_required",
          `Stage obligation ${String(ref)} has no qualifying current verifier coverage (the verification Directive must explicitly declare it)`,
          { executionRunID: run.id, obligation: ref },
        );
      }
    }

    // (f) §45 stage-closure gate: explicit obligations + full coverage.
    let stageCompletes = false;
    if (draft.acceptanceScope === "stage") {
      if (!stageHasExplicitCompletionObligations(stage)) {
        throw new UltraPlanError(
          "stage_completion_obligations_missing",
          `Stage ${stage.id} has no explicit completion obligations; missing obligations are never trivially satisfied`,
          { executionRunID: run.id, stageID: stage.id },
        );
      }
      const accepted = await this.acceptedStageObligations(run.id, stage.id);
      const covered = new Set<string>([...accepted, ...candidateRecord.coveredObligations].map((ref) => ref as string));
      const missing = obligations.filter((obligation) => !covered.has(obligation.id as string));
      if (missing.length > 0) {
        throw new UltraPlanError(
          "stage_completion_incomplete",
          `Stage ${stage.id} closure is incomplete: obligations not yet accepted: ${missing.map((obligation) => obligation.id).join(", ")}`,
          { executionRunID: run.id, stageID: stage.id, missing: missing.map((obligation) => obligation.id) },
        );
      }
      stageCompletes = true;
    }

    // ------------------------------------------------------------------
    // THE SINGLE CRASH-SAFE COMMIT POINT (§31): assessment + commit + window
    // closure + acceptedHead advance (+ optional Stage completion) mutate
    // together, then publish atomically.
    // ------------------------------------------------------------------
    const commitID = ExecutionCommitIDs.from(nextSequence([...this.executionCommits.keys()], ExecutionCommitIDs.prefix));
    const commit: ExecutionCommit = {
      id: commitID,
      executionRunID: run.id,
      stageID: stage.id,
      windowID: window.id,
      candidateRevision: window.candidateRevision,
      parentAcceptedState:
        window.baseAcceptedState.kind === "execution_start"
          ? { kind: "execution_start", executionRunID: window.baseAcceptedState.executionRunID }
          : { kind: "execution_commit", executionCommitID: window.baseAcceptedState.executionCommitID },
      directiveRefs: windowDirectiveLogicalIDs,
      reportRefs: windowReports.map((report) => report.id),
      supervisorAssessmentID: assessmentID,
      satisfiedObligations: [...candidateRecord.coveredObligations],
      // Phase 6A §90 — indeterminate history and its resolution stay visible
      // in the accepted provenance (never hidden).
      reconciliationRefs: [...this.attemptReconciliations.values()]
        .filter((reconciliation) => reconciliation.windowID === window.id && reconciliation.resultingCandidateRevision <= window.candidateRevision)
        .map((reconciliation) => reconciliation.id),
      stageCompleted: stageCompletes,
      createdAt: now,
    };
    const closedWindow: VerificationWindow = { ...window, state: "closed", closedAt: now, revision: window.revision + 1 };
    const updatedRun: ExecutionRun = {
      ...run,
      openWindow: undefined,
      acceptedHead: commitID,
      ...(stageCompletes ? { activeStage: undefined } : {}),
      revision: run.revision + 1,
      updatedAt: now,
    };
    this.supervisorAssessments.set(assessmentID, candidateRecord);
    this.executionCommits.set(commitID, commit);
    this.executionCommitByWindow.set(window.id, commitID);
    this.executionCommitByAssessment.set(assessmentID, commitID);
    this.verificationWindows.set(window.id, closedWindow);
    if (stageCompletes) {
      this.executionStages.set(stage.id, { ...stage, status: "completed", revision: stage.revision + 1, updatedAt: now });
    }
    this.executionRuns.set(run.id, updatedRun);
    await this.appendEvent(run.planID, {
      type: "execution.supervisor_assessment_recorded",
      executionRunID: run.id,
      assessmentID,
      windowID: window.id,
      candidateRevision: window.candidateRevision,
      disposition: draft.disposition,
      acceptanceScope: draft.acceptanceScope,
    });
    await this.appendEvent(run.planID, {
      type: "execution.commit_created",
      executionRunID: run.id,
      commitID,
      assessmentID,
      windowID: window.id,
      candidateRevision: commit.candidateRevision,
      parent: commit.parentAcceptedState.kind === "execution_start" ? "execution_start" : commit.parentAcceptedState.executionCommitID,
      satisfiedObligations: commit.satisfiedObligations,
      stageCompleted: stageCompletes,
    });
    await this.appendEvent(run.planID, {
      type: "execution.window_closed",
      executionRunID: run.id,
      windowID: window.id,
      commitID,
    });
    if (stageCompletes) {
      await this.appendEvent(run.planID, {
        type: "execution.stage_completed",
        executionRunID: run.id,
        stageID: stage.id,
        commitID,
      });
    }
    return { assessment: candidateRecord, commit };
  }

  async getSupervisorAssessment(assessmentID: SupervisorAssessmentID): Promise<SupervisorAssessment | undefined> {
    return this.supervisorAssessments.get(assessmentID);
  }

  async listSupervisorAssessmentsForRun(executionRunID: ExecutionRunID): Promise<SupervisorAssessment[]> {
    return [...this.supervisorAssessments.values()].filter((assessment) => assessment.executionRunID === executionRunID);
  }

  async getExecutionCommit(commitID: ExecutionCommitID): Promise<ExecutionCommit | undefined> {
    return this.executionCommits.get(commitID);
  }

  async findAcceptedHeadCommit(executionRunID: ExecutionRunID): Promise<ExecutionCommit | undefined> {
    const run = this.executionRuns.get(executionRunID);
    return run?.acceptedHead !== undefined ? this.executionCommits.get(run.acceptedHead) : undefined;
  }

  async findExecutionCommitForWindow(windowID: VerificationWindowID): Promise<ExecutionCommit | undefined> {
    const commitID = this.executionCommitByWindow.get(windowID);
    return commitID === undefined ? undefined : this.executionCommits.get(commitID);
  }

  async listExecutionCommitsForRun(executionRunID: ExecutionRunID): Promise<ExecutionCommit[]> {
    return [...this.executionCommits.values()].filter((commit) => commit.executionRunID === executionRunID);
  }

  async acceptedStageObligations(executionRunID: ExecutionRunID, stageID: ExecutionStageID): Promise<StageCompletionObligationID[]> {
    const satisfied = new Set<string>();
    for (const commit of this.executionCommits.values()) {
      if (commit.executionRunID === executionRunID && commit.stageID === stageID) {
        for (const obligation of commit.satisfiedObligations) satisfied.add(obligation as string);
      }
    }
    return [...satisfied] as StageCompletionObligationID[];
  }

  // -------------------------------------------------------------------------
  // Phase 6A — the abnormal / escalation control plane: ExecutionIssue +
  // REPLAN_REQUIRED (Part A), VerificationConflict + one bounded resolver
  // (Part B), and AttemptReconciliation for indeterminate Attempts (Part C).
  // Same rules as every layer above: authority-gated mutations, exact
  // candidate bindings, immutable records, deterministic projections.
  // -------------------------------------------------------------------------

  /**
   * §41 — the CANONICAL unresolved-indeterminate set, run-wide: an Attempt
   * counts ONLY while it is indeterminate AND no successful
   * AttemptReconciliation covers it (never a "latest event" heuristic).
   */
  private unresolvedIndeterminateAttemptRefs(executionRunID: ExecutionRunID): ExecutionAttemptID[] {
    return [...this.executionAttempts.values()]
      .filter((attempt) => attempt.executionRunID === executionRunID && attempt.state === "indeterminate")
      .filter((attempt) => !this.reconciliationByAttempt.has(attempt.id))
      .map((attempt) => attempt.id);
  }

  /** §41 — window-scoped unresolved indeterminate Attempts (records, not refs). */
  async unresolvedIndeterminateAttempts(executionRunID: ExecutionRunID, windowID: VerificationWindowID): Promise<ExecutionAttempt[]> {
    const covered = new Set(
      [...this.attemptReconciliations.values()]
        .filter((reconciliation) => reconciliation.executionRunID === executionRunID && reconciliation.windowID === windowID)
        .flatMap((reconciliation) => reconciliation.targetAttemptIDs.map((target) => target as string)),
    );
    return [...this.executionAttempts.values()].filter(
      (attempt) =>
        attempt.executionRunID === executionRunID &&
        attempt.windowID === windowID &&
        attempt.state === "indeterminate" &&
        !covered.has(attempt.id),
    );
  }

  /**
   * Phase 7A §3/§4 — the RECONCILIATION/COMMIT-blocking subset of the
   * unresolved-indeterminate set: only indeterminate Attempts whose Directive
   * could mutate the candidate make repository reality uncertain. A
   * non-mutating interrupted Attempt never blocks a gate — it merely provides
   * no acceptance evidence, and fresh non-mutating work may replace it.
   */
  async unresolvedSideEffectingAttempts(executionRunID: ExecutionRunID, windowID: VerificationWindowID): Promise<ExecutionAttempt[]> {
    return (await this.unresolvedIndeterminateAttempts(executionRunID, windowID)).filter(
      (attempt) => attempt.candidateEffect === "may_mutate",
    );
  }

  /** §36/§37 — neutralized evidence from RESOLVED conflicts on the exact current candidate. */
  private currentCandidateNeutralizedEvidence(windowID: VerificationWindowID, candidateRevision: number): VerificationEvidenceRef[] {
    const neutralized: VerificationEvidenceRef[] = [];
    for (const conflict of this.verificationConflicts.values()) {
      if (conflict.windowID !== windowID || conflict.candidateRevision !== candidateRevision) continue;
      if (conflict.status !== "resolved") continue;
      for (const ref of conflict.neutralizedEvidenceRefs ?? []) neutralized.push(ref);
    }
    return neutralized;
  }

  async getVerificationConflict(conflictID: VerificationConflictID): Promise<VerificationConflict | undefined> {
    return this.verificationConflicts.get(conflictID);
  }

  async listVerificationConflictsForRun(executionRunID: ExecutionRunID): Promise<VerificationConflict[]> {
    return [...this.verificationConflicts.values()].filter((conflict) => conflict.executionRunID === executionRunID);
  }

  /**
   * §25 — Supervisor-driven creation of ONE disputed-fact record. Evidence
   * must be exact current-candidate evidence of this window (§23); at least
   * one side must be acceptance-relevant (verifier evidence — never a purely
   * informational disagreement). Creation records the conflict ONLY: no
   * verifier is launched, no candidate moves, no window state changes.
   */
  async createVerificationConflict(input: CreateVerificationConflictInput): Promise<{ conflict: VerificationConflict; created: boolean }> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError("invalid_execution_lifecycle", `Conflicts require an active ExecutionRun (run is ${run.lifecycle})`, {
        executionRunID: run.id,
        lifecycle: run.lifecycle,
      });
    }
    const stage = this.executionStages.get(input.stageID);
    const window = this.verificationWindows.get(input.windowID);
    if (!stage || stage.executionRunID !== run.id || run.activeStage !== stage.id || stage.status !== "active") {
      throw new UltraPlanError("invalid_scope", `Conflicts can only be created against the run's active Stage (${input.stageID})`, {
        executionRunID: run.id,
        stageID: input.stageID,
      });
    }
    if (!window || window.executionRunID !== run.id || run.openWindow !== window.id || window.stageID !== stage.id || window.state !== "open") {
      throw new UltraPlanError("invalid_scope", `Conflicts can only be created against the run's open Window (${input.windowID})`, {
        executionRunID: run.id,
        windowID: input.windowID,
      });
    }
    if (input.candidateRevision !== window.candidateRevision) {
      throw new UltraPlanError(
        "stale_candidate_revision",
        `Conflict binds candidateRevision ${input.candidateRevision}, but the window is at ${window.candidateRevision}`,
        { windowID: window.id },
      );
    }
    assertVerificationEvidenceRef(input.evidenceA);
    assertVerificationEvidenceRef(input.evidenceB);
    if (verificationEvidenceRefEquals(input.evidenceA, input.evidenceB)) {
      throw new UltraPlanError("invalid_verification_evidence_ref", "A conflict requires two DISTINCT evidence refs", {});
    }
    if (!input.claimA.trim() || !input.claimB.trim() || !input.resolutionQuestion.trim()) {
      throw new UltraPlanError("invalid_scope", "A conflict requires non-empty claims and resolution question", {});
    }
    // §23 — both evidence refs must resolve to reports of THIS window bound to
    // the exact current candidate.
    const resolveEvidence = (ref: VerificationEvidenceRef, side: "A" | "B"): { report: ExecutionReport; acceptanceRelevant: boolean } => {
      const report = this.executionReports.get(ref.reportID);
      if (!report) {
        throw new UltraPlanError("invalid_verification_evidence_ref", `Conflict evidence ${side} references missing Report ${ref.reportID}`, { ref });
      }
      const attempt = this.executionAttempts.get(report.attemptID);
      if (!attempt || attempt.windowID !== window.id) {
        throw new UltraPlanError("invalid_verification_evidence_ref", `Conflict evidence ${side} references a Report outside Window ${window.id}`, { ref });
      }
      if (report.baseCandidateRevision !== window.candidateRevision) {
        throw new UltraPlanError(
          "invalid_verification_evidence_ref",
          `Conflict evidence ${side} binds candidateRevision ${report.baseCandidateRevision}, but the window is at ${window.candidateRevision}`,
          { ref },
        );
      }
      if (ref.kind === "finding" && ref.findingIndex >= report.findings.length) {
        throw new UltraPlanError("invalid_verification_evidence_ref", `Conflict evidence ${side} findingIndex ${ref.findingIndex} is out of bounds`, { ref });
      }
      const directive = this.executionDirectives.get(`${attempt.directive.id}@${attempt.directive.revision}`);
      return { report, acceptanceRelevant: attempt.workerRole === "verifier" && directive?.kind === "verification" };
    };
    const sideA = resolveEvidence(input.evidenceA, "A");
    const sideB = resolveEvidence(input.evidenceB, "B");
    if (!sideA.acceptanceRelevant && !sideB.acceptanceRelevant) {
      throw new UltraPlanError(
        "invalid_scope",
        "A conflict requires at least one acceptance-relevant side (verifier evidence on the current candidate); purely informational disagreements never create harness conflicts",
        {},
      );
    }
    // §25 idempotency — same id + same content returns the existing conflict.
    const conflictID =
      input.conflictID ??
      VerificationConflictIDs.from(nextSequence([...this.verificationConflicts.keys()], VerificationConflictIDs.prefix));
    const existing = this.verificationConflicts.get(conflictID);
    if (existing) {
      const retry = this.buildConflictCandidate(run, stage, window, input, conflictID, "");
      if (
        existing.executionRunID === retry.executionRunID &&
        existing.stageID === retry.stageID &&
        existing.windowID === retry.windowID &&
        existing.candidateRevision === retry.candidateRevision &&
        verificationEvidenceRefEquals(existing.evidenceA, retry.evidenceA) &&
        verificationEvidenceRefEquals(existing.evidenceB, retry.evidenceB) &&
        existing.claimA === retry.claimA &&
        existing.claimB === retry.claimB &&
        existing.resolutionQuestion === retry.resolutionQuestion
      ) {
        return { conflict: existing, created: false };
      }
      throw new UltraPlanError("verification_conflict_conflict", `VerificationConflict ${conflictID} already exists with DIFFERENT content; new dispute requires a new id`, {
        conflictID,
      });
    }
    const conflict = this.buildConflictCandidate(run, stage, window, input, conflictID, this.now());
    this.verificationConflicts.set(conflictID, conflict);
    await this.appendEvent(run.planID, {
      type: "execution.verification_conflict_created",
      executionRunID: run.id,
      conflictID,
      windowID: window.id,
      candidateRevision: window.candidateRevision,
    });
    return { conflict, created: true };
  }

  private buildConflictCandidate(
    run: ExecutionRun,
    stage: ExecutionStage,
    window: VerificationWindow,
    input: CreateVerificationConflictInput,
    conflictID: VerificationConflictID,
    createdAt: Timestamp,
  ): VerificationConflict {
    return {
      id: conflictID,
      executionRunID: run.id,
      stageID: stage.id,
      windowID: window.id,
      candidateRevision: window.candidateRevision,
      evidenceA: structuredClone(input.evidenceA),
      evidenceB: structuredClone(input.evidenceB),
      claimA: input.claimA,
      claimB: input.claimB,
      resolutionQuestion: input.resolutionQuestion,
      status: "open",
      createdAt,
    };
  }

  async getAttemptReconciliation(reconciliationID: AttemptReconciliationID): Promise<AttemptReconciliation | undefined> {
    return this.attemptReconciliations.get(reconciliationID);
  }

  async listAttemptReconciliationsForRun(executionRunID: ExecutionRunID): Promise<AttemptReconciliation[]> {
    return [...this.attemptReconciliations.values()].filter((reconciliation) => reconciliation.executionRunID === executionRunID);
  }

  /**
   * §50 — durable resolution of the COMPLETE unresolved indeterminate set via
   * a reconciliation inspection's evidence. `unchanged` records base =
   * resulting = N (no candidate advance); `changed` advances the window's
   * candidateRevision N → N+1 EXACTLY ONCE inside this transaction (§52). An
   * `unresolved` observation persists NOTHING (reconciliation_inconclusive) —
   * the Worker Report is retained and the Supervisor may issue a new
   * reconciliation inspection (§35-style bounded retry, no automation).
   */
  async recordAttemptReconciliation(input: RecordAttemptReconciliationInput): Promise<{ reconciliation?: AttemptReconciliation; created: boolean; window: VerificationWindow }> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError("invalid_execution_lifecycle", `Reconciliation requires an active ExecutionRun (run is ${run.lifecycle})`, {
        executionRunID: run.id,
        lifecycle: run.lifecycle,
      });
    }
    const stage = this.executionStages.get(input.stageID);
    const window = this.verificationWindows.get(input.windowID);
    if (!stage || stage.executionRunID !== run.id || run.activeStage !== stage.id || stage.status !== "active") {
      throw new UltraPlanError("invalid_scope", `Reconciliation can only be recorded against the run's active Stage (${input.stageID})`, {
        executionRunID: run.id,
        stageID: input.stageID,
      });
    }
    if (!window || window.executionRunID !== run.id || run.openWindow !== window.id || window.stageID !== stage.id || window.state !== "open") {
      throw new UltraPlanError("invalid_scope", `Reconciliation can only be recorded against the run's open Window (${input.windowID})`, {
        executionRunID: run.id,
        windowID: input.windowID,
      });
    }
    // §56 idempotency FIRST — same id + same semantic content returns the
    // existing record WITHOUT re-advancing the candidate (a changed-reconciliation
    // retry must never produce N → N+2).
    const reconciliationID =
      input.reconciliationID ??
      AttemptReconciliationIDs.from(nextSequence([...this.attemptReconciliations.keys()], AttemptReconciliationIDs.prefix));
    const existing = this.attemptReconciliations.get(reconciliationID);
    if (existing) {
      const sameContent =
        existing.executionRunID === run.id &&
        existing.stageID === stage.id &&
        existing.windowID === window.id &&
        existing.inspectionDirectiveRef.id === input.inspectionDirective.id &&
        existing.inspectionDirectiveRef.revision === input.inspectionDirective.revision &&
        existing.targetAttemptIDs.length === input.targetAttemptIDs.length &&
        [...existing.targetAttemptIDs].sort().join("|") === [...input.targetAttemptIDs].sort().join("|");
      if (sameContent) {
        return { reconciliation: existing, created: false, window };
      }
      throw new UltraPlanError("reconciliation_conflict", `AttemptReconciliation ${reconciliationID} already exists with DIFFERENT content; new reconciliation requires a new id`, {
        reconciliationID,
      });
    }
    // §43 with the Phase 7A §7 correction — the targets MUST be the complete
    // canonical SIDE-EFFECTING unresolved set (a non-mutating interrupted
    // Attempt is never a reconciliation target).
    const unresolved = await this.unresolvedSideEffectingAttempts(run.id, window.id);
    const unresolvedIDs = unresolved.map((attempt) => attempt.id).sort();
    const requested = [...input.targetAttemptIDs].sort();
    if (unresolvedIDs.join("|") !== requested.join("|")) {
      const reconciled = new Set(
        [...this.attemptReconciliations.values()].flatMap((reconciliation) => reconciliation.targetAttemptIDs.map((target) => target as string)),
      );
      if (requested.length > 0 && requested.every((target) => reconciled.has(target))) {
        throw new UltraPlanError("attempt_already_reconciled", `Every target Attempt is already covered by a successful AttemptReconciliation`, {
          targetAttemptIDs: input.targetAttemptIDs,
        });
      }
      throw new UltraPlanError(
        "invalid_scope",
        `Reconciliation targets must equal the COMPLETE canonical side-effecting unresolved set (canonical: ${unresolvedIDs.join(", ") || "empty"}; requested: ${requested.join(", ") || "empty"})`,
        { targetAttemptIDs: input.targetAttemptIDs },
      );
    }
    // §50 — the inspection must be a real reconciliation inspection of this window.
    const directive = this.executionDirectives.get(`${input.inspectionDirective.id}@${input.inspectionDirective.revision}`);
    if (!directive || directive.executionRunID !== run.id || directive.windowID !== window.id) {
      throw new UltraPlanError("execution_directive_not_found", `Inspection Directive ${input.inspectionDirective.id}@${input.inspectionDirective.revision} does not resolve in Window ${window.id}`, {
        directive: `${input.inspectionDirective.id}@${input.inspectionDirective.revision}`,
      });
    }
    if (directive.reconciliationTargets === undefined) {
      throw new UltraPlanError("invalid_scope", `Directive ${directive.id}@${directive.revision} is not a reconciliation inspection (no reconciliationTargets)`, {});
    }
    if (directive.kind !== "inspection" || directive.candidateEffect !== "non_mutating") {
      throw new UltraPlanError("invalid_scope", "A reconciliation inspection must be an inspection-kind, non-mutating Directive", {});
    }
    assertReconciliationCapabilityConstraints(directive.capabilityEnvelope);
    const attemptID = this.executionAttemptByDirective.get(executionAttemptIndexKey(run.id, directive.id, directive.revision));
    const attempt = attemptID !== undefined ? this.executionAttempts.get(attemptID) : undefined;
    if (!attempt || attempt.state !== "reported") {
      throw new UltraPlanError("invalid_scope", `The reconciliation inspection has no reported Attempt yet`, { directive: `${directive.id}@${directive.revision}` });
    }
    let report: ExecutionReport | undefined;
    for (const candidate of this.executionReports.values()) {
      if (candidate.attemptID === attempt.id) {
        report = candidate;
        break;
      }
    }
    if (!report) {
      throw new UltraPlanError("invalid_scope", `The reconciliation inspection Attempt ${attempt.id} has no Report`, { attemptID: attempt.id });
    }
    if (report.result !== "completed") {
      throw new UltraPlanError("invalid_scope", `Reconciliation requires a completed inspection Report (Report ${report.id} is ${report.result})`, { reportID: report.id });
    }
    // §48 — a mutating reconciliation Worker cannot resolve prior uncertainty.
    if (report.candidateMutation !== "none") {
      throw new UltraPlanError("invalid_scope", `Reconciliation Report ${report.id} mutated the candidate; it cannot resolve uncertainty (issue a new reconciliation inspection)`, {
        reportID: report.id,
      });
    }
    const observation = report.reconciliationObservation;
    if (observation === undefined) {
      throw new UltraPlanError("invalid_scope", `Reconciliation Report ${report.id} carries no reconciliationObservation`, { reportID: report.id });
    }
    if (observation === "unresolved") {
      // §50 — inconclusive: NO record, NO coverage; the Report stays durable.
      throw new UltraPlanError("reconciliation_inconclusive", `Reconciliation Report ${report.id} could not establish repository reality (observation=unresolved); issue a new reconciliation inspection`, {
        reportID: report.id,
      });
    }
    if (report.baseCandidateRevision !== window.candidateRevision) {
      throw new UltraPlanError(
        "stale_candidate_revision",
        `Reconciliation Report ${report.id} binds baseCandidateRevision ${report.baseCandidateRevision}, but the window is at ${window.candidateRevision}`,
        { windowID: window.id },
      );
    }
    const now = this.now();
    const reconciliation: AttemptReconciliation = {
      id: reconciliationID,
      executionRunID: run.id,
      stageID: stage.id,
      windowID: window.id,
      targetAttemptIDs: [...input.targetAttemptIDs],
      inspectionDirectiveRef: { id: directive.id, revision: directive.revision, hash: directive.hash },
      inspectionAttemptID: attempt.id,
      inspectionReportID: report.id,
      observation: observation as SuccessfulReconciliationObservation,
      baseCandidateRevision: window.candidateRevision,
      resultingCandidateRevision: observation === "changed" ? window.candidateRevision + 1 : window.candidateRevision,
      createdAt: now,
    };
    // §51/§52 — ONE transaction: record + (changed only) exactly one candidate advance.
    const updatedWindow: VerificationWindow =
      observation === "changed"
        ? { ...window, candidateRevision: window.candidateRevision + 1, revision: window.revision + 1, updatedAt: now }
        : window;
    this.attemptReconciliations.set(reconciliationID, reconciliation);
    for (const target of input.targetAttemptIDs) {
      this.reconciliationByAttempt.set(target, reconciliationID);
    }
    if (observation === "changed") {
      this.verificationWindows.set(window.id, updatedWindow);
    }
    await this.appendEvent(run.planID, {
      type: "execution.attempt_reconciled",
      executionRunID: run.id,
      reconciliationID,
      windowID: window.id,
      observation,
      from: reconciliation.baseCandidateRevision,
      to: reconciliation.resultingCandidateRevision,
    });
    return { reconciliation, created: true, window: updatedWindow };
  }

  // -------------------------------------------------------------------------
  // Phase 6B — final closure & the ExecutionCompletionGate. The normal
  // success path's last loop: ONE final_closure Stage reusing the frozen
  // Stage→Window→Directive→Attempt→Report→Assessment→Commit chain, then a
  // SEPARATE gated completion transaction (never auto-complete at Commit
  // time). No second Commit/Attempt/Report type exists anywhere here.
  // -------------------------------------------------------------------------

  /** The run's (at most one) final_closure Stage, any status. */
  private findFinalClosureStage(executionRunID: ExecutionRunID): ExecutionStage | undefined {
    return [...this.executionStages.values()].find(
      (stage) => stage.executionRunID === executionRunID && executionStageKindOf(stage) === "final_closure",
    );
  }

  /** The Commit that completed the final closure Stage (unique per Phase 5 closure invariants). */
  private findFinalClosureCommit(finalClosureStageID: ExecutionStageID): ExecutionCommit | undefined {
    return [...this.executionCommits.values()].find(
      (commit) => commit.stageID === finalClosureStageID && commit.stageCompleted === true,
    );
  }

  /** The ordinary, non-superseded Stages of a run — the readiness population (§8). */
  private ordinaryStagesForRun(executionRunID: ExecutionRunID): ExecutionStage[] {
    return [...this.executionStages.values()].filter(
      (stage) => stage.executionRunID === executionRunID && executionStageKindOf(stage) === "ordinary" && stage.status !== "superseded",
    );
  }

  private readinessInput(executionRunID: ExecutionRunID): Parameters<typeof isExecutionReadyForFinalClosure>[0] {
    const run = this.requireExecutionRun(executionRunID);
    const attempts = [...this.executionAttempts.values()].filter((attempt) => attempt.executionRunID === executionRunID);
    return {
      run,
      stagesForRun: [...this.executionStages.values()].filter((stage) => stage.executionRunID === executionRunID),
      hasRunningAttempt: attempts.some((attempt) => attempt.state === "running"),
      // Phase 7A §6 — only unresolved SIDE-EFFECTING indeterminate work blocks
      // final-closure readiness; a non-mutating interruption is inert history.
      unresolvedIndeterminateAttempts: attempts.filter(
        (attempt) =>
          attempt.state === "indeterminate" &&
          attempt.candidateEffect === "may_mutate" &&
          !this.reconciliationByAttempt.has(attempt.id),
      ).length,
    };
  }

  async isExecutionReadyForFinalClosure(executionRunID: ExecutionRunID): Promise<boolean> {
    return isExecutionReadyForFinalClosure(this.readinessInput(executionRunID));
  }

  /**
   * §12 — prepare the ONE final_closure Stage. Gates: current Supervisor
   * fencing, active run, full final-closure readiness (§8), no existing
   * final_closure Stage (idempotent same-request retry, §7), explicit
   * non-empty obligations with exact FinalPlan refs covering the plan and all
   * hard Constraints (§14-§16). Dependencies are DERIVED: every ordinary
   * non-superseded completed Stage (§13) — the Supervisor cannot miss one.
   * The Stage is created pending; activation is a separate, deliberate step.
   */
  async prepareFinalClosureStage(input: PrepareFinalClosureStageInput): Promise<{ stage: ExecutionStage; created: boolean }> {
    const run = this.requireExecutionRun(input.executionRunID);
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError("invalid_execution_lifecycle", `Final closure preparation requires an active ExecutionRun (run is ${run.lifecycle})`, {
        executionRunID: run.id,
        lifecycle: run.lifecycle,
      });
    }
    if (run.revision !== input.expectedRunRevision) {
      throw new UltraPlanError(
        "stale_execution_run",
        `ExecutionRun ${run.id} is at revision ${run.revision}, not the expected ${input.expectedRunRevision}; re-read and retry`,
        { executionRunID: run.id, revision: run.revision, expected: input.expectedRunRevision },
      );
    }
    // §7 — uniqueness with idempotent same-request retry. This check comes
    // BEFORE readiness so a crash-safe retry that arrives after the closure
    // Stage was already activated (run.activeStage set) replays the existing
    // Stage instead of failing on the now-busy run.
    const existing = this.findFinalClosureStage(run.id);
    if (existing) {
      const ordinary = this.ordinaryStagesForRun(run.id);
      const sameRequest =
        existing.title === input.title &&
        existing.objective === input.objective &&
        existing.dependsOn.length === ordinary.length &&
        (existing.completionObligations ?? []).length === input.completionObligations.length &&
        (existing.completionObligations ?? []).every((obligation, index) => {
          const draft = input.completionObligations[index]!;
          return obligation.description === draft.description && JSON.stringify(obligation.planRefs) === JSON.stringify(draft.planRefs ?? []);
        });
      if (sameRequest) {
        return { stage: existing, created: false };
      }
      throw new UltraPlanError(
        "final_closure_already_exists",
        `ExecutionRun ${run.id} already has its final_closure Stage (${existing.id}); closure Stages are never superseded or duplicated (§11)`,
        { executionRunID: run.id, stageID: existing.id },
      );
    }
    // §8 — deterministic readiness, with the exact violation in the error.
    const violation = finalClosureReadinessViolation(this.readinessInput(run.id));
    if (violation !== undefined) {
      throw new UltraPlanError("final_closure_not_ready", `ExecutionRun ${run.id} is not ready for final closure: ${violation}`, {
        executionRunID: run.id,
        violation,
      });
    }
    // §14 — explicit, non-empty obligations.
    if (!Array.isArray(input.completionObligations) || input.completionObligations.length === 0) {
      throw new UltraPlanError("invalid_final_closure_obligations", "The final closure Stage requires EXPLICIT, non-empty completion obligations", {
        executionRunID: run.id,
      });
    }
    const finalPlan = this.getFinalPlanSync(run.planID, run.finalPlan);
    if (!finalPlan || finalPlan.hash !== run.finalPlanHash) {
      throw new UltraPlanError("final_plan_binding_mismatch", `ExecutionRun ${run.id} FinalPlan binding no longer resolves with the bound hash`, {
        executionRunID: run.id,
      });
    }
    // §15 — the obligation set must reference the exact FinalPlan and cover
    // every hard Constraint (the ExecutionPlanRef vocabulary can express
    // both), plus whatever Sections/Decisions/steps the Supervisor adds.
    const flattenedRefs = input.completionObligations.flatMap((obligation) => obligation.planRefs ?? []);
    validateExecutionPlanRefs(flattenedRefs, finalPlan);
    const refKeys = new Set(
      flattenedRefs.map((ref) => (ref.kind === "implementation_step" ? `step:${ref.order}` : `${ref.kind}:${"id" in ref ? ref.id : ""}`)),
    );
    if (!flattenedRefs.some((ref) => ref.kind === "final_plan" && ref.id === finalPlan.id && ref.revision === finalPlan.revision)) {
      throw new UltraPlanError("invalid_final_closure_obligations", "The final closure obligation set must reference the exact bound FinalPlan ref", {
        executionRunID: run.id,
      });
    }
    const missingConstraints = finalPlan.constraints.filter((constraint) => !refKeys.has(`constraint:${constraint.id as string}`));
    if (missingConstraints.length > 0) {
      throw new UltraPlanError(
        "invalid_final_closure_obligations",
        `The final closure obligation set must cover every hard Constraint of the FinalPlan; missing: ${missingConstraints.map((constraint) => constraint.id as string).join(", ")}`,
        { executionRunID: run.id, missing: missingConstraints.map((constraint) => constraint.id as string) },
      );
    }
    for (const obligation of input.completionObligations) {
      if (typeof obligation.description !== "string" || obligation.description.trim().length === 0) {
        throw new UltraPlanError("invalid_final_closure_obligations", "Every final closure obligation requires a non-empty description", {
          executionRunID: run.id,
        });
      }
    }
    // §13 — dependencies are Core-derived: ALL ordinary non-superseded completed Stages.
    const dependsOn = this.ordinaryStagesForRun(run.id).map((stage) => stage.id);
    const id = input.stageID ?? ExecutionStageIDs.from(nextSequence([...this.executionStages.keys()], ExecutionStageIDs.prefix));
    const knownObligationIDs = [
      ...new Set(
        [...this.executionStages.values()].flatMap((stage) => stageCompletionObligations(stage).map((obligation) => obligation.id as string)),
      ),
    ];
    const assignedObligationIDs = new Set<string>();
    const completionObligations = input.completionObligations.map((obligation) => {
      const obligationID = StageCompletionObligationIDs.from(nextSequence([...knownObligationIDs, ...assignedObligationIDs], StageCompletionObligationIDs.prefix));
      assignedObligationIDs.add(obligationID as string);
      return {
        id: obligationID,
        description: obligation.description,
        planRefs: (obligation.planRefs ?? []).map((ref) => ({ ...ref })) as ExecutionPlanRef[],
      };
    });
    const now = this.now();
    const stage: ExecutionStage = {
      id,
      executionRunID: run.id,
      title: input.title,
      objective: input.objective,
      kind: "final_closure",
      status: "pending",
      planRefs: [{ kind: "final_plan", id: finalPlan.id, revision: finalPlan.revision }],
      dependsOn,
      completionObligations,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.executionStages.set(id, stage);
    await this.appendEvent(run.planID, {
      type: "execution.final_closure_prepared",
      executionRunID: run.id,
      stageID: id,
      dependsOn,
      obligations: completionObligations.length,
    });
    return { stage, created: true };
  }

  /**
   * §33-§47 — THE ExecutionCompletionGate: the ONLY active → completed path.
   * Structural revalidation of the final closure provenance (never a
   * verifier/semantic re-run, §37), then ONE durable transaction persisting
   * the ExecutionCompletionRecord + the terminal lifecycle transition (§44).
   */
  async completeExecutionRunThroughGate(input: CompleteExecutionRunThroughGateInput): Promise<{ record: ExecutionCompletionRecord; run: ExecutionRun; created: boolean }> {
    const run = this.requireExecutionRun(input.executionRunID);
    this.assertTrustedSupervisorIdentity(input.sessionID, input.workspace);
    if (!workspaceIdentityEquals(run.workspace, input.workspace)) {
      throw new UltraPlanError("workspace_mismatch", `ExecutionRun ${run.id} is bound to workspace ${JSON.stringify(run.workspace)}, not the caller's ${JSON.stringify(input.workspace)}`, {
        executionRunID: run.id,
      });
    }
    // §47/§48 idempotency BEFORE the authority gate: the crash-safe retry
    // arrives after the run terminalized (a completed run refuses supervision
    // authority by the frozen Phase 2 check).
    const completionID =
      input.completionID ??
      ExecutionCompletionIDs.from(nextSequence([...this.executionCompletions.keys()], ExecutionCompletionIDs.prefix));
    const existingRecord = this.executionCompletions.get(completionID);
    if (existingRecord) {
      if (existingRecord.executionRunID !== run.id) {
        throw new UltraPlanError("execution_completion_conflict", `Completion ${completionID} belongs to ExecutionRun ${existingRecord.executionRunID}`, {
          completionID,
        });
      }
      if (input.expectedFinalCommitID !== undefined && input.expectedFinalCommitID !== existingRecord.finalCommitID) {
        throw new UltraPlanError("execution_completion_conflict", `Completion ${completionID} is bound to final commit ${existingRecord.finalCommitID}, not ${String(input.expectedFinalCommitID)}`, {
          completionID,
        });
      }
      const completedRun = this.requireExecutionRun(existingRecord.executionRunID);
      return { record: existingRecord, run: completedRun, created: false };
    }
    // §32/§62 — completion only from an ACTIVE run; an already-completed run
    // without the presented record id is `execution_already_completed`. This
    // check precedes the authority gate (the frozen Phase 2 authority check
    // refuses terminal runs outright).
    if (run.lifecycle === "completed") {
      throw new UltraPlanError("execution_already_completed", `ExecutionRun ${run.id} is already completed (completion provenance: ${run.completionRecord ?? "legacy"})`, {
        executionRunID: run.id,
      });
    }
    await this.authorizeExecutionSupervisor(input.executionRunID, {
      sessionID: input.sessionID,
      workspace: input.workspace,
      generation: input.generation,
    });
    if (run.lifecycle !== "active") {
      throw new UltraPlanError("invalid_execution_lifecycle", `The ExecutionCompletionGate requires an active ExecutionRun (run is ${run.lifecycle})`, {
        executionRunID: run.id,
        lifecycle: run.lifecycle,
      });
    }
    // §33 — exact FinalPlan binding intact.
    const finalPlan = this.getFinalPlanSync(run.planID, run.finalPlan);
    if (!finalPlan || finalPlan.hash !== run.finalPlanHash) {
      throw new UltraPlanError("final_plan_binding_mismatch", `ExecutionRun ${run.id} FinalPlan binding no longer resolves with the bound hash`, {
        executionRunID: run.id,
      });
    }
    // §33 — no ExecutionIssue (replan/completion mutual exclusivity, §103).
    if (this.issueByExecutionRun.has(run.id)) {
      throw new UltraPlanError("execution_completion_not_ready", `ExecutionRun ${run.id} carries an ExecutionIssue; replan and completion are mutually exclusive`, {
        executionRunID: run.id,
      });
    }
    // §33/§40/§41 — idle run.
    if (run.activeStage !== undefined || run.openWindow !== undefined) {
      throw new UltraPlanError("execution_completion_not_ready", `ExecutionRun ${run.id} still carries active execution structure (activeStage=${run.activeStage ?? "none"}, openWindow=${run.openWindow ?? "none"})`, {
        executionRunID: run.id,
      });
    }
    const attempts = [...this.executionAttempts.values()].filter((attempt) => attempt.executionRunID === run.id);
    const running = attempts.find((attempt) => attempt.state === "running");
    if (running) {
      throw new UltraPlanError("active_attempt_conflict", `ExecutionRun ${run.id} has a running Attempt (${running.id})`, { executionRunID: run.id, attemptID: running.id });
    }
    // §43 with the Phase 7A §6 correction — the canonical unresolved
    // SIDE-EFFECTING indeterminate set must be empty (a non-mutating
    // interruption never blocks completion).
    const unresolvedIndeterminate = attempts.filter(
      (attempt) =>
        attempt.state === "indeterminate" &&
        attempt.candidateEffect === "may_mutate" &&
        !this.reconciliationByAttempt.has(attempt.id),
    );
    if (unresolvedIndeterminate.length > 0) {
      throw new UltraPlanError(
        "reconciliation_required",
        `ExecutionRun ${run.id} carries unresolved side-effecting indeterminate Attempt(s) ${unresolvedIndeterminate.map((attempt) => attempt.id).join(", ")}`,
        { executionRunID: run.id, unresolved: unresolvedIndeterminate.map((attempt) => attempt.id) },
      );
    }
    // §34 — every ordinary non-superseded Stage is completed.
    const ordinary = this.ordinaryStagesForRun(run.id);
    const uncompletedOrdinary = ordinary.filter((stage) => stage.status !== "completed");
    if (uncompletedOrdinary.length > 0) {
      throw new UltraPlanError(
        "execution_completion_not_ready",
        `ExecutionRun ${run.id} has uncompleted ordinary Stage(s): ${uncompletedOrdinary.map((stage) => `${stage.id} (${stage.status})`).join(", ")}`,
        { executionRunID: run.id },
      );
    }
    // §35 — exactly one final_closure Stage, completed, obligations explicit.
    const finalClosure = this.findFinalClosureStage(run.id);
    if (!finalClosure) {
      throw new UltraPlanError("final_closure_commit_required", `ExecutionRun ${run.id} has no final_closure Stage; completion requires the final integration closure`, {
        executionRunID: run.id,
      });
    }
    if (finalClosure.status !== "completed") {
      throw new UltraPlanError("execution_completion_not_ready", `The final_closure Stage ${finalClosure.id} is ${finalClosure.status}, not completed`, {
        executionRunID: run.id,
        stageID: finalClosure.id,
      });
    }
    if (!stageHasExplicitCompletionObligations(finalClosure)) {
      throw new UltraPlanError("execution_completion_provenance_invalid", `The final_closure Stage ${finalClosure.id} carries no explicit completion obligations`, {
        stageID: finalClosure.id,
      });
    }
    // §35 — its dependencies still resolve to ALL ordinary completed Stages.
    const expectedDeps = ordinary.map((stage) => stage.id).sort();
    if (JSON.stringify(expectedDeps) !== JSON.stringify([...finalClosure.dependsOn].sort())) {
      throw new UltraPlanError(
        "execution_completion_provenance_invalid",
        `The final_closure Stage dependencies no longer cover all ordinary completed Stages (expected ${expectedDeps.join(", ")}, has ${finalClosure.dependsOn.join(", ")})`,
        { stageID: finalClosure.id },
      );
    }
    // §36/§88 — the stage-completing Commit must exist AND be the accepted head.
    const finalCommit = this.findFinalClosureCommit(finalClosure.id);
    if (!finalCommit) {
      throw new UltraPlanError("final_closure_commit_required", `The final_closure Stage ${finalClosure.id} has no stage-completing ExecutionCommit`, {
        executionRunID: run.id,
        stageID: finalClosure.id,
      });
    }
    if (run.acceptedHead === undefined || run.acceptedHead !== finalCommit.id) {
      throw new UltraPlanError(
        "stale_execution_head",
        `ExecutionRun ${run.id} acceptedHead is ${run.acceptedHead ?? "absent"}, but the final closure Commit is ${finalCommit.id}; the head must BE the final closure Commit (§26/§39)`,
        { executionRunID: run.id, acceptedHead: run.acceptedHead, finalCommitID: finalCommit.id },
      );
    }
    // §36 — full provenance chain of the final commit.
    const finalWindow = this.verificationWindows.get(finalCommit.windowID);
    if (!finalWindow || finalWindow.state !== "closed" || finalWindow.stageID !== finalClosure.id) {
      throw new UltraPlanError("execution_completion_provenance_invalid", `The final closure Commit ${finalCommit.id} does not close a Window of the final_closure Stage`, {
        commitID: finalCommit.id,
      });
    }
    const finalAssessment = this.supervisorAssessments.get(finalCommit.supervisorAssessmentID);
    if (
      !finalAssessment ||
      finalAssessment.disposition !== "accept" ||
      finalAssessment.acceptanceScope !== "stage" ||
      finalAssessment.windowID !== finalWindow.id ||
      finalAssessment.candidateRevision !== finalCommit.candidateRevision
    ) {
      throw new UltraPlanError("execution_completion_provenance_invalid", `The final closure Commit ${finalCommit.id} is not backed by a stage-scope accept Assessment bound to its exact candidate`, {
        commitID: finalCommit.id,
      });
    }
    // §38 — obligations fully covered by accepted commits (never re-run semantics).
    const accepted = await this.acceptedStageObligations(run.id, finalClosure.id);
    const acceptedSet = new Set(accepted.map((ref) => ref as string));
    const missingObligations = stageCompletionObligations(finalClosure).filter((obligation) => !acceptedSet.has(obligation.id as string));
    if (missingObligations.length > 0) {
      throw new UltraPlanError(
        "execution_completion_provenance_invalid",
        `The final closure Stage ${finalClosure.id} obligation coverage is incomplete: ${missingObligations.map((obligation) => obligation.id).join(", ")}`,
        { stageID: finalClosure.id, missing: missingObligations.map((obligation) => obligation.id) },
      );
    }
    // §42 — only CURRENT-candidate unresolved conflicts block; history stays history.
    const blockingConflicts = [...this.verificationConflicts.values()].filter(
      (conflict) =>
        conflict.executionRunID === run.id &&
        (conflict.status === "open" || conflict.status === "verification_blocked") &&
        conflict.windowID === finalCommit.windowID &&
        conflict.candidateRevision === finalCommit.candidateRevision,
    );
    if (blockingConflicts.length > 0) {
      throw new UltraPlanError(
        "execution_completion_not_ready",
        `ExecutionRun ${run.id} carries unresolved conflict(s) on the final candidate: ${blockingConflicts.map((conflict) => conflict.id).join(", ")}`,
        { executionRunID: run.id },
      );
    }
    if (input.expectedFinalCommitID !== undefined && input.expectedFinalCommitID !== finalCommit.id) {
      throw new UltraPlanError("execution_completion_conflict", `The derived final commit is ${finalCommit.id}, not the caller's ${String(input.expectedFinalCommitID)}`, {
        executionRunID: run.id,
      });
    }
    // §44 — THE completion transaction: record + terminal transition + events.
    const now = this.now();
    const record: ExecutionCompletionRecord = {
      id: completionID,
      executionRunID: run.id,
      finalPlanRef: { id: run.finalPlan.id, revision: run.finalPlan.revision },
      finalClosureStageID: finalClosure.id,
      finalWindowID: finalWindow.id,
      finalCommitID: finalCommit.id,
      finalAssessmentID: finalAssessment.id,
      acceptedHead: run.acceptedHead,
      completedAt: now,
      finalCandidateRevision: finalCommit.candidateRevision,
      finalVerificationReportRefs: [...finalCommit.reportRefs],
      hash: "",
    };
    record.hash = computeExecutionCompletionHashFromRecord(record);
    const binding = this.supervisorBindings.get(run.id);
    const updated: ExecutionRun = {
      ...run,
      lifecycle: "completed",
      completionRecord: completionID,
      revision: run.revision + 1,
      updatedAt: now,
    };
    assertExecutionRunBindingUnchanged(run, updated);
    this.executionCompletions.set(completionID, record);
    this.completionByExecutionRun.set(run.id, completionID);
    this.executionRuns.set(run.id, updated);
    await this.appendEvent(run.planID, {
      type: "execution.completion_recorded",
      executionRunID: run.id,
      completionID,
      finalClosureStageID: finalClosure.id,
      finalWindowID: finalWindow.id,
      finalCommitID: finalCommit.id,
      finalAssessmentID: finalAssessment.id,
      supervisorGeneration: binding?.generation ?? 0,
    });
    await this.appendEvent(run.planID, {
      type: "execution.run_completed",
      executionRunID: run.id,
      completionID,
    });
    return { record, run: updated, created: true };
  }

  async getExecutionCompletion(completionID: ExecutionCompletionID): Promise<ExecutionCompletionRecord | undefined> {
    return this.executionCompletions.get(completionID);
  }

  async findExecutionCompletionForRun(executionRunID: ExecutionRunID): Promise<ExecutionCompletionRecord | undefined> {
    const completionID = this.completionByExecutionRun.get(executionRunID);
    return completionID === undefined ? undefined : this.executionCompletions.get(completionID);
  }

  async getExecutionIssue(issueID: ExecutionIssueID): Promise<ExecutionIssue | undefined> {
    return this.executionIssues.get(issueID);
  }

  async findExecutionIssueForRun(executionRunID: ExecutionRunID): Promise<ExecutionIssue | undefined> {
    const issueID = this.issueByExecutionRun.get(executionRunID);
    return issueID === undefined ? undefined : this.executionIssues.get(issueID);
  }

  /**
   * §15/§16/§66 — the deterministic read-only Replan Context projection for
   * one ExecutionIssue. This is NOT canonical truth (the Store records are);
   * it never mutates Plan Memory and never creates a PlanningRun.
   */
  async buildExecutionIssueReplanContext(issueID: ExecutionIssueID): Promise<ExecutionIssueReplanContext> {
    const issue = this.executionIssues.get(issueID);
    if (!issue) {
      throw new UltraPlanError("replan_context_unavailable", `ExecutionIssue ${issueID} does not resolve; no replan context exists`, { issueID });
    }
    const run = this.executionRuns.get(issue.executionRunID);
    if (!run) {
      throw new UltraPlanError("replan_context_unavailable", `ExecutionIssue ${issueID} references missing ExecutionRun ${issue.executionRunID}`, { issueID });
    }
    const sourceAssessment = this.supervisorAssessments.get(issue.sourceAssessmentID);
    if (!sourceAssessment) {
      throw new UltraPlanError("replan_context_unavailable", `ExecutionIssue ${issueID} references missing source assessment ${issue.sourceAssessmentID}`, { issueID });
    }
    const acceptedCommits = this.acceptedCommitChain(run.id)
      .map((commitID) => this.executionCommits.get(commitID))
      .filter((commit): commit is ExecutionCommit => commit !== undefined);
    const relevantReports = issue.reportRefs
      .map((reportID) => this.executionReports.get(reportID))
      .filter((report): report is ExecutionReport => report !== undefined);
    const conflicts = issue.verificationConflictRefs
      .map((conflictID) => this.verificationConflicts.get(conflictID))
      .filter((conflict): conflict is VerificationConflict => conflict !== undefined);
    const indeterminate = issue.unresolvedIndeterminateAttemptRefs
      .map((attemptID) => this.executionAttempts.get(attemptID))
      .filter((attempt): attempt is ExecutionAttempt => attempt !== undefined);
    const reconciliations = [...this.attemptReconciliations.values()].filter(
      (reconciliation) =>
        reconciliation.executionRunID === run.id &&
        reconciliation.targetAttemptIDs.some((target) => issue.unresolvedIndeterminateAttemptRefs.includes(target)),
    );
    return {
      issue: structuredClone(issue),
      finalPlan: { id: run.finalPlan.id, revision: run.finalPlan.revision, hash: run.finalPlanHash },
      sourceAssessment: structuredClone(sourceAssessment),
      affectedPlanRefs: issue.affectedPlanRefs.map((ref) => ({ ...ref })) as ExecutionPlanRef[],
      acceptedCommits,
      candidateContext: {
        ...(issue.activeStageID !== undefined ? { activeStageID: issue.activeStageID } : {}),
        ...(issue.openWindowID !== undefined ? { openWindowID: issue.openWindowID } : {}),
        ...(issue.candidateRevision !== undefined ? { candidateRevision: issue.candidateRevision } : {}),
      },
      relevantReports,
      verificationConflicts: conflicts,
      unresolvedIndeterminateAttempts: indeterminate,
      reconciliations,
    };
  }



  /** Existence guard shared by the binding operations. */
  private requireExecutionRun(executionRunID: ExecutionRunID): ExecutionRun {
    const run = this.executionRuns.get(executionRunID);
    if (!run) {
      throw new UltraPlanError("execution_run_not_found", `ExecutionRun ${executionRunID} does not exist`, { executionRunID });
    }
    return run;
  }

  /** Trusted-identity shape checks (host-supplied values; never model payload). */
  private assertTrustedSupervisorIdentity(sessionID: string, workspace: WorkspaceIdentity): void {
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      throw new UltraPlanError("supervisor_session_mismatch", "Supervisor operations require a non-empty trusted session identity", {});
    }
    if (typeof workspace?.key !== "string" || workspace.key.length === 0) {
      throw new UltraPlanError("workspace_mismatch", "Supervisor operations require a non-empty WorkspaceIdentity", {});
    }
  }

  /** Workspace + generation + owner fencing for an existing binding (same order as the Core authority check). */
  private assertBindingFenced(
    binding: SupervisorBinding,
    sessionID: string,
    workspace: WorkspaceIdentity,
    generation: number,
  ): void {
    if (stableStringify(binding.workspace) !== stableStringify(workspace)) {
      throw new UltraPlanError(
        "workspace_mismatch",
        `SupervisorBinding for ${binding.executionRunID} is bound to workspace ${JSON.stringify(binding.workspace)}, not the caller's ${JSON.stringify(workspace)}`,
        { executionRunID: binding.executionRunID },
      );
    }
    if (binding.generation !== generation) {
      throw new UltraPlanError(
        "stale_supervisor_binding",
        `SupervisorBinding for ${binding.executionRunID} is at generation ${binding.generation}; the presented generation ${generation} is fenced out`,
        { executionRunID: binding.executionRunID, currentGeneration: binding.generation, presentedGeneration: generation },
      );
    }
    if (binding.ownerSessionID !== sessionID) {
      throw new UltraPlanError(
        "supervisor_session_mismatch",
        `SupervisorBinding for ${binding.executionRunID} is owned by another session; the current session holds no authority over it`,
        { executionRunID: binding.executionRunID },
      );
    }
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
        // R1a §10-§14: blocker-driven reasons run in synthesis or detail and
        // bind exact, currently-open, currently-blocking blockers whose
        // remediation target is THIS section.
        if (change.reason.type === "blocking_question") {
          if (run.stage !== "synthesis" && run.stage !== "detail") {
            addFailure(
              "reopen_stage_invalid",
              `A blocker-driven reopen requires stage=synthesis or detail (run is in ${run.stage})`,
              { stage: run.stage },
            );
          }
          const blockerReason = change.reason;
          const question = run.openQuestions.find((q) => q.id === blockerReason.questionID);
          if (!question) {
            addFailure("unknown_reference", `Question ${blockerReason.questionID} does not exist in run ${run.id}`);
          } else if (question.status !== "open" || !question.blocking) {
            addFailure(
              "reopen_reason_invalid",
              `A blocker-driven reopen requires an OPEN, BLOCKING question (${question.id} is ${question.status}/${question.blocking ? "blocking" : "non-blocking"})`,
              { questionID: question.id },
            );
          } else if ("revision" in question.scope || question.scope.id !== change.target.id) {
            addFailure(
              "reopen_target_unsupported",
              `Question ${question.id} is not scoped to ${change.target.id}; the reopen target must be the blocker's own remediation target`,
              { questionID: question.id, sectionID: change.target.id },
            );
          }
        }
        if (change.reason.type === "blocking_conflict") {
          if (run.stage !== "synthesis" && run.stage !== "detail") {
            addFailure(
              "reopen_stage_invalid",
              `A blocker-driven reopen requires stage=synthesis or detail (run is in ${run.stage})`,
              { stage: run.stage },
            );
          }
          if (change.reason.conflictIDs.length === 0) {
            addFailure(
              "reopen_reason_invalid",
              "A blocking_conflict reopen must bind at least one conflictID",
              { sectionID: change.target.id },
            );
          }
          for (const conflictID of change.reason.conflictIDs) {
            const conflict = run.conflicts.find((c) => c.id === conflictID);
            if (!conflict) {
              addFailure("unknown_reference", `Conflict ${conflictID} does not exist in run ${run.id}`);
              continue;
            }
            if (conflict.status !== "open" || conflict.severity !== "blocking") {
              addFailure(
                "reopen_reason_invalid",
                `A blocker-driven reopen requires an OPEN, BLOCKING conflict (${conflict.id} is ${conflict.status}/${conflict.severity})`,
                { conflictID: conflict.id },
              );
              continue;
            }
            const identifiesTarget =
              conflict.refs.some((ref) => ref.kind === "section" && ref.id === change.target.id) ||
              conflict.refs.some((ref) => {
                if (ref.kind !== "decision") return false;
                const decision = this.decisions.get(run.id)?.latest.get(ref.id);
                return decision?.scope.sections?.includes(change.target.id) ?? false;
              });
            if (!identifiesTarget) {
              addFailure(
                "reopen_target_unsupported",
                `Conflict ${conflict.id} does not identify ${change.target.id} as its remediation target`,
                { conflictID: conflict.id, sectionID: change.target.id },
              );
            }
          }
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

    // R1b §19-§20: reopen_architecture boundary — amendment proposals only,
    // scoped to the exact target ArchitectureRef, with the same report
    // revalidation the section reopen applies (registry-backed here, so it
    // also holds for hostile direct engine calls).
    const hasArchReopen = proposal.changes.some((c) => c.kind === "reopen_architecture");
    if (hasArchReopen) {
      if (proposal.type !== "amendment") {
        addFailure(
          "reopen_type_invalid",
          `reopen_architecture is only valid inside an amendment proposal (got ${proposal.type})`,
          { proposalID: proposal.id, type: proposal.type },
        );
      }
      if (run.stage !== "synthesis" && run.stage !== "detail") {
        addFailure(
          "reopen_stage_invalid",
          `An Architecture reopen runs in synthesis or detail (run is in ${run.stage})`,
          { stage: run.stage },
        );
      }
      for (const change of proposal.changes) {
        if (change.kind !== "reopen_architecture" || change.reason.type !== "semantic_validation") continue;
        const report = this.validationReports.get(run.id)?.get(change.reason.reportID);
        if (!report) {
          addFailure("unknown_reference", `ValidationReport ${change.reason.reportID} does not exist in run ${run.id}`);
          continue;
        }
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
        if (selectedIDs.length === 0 || selectedIDs.some((findingID) => !knownFindings.has(findingID))) {
          addFailure(
            "reopen_reason_invalid",
            `The reopen cites findings that do not exist in ${report.id}`,
            { reportID: report.id },
          );
          continue;
        }
        const affectsArchitecture = report.findings.some(
          (finding) =>
            selectedIDs.includes(finding.id) && finding.scope.architecture?.revision === change.target.revision,
        );
        if (!affectsArchitecture) {
          addFailure(
            "reopen_target_unsupported",
            `No selected finding of ${report.id} is scoped to ARCH@${change.target.revision}`,
            { reportID: report.id, revision: change.target.revision },
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

    // R1a §4-§7 conflict-resolution boundary: `resolve_conflict` rides ONLY
    // design_checkpoint/amendment proposals in the stages where
    // prepare_proposal exists (architecture/detail). The commit re-checks
    // everything the freeze validated — the conflict exists and is open, and
    // the remediation binding witnesses the staged result — so hostile direct
    // engine calls fail closed exactly like the controller path.
    const hasResolveConflict = proposal.changes.some((c) => c.kind === "resolve_conflict");
    if (hasResolveConflict) {
      if (proposal.type !== "design_checkpoint" && proposal.type !== "amendment") {
        addFailure(
          "conflict_resolution_invalid",
          `resolve_conflict is only valid inside design_checkpoint or amendment proposals (got ${proposal.type})`,
          { proposalID: proposal.id, type: proposal.type },
        );
      }
      if (run.stage !== "architecture" && run.stage !== "detail") {
        addFailure(
          "conflict_resolution_invalid",
          `Conflict resolution requires stage=architecture or detail (run is in ${run.stage}); synthesis blockers are remediated through the sanctioned reopen → detail loop`,
          { stage: run.stage },
        );
      }
      for (const change of proposal.changes) {
        if (change.kind !== "resolve_conflict") continue;
        const conflict = run.conflicts.find((c) => c.id === change.conflictID);
        if (!conflict) {
          addFailure("unknown_reference", `Conflict ${change.conflictID} does not exist in run ${run.id}`);
          continue;
        }
        if (conflict.status !== "open") {
          addFailure(
            "conflict_resolution_invalid",
            `Conflict ${change.conflictID} is already resolved; resolutions are immutable historical state`,
            { conflictID: change.conflictID },
          );
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
      conflicts: run.conflicts.map((c) => ({ ...c, ...(c.resolution ? { resolution: { ...c.resolution } } : {}) })),
      resolvedConflicts: [],
      stage: run.stage,
      lifecycle: run.lifecycle,
      runArchitecture: run.architecture,
      runSections: run.sections.map((ref) => ({ id: ref.id })),
      runDecisions: [...run.decisions],
      runFinalPlan: run.finalPlan,
      handoffProtocol: run.handoffProtocol,
      sectionDecompositionArchitecture: run.sectionDecompositionArchitecture,
      provenanceTouched: false,
      sectionsStartedEmpty: run.sections.length === 0,
      activeWork: run.activeWork,
      addedSections: [],
      addedFinalPlans: [],
      committedChanges: [],
      revised: [],
      resolvedQuestions: [],
    };

    for (const change of proposal.changes) {
      this.stageChange(staged, change, addFailure, approval, proposal);
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
        // Phase 7B §6/§8 — the Final Approval transaction ATOMICALLY determines
        // the handoff protocol: every new handoff_pending run durably records
        // supervised_v0_2 here, so the legal crash window "committed +
        // handoff_pending but ExecutionRun not yet prepared" still resolves to
        // the supervised recovery path. Never inferred from artifacts (§5).
        staged.handoffProtocol = "supervised_v0_2";
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
    //
    // R1a §7 — the CONFLICT SELF-BLOCK EXCEPTION. The gate must never reject
    // the exact transaction authorized to remediate a conflict. Exempt = the
    // conflicts explicitly named by sanctioned remediation changes in THIS
    // exact Proposal: `resolve_conflict(C)` (which already staged C to
    // `resolved` above), plus the conflictIDs bound by blocker-driven
    // reopen reasons. No generic ignore/force flag exists; UNRELATED blocking
    // conflicts still block the transaction exactly as before.
    const remediatedConflictIDs = new Set<ConflictID>([
      ...proposal.changes.flatMap((c) => (c.kind === "resolve_conflict" ? [c.conflictID] : [])),
      ...proposal.changes.flatMap((c) =>
        c.kind === "reopen_section" && c.reason.type === "blocking_conflict" ? c.reason.conflictIDs : [],
      ),
      ...proposal.changes.flatMap((c) =>
        c.kind === "reopen_architecture" && c.reason.type === "blocking_conflict" ? c.reason.conflictIDs : [],
      ),
    ]);
    const changedTargets = staged.committedChanges
      .map((change) => change.ref)
      .filter((ref): ref is MemoryRef => ref !== undefined);
    for (const conflict of staged.conflicts) {
      if (conflict.status !== "open" || conflict.severity !== "blocking") continue;
      if (remediatedConflictIDs.has(conflict.id)) continue;
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
      conflicts: staged.conflicts,
      stage: staged.stage,
      lifecycle: staged.lifecycle,
      architecture: staged.runArchitecture,
      sections: staged.runSections.map((mirror) => ({ id: mirror.id })),
      // R1b §50: provenance is present only when staged/persisted state carries
      // it (set by decomposition, CLEARED by amend_architecture — an explicit
      // value so the run spread's prior key cannot survive), absent for legacy
      // runs.
      sectionDecompositionArchitecture: staged.provenanceTouched
        ? staged.sectionDecompositionArchitecture
        : run.sectionDecompositionArchitecture,
      decisions: staged.runDecisions,
      ...(staged.runFinalPlan ? { finalPlan: staged.runFinalPlan } : {}),
      // Phase 7B §6/§8: the Final PlanCommit durably records the supervised
      // handoff protocol in this same publication (never artifact-inferred).
      ...(staged.handoffProtocol ? { handoffProtocol: staged.handoffProtocol } : {}),
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
    proposal: Proposal,
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
        // R1b §50: record the decomposition provenance — the exact Architecture
        // revision this DAG was decomposed from (the proposal's committed scope).
        if ("revision" in proposal.scope) {
          staged.sectionDecompositionArchitecture = { ...proposal.scope };
          staged.provenanceTouched = true;
        }
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
      case "resolve_conflict": {
        // R1a §4-§7: the ONLY open → resolved transition for a Conflict —
        // staged by an approved change, verified against the SAME staged
        // state the resolution binds (never against HEAD-relative state).
        const conflict = staged.conflicts.find((c) => c.id === change.conflictID);
        if (!conflict) {
          addFailure("unknown_reference", `Conflict ${change.conflictID} does not exist`);
          return;
        }
        if (conflict.status === "resolved") {
          addFailure(
            "conflict_resolution_invalid",
            `Conflict ${change.conflictID} is already resolved${conflict.resolution ? ` (by ${conflict.resolution.action})` : ""}; resolutions are immutable historical state`,
            { conflictID: change.conflictID },
          );
          return;
        }
        if (staged.resolvedConflicts.includes(change.conflictID)) {
          addFailure(
            "conflict_resolution_invalid",
            `This transaction already stages a resolution for ${change.conflictID}; one resolution per conflict per proposal`,
            { conflictID: change.conflictID },
          );
          return;
        }
        // §6: the binding must witness REAL remediation in the staged result.
        if (change.resolution.action === "amend_decision") {
          const ref = change.resolution.ref;
          if (ref.kind !== "decision" || !("revision" in ref) || ref.revision === undefined) {
            addFailure(
              "conflict_resolution_invalid",
              `resolve_conflict(${change.conflictID}, amend_decision) must bind an exact DecisionRef`,
              { conflictID: change.conflictID },
            );
            return;
          }
          const decision = staged.decisions.byKey.get(revisionKey(ref.id, ref.revision));
          if (!decision) {
            addFailure(
              "conflict_resolution_invalid",
              `resolve_conflict(${change.conflictID}) binds ${ref.id}@${ref.revision}, which this transaction does not create and the run does not contain`,
              { conflictID: change.conflictID, ref: `${ref.id}@${ref.revision}` },
            );
            return;
          }
          const conflictNamesDecision = conflict.refs.some((r) => r.kind === "decision" && r.id === ref.id);
          if (!conflictNamesDecision) {
            addFailure(
              "conflict_resolution_invalid",
              `resolve_conflict(${change.conflictID}, amend_decision) binds ${ref.id}, but the conflict does not name that Decision`,
              { conflictID: change.conflictID, decisionID: ref.id },
            );
            return;
          }
        } else if (change.resolution.action === "amend_architecture") {
          const ref = change.resolution.ref;
          if (ref.kind !== "architecture" || ref.revision === undefined) {
            addFailure(
              "conflict_resolution_invalid",
              `resolve_conflict(${change.conflictID}, amend_architecture) must bind an exact ArchitectureRef`,
              { conflictID: change.conflictID },
            );
            return;
          }
          const architecture = staged.architectures.byKey.get(revisionKey("ARCH", ref.revision));
          if (!architecture) {
            addFailure(
              "conflict_resolution_invalid",
              `resolve_conflict(${change.conflictID}) binds ARCH@${ref.revision}, which this transaction does not create`,
              { conflictID: change.conflictID, revision: ref.revision },
            );
            return;
          }
        } else {
          // revise_proposal: ref must be THIS proposal's own exact ref.
          const ref = change.resolution.ref;
          if (ref.kind !== "proposal" || ref.id !== proposal.id) {
            addFailure(
              "conflict_resolution_invalid",
              `resolve_conflict(${change.conflictID}, revise_proposal) must bind the carrying Proposal's own exact ref (bound ${ref.kind}${"id" in ref ? ` ${ref.id}` : ""})`,
              { conflictID: change.conflictID, proposalID: proposal.id },
            );
            return;
          }
        }
        conflict.status = "resolved";
        conflict.resolution = {
          action: change.resolution.action,
          ref: change.resolution.ref,
        };
        staged.resolvedConflicts.push(change.conflictID);
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "conflict", id: change.conflictID },
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
        // activeWork → the exact target Section; any reopen coming FROM
        // synthesis moves the stage back to detail (semantic_validation and
        // the R1a blocker-driven reasons alike — the reopen opens the detail
        // remediation workflow). A detail dependency_review/blocker reopen
        // stays in detail. Downstream propagation is deliberately NOT done
        // here — needs_review reaches dependents only when the reopened
        // Section's new revision/contract commits (§48).
        staged.sections.set(change.target.id, {
          ...section,
          status: "reopened",
          validation: "needs_review",
        });
        staged.activeWork = { type: "section", id: change.target.id };
        if (change.reopen.fromStage === "synthesis") {
          staged.stage = "detail";
        }
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "section", id: change.target.id, revision: change.target.revision },
          resultingRevision: change.target.revision,
        });
        return;
      }
      case "reopen_architecture": {
        // R1b §19-§20: the sanctioned Architecture reopen — NO design content,
        // NO new revision. The exact target must be the run's current
        // Architecture; ARCH@n stays approved and immutable; Sections stay
        // unchanged (invalidation belongs to the amend_architecture commit);
        // the run enters the architecture-remediation workflow.
        const architecture = staged.architectures.byKey.get(revisionKey("ARCH", change.target.revision));
        if (!architecture) {
          addFailure("unknown_reference", `Architecture ARCH@${change.target.revision} does not exist`);
          return;
        }
        if (architecture.status !== "approved") {
          addFailure(
            "reopen_target_invalid",
            `Architecture ARCH@${change.target.revision} is ${architecture.status}; reopen targets the approved Architecture`,
            { revision: change.target.revision, status: architecture.status },
          );
          return;
        }
        const runArchitecture = staged.runArchitecture;
        if (!runArchitecture || runArchitecture.revision !== change.target.revision) {
          addFailure(
            "reopen_target_invalid",
            `reopen_architecture targets ARCH@${change.target.revision}, but the run's current Architecture is ${runArchitecture ? `ARCH@${runArchitecture.revision}` : "none"}`,
            { target: change.target.revision, current: runArchitecture?.revision },
          );
          return;
        }
        if (staged.stage !== "synthesis" && staged.stage !== "detail") {
          addFailure(
            "reopen_stage_invalid",
            `An Architecture reopen runs in synthesis or detail (run is in ${staged.stage})`,
            { stage: staged.stage },
          );
        }
        if (!("revision" in proposal.scope)) {
          addFailure(
            "reopen_scope_invalid",
            `An Architecture reopen proposal is scoped to the exact ArchitectureRef (scope is ${proposal.scope.id})`,
            { scope: proposal.scope.id },
          );
        } else if (proposal.scope.revision !== change.target.revision) {
          addFailure(
            "reopen_scope_invalid",
            `The reopen proposal scope binds ARCH@${proposal.scope.revision}, not the target ARCH@${change.target.revision}`,
            { scope: proposal.scope.revision, target: change.target.revision },
          );
        }
        // semantic_validation revalidation (report existence/hash/result/
        // identity currency/architecture scope) lives in the executeTransaction
        // precondition block — the report registries are immutable within a
        // transaction, and that block runs for hostile direct calls too.
        if (change.reason.type === "blocking_question") {
          if (staged.stage !== "synthesis" && staged.stage !== "detail") {
            addFailure(
              "reopen_stage_invalid",
              `A blocker-driven reopen requires stage=synthesis or detail (run is in ${staged.stage})`,
              { stage: staged.stage },
            );
          }
          const blockerReason = change.reason;
          const question = staged.openQuestions.find((q) => q.id === blockerReason.questionID);
          if (!question) {
            addFailure("unknown_reference", `Question ${blockerReason.questionID} does not exist in this run`);
          } else if (question.status !== "open" || !question.blocking) {
            addFailure(
              "reopen_reason_invalid",
              `A blocker-driven reopen requires an OPEN, BLOCKING question (${question.id} is ${question.status}/${question.blocking ? "blocking" : "non-blocking"})`,
              { questionID: question.id },
            );
          } else if (!("revision" in question.scope) || question.scope.revision !== change.target.revision) {
            addFailure(
              "reopen_target_unsupported",
              `Question ${question.id} is not scoped to ARCH@${change.target.revision}; the reopen target must be the blocker's own remediation target`,
              { questionID: question.id, revision: change.target.revision },
            );
          }
        }
        if (change.reason.type === "blocking_conflict") {
          if (staged.stage !== "synthesis" && staged.stage !== "detail") {
            addFailure(
              "reopen_stage_invalid",
              `A blocker-driven reopen requires stage=synthesis or detail (run is in ${staged.stage})`,
              { stage: staged.stage },
            );
          }
          if (change.reason.conflictIDs.length === 0) {
            addFailure(
              "reopen_reason_invalid",
              "A blocking_conflict reopen must bind at least one conflictID",
              { revision: change.target.revision },
            );
          }
          for (const conflictID of change.reason.conflictIDs) {
            const conflict = staged.conflicts.find((c) => c.id === conflictID);
            if (!conflict) {
              addFailure("unknown_reference", `Conflict ${conflictID} does not exist in this run`);
              continue;
            }
            if (conflict.status !== "open" || conflict.severity !== "blocking") {
              addFailure(
                "reopen_reason_invalid",
                `A blocker-driven reopen requires an OPEN, BLOCKING conflict (${conflict.id} is ${conflict.status}/${conflict.severity})`,
                { conflictID: conflict.id },
              );
              continue;
            }
            const identifiesArchitecture = conflict.refs.some(
              (ref) =>
                (ref.kind === "architecture" && (ref.revision === undefined || ref.revision === change.target.revision)) ||
                (ref.kind === "decision" && staged.decisions.latest.get(ref.id)?.scope.architecture === true),
            );
            if (!identifiesArchitecture) {
              addFailure(
                "reopen_target_unsupported",
                `Conflict ${conflict.id} does not identify ARCH@${change.target.revision} as its remediation target`,
                { conflictID: conflict.id, revision: change.target.revision },
              );
            }
          }
        }
        // §20: the reopen commit moves the run into the remediation workflow —
        // stage → detail (from synthesis OR detail), activeWork → the exact
        // Architecture. Sections, Architecture content, and HEAD-level design
        // state are untouched by THIS commit.
        staged.stage = "detail";
        staged.activeWork = { type: "architecture" };
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "architecture", revision: change.target.revision },
          resultingRevision: change.target.revision,
        });
        return;
      }
      case "amend_architecture": {
        // R1b §23-§26: the Architecture amendment — the ONLY sanctioned way to
        // revise an approved Architecture. The exact base must be the run's
        // CURRENT ARCH; the result is the complete ARCH@n+1 written verbatim;
        // the Section DAG decomposed from ARCH@n is CONSERVATIVELY INVALIDATED
        // (old roots stay durable history marked needs_review, run.sections →
        // [], provenance cleared, activeWork cleared) — full re-decomposition
        // against ARCH@n+1 is mandatory (brief §27, never DAG patching).
        const base = staged.architectures.byKey.get(revisionKey("ARCH", change.supersedes.revision));
        if (!base) {
          addFailure("unknown_reference", `Amend base ARCH@${change.supersedes.revision} does not exist`);
          return;
        }
        const runArchitecture = staged.runArchitecture;
        if (!runArchitecture || runArchitecture.revision !== change.supersedes.revision) {
          addFailure(
            "amendment_base_mismatch",
            `amend_architecture supersedes ARCH@${change.supersedes.revision}, but the run's current Architecture is ${runArchitecture ? `ARCH@${runArchitecture.revision}` : "none"}`,
            { supersedes: change.supersedes.revision, current: runArchitecture?.revision },
          );
          return;
        }
        if (change.architecture.revision !== change.supersedes.revision + 1) {
          addFailure(
            "amendment_base_mismatch",
            `amend_architecture must produce exactly ARCH@${change.supersedes.revision + 1} (got @${change.architecture.revision}); revisions are contiguous`,
            { expected: change.supersedes.revision + 1, got: change.architecture.revision },
          );
          return;
        }
        if (change.architecture.status !== "approved") {
          addFailure(
            "change_invalid",
            "amend_architecture stages the committed approved record; status is Harness-assigned at freeze",
            { status: change.architecture.status },
          );
          return;
        }
        // §35/§36: the remediation substate is the only amendment stage.
        if (staged.stage !== "detail" || staged.activeWork?.type !== "architecture") {
          addFailure(
            "amendment_stage_invalid",
            `amend_architecture requires the architecture-remediation detail substate (stage=detail, activeWork=architecture); run is ${staged.stage}${staged.activeWork ? `/${staged.activeWork.type}` : "/no focus"}`,
            { stage: staged.stage, activeWork: staged.activeWork?.type },
          );
          return;
        }
        this.stagePutRevision(staged.architectures, "ARCH", change.architecture.revision, change.architecture, "architecture", addFailure);
        staged.runArchitecture = { id: "ARCH", revision: change.architecture.revision };
        // §26 conservative invalidation: old roots remain durable history
        // (never deleted), marked needs_review; the run's current Section set
        // is reset so the run enters detail/decomposition-needed.
        for (const [sectionID, section] of staged.sections) {
          if (staged.runSections.some((mirror) => mirror.id === sectionID)) {
            staged.sections.set(sectionID, { ...section, validation: "needs_review" });
          }
        }
        staged.runSections = [];
        staged.activeWork = undefined;
        staged.sectionDecompositionArchitecture = undefined;
        staged.provenanceTouched = true;
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "architecture", revision: change.architecture.revision },
          resultingRevision: change.architecture.revision,
        });
        staged.revised.push({ kind: "architecture", id: "ARCH", revision: change.architecture.revision });
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
        // R1b §50/§51: the decomposition provenance as of THIS commit —
        // present on decomposition commits, absent after amend_architecture
        // invalidates the DAG (absence is meaningful, never backfilled).
        ...(staged.sectionDecompositionArchitecture
          ? { sectionDecompositionArchitectureRevision: staged.sectionDecompositionArchitecture.revision }
          : {}),
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
      // R2: also mirror into the run's HEAD snapshot state (as prior commits
      // would have) so the snapshot-consistent context read boundary resolves
      // seeded artifacts. TEST-ONLY seam — production state changes always
      // materialize their own snapshot inside commitTransaction.
      const snapshot = run.headSnapshot ? this.snapshots.get(planID)?.get(run.headSnapshot) : undefined;
      if (snapshot) {
        const currentSections = [...(this.sections.get(planID)?.values() ?? [])];
        this.snapshots.get(planID)?.set(run.headSnapshot!, {
          ...snapshot,
          state: {
            ...snapshot.state,
            ...(architecture ? { architectureRevision: architecture.revision } : {}),
            sectionRevisions: Object.fromEntries(
              [...(this.sectionRevisions.get(planID)?.latest ?? [])].map(([id, revision]) => [id, revision.revision]),
            ),
            decisionRevisions: Object.fromEntries(
              [...(this.decisions.get(planID)?.latest ?? [])].map(([id, decision]) => [id, decision.revision]),
            ),
            sectionRoots: currentSections.map((section) => ({
              id: section.id,
              title: section.title,
              objective: section.objective,
              dependencies: section.dependencies,
              status: section.status,
              validation: section.validation,
              ...(section.currentRevision !== undefined ? { currentRevision: section.currentRevision } : {}),
              ...(section.approvedRevision !== undefined ? { approvedRevision: section.approvedRevision } : {}),
            })),
          },
        });
      }
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
