/**
 * Durable store document — persistence DTO layer (Phase 2B2 brief §8/§9/§12).
 *
 * One structured, versioned document per project holds the authoritative Plan
 * Memory as RECORDS with stable identities (not an opaque blob): every entity
 * family is keyed by its branded domain id, so identity, revision, status,
 * hash, and HEAD references remain first-class and enforceable. Structured
 * immutable content (decision bodies, section projections, proposal changes)
 * lives in validated JSON payloads — the boundary from brief §9.
 *
 * Validation is FAIL-CLOSED: `decodeStoreDocument` throws `store_corrupt` on
 * any malformed payload or broken reference, and `store_version_unsupported`
 * on a newer schema — it never repairs, deletes, or downgrades (brief §20).
 */
import { createHash } from "node:crypto";

import { UltraPlanError } from "../core/errors.js";
import type {
  Architecture,
  Decision,
  PlanningRun,
  Section,
  SectionRevision,
} from "../core/types.js";
import type { Approval, PlanCommit, Proposal } from "../transaction/types.js";
import type { Evidence } from "../repository/evidence.js";
import type { PlanEvent } from "./events.js";
import type { Snapshot } from "./snapshots.js";
import {
  computeSynthesisInputHash,
  computeSynthesisManifestHashFromRecord,
} from "../synthesis/hash.js";
import type { SynthesisInput, SynthesisManifest } from "../synthesis/types.js";
import { SYNTHESIS_FINDING_CATEGORIES } from "../synthesis/types.js";
import { computeValidationReportHashFromRecord } from "../validation/hash.js";
import { SEMANTIC_FINDING_CATEGORIES } from "../validation/types.js";
import type { SemanticValidationAdmission, SemanticValidationFinding, ValidationReport } from "../validation/types.js";
import { computeEvidenceAuditHashFromRecord, computeFinalPlanCandidateHashFromRecord } from "../finalization/hash.js";
import { computeFinalPlanHashFromContent, renderFinalPlanBody } from "../finalization/plan.js";
import { computeExecutionHandoffHashFromRecord } from "../handoff/hash.js";
import { handoffDeliveryKey } from "../handoff/types.js";
import { assertEvidenceAuditInternallyConsistent } from "../finalization/audit.js";
import { EXECUTION_LIFECYCLES } from "../core/execution-run.js";
import {
  DIRECTIVE_CANDIDATE_EFFECTS,
  EXECUTION_CAPABILITIES,
  EXECUTION_DIRECTIVE_KINDS,
  computeExecutionDirectiveHashFromRecord,
} from "../core/execution-directive.js";
import { EXECUTION_ATTEMPT_STATES, WORKER_ROLES } from "../core/execution-attempt.js";
import {
  CANDIDATE_MUTATIONS,
  EXECUTION_BLOCKER_KINDS,
  EXECUTION_REPORT_RESULTS,
  assertConflictResolutionOutcomeVocabulary,
  assertReconciliationObservationVocabulary,
} from "../core/execution-report.js";
import { ASSESSMENT_ACCEPTANCE_SCOPES, ASSESSMENT_DISPOSITIONS, computeSupervisorAssessmentHashFromRecord } from "../core/supervisor-assessment.js";
import { computeExecutionIssueHashFromRecord } from "../core/execution-issue.js";
import {
  CONFLICT_RESOLUTION_OUTCOMES,
  VERIFICATION_CONFLICT_STATUSES,
  assertVerificationEvidenceRef,
  neutralizedEvidenceForOutcome,
} from "../core/verification-conflict.js";
import { SUCCESSFUL_RECONCILIATION_OBSERVATIONS } from "../core/attempt-reconciliation.js";
import { computeExecutionCompletionHashFromRecord } from "../core/execution-completion.js";
import { EXECUTION_STAGE_KINDS, executionStageKindOf } from "../core/execution-stage.js";
import { RECONCILIATION_FORBIDDEN_CAPABILITIES, VERIFICATION_PURPOSES } from "../core/execution-directive.js";
import { validateExecutionPlanRefs } from "../core/execution-stage.js";

export const STORE_SCHEMA_VERSION = 1;

/**
 * Authoritative durable state. Record keys:
 * - committed artifacts: `ID@REVISION` (architectures use `ARCH@N`)
 * - sections: SectionID
 * - proposals/approvals/commits/snapshots: their own ids
 * - evidence: `EVD-###@REVISION`
 * - synthesis manifests: `SYN-###@REVISION` (Phase 2F)
 * - synthesis inputs: their own ids (`SYN-IN-###`)
 * Family maps are keyed per plan id.
 */
export interface StoreDocument {
  schemaVersion: number;
  runs: Record<string, PlanningRun>;
  runOrder: string[];
  events: Record<string, PlanEvent[]>;
  committed: Record<
    string,
    {
      architectures: Record<string, Architecture>;
      sections: Record<string, Section>;
      sectionRevisions: Record<string, SectionRevision>;
      decisions: Record<string, Decision>;
    }
  >;
  proposals: Record<string, Record<string, Proposal>>;
  approvals: Record<string, Record<string, Approval>>;
  commits: Record<string, Record<string, PlanCommit>>;
  /** `planID:proposalID` → commitID; the idempotency index. */
  commitByProposal: Record<string, string>;
  snapshots: Record<string, Record<string, Snapshot>>;
  evidence: Record<string, Record<string, Evidence>>;
  /**
   * Phase 2F derived synthesis artifacts — durable workflow state, NOT
   * committed Plan Memory. ADDITIVE: documents written before Phase 2F
   * legitimately lack both families; absence has the unambiguous semantics
   * "no synthesis was performed", so the schema version stays 1 (brief §39).
   */
  synthesisInputs?: Record<string, Record<string, SynthesisInput>>;
  synthesisManifests?: Record<string, Record<string, SynthesisManifest>>;
  /**
   * Phase 2G semantic validation (brief §28) — durable derived reports plus
   * the transient single-flight admission records. ADDITIVE for the same
   * reason: a pre-2G document without `validationReports` unambiguously means
   * "semantic validation has never run"; no existing family is reinterpreted,
   * so STORE_SCHEMA_VERSION stays 1. Admissions are transient machinery but
   * ride the document so a process death leaves a RECLAIMABLE (never wedging)
   * ownership record (§32) instead of invisible cross-instance drift.
   */
  validationReports?: Record<string, Record<string, ValidationReport>>;
  validationAdmissions?: Record<string, Record<string, SemanticValidationAdmission>>;
  /**
   * Phase 2H finalization (brief §61) — durable derived audit snapshots and
   * FinalPlanCandidates. ADDITIVE for the same reason as the 2F/2G families:
   * a pre-2H document without them unambiguously means "finalization has never
   * run", no existing family is reinterpreted, so STORE_SCHEMA_VERSION stays 1.
   * Malformed records fail closed (§62/§63); there is no repair.
   */
  evidenceAudits?: Record<string, Record<string, import("../finalization/types.js").EvidenceAuditSnapshot>>;
  finalPlanCandidates?: Record<string, Record<string, import("../finalization/types.js").FinalPlanCandidate>>;
  /**
   * Phase 2I committed FinalPlans — ADDITIVE like every later family: a
   * pre-2I document without `finalPlans` unambiguously means "no Final
   * PlanCommit has ever happened", no existing family is reinterpreted, and
   * STORE_SCHEMA_VERSION stays 1. These ARE committed Plan Memory (the only
   * writer is the final transaction), so load validation additionally proves
   * the run-pointer/commit/snapshot consistency (§70-§74) — fail closed.
   */
  finalPlans?: Record<string, Record<string, import("../core/types.js").FinalPlan>>;
  /**
   * Phase 2J runtime handoff (§85) — the immutable ExecutionHandoff and the
   * mutable delivery workflow record. ADDITIVE for the same reason as every
   * later family: a pre-2J document without them unambiguously means "no
   * handoff has been prepared", so STORE_SCHEMA_VERSION stays 1. Load
   * validation proves hash/projection/binding integrity (§86) and the
   * delivery state machine invariants (§87/§88/§123/§124) — fail closed.
   */
  executionHandoffs?: Record<string, Record<string, import("../handoff/types.js").ExecutionHandoff>>;
  handoffDeliveries?: Record<string, Record<string, import("../handoff/types.js").HandoffDelivery>>;
  /**
   * v0.2.0 Phase 1 — ExecutionRun supervised-execution foundation (SPEC §11),
   * keyed by EXEC id (globally unique; the record carries its planID), plus
   * the `planID:initialHandoffKey` → EXEC id idempotency index. ADDITIVE for
   * the same reason as every later family: a pre-execution document without
   * them unambiguously means "no ExecutionRun has ever been prepared", no
   * existing family is reinterpreted, so STORE_SCHEMA_VERSION stays 1. Load
   * validation proves the authority binding shape (exact FinalPlan identity,
   * non-empty workspace, known lifecycle, resolvable handoff index) — fail
   * closed, never repaired.
   */
  executionRuns?: Record<string, import("../core/execution-run.js").ExecutionRun>;
  executionRunByHandoffKey?: Record<string, string>;
  /**
   * v0.2.0 Phase 2 — SupervisorBindings (supervised-execution ownership),
   * keyed by executionRunID: AT MOST ONE record per run, so a second writable
   * owner is unrepresentable. ADDITIVE like every later family: a
   * pre-Phase-2 document without it unambiguously means "no supervisor has
   * ever attached", no existing family is reinterpreted, so
   * STORE_SCHEMA_VERSION stays 1. Load validation proves the fencing shape —
   * existing run reference, workspace equality with the run, monotonic
   * generation, valid owner/state/timestamps — fail closed, never repaired.
   */
  supervisorBindings?: Record<string, import("../core/supervisor-binding.js").SupervisorBinding>;
  /**
   * v0.2.0 Phase 3 — the supervised-execution structural layer: ExecutionStages
   * and VerificationWindows, each keyed by its own never-reused id. ADDITIVE
   * like every later family: a pre-Phase-3 document without them unambiguously
   * means "no Stage/Window was ever created", no existing family is
   * reinterpreted, so STORE_SCHEMA_VERSION stays 1. Load validation proves the
   * full structural graph — run/stage/window references, the single-active-
   * Stage and single-open-Window invariants, run.activeStage/openWindow
   * consistency, dependency acyclicity, candidateRevision shape, and the
   * execution-start-only baseAcceptedState — fail closed, never repaired.
   * (`completed` Stage status and `closed` Window state are legal stored
   * values reserved for future phases; the loader must hydrate, not reject.)
   */
  executionStages?: Record<string, import("../core/execution-stage.js").ExecutionStage>;
  verificationWindows?: Record<string, import("../core/verification-window.js").VerificationWindow>;
  /**
   * v0.2.0 Phase 4 — the worker transaction protocol families. Directives are
   * keyed "DIR-###@REV" (EVERY revision durable; staleness against the current
   * window is legitimate history, never corruption); attempts ATT-### with
   * the attempt-by-directive-revision index ("runID:DIR@REV" → ATT id)
   * enforcing one logical Attempt per exact revision; reports RPT-###.
   * ADDITIVE like every later family; STORE_SCHEMA_VERSION stays 1. Load
   * validation proves hash recomputation, exact run/FinalPlan/Stage/Window
   * bindings, attempt uniqueness/state/report consistency, report provenance
   * arithmetic, and blocker vocabulary — fail closed, never repaired.
   */
  executionDirectives?: Record<string, import("../core/execution-directive.js").ExecutionDirective>;
  executionAttempts?: Record<string, import("../core/execution-attempt.js").ExecutionAttempt>;
  executionReports?: Record<string, import("../core/execution-report.js").ExecutionReport>;
  executionAttemptByDirective?: Record<string, string>;
  /**
   * v0.2.0 Phase 5 — the acceptance layer. supervisorAssessments (SA-###,
   * immutable judgments incl. non-accept history) and the linear
   * executionCommits chain (EC-###) with commitByWindow/commitByAssessment
   * indexes (one commit per window; idempotent accept retry). ADDITIVE;
   * STORE_SCHEMA_VERSION stays 1. Load validation proves the full graph —
   * exact bindings, accept-only commits, linear parent chain, acceptedHead
   * at the chain tip, one commit per window, obligation subsets, and
   * completed-Stage closure provenance — fail closed, never repaired.
   */
  supervisorAssessments?: Record<string, import("../core/supervisor-assessment.js").SupervisorAssessment>;
  executionCommits?: Record<string, import("../core/execution-commit.js").ExecutionCommit>;
  executionCommitByWindow?: Record<string, string>;
  executionCommitByAssessment?: Record<string, string>;
  /**
   * v0.2.0 Phase 6A — the abnormal/escalation control plane: ExecutionIssues
   * (ISS-### + the run→issue index; a replan_required run ALWAYS carries
   * exactly one valid terminal issue), VerificationConflicts (VCF-###, one
   * disputed fact each with at most one bound resolver), and
   * AttemptReconciliations (REC-###) with the attempt→reconciliation coverage
   * index backing the canonical unresolved-indeterminate set. ADDITIVE;
   * STORE_SCHEMA_VERSION stays 1. Load validation proves the full escalation
   * graph — bidirectional issue↔replan_required consistency, request_replan
   * source assessments, exact affected plan refs, accepted-history snapshots,
   * exact evidence refs, resolver uniqueness/role/purpose/candidate binding,
   * deterministic neutralization, reconciliation targets/observation/revision
   * arithmetic — fail closed, never repaired.
   */
  executionIssues?: Record<string, import("../core/execution-issue.js").ExecutionIssue>;
  issueByExecutionRun?: Record<string, string>;
  verificationConflicts?: Record<string, import("../core/verification-conflict.js").VerificationConflict>;
  attemptReconciliations?: Record<string, import("../core/attempt-reconciliation.js").AttemptReconciliation>;
  reconciliationByAttempt?: Record<string, string>;
  /**
   * v0.2.0 Phase 6B — the final-closure/completion layer: ExecutionCompletions
   * (CMPL-###, ONE per completed run via the run→completion index) make
   * `ExecutionRun.completed` gate-provenanced rather than a bare enum value.
   * ADDITIVE; STORE_SCHEMA_VERSION stays 1. LEGACY distinction (§50-§53): a
   * completed run WITHOUT a record is pre-6B history and loads unchanged; a
   * record REQUIRES a completed run and full final-closure provenance —
   * fail closed, never repaired.
   */
  executionCompletions?: Record<string, import("../core/execution-completion.js").ExecutionCompletionRecord>;
  completionByExecutionRun?: Record<string, string>;
}

export function freshStoreDocument(): StoreDocument {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    runs: {},
    runOrder: [],
    events: {},
    committed: {},
    proposals: {},
    approvals: {},
    commits: {},
    commitByProposal: {},
    snapshots: {},
    evidence: {},
    synthesisInputs: {},
    synthesisManifests: {},
    validationReports: {},
    validationAdmissions: {},
    evidenceAudits: {},
    finalPlanCandidates: {},
    finalPlans: {},
    executionHandoffs: {},
    handoffDeliveries: {},
    executionRuns: {},
    executionRunByHandoffKey: {},
    supervisorBindings: {},
    executionStages: {},
    verificationWindows: {},
    executionDirectives: {},
    executionAttempts: {},
    executionReports: {},
    executionAttemptByDirective: {},
    supervisorAssessments: {},
    executionCommits: {},
    executionCommitByWindow: {},
    executionCommitByAssessment: {},
    executionIssues: {},
    issueByExecutionRun: {},
    verificationConflicts: {},
    attemptReconciliations: {},
    reconciliationByAttempt: {},
    executionCompletions: {},
    completionByExecutionRun: {},
  };
}

function corrupt(message: string, detail?: Record<string, unknown>): UltraPlanError {
  return new UltraPlanError("store_corrupt", `Durable store is corrupt: ${message}`, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed durable document and its critical references. Throws
 * `store_version_unsupported` / `store_corrupt`. Invariants checked here are
 * the storage-level ones only (references, hashes, chain shape); domain
 * transaction rules remain in the transaction engine.
 */
export function validateStoreDocument(doc: unknown): asserts doc is StoreDocument {
  if (!isRecord(doc)) throw corrupt("document is not an object");
  if (typeof doc.schemaVersion !== "number") throw corrupt("missing numeric schemaVersion");
  if (doc.schemaVersion > STORE_SCHEMA_VERSION) {
    throw new UltraPlanError(
      "store_version_unsupported",
      `Durable store schema version ${doc.schemaVersion} is newer than supported version ${STORE_SCHEMA_VERSION}; upgrade the plugin — refusing to open`,
      { found: doc.schemaVersion, supported: STORE_SCHEMA_VERSION },
    );
  }
  if (doc.schemaVersion < STORE_SCHEMA_VERSION) {
    throw corrupt(`schema version ${doc.schemaVersion} is older than supported; no migration exists`, {
      found: doc.schemaVersion,
      supported: STORE_SCHEMA_VERSION,
    });
  }
  for (const family of ["runs", "events", "committed", "proposals", "approvals", "commits", "commitByProposal", "snapshots", "evidence"]) {
    if (!isRecord(doc[family as keyof StoreDocument])) throw corrupt(`missing "${family}" family`);
  }
  if (!Array.isArray(doc.runOrder)) throw corrupt("runOrder is not an array");

  const runs = doc.runs as Record<string, unknown>;
  const snapshots = doc.snapshots as Record<string, Record<string, unknown>>;
  const commits = doc.commits as Record<string, Record<string, unknown>>;
  const proposals = doc.proposals as Record<string, Record<string, unknown>>;
  const approvals = doc.approvals as Record<string, Record<string, unknown>>;

  // Runs reference existing HEAD snapshot/commit.
  for (const [planID, run] of Object.entries(runs)) {
    if (!isRecord(run)) throw corrupt(`run ${planID} is not an object`);
    const headSnapshot = run["headSnapshot"];
    if (headSnapshot !== undefined && headSnapshot !== null) {
      const family = snapshots[planID];
      if (!isRecord(family) || !(headSnapshot as string in family)) {
        throw corrupt(`run ${planID} references missing HEAD snapshot ${String(headSnapshot)}`, {
          planID,
          headSnapshot: String(headSnapshot),
        });
      }
    }
    const headCommit = run["headCommit"];
    if (headCommit !== undefined && headCommit !== null) {
      const family = commits[planID];
      if (!isRecord(family) || !(headCommit as string in family)) {
        throw corrupt(`run ${planID} references missing HEAD commit ${String(headCommit)}`, {
          planID,
          headCommit: String(headCommit),
        });
      }
    }

    // R1a §49 — RESOLVED CONFLICTS must carry a valid, resolvable resolution:
    // a conflict can only reach `resolved` through an approved
    // resolve_conflict PlanCommit, whose binding the durable state must still
    // witness. Never repaired, never normalized into a different meaning.
    const runConflicts = run["conflicts"];
    if (runConflicts !== undefined) {
      if (!Array.isArray(runConflicts)) throw corrupt(`run ${planID} has a malformed conflicts array`);
      // The committed families are nested PER PLAN: doc.committed[planID].
      // (R2 regression fix: this validation originally read doc.committed[
      // "architectures"]/["decisions"] — the wrong nesting level, which made
      // every store carrying a resolved conflict fail closed on reload.)
      const planCommitted = (doc.committed as Record<string, Record<string, Record<string, unknown>>>)[planID] ?? {};
      const architectures = planCommitted["architectures"];
      const decisions = planCommitted["decisions"];
      for (const conflict of runConflicts) {
        if (!isRecord(conflict) || typeof conflict["id"] !== "string") {
          throw corrupt(`run ${planID} has a malformed conflict entry`);
        }
        if (conflict["status"] !== "resolved") continue;
        const resolution = conflict["resolution"];
        if (!isRecord(resolution)) {
          throw corrupt(`run ${planID} conflict ${conflict["id"]} is resolved without a resolution`);
        }
        const action = resolution["action"];
        const ref = resolution["ref"];
        if (!isRecord(ref)) {
          throw corrupt(`run ${planID} conflict ${conflict["id"]} has a malformed resolution ref`);
        }
        if (action === "amend_decision") {
          if (ref["kind"] !== "decision" || typeof ref["id"] !== "string" || typeof ref["revision"] !== "number") {
            throw corrupt(`run ${planID} conflict ${conflict["id"]} must bind an exact DecisionRef`);
          }
          if (!isRecord(decisions) || !(`${ref["id"]}@${ref["revision"]}` in decisions)) {
            throw corrupt(
              `run ${planID} conflict ${conflict["id"]} resolution binds missing decision ${ref["id"]}@${String(ref["revision"])}`,
            );
          }
        } else if (action === "amend_architecture") {
          if (ref["kind"] !== "architecture" || typeof ref["revision"] !== "number") {
            throw corrupt(`run ${planID} conflict ${conflict["id"]} must bind an exact ArchitectureRef`);
          }
          if (!isRecord(architectures) || !(`ARCH@${ref["revision"]}` in architectures)) {
            throw corrupt(
              `run ${planID} conflict ${conflict["id"]} resolution binds missing ARCH@${String(ref["revision"])}`,
            );
          }
        } else if (action === "revise_proposal") {
          if (ref["kind"] !== "proposal" || typeof ref["id"] !== "string") {
            throw corrupt(`run ${planID} conflict ${conflict["id"]} must bind a ProposalRef`);
          }
          if (!isRecord(proposals[planID]) || !(ref["id"] in proposals[planID])) {
            throw corrupt(
              `run ${planID} conflict ${conflict["id"]} resolution binds missing proposal ${ref["id"]}`,
            );
          }
        } else {
          throw corrupt(`run ${planID} conflict ${conflict["id"]} has an unknown resolution action ${String(action)}`);
        }
      }
    }

    // R1b §49/§50 — DECOMPOSITION PROVENANCE consistency and architecture-
    // remediation focus legality. The provenance field records the exact ARCH
    // revision the current Section DAG was decomposed from; it can never
    // silently contradict the run's current Architecture, and it never
    // dangles over an empty Section set (new-format runs; legacy runs without
    // the field load unchanged).
    const provenance = run["sectionDecompositionArchitecture"];
    const runSections = run["sections"];
    const runArchitecture = run["architecture"];
    if (provenance !== undefined) {
      if (!isRecord(provenance) || typeof provenance["revision"] !== "number") {
        throw corrupt(`run ${planID} has a malformed sectionDecompositionArchitecture`);
      }
      if (!Array.isArray(runSections) || runSections.length === 0) {
        throw corrupt(`run ${planID} records decomposition provenance with no current Section set`);
      }
      if (
        !isRecord(runArchitecture) ||
        runArchitecture["revision"] !== provenance["revision"]
      ) {
        throw corrupt(
          `run ${planID} current Section DAG was decomposed from ARCH@${String(provenance["revision"])}, but the run binds ARCH@${String(isRecord(runArchitecture) ? runArchitecture["revision"] : "none")}`,
        );
      }
    }
    const activeWork = run["activeWork"];
    if (isRecord(activeWork) && activeWork["type"] === "architecture") {
      // Architecture-remediation focus requires the exact current Architecture.
      if (!isRecord(runArchitecture) || typeof runArchitecture["revision"] !== "number") {
        throw corrupt(`run ${planID} focuses architecture remediation with no committed Architecture`);
      }
      if (run["stage"] !== "detail") {
        throw corrupt(`run ${planID} focuses architecture remediation outside stage=detail`);
      }
    }
    if (run["lifecycle"] === "aborted") {
      if (run["stage"] === "final") {
        throw corrupt(`run ${planID} is aborted at stage=final (aborted runs never reach final)`);
      }
      if (activeWork !== undefined) {
        throw corrupt(`run ${planID} is aborted but still carries activeWork`);
      }
    }
    // Phase 7B §5-§7/§97 — the handoff protocol marker fails CLOSED on any
    // contradiction. Absence is pre-cutover history (legacy_v0_1); an unknown
    // value is corrupt; a supervised marker may never coexist with legacy
    // free-Build handoff artifacts; a legacy run may never carry supervised
    // execution state.
    const protocolValue = run["handoffProtocol"];
    let protocol: "legacy_v0_1" | "supervised_v0_2";
    if (protocolValue === undefined || protocolValue === null) {
      protocol = "legacy_v0_1";
    } else if (
      typeof protocolValue === "string" &&
      (["legacy_v0_1", "supervised_v0_2"] as readonly string[]).includes(protocolValue)
    ) {
      protocol = protocolValue as "legacy_v0_1" | "supervised_v0_2";
    } else {
      throw corrupt(`run ${planID} carries unknown handoffProtocol ${JSON.stringify(protocolValue)}`, {
        planID,
        handoffProtocol: protocolValue,
      });
    }
    const replanProvenance = run["replanProvenance"];
    if (replanProvenance !== undefined && !isRecord(replanProvenance)) {
      throw corrupt(`run ${planID} carries a malformed replanProvenance`, { planID });
    }
    const legacyHandoffs = isRecord((doc as { executionHandoffs?: unknown }).executionHandoffs)
      ? ((doc as { executionHandoffs: Record<string, Record<string, unknown>> }).executionHandoffs[planID] as Record<string, unknown> | undefined) ?? {}
      : {};
    const legacyDeliveries = isRecord((doc as { handoffDeliveries?: unknown }).handoffDeliveries)
      ? ((doc as { handoffDeliveries: Record<string, Record<string, unknown>> }).handoffDeliveries[planID] as Record<string, unknown> | undefined) ?? {}
      : {};
    if (protocol === "supervised_v0_2" && (Object.keys(legacyHandoffs).length > 0 || Object.keys(legacyDeliveries).length > 0)) {
      throw corrupt(
        `run ${planID} durably selected the supervised_v0_2 handoff protocol but carries legacy free-Build handoff artifacts`,
        { planID, handoffs: Object.keys(legacyHandoffs), deliveries: Object.keys(legacyDeliveries) },
      );
    }
    const executionRunRecords = isRecord((doc as { executionRuns?: unknown }).executionRuns)
      ? ((doc as { executionRuns: Record<string, Record<string, unknown>> }).executionRuns) as Record<string, Record<string, unknown>>
      : {};
    const supervisedRunsForPlan = Object.values(executionRunRecords).filter(
      (executionRun) => executionRun["planID"] === planID,
    );
    if (protocol === "legacy_v0_1" && supervisedRunsForPlan.length > 0) {
      throw corrupt(
        `run ${planID} is a legacy (pre-marker) handoff but carries supervised execution state (${supervisedRunsForPlan.length} ExecutionRun(s))`,
        { planID, executionRunIDs: supervisedRunsForPlan.map((executionRun) => String(executionRun["id"])) },
      );
    }
  }

  // Snapshot section roots (Phase 2D, additive optional field): when present,
  // each root must be a well-shaped record. Absence is legitimate — snapshots
  // created before decomposition-carrying commits simply have no section
  // roots, and absence is never backfilled.
  for (const [planID, family] of Object.entries(snapshots)) {
    if (!isRecord(family)) throw corrupt(`snapshot family ${planID} is not an object`);
    for (const [snapshotID, snapshot] of Object.entries(family)) {
      if (!isRecord(snapshot)) throw corrupt(`snapshot ${snapshotID} is not an object`);
      const state = snapshot["state"];
      if (!isRecord(state)) continue; // deeper shape stays with the domain layer
      const roots = state["sectionRoots"];
      if (roots === undefined) continue;
      if (!Array.isArray(roots)) {
        throw corrupt(`snapshot ${snapshotID} has a malformed sectionRoots field`, { planID, snapshotID });
      }
      for (const root of roots) {
        if (!isRecord(root) || typeof root["id"] !== "string") {
          throw corrupt(`snapshot ${snapshotID} has a malformed section root entry`, { planID, snapshotID });
        }
        // Phase 2E1 (additive): checkpoint pointers, when present, must be
        // positive integers. Absence stays legitimate (pre-checkpoint roots).
        for (const pointer of ["currentRevision", "approvedRevision"]) {
          const value = root[pointer];
          if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
            throw corrupt(`snapshot ${snapshotID} has a malformed section root ${pointer}`, {
              planID,
              snapshotID,
            });
          }
        }
      }
      // Phase 2E2 (additive): the workflow focus, when present, must be a
      // well-shaped WorkRef — a section focus carries the Section id; the R1b
      // architecture-remediation focus is the bare {type:"architecture"}.
      // Absence is legitimate (pre-decomposition snapshots and the final
      // completion that cleared the focus).
      const activeWork = state["activeWork"];
      if (activeWork !== undefined) {
        const shapeOk =
          isRecord(activeWork) &&
          (activeWork["type"] === "architecture" ||
            (activeWork["type"] === "section" &&
              typeof activeWork["id"] === "string" &&
              activeWork["id"].length > 0));
        if (!shapeOk) {
          throw corrupt(`snapshot ${snapshotID} has a malformed activeWork field`, { planID, snapshotID });
        }
      }
    }
  }

  // Commits reference existing snapshots and existing parents.
  for (const [planID, family] of Object.entries(commits)) {
    if (!isRecord(family)) throw corrupt(`commit family ${planID} is not an object`);
    for (const [commitID, commit] of Object.entries(family)) {
      if (!isRecord(commit)) throw corrupt(`commit ${commitID} is not an object`);
      const resultingSnapshot = commit["resultingSnapshot"];
      const snapshotFamily = snapshots[planID];
      if (!isRecord(snapshotFamily) || !isRecord(snapshotFamily[resultingSnapshot as string])) {
        throw corrupt(`commit ${commitID} references missing snapshot ${String(resultingSnapshot)}`, {
          planID,
          commitID,
        });
      }
      const parent = commit["parentCommit"];
      if (parent !== null && (typeof parent !== "string" || !(parent in family))) {
        throw corrupt(`commit ${commitID} references missing parent commit ${String(parent)}`, {
          planID,
          commitID,
        });
      }
    }
  }

  // Proposal hashes must recompute (corrupt payload fails closed; brief §24).
  for (const [planID, family] of Object.entries(proposals)) {
    if (!isRecord(family)) throw corrupt(`proposal family ${planID} is not an object`);
    for (const [proposalID, proposal] of Object.entries(family)) {
      if (!isRecord(proposal)) throw corrupt(`proposal ${proposalID} is not an object`);
      const hash = proposal["hash"];
      if (typeof hash !== "string" || hash.length === 0) {
        throw corrupt(`proposal ${proposalID} is missing its approval hash`, { planID, proposalID });
      }
      if (approvalHashForDoc(proposal) !== hash) {
        throw corrupt(`proposal ${proposalID} content does not recompute to its frozen hash`, {
          planID,
          proposalID,
        });
      }
    }
  }

  // Approvals must bind to an existing proposal with matching id/revision/hash.
  for (const [planID, family] of Object.entries(approvals)) {
    if (!isRecord(family)) throw corrupt(`approval family ${planID} is not an object`);
    for (const [approvalID, approval] of Object.entries(family)) {
      if (!isRecord(approval)) throw corrupt(`approval ${approvalID} is not an object`);
      const proposalID = approval["proposalID"];
      const proposalFamily = proposals[planID];
      const proposal = isRecord(proposalFamily) ? proposalFamily[proposalID as string] : undefined;
      if (!isRecord(proposal)) {
        throw corrupt(`approval ${approvalID} references missing proposal ${String(proposalID)}`, {
          planID,
          approvalID,
        });
      }
      if (
        approval["proposalRevision"] !== proposal["revision"] ||
        approval["proposalHash"] !== proposal["hash"]
      ) {
        throw corrupt(`approval ${approvalID} is inconsistent with proposal ${String(proposalID)}`, {
          planID,
          approvalID,
        });
      }
    }
  }

  // -- Phase 2F derived synthesis artifacts (fail-closed, brief §40) ---------
  // Both families are ADDITIVE and may be absent entirely (pre-2F documents).
  // When present: stored hashes must recompute exactly (never recalculated
  // and replaced), and every cross-reference must resolve.
  const synthesisInputs = isRecord(doc.synthesisInputs) ? doc.synthesisInputs : {};
  const synthesisManifests = isRecord(doc.synthesisManifests) ? doc.synthesisManifests : {};
  const SUPPORTED_SOURCE_KINDS = ["architecture", "section", "decision", "constraint", "question", "conflict", "evidence"];

  const validSourceRef = (ref: unknown): boolean => {
    if (!isRecord(ref) || !SUPPORTED_SOURCE_KINDS.includes(ref["kind"] as string)) return false;
    switch (ref["kind"]) {
      case "architecture":
        return true;
      case "section":
      case "decision":
      case "evidence":
        return (
          typeof ref["id"] === "string" &&
          ref["id"].length > 0 &&
          typeof ref["revision"] === "number" &&
          Number.isInteger(ref["revision"]) &&
          ref["revision"] >= 1
        );
      default:
        return typeof ref["id"] === "string" && ref["id"].length > 0;
    }
  };
  const validDerivedStatements = (statements: unknown): boolean =>
    Array.isArray(statements) &&
    statements.every(
      (statement) =>
        isRecord(statement) &&
        typeof statement["statement"] === "string" &&
        statement["statement"].length > 0 &&
        Array.isArray(statement["sources"]) &&
        (statement["sources"] as unknown[]).every(validSourceRef),
    );

  for (const [planID, family] of Object.entries(synthesisInputs)) {
    if (!isRecord(family)) throw corrupt(`synthesis input family ${planID} is not an object`);
    for (const [inputID, input] of Object.entries(family)) {
      if (!isRecord(input)) throw corrupt(`synthesis input ${inputID} is not an object`);
      if (typeof input["hash"] !== "string" || input["hash"].length === 0) {
        throw corrupt(`synthesis input ${inputID} is missing its canonical hash`, { planID, inputID });
      }
      // The stored hash must recompute from the exact authority payload
      // (id/createdAt excluded by contract) — corruption fails closed.
      const payload = {
        planID: input["planID"],
        baseSnapshot: input["baseSnapshot"],
        baseCommit: input["baseCommit"],
        architecture: input["architecture"],
        sections: input["sections"],
        decisions: input["decisions"],
        constraints: input["constraints"],
        questions: input["questions"],
        conflicts: input["conflicts"],
        evidence: input["evidence"],
      };
      if (computeSynthesisInputHash(payload as Parameters<typeof computeSynthesisInputHash>[0]) !== input["hash"]) {
        throw corrupt(`synthesis input ${inputID} content does not recompute to its frozen hash`, {
          planID,
          inputID,
        });
      }
    }
  }

  for (const [planID, family] of Object.entries(synthesisManifests)) {
    if (!isRecord(family)) throw corrupt(`synthesis manifest family ${planID} is not an object`);
    /** manifest id → sorted revision list, for the chain check. */
    const revisionChains = new Map<string, number[]>();
    for (const [manifestKey, manifest] of Object.entries(family)) {
      if (!isRecord(manifest)) throw corrupt(`synthesis manifest ${manifestKey} is not an object`);
      const id = manifest["id"];
      const revision = manifest["revision"];
      if (typeof id !== "string" || id.length === 0 || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
        throw corrupt(`synthesis manifest ${manifestKey} has a malformed identity`, { planID });
      }
      if (manifestKey !== `${id}@${revision}`) {
        throw corrupt(`synthesis manifest key ${manifestKey} does not match its identity ${id}@${String(revision)}`, { planID });
      }
      const list = revisionChains.get(id) ?? [];
      list.push(revision);
      revisionChains.set(id, list);

      if (typeof manifest["hash"] !== "string" || manifest["hash"].length === 0) {
        throw corrupt(`synthesis manifest ${manifestKey} is missing its canonical hash`, { planID });
      }
      // The referenced input must exist and the manifest must mirror it
      // exactly (brief §40): baseSnapshot, architecture, and section set.
      const inputID = (manifest["input"] as Record<string, unknown> | undefined)?.["inputID"] ?? (manifest["input"] as Record<string, unknown> | undefined)?.["id"];
      const inputFamily = synthesisInputs[planID];
      const input = isRecord(inputFamily) ? inputFamily[inputID as string] : undefined;
      if (!isRecord(input)) {
        throw corrupt(`synthesis manifest ${manifestKey} references missing synthesis input ${String(inputID)}`, {
          planID,
          manifestKey,
        });
      }
      if (
        stableStringifyForDoc(manifest["baseSnapshot"]) !== stableStringifyForDoc(input["baseSnapshot"]) ||
        stableStringifyForDoc(manifest["architecture"]) !== stableStringifyForDoc(input["architecture"]) ||
        stableStringifyForDoc(manifest["sections"]) !== stableStringifyForDoc(input["sections"])
      ) {
        throw corrupt(`synthesis manifest ${manifestKey} does not mirror its synthesis input ${String(inputID)}`, {
          planID,
          manifestKey,
        });
      }
      if (manifest["inputHash"] !== input["hash"]) {
        throw corrupt(`synthesis manifest ${manifestKey} carries a mismatched inputHash`, { planID, manifestKey });
      }
      // The derived content must recompute to the frozen hash (id/revision/
      // createdAt excluded by contract).
      if (
        computeSynthesisManifestHashFromRecord({
          input: { id: inputID as never },
          baseSnapshot: manifest["baseSnapshot"] as never,
          inputHash: manifest["inputHash"] as string,
          architecture: manifest["architecture"] as never,
          sections: manifest["sections"] as never,
          crossSectionLinks: manifest["crossSectionLinks"] as never,
          implementationOrder: manifest["implementationOrder"] as never,
          limitations: manifest["limitations"] as never,
          unresolvedFindings: manifest["unresolvedFindings"] as never,
        }) !== manifest["hash"]
      ) {
        throw corrupt(`synthesis manifest ${manifestKey} content does not recompute to its frozen hash`, {
          planID,
          manifestKey,
        });
      }
      // Shape gates: derived statements + provenance ref forms.
      if (!validDerivedStatements(manifest["crossSectionLinks"])) {
        throw corrupt(`synthesis manifest ${manifestKey} has malformed crossSectionLinks`, { planID, manifestKey });
      }
      if (!validDerivedStatements(manifest["limitations"])) {
        throw corrupt(`synthesis manifest ${manifestKey} has malformed limitations`, { planID, manifestKey });
      }
      if (
        !Array.isArray(manifest["implementationOrder"]) ||
        (manifest["implementationOrder"] as unknown[]).some(
          (step, index) =>
            !isRecord(step) ||
            typeof step["title"] !== "string" ||
            typeof step["description"] !== "string" ||
            step["order"] !== index + 1 ||
            !Array.isArray(step["sections"]) ||
            !(step["sections"] as unknown[]).every(
              (ref) =>
                isRecord(ref) &&
                typeof ref["id"] === "string" &&
                typeof ref["revision"] === "number" &&
                Number.isInteger(ref["revision"]),
            ) ||
            !Array.isArray(step["sources"]) ||
            !(step["sources"] as unknown[]).every(validSourceRef),
        )
      ) {
        throw corrupt(`synthesis manifest ${manifestKey} has a malformed implementationOrder`, { planID, manifestKey });
      }
      if (
        !Array.isArray(manifest["unresolvedFindings"]) ||
        (manifest["unresolvedFindings"] as unknown[]).some(
          (finding) =>
            !isRecord(finding) ||
            typeof finding["statement"] !== "string" ||
            finding["statement"].length === 0 ||
            !SYNTHESIS_FINDING_CATEGORIES.includes(finding["category"] as never) ||
            (finding["sources"] !== undefined &&
              (!Array.isArray(finding["sources"]) || !(finding["sources"] as unknown[]).every(validSourceRef))),
        )
      ) {
        throw corrupt(`synthesis manifest ${manifestKey} has malformed unresolvedFindings`, { planID, manifestKey });
      }
    }
    // Immutable revision chain: each manifest id carries contiguous 1..n.
    for (const [id, revisions] of revisionChains) {
      revisions.sort((a, b) => a - b);
      for (let index = 0; index < revisions.length; index++) {
        if (revisions[index] !== index + 1) {
          throw corrupt(`synthesis manifest ${id} has a broken revision chain (${revisions.join(", ")})`, { planID });
        }
      }
    }
  }

  // -- Phase 2G semantic validation (fail-closed, brief §29) ------------------
  // ADDITIVE family, may be absent entirely (pre-2G documents = "semantic
  // validation has never run"). When present, every stored report must
  // recompute its hash, bind an existing input/manifest pair exactly, and
  // carry structurally exact findings. No auto-repair.
  const validationReports = isRecord(doc.validationReports) ? doc.validationReports : {};
  const manifestFamilyFor = (planID: string): Record<string, unknown> =>
    (isRecord(synthesisManifests[planID]) ? synthesisManifests[planID] : {}) as Record<string, unknown>;

  /** Doc-level exact resolution of a source ref against a stored input record. */
  const sourceResolvesAgainstInput = (ref: unknown, input: Record<string, unknown>): boolean => {
    if (!isRecord(ref)) return false;
    switch (ref["kind"]) {
      case "architecture":
        return true;
      case "section": {
        const sections = Array.isArray(input["sections"]) ? input["sections"] : [];
        return sections.some(
          (section) =>
            isRecord(section) &&
            isRecord(section["ref"]) &&
            (section["ref"] as Record<string, unknown>)["id"] === ref["id"] &&
            (section["ref"] as Record<string, unknown>)["revision"] === ref["revision"],
        );
      }
      case "decision": {
        const decisions = Array.isArray(input["decisions"]) ? input["decisions"] : [];
        return decisions.some(
          (decision) => isRecord(decision) && decision["id"] === ref["id"] && decision["revision"] === ref["revision"],
        );
      }
      case "constraint": {
        const constraints = Array.isArray(input["constraints"]) ? input["constraints"] : [];
        return constraints.some((constraint) => isRecord(constraint) && constraint["id"] === ref["id"]);
      }
      case "question": {
        const questions = Array.isArray(input["questions"]) ? input["questions"] : [];
        return questions.some((question) => isRecord(question) && question["id"] === ref["id"]);
      }
      case "conflict": {
        const conflicts = Array.isArray(input["conflicts"]) ? input["conflicts"] : [];
        return conflicts.some((conflict) => isRecord(conflict) && conflict["id"] === ref["id"]);
      }
      case "evidence": {
        const evidence = Array.isArray(input["evidence"]) ? input["evidence"] : [];
        return evidence.some(
          (record) => isRecord(record) && record["id"] === ref["id"] && record["revision"] === ref["revision"],
        );
      }
      default:
        return false;
    }
  };

  for (const [planID, family] of Object.entries(validationReports)) {
    if (!isRecord(family)) throw corrupt(`validation report family ${planID} is not an object`);
    const inputFamily = isRecord(synthesisInputs[planID]) ? synthesisInputs[planID] : {};
    const manifests = manifestFamilyFor(planID);
    for (const [reportID, report] of Object.entries(family)) {
      if (!isRecord(report)) throw corrupt(`validation report ${reportID} is not an object`);
      if (report["id"] !== reportID) {
        throw corrupt(`validation report key ${reportID} does not match its identity`, { planID });
      }
      // Exact input/manifest binding (§29): both exist, hashes match, the
      // manifest belongs to the input, baseSnapshot mirrors the input.
      const inputID = (isRecord(report["input"]) ? (report["input"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      const input = isRecord(inputFamily[inputID as string]) ? (inputFamily[inputID as string] as Record<string, unknown>) : undefined;
      if (!input) {
        throw corrupt(`validation report ${reportID} references missing synthesis input ${String(inputID)}`, { planID });
      }
      if (report["inputHash"] !== input["hash"]) {
        throw corrupt(`validation report ${reportID} carries a mismatched inputHash`, { planID, reportID });
      }
      const manifestRef = isRecord(report["manifest"]) ? (report["manifest"] as Record<string, unknown>) : undefined;
      const manifestKey = manifestRef ? `${manifestRef["id"]}@${manifestRef["revision"]}` : undefined;
      const manifest = manifestKey && isRecord(manifests[manifestKey]) ? (manifests[manifestKey] as Record<string, unknown>) : undefined;
      if (!manifest) {
        throw corrupt(`validation report ${reportID} references missing synthesis manifest ${String(manifestKey)}`, {
          planID,
          reportID,
        });
      }
      if (report["manifestHash"] !== manifest["hash"]) {
        throw corrupt(`validation report ${reportID} carries a mismatched manifestHash`, { planID, reportID });
      }
      if ((manifest["input"] as Record<string, unknown> | undefined)?.["id"] !== inputID) {
        throw corrupt(`validation report ${reportID} binds a manifest from another synthesis input`, { planID, reportID });
      }
      if (stableStringifyForDoc(report["baseSnapshot"]) !== stableStringifyForDoc(input["baseSnapshot"])) {
        throw corrupt(`validation report ${reportID} baseSnapshot does not match its input`, { planID, reportID });
      }
      if (typeof report["validatorProtocol"] !== "string" || report["validatorProtocol"].length === 0) {
        throw corrupt(`validation report ${reportID} is missing its validator protocol`, { planID, reportID });
      }
      if (
        report["validatorModel"] !== undefined &&
        (typeof report["validatorModel"] !== "string" || report["validatorModel"].length === 0)
      ) {
        throw corrupt(`validation report ${reportID} carries a malformed validatorModel`, { planID, reportID });
      }
      // Result + cardinality (§29) + the §13 clean-forbidden rule.
      const result = report["result"];
      const findings = report["findings"];
      if (result !== "clean" && result !== "findings") {
        throw corrupt(`validation report ${reportID} carries an invalid result`, { planID, reportID });
      }
      if (!Array.isArray(findings)) {
        throw corrupt(`validation report ${reportID} findings is not an array`, { planID, reportID });
      }
      if (result === "clean" && findings.length > 0) {
        throw corrupt(`validation report ${reportID} is clean but carries findings`, { planID, reportID });
      }
      if (result === "findings" && findings.length === 0) {
        throw corrupt(`validation report ${reportID} has findings but an empty findings array`, { planID, reportID });
      }
      const unresolved = Array.isArray(manifest["unresolvedFindings"]) ? (manifest["unresolvedFindings"] as unknown[]).length : 0;
      if (result === "clean" && unresolved > 0) {
        throw corrupt(
          `validation report ${reportID} is clean while its manifest declares ${unresolved} unresolved finding(s)`,
          { planID, reportID },
        );
      }
      // Finding shape + exact scope/manifest-item/source resolution.
      for (const finding of findings as unknown[]) {
        if (!isRecord(finding)) throw corrupt(`validation report ${reportID} has a malformed finding`, { planID, reportID });
        if (typeof finding["id"] !== "string" || finding["id"].length === 0) {
          throw corrupt(`validation report ${reportID} has a finding without a Harness-assigned id`, { planID, reportID });
        }
        if (!SEMANTIC_FINDING_CATEGORIES.includes(finding["category"] as never)) {
          throw corrupt(`validation report ${reportID} has a finding with an unsupported category`, { planID, reportID });
        }
        if (typeof finding["statement"] !== "string" || finding["statement"].length === 0) {
          throw corrupt(`validation report ${reportID} has a finding without a statement`, { planID, reportID });
        }
        const scope = finding["scope"];
        if (!isRecord(scope)) throw corrupt(`validation report ${reportID} has a finding without a scope`, { planID, reportID });
        let scopeBound = false;
        if (scope["architecture"] !== undefined) {
          const arch = scope["architecture"];
          if (
            !isRecord(arch) ||
            arch["id"] !== "ARCH" ||
            arch["revision"] !== (isRecord(input["architecture"]) ? (input["architecture"] as Record<string, unknown>)["revision"] : undefined)
          ) {
            throw corrupt(`validation report ${reportID} has a finding citing a non-input architecture revision`, { planID, reportID });
          }
          scopeBound = true;
        }
        if (scope["sections"] !== undefined) {
          const sections = scope["sections"];
          if (!Array.isArray(sections)) {
            throw corrupt(`validation report ${reportID} has a finding with malformed scope sections`, { planID, reportID });
          }
          for (const sectionRef of sections) {
            if (!sourceResolvesAgainstInput({ kind: "section", ...(isRecord(sectionRef) ? sectionRef : {}) }, input)) {
              throw corrupt(`validation report ${reportID} has a finding citing non-input section ${JSON.stringify(sectionRef)}`, {
                planID,
                reportID,
              });
            }
          }
          if ((sections as unknown[]).length > 0) scopeBound = true;
        }
        if (!scopeBound) {
          throw corrupt(`validation report ${reportID} has a finding without an affected scope`, { planID, reportID });
        }
        if (finding["manifestItem"] !== undefined) {
          const item = finding["manifestItem"];
          if (!isRecord(item)) {
            throw corrupt(`validation report ${reportID} has a malformed manifestItem`, { planID, reportID });
          }
          const withinBounds =
            (item["kind"] === "cross_section_link" &&
              typeof item["index"] === "number" &&
              item["index"] >= 1 &&
              item["index"] <= (Array.isArray(manifest["crossSectionLinks"]) ? (manifest["crossSectionLinks"] as unknown[]).length : 0)) ||
            (item["kind"] === "implementation_step" &&
              Array.isArray(manifest["implementationOrder"]) &&
              (manifest["implementationOrder"] as unknown[]).some(
                (step) => isRecord(step) && step["order"] === item["order"],
              )) ||
            (item["kind"] === "limitation" &&
              typeof item["index"] === "number" &&
              item["index"] >= 1 &&
              item["index"] <= (Array.isArray(manifest["limitations"]) ? (manifest["limitations"] as unknown[]).length : 0)) ||
            (item["kind"] === "synthesis_finding" &&
              typeof item["index"] === "number" &&
              item["index"] >= 1 &&
              item["index"] <= unresolved);
          if (!withinBounds) {
            throw corrupt(`validation report ${reportID} has a finding citing a nonexistent manifest item`, { planID, reportID });
          }
        }
        if (finding["sources"] !== undefined) {
          const sources = finding["sources"];
          if (!Array.isArray(sources)) {
            throw corrupt(`validation report ${reportID} has a finding with malformed sources`, { planID, reportID });
          }
          for (const source of sources) {
            if (!validSourceRef(source) || !sourceResolvesAgainstInput(source, input)) {
              throw corrupt(`validation report ${reportID} has a finding citing a source outside its input`, { planID, reportID });
            }
          }
        }
      }
      // The stored hash must recompute (id/createdAt excluded by contract).
      if (
        computeValidationReportHashFromRecord({
          planID: report["planID"] as ValidationReport["planID"],
          input: report["input"] as ValidationReport["input"],
          inputHash: report["inputHash"] as string,
          manifest: report["manifest"] as ValidationReport["manifest"],
          manifestHash: report["manifestHash"] as string,
          baseSnapshot: report["baseSnapshot"] as ValidationReport["baseSnapshot"],
          validatorProtocol: report["validatorProtocol"] as string,
          ...(report["validatorModel"] !== undefined ? { validatorModel: report["validatorModel"] as string } : {}),
          result: report["result"] as ValidationReport["result"],
          findings: findings as SemanticValidationFinding[],
        }) !== report["hash"]
      ) {
        throw corrupt(`validation report ${reportID} content does not recompute to its frozen hash`, { planID, reportID });
      }
    }
  }

  // Admission records: transient but durable single-flight ownership (§32).
  const validationAdmissions = isRecord(doc.validationAdmissions) ? doc.validationAdmissions : {};
  for (const [planID, family] of Object.entries(validationAdmissions)) {
    if (!isRecord(family)) throw corrupt(`validation admission family ${planID} is not an object`);
    for (const [identityKey, admission] of Object.entries(family)) {
      if (!isRecord(admission)) throw corrupt(`validation admission ${identityKey} is not an object`);
      const parts = typeof identityKey === "string" ? identityKey.split("|") : [];
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        throw corrupt(`validation admission key ${identityKey} is not a validation identity`, { planID });
      }
      for (const field of ["admittedAt", "expiresAt"] as const) {
        if (typeof admission[field] !== "string" || (admission[field] as string).length === 0) {
          throw corrupt(`validation admission ${identityKey} is missing "${field}"`, { planID });
        }
      }
      if (Date.parse(admission["expiresAt"] as string) < Date.parse(admission["admittedAt"] as string)) {
        throw corrupt(`validation admission ${identityKey} expires before it was admitted`, { planID });
      }
    }
  }

  // -- Phase 2H finalization (fail-closed, brief §61/§62/§63) ------------------
  // Both families are ADDITIVE and may be absent entirely (pre-2H documents =
  // "finalization has never run"). When present: stored hashes must recompute
  // exactly, every cross-reference must resolve with matching hashes, evidence
  // entries must be exact, counts/result/blockers consistent, and the
  // candidate must be the exact projection of its bound authority objects.
  // No repair.
  const evidenceAudits = isRecord(doc.evidenceAudits) ? doc.evidenceAudits : {};
  const finalPlanCandidates = isRecord(doc.finalPlanCandidates) ? doc.finalPlanCandidates : {};

  /** Newest revision of one evidence id across a doc-level evidence family. */
  const latestEvidenceRevision = (family: Record<string, unknown>, id: string): number => {
    let highest = 0;
    for (const key of Object.keys(family)) {
      if (!key.startsWith(`${id}@`)) continue;
      const revision = Number(key.slice(id.length + 1));
      if (Number.isInteger(revision) && revision > highest) highest = revision;
    }
    return highest;
  };

  for (const [planID, family] of Object.entries(evidenceAudits)) {
    if (!isRecord(family)) throw corrupt(`evidence audit family ${planID} is not an object`);
    const inputFamily = isRecord(synthesisInputs[planID]) ? (synthesisInputs[planID] as Record<string, unknown>) : {};
    const manifests = manifestFamilyFor(planID);
    const reports = isRecord(validationReports[planID]) ? (validationReports[planID] as Record<string, unknown>) : {};
    const snapshots = isRecord((doc as { snapshots?: unknown }).snapshots)
      ? ((doc as { snapshots: Record<string, unknown> }).snapshots[planID] as Record<string, unknown> | undefined) ?? {}
      : {};
    const evidence = isRecord((doc as { evidence?: unknown }).evidence)
      ? ((doc as { evidence: Record<string, unknown> }).evidence[planID] as Record<string, unknown> | undefined) ?? {}
      : {};
    for (const [auditID, audit] of Object.entries(family)) {
      if (!isRecord(audit)) throw corrupt(`evidence audit ${auditID} is not an object`);
      if (audit["id"] !== auditID) {
        throw corrupt(`evidence audit key ${auditID} does not match its identity`, { planID });
      }
      // Hash recompute (§62).
      const auditRest = { ...audit } as Record<string, unknown>;
      delete auditRest["id"];
      delete auditRest["createdAt"];
      delete auditRest["hash"];
      if (
        computeEvidenceAuditHashFromRecord(auditRest as unknown as Parameters<typeof computeEvidenceAuditHashFromRecord>[0]) !==
        audit["hash"]
      ) {
        throw corrupt(`evidence audit ${auditID} content does not recompute to its frozen hash`, { planID, auditID });
      }
      // HEAD/base refs well-formed + resolvable (§62).
      const headSnapshot = (isRecord(audit["headSnapshot"]) ? (audit["headSnapshot"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      if (typeof headSnapshot !== "string" || !snapshots[headSnapshot]) {
        throw corrupt(`evidence audit ${auditID} references missing HEAD snapshot ${String(headSnapshot)}`, { planID, auditID });
      }
      // Input/manifest/report existence + exact hash mirrors (§62).
      const auditInputID = (isRecord(audit["synthesisInput"]) ? (audit["synthesisInput"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      const auditInputHash = isRecord(audit["synthesisInput"]) ? (audit["synthesisInput"] as Record<string, unknown>)["hash"] : undefined;
      const auditInput = isRecord(inputFamily[auditInputID as string]) ? (inputFamily[auditInputID as string] as Record<string, unknown>) : undefined;
      if (!auditInput || auditInputHash !== auditInput["hash"]) {
        throw corrupt(`evidence audit ${auditID} references missing synthesis input ${String(auditInputID)} (or a mismatched hash)`, { planID, auditID });
      }
      const auditManifestRef = isRecord(audit["synthesisManifest"]) ? (audit["synthesisManifest"] as Record<string, unknown>) : undefined;
      const auditManifestKey = auditManifestRef ? `${auditManifestRef["id"]}@${auditManifestRef["revision"]}` : undefined;
      const auditManifest = auditManifestKey && isRecord(manifests[auditManifestKey]) ? (manifests[auditManifestKey] as Record<string, unknown>) : undefined;
      if (
        !auditManifest ||
        auditManifestRef?.["hash"] !== auditManifest["hash"] ||
        (isRecord(auditManifest["input"]) ? (auditManifest["input"] as Record<string, unknown>)["id"] : undefined) !== auditInputID
      ) {
        throw corrupt(`evidence audit ${auditID} references missing synthesis manifest ${String(auditManifestKey)} (or a mismatched hash/binding)`, { planID, auditID });
      }
      const auditReportID = (isRecord(audit["validationReport"]) ? (audit["validationReport"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      const auditReport = isRecord(reports[auditReportID as string]) ? (reports[auditReportID as string] as Record<string, unknown>) : undefined;
      if (!auditReport || (audit["validationReport"] as Record<string, unknown>)["hash"] !== auditReport["hash"]) {
        throw corrupt(`evidence audit ${auditID} references missing validation report ${String(auditReportID)} (or a mismatched hash)`, { planID, auditID });
      }
      // Entries exact (§62): each entry resolves at its exact revision with
      // matching state, and reports the family's true newest revision.
      const entries = audit["entries"];
      if (!Array.isArray(entries)) throw corrupt(`evidence audit ${auditID} entries is not an array`, { planID, auditID });
      for (const entry of entries as unknown[]) {
        if (!isRecord(entry)) throw corrupt(`evidence audit ${auditID} has a malformed entry`, { planID, auditID });
        const entryRef = isRecord(entry["ref"]) ? (entry["ref"] as Record<string, unknown>) : undefined;
        const evidenceID = entryRef?.["id"] as string | undefined;
        const revision = entryRef?.["revision"];
        const recordKey = evidenceID !== undefined && typeof revision === "number" ? `${evidenceID}@${revision}` : undefined;
        const record = recordKey && isRecord(evidence[recordKey]) ? (evidence[recordKey] as Record<string, unknown>) : undefined;
        if (!record) {
          throw corrupt(`evidence audit ${auditID} entry ${String(evidenceID)}@${String(revision)} does not resolve`, { planID, auditID });
        }
        if (
          record["confidence"] !== entry["confidence"] ||
          record["criticality"] !== entry["criticality"] ||
          record["freshness"] !== entry["freshness"] ||
          record["status"] !== entry["status"]
        ) {
          throw corrupt(`evidence audit ${auditID} entry ${String(evidenceID)}@${String(revision)} state does not match the stored record`, { planID, auditID });
        }
        if (latestEvidenceRevision(evidence, evidenceID as string) < (entry["latestRevision"] as number)) {
          // Evidence grows monotonically: a HISTORICAL audit legitimately
          // records the newest revision AT AUDIT TIME (evidence is a separate
          // trust domain and may advance afterwards, brief §9) — the load
          // check only requires the record to never shrink below it.
          throw corrupt(`evidence audit ${auditID} entry ${String(evidenceID)} records a latest revision below the stored record`, { planID, auditID });
        }
      }
      // Consistency + fingerprint recompute (§62). Any structural violation
      // the shared guard throws is corruption at load time — fail closed.
      try {
        assertEvidenceAuditInternallyConsistent(audit as unknown as Parameters<typeof assertEvidenceAuditInternallyConsistent>[0]);
      } catch (error) {
        throw corrupt(`evidence audit ${auditID}: ${error instanceof Error ? error.message : String(error)}`, { planID, auditID });
      }
    }
  }

  for (const [planID, family] of Object.entries(finalPlanCandidates)) {
    if (!isRecord(family)) throw corrupt(`final plan candidate family ${planID} is not an object`);
    const inputFamily = isRecord(synthesisInputs[planID]) ? (synthesisInputs[planID] as Record<string, unknown>) : {};
    const manifests = manifestFamilyFor(planID);
    const reports = isRecord(validationReports[planID]) ? (validationReports[planID] as Record<string, unknown>) : {};
    const audits = isRecord(evidenceAudits[planID]) ? (evidenceAudits[planID] as Record<string, unknown>) : {};
    for (const [candidateKey, candidate] of Object.entries(family)) {
      if (!isRecord(candidate)) throw corrupt(`final plan candidate ${candidateKey} is not an object`);
      const candidateID = candidate["id"];
      const candidateRevision = candidate["revision"];
      if (
        typeof candidateID !== "string" ||
        candidateID.length === 0 ||
        typeof candidateRevision !== "number" ||
        !Number.isInteger(candidateRevision) ||
        candidateRevision < 1
      ) {
        throw corrupt(`final plan candidate ${candidateKey} has a malformed identity`, { planID });
      }
      if (candidateKey !== `${candidateID}@${candidateRevision}`) {
        throw corrupt(`final plan candidate key ${candidateKey} does not match its identity ${candidateID}@${String(candidateRevision)}`, { planID });
      }
      // Hash recompute (§63).
      const candidateRest = { ...candidate } as Record<string, unknown>;
      delete candidateRest["id"];
      delete candidateRest["revision"];
      delete candidateRest["createdAt"];
      delete candidateRest["hash"];
      if (
        computeFinalPlanCandidateHashFromRecord(candidateRest as unknown as Parameters<typeof computeFinalPlanCandidateHashFromRecord>[0]) !==
        candidate["hash"]
      ) {
        throw corrupt(`final plan candidate ${candidateKey} content does not recompute to its frozen hash`, { planID, candidateKey });
      }
      // Bound authority: audit pass + clean report + exact input/manifest (§63).
      const auditRef = isRecord(candidate["evidenceAudit"]) ? (candidate["evidenceAudit"] as Record<string, unknown>) : undefined;
      const audit = auditRef && isRecord(audits[auditRef["id"] as string]) ? (audits[auditRef["id"] as string] as Record<string, unknown>) : undefined;
      if (!audit || auditRef?.["hash"] !== audit["hash"]) {
        throw corrupt(`final plan candidate ${candidateKey} references missing evidence audit ${String(auditRef?.["id"])}`, { planID, candidateKey });
      }
      if (audit["result"] !== "pass") {
        throw corrupt(`final plan candidate ${candidateKey} references a ${String(audit["result"])} evidence audit`, { planID, candidateKey });
      }
      const inputID = (isRecord(candidate["synthesisInput"]) ? (candidate["synthesisInput"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      const boundInput = isRecord(inputFamily[inputID as string]) ? (inputFamily[inputID as string] as Record<string, unknown>) : undefined;
      if (!boundInput || (candidate["synthesisInput"] as Record<string, unknown>)["hash"] !== boundInput["hash"]) {
        throw corrupt(`final plan candidate ${candidateKey} references missing synthesis input ${String(inputID)} (or a mismatched hash)`, { planID, candidateKey });
      }
      const manifestRef = isRecord(candidate["synthesisManifest"]) ? (candidate["synthesisManifest"] as Record<string, unknown>) : undefined;
      const manifestKey = manifestRef ? `${manifestRef["id"]}@${manifestRef["revision"]}` : undefined;
      const boundManifest = manifestKey && isRecord(manifests[manifestKey]) ? (manifests[manifestKey] as Record<string, unknown>) : undefined;
      if (!boundManifest || manifestRef?.["hash"] !== boundManifest["hash"]) {
        throw corrupt(`final plan candidate ${candidateKey} references missing synthesis manifest ${String(manifestKey)}`, { planID, candidateKey });
      }
      const reportID = (isRecord(candidate["semanticValidation"]) ? (candidate["semanticValidation"] as Record<string, unknown>)["reportID"] : undefined) as string | undefined;
      const boundReport = isRecord(reports[reportID as string]) ? (reports[reportID as string] as Record<string, unknown>) : undefined;
      if (!boundReport || (candidate["semanticValidation"] as Record<string, unknown>)["hash"] !== boundReport["hash"] || boundReport["result"] !== "clean") {
        throw corrupt(`final plan candidate ${candidateKey} references missing/non-clean validation report ${String(reportID)}`, { planID, candidateKey });
      }
      // Exact projection mirrors (§63): snapshot/commit, architecture,
      // sections, decisions, constraints, implementationOrder, limitations.
      const docEqual = (a: unknown, b: unknown): boolean => stableStringifyForDoc(a) === stableStringifyForDoc(b);
      const sectionRefs = Array.isArray(boundInput["sections"])
        ? (boundInput["sections"] as unknown[]).map((section) => (isRecord(section) ? section["ref"] : undefined))
        : [];
      if (
        !docEqual(candidate["baseSnapshot"], boundInput["baseSnapshot"]) ||
        candidate["baseCommit"] !== boundInput["baseCommit"] ||
        !docEqual(candidate["architecture"], boundInput["architecture"]) ||
        !docEqual(candidate["sections"], sectionRefs) ||
        !docEqual(candidate["decisions"], boundInput["decisions"]) ||
        !docEqual(candidate["constraints"], boundInput["constraints"]) ||
        !docEqual(candidate["implementationOrder"], boundManifest["implementationOrder"]) ||
        !docEqual(candidate["limitations"], boundManifest["limitations"])
      ) {
        throw corrupt(`final plan candidate ${candidateKey} is not the exact projection of its bound authority objects`, { planID, candidateKey });
      }
      const validation = candidate["validation"];
      if (
        !isRecord(validation) ||
        validation["blockingQuestions"] !== 0 ||
        validation["blockingConflicts"] !== 0 ||
        validation["invalidSections"] !== 0 ||
        validation["semanticValidation"] !== "clean" ||
        validation["evidenceAudit"] !== "pass"
      ) {
        throw corrupt(`final plan candidate ${candidateKey} carries an inconsistent validation summary`, { planID, candidateKey });
      }
    }
  }

  // -- Phase 2I committed FinalPlans (fail-closed, brief §70-§74) --------------
  // ADDITIVE family (pre-2I documents = "no Final PlanCommit has happened").
  // A FinalPlan is COMMITTED Plan Memory, so load validation proves the full
  // chain: hash + body projection recompute (§70), every exact ref resolves,
  // the bound candidate/input/manifest/report/audit exist with matching hashes
  // and the clean/pass results (§70), the payload is still the exact
  // deterministic projection of its candidate (§73 mutation cases), and the
  // run-pointer/commit/snapshot triangle is consistent (§71/§72/§74). No repair.
  const finalPlans = isRecord(doc.finalPlans) ? doc.finalPlans : {};
  const committedFamilies = isRecord(doc.committed) ? doc.committed : {};

  for (const [planID, family] of Object.entries(finalPlans)) {
    if (!isRecord(family)) throw corrupt(`final plan family ${planID} is not an object`);
    const candidateFamily = isRecord(finalPlanCandidates[planID]) ? (finalPlanCandidates[planID] as Record<string, unknown>) : {};
    const inputFamily2 = isRecord(synthesisInputs[planID]) ? (synthesisInputs[planID] as Record<string, unknown>) : {};
    const manifests2 = manifestFamilyFor(planID);
    const reports2 = isRecord(validationReports[planID]) ? (validationReports[planID] as Record<string, unknown>) : {};
    const audits2 = isRecord(evidenceAudits[planID]) ? (evidenceAudits[planID] as Record<string, unknown>) : {};
    const committed = isRecord(committedFamilies[planID]) ? (committedFamilies[planID] as Record<string, unknown>) : {};
    const architectures2 = isRecord(committed["architectures"]) ? (committed["architectures"] as Record<string, unknown>) : {};
    const sectionRevisions2 = isRecord(committed["sectionRevisions"]) ? (committed["sectionRevisions"] as Record<string, unknown>) : {};
    const decisions2 = isRecord(committed["decisions"]) ? (committed["decisions"] as Record<string, unknown>) : {};
    for (const [planKey, plan] of Object.entries(family)) {
      if (!isRecord(plan)) throw corrupt(`final plan ${planKey} is not an object`);
      const id = plan["id"];
      const revision = plan["revision"];
      if (typeof id !== "string" || id.length === 0 || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
        throw corrupt(`final plan ${planKey} has a malformed identity`, { planID });
      }
      if (planKey !== `${id}@${revision}`) {
        throw corrupt(`final plan key ${planKey} does not match its identity ${id}@${String(revision)}`, { planID });
      }
      if (plan["status"] !== "approved") {
        throw corrupt(`final plan ${planKey} is not approved; a committed FinalPlan exists only through an approved final transaction`, { planID, planKey });
      }
      if (typeof plan["approvedAt"] !== "string" || (plan["approvedAt"] as string).length === 0) {
        throw corrupt(`final plan ${planKey} is missing approvedAt (= the exact user Approval's createdAt)`, { planID, planKey });
      }
      // Hash + body projection recompute (§70/§14): the persisted body is a
      // hash-bound deterministic projection, never a second source of truth.
      const rest = { ...plan } as Record<string, unknown>;
      delete rest["hash"];
      if (
        computeFinalPlanHashFromContent(rest as unknown as Parameters<typeof computeFinalPlanHashFromContent>[0]) !==
        plan["hash"]
      ) {
        throw corrupt(`final plan ${planKey} content does not recompute to its frozen hash`, { planID, planKey });
      }
      try {
        if (renderFinalPlanBody(rest as unknown as Parameters<typeof renderFinalPlanBody>[0]) !== plan["body"]) {
          throw new Error("body differs from the deterministic projection of the structured payload");
        }
      } catch (error) {
        throw corrupt(`final plan ${planKey}: ${error instanceof Error ? error.message : String(error)}`, { planID, planKey });
      }
      // Bound candidate resolves with matching hash (§70).
      const candRef = isRecord(plan["finalPlanCandidate"]) ? (plan["finalPlanCandidate"] as Record<string, unknown>) : undefined;
      const candKey = candRef ? `${candRef["id"]}@${candRef["revision"]}` : undefined;
      const boundCandidate = candKey && isRecord(candidateFamily[candKey]) ? (candidateFamily[candKey] as Record<string, unknown>) : undefined;
      if (!boundCandidate || candRef?.["hash"] !== boundCandidate["hash"]) {
        throw corrupt(`final plan ${planKey} references missing final plan candidate ${String(candKey)}`, { planID, planKey });
      }
      // Derived provenance bindings resolve with matching hashes + results (§70).
      const inputRef = isRecord(plan["synthesisInput"]) ? (plan["synthesisInput"] as Record<string, unknown>) : undefined;
      const boundInput2 = inputRef && isRecord(inputFamily2[inputRef["id"] as string]) ? (inputFamily2[inputRef["id"] as string] as Record<string, unknown>) : undefined;
      if (!boundInput2 || inputRef?.["hash"] !== boundInput2["hash"]) {
        throw corrupt(`final plan ${planKey} references missing synthesis input ${String(inputRef?.["id"])}`, { planID, planKey });
      }
      const manRef = isRecord(plan["synthesisManifest"]) ? (plan["synthesisManifest"] as Record<string, unknown>) : undefined;
      const manKey = manRef ? `${manRef["id"]}@${manRef["revision"]}` : undefined;
      const boundManifest2 = manKey && isRecord(manifests2[manKey]) ? (manifests2[manKey] as Record<string, unknown>) : undefined;
      if (!boundManifest2 || manRef?.["hash"] !== boundManifest2["hash"]) {
        throw corrupt(`final plan ${planKey} references missing synthesis manifest ${String(manKey)}`, { planID, planKey });
      }
      const valRef = isRecord(plan["semanticValidation"]) ? (plan["semanticValidation"] as Record<string, unknown>) : undefined;
      const boundReport2 = valRef && isRecord(reports2[valRef["reportID"] as string]) ? (reports2[valRef["reportID"] as string] as Record<string, unknown>) : undefined;
      if (!boundReport2 || valRef?.["hash"] !== boundReport2["hash"] || valRef?.["result"] !== "clean" || boundReport2["result"] !== "clean") {
        throw corrupt(`final plan ${planKey} references a missing/non-clean validation report ${String(valRef?.["reportID"])}`, { planID, planKey });
      }
      const audRef = isRecord(plan["evidenceAudit"]) ? (plan["evidenceAudit"] as Record<string, unknown>) : undefined;
      const boundAudit2 = audRef && isRecord(audits2[audRef["id"] as string]) ? (audits2[audRef["id"] as string] as Record<string, unknown>) : undefined;
      if (!boundAudit2 || audRef?.["hash"] !== boundAudit2["hash"] || audRef?.["result"] !== "pass" || boundAudit2["result"] !== "pass") {
        throw corrupt(`final plan ${planKey} references a missing/blocked evidence audit ${String(audRef?.["id"])}`, { planID, planKey });
      }
      // Exact committed refs resolve (§70) + the payload is STILL the exact
      // deterministic projection of the bound candidate (§73 mutation cases:
      // tampered implementation order / limitations / section revisions /
      // constraints / architecture / provenance all differ from the candidate).
      const docEqual2 = (a: unknown, b: unknown): boolean => stableStringifyForDoc(a) === stableStringifyForDoc(b);
      if (docEqual2(plan["architecture"], boundCandidate["architecture"]) === false) {
        throw corrupt(`final plan ${planKey} architecture differs from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["sections"], boundCandidate["sections"]) === false) {
        throw corrupt(`final plan ${planKey} section refs differ from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["decisions"], boundCandidate["decisions"]) === false) {
        throw corrupt(`final plan ${planKey} decision refs differ from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["constraints"], boundCandidate["constraints"]) === false) {
        throw corrupt(`final plan ${planKey} constraints differ from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["implementationOrder"], boundCandidate["implementationOrder"]) === false) {
        throw corrupt(`final plan ${planKey} implementationOrder differs from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["limitations"], boundCandidate["limitations"]) === false) {
        throw corrupt(`final plan ${planKey} limitations differ from its bound candidate`, { planID, planKey });
      }
      if (
        docEqual2(plan["baseSnapshot"], boundCandidate["baseSnapshot"]) === false ||
        plan["baseCommit"] !== boundCandidate["baseCommit"] ||
        docEqual2(plan["synthesisInput"], boundCandidate["synthesisInput"]) === false ||
        docEqual2(plan["synthesisManifest"], boundCandidate["synthesisManifest"]) === false ||
        // semanticValidation/evidenceAudit legitimately carry the extra
        // committed `result` stamp ("clean"/"pass") — compare the binding
        // subset the candidate actually holds.
        (isRecord(plan["semanticValidation"]) && isRecord(boundCandidate["semanticValidation"])
          ? plan["semanticValidation"]["reportID"] !== boundCandidate["semanticValidation"]["reportID"] ||
            plan["semanticValidation"]["hash"] !== boundCandidate["semanticValidation"]["hash"] ||
            plan["semanticValidation"]["result"] !== "clean"
          : true) ||
        (isRecord(plan["evidenceAudit"]) && isRecord(boundCandidate["evidenceAudit"])
          ? plan["evidenceAudit"]["id"] !== boundCandidate["evidenceAudit"]["id"] ||
            plan["evidenceAudit"]["hash"] !== boundCandidate["evidenceAudit"]["hash"] ||
            plan["evidenceAudit"]["result"] !== "pass"
          : true)
      ) {
        throw corrupt(`final plan ${planKey} provenance differs from its bound candidate`, { planID, planKey });
      }
      const archRef = isRecord(plan["architecture"]) ? (plan["architecture"] as Record<string, unknown>) : undefined;
      if (!archRef || !architectures2[`ARCH@${archRef["revision"] as number}`]) {
        throw corrupt(`final plan ${planKey} architecture ARCH@${String(archRef?.["revision"])} does not resolve`, { planID, planKey });
      }
      for (const sectionRef of Array.isArray(plan["sections"]) ? (plan["sections"] as unknown[]) : []) {
        const ref = isRecord(sectionRef) ? sectionRef : undefined;
        if (!ref || !sectionRevisions2[`${ref["id"]}@${ref["revision"]}`]) {
          throw corrupt(`final plan ${planKey} section ${JSON.stringify(sectionRef)} does not resolve`, { planID, planKey });
        }
      }
      for (const decisionRef of Array.isArray(plan["decisions"]) ? (plan["decisions"] as unknown[]) : []) {
        const ref = isRecord(decisionRef) ? decisionRef : undefined;
        if (!ref || !decisions2[`${ref["id"]}@${ref["revision"]}`]) {
          throw corrupt(`final plan ${planKey} decision ${JSON.stringify(decisionRef)} does not resolve`, { planID, planKey });
        }
      }
    }
  }

  // Run-pointer / commit / snapshot consistency (§71/§72/§74) — impossible
  // states fail closed at load, never repaired.
  for (const [planID, run] of Object.entries(runs)) {
    if (!isRecord(run)) continue;
    const runFinalPlan = run["finalPlan"] as Record<string, unknown> | undefined | null;
    const family = isRecord(finalPlans[planID]) ? (finalPlans[planID] as Record<string, unknown>) : {};
    const familyKeys = Object.keys(family);
    if (runFinalPlan === undefined || runFinalPlan === null) {
      if (familyKeys.length > 0) {
        throw corrupt(`run ${planID} has committed FinalPlan(s) [${familyKeys.join(", ")}] but its finalPlan pointer is unset`, { planID });
      }
      continue;
    }
    const pointerKey = `${runFinalPlan["id"]}@${runFinalPlan["revision"]}`;
    if (!isRecord(family[pointerKey])) {
      throw corrupt(`run ${planID}.finalPlan references missing FinalPlan ${pointerKey}`, { planID });
    }
    if (familyKeys.length !== 1) {
      throw corrupt(`run ${planID} has ${familyKeys.length} committed FinalPlans for an initial-only family`, { planID });
    }
    if (run["lifecycle"] === "handoff_pending" || run["lifecycle"] === "completed") {
      const terminal = String(run["lifecycle"]);
      if (run["stage"] !== "final") {
        throw corrupt(`run ${planID} is ${terminal} but stage is ${String(run["stage"])} (must be final)`, { planID });
      }
      const headCommitID = run["headCommit"];
      const commitFamily = isRecord(commits[planID]) ? (commits[planID] as Record<string, unknown>) : {};
      const headCommit = typeof headCommitID === "string" ? commitFamily[headCommitID] : undefined;
      if (!isRecord(headCommit)) {
        throw corrupt(`${terminal} run ${planID} has no final PlanCommit at HEAD`, { planID });
      }
      const proposalFamily = isRecord(proposals[planID]) ? (proposals[planID] as Record<string, unknown>) : {};
      const commitProposal = proposalFamily[headCommit["proposalID"] as string];
      if (
        !isRecord(commitProposal) ||
        commitProposal["type"] !== "final_plan" ||
        commitProposal["status"] !== "approved"
      ) {
        throw corrupt(`${terminal} run ${planID}'s HEAD commit is not an approved final_plan transaction`, { planID });
      }
      const changes = headCommit["changes"];
      if (
        !Array.isArray(changes) ||
        !changes.some((change) => isRecord(change) && change["kind"] === "add_final_plan")
      ) {
        throw corrupt(`run ${planID}'s final PlanCommit does not record add_final_plan`, { planID });
      }
      const snapshotFamily2 = isRecord(snapshots[planID]) ? (snapshots[planID] as Record<string, unknown>) : {};
      const resultingSnapshot = snapshotFamily2[headCommit["resultingSnapshot"] as string];
      const snapshotState = isRecord(resultingSnapshot) ? resultingSnapshot["state"] : undefined;
      if (!isRecord(snapshotState) || snapshotState["finalPlanRevision"] !== runFinalPlan["revision"]) {
        throw corrupt(`run ${planID}'s final commit snapshot does not carry the committed finalPlan ref`, { planID });
      }
      const approvalFamily = isRecord(approvals[planID]) ? (approvals[planID] as Record<string, unknown>) : {};
      const approval = approvalFamily[headCommit["approvalID"] as string];
      if (!isRecord(approval) || approval["proposalID"] !== headCommit["proposalID"]) {
        throw corrupt(`run ${planID}'s final PlanCommit approval binding does not resolve`, { planID });
      }
      // §124: a completed LEGACY run REQUIRES its confirmed delivered
      // handoff. Phase 7B §16: a SUPERVISED run's completion means "handed to
      // a durable ACTIVE supervised ExecutionRun" — its proof is the
      // executionRuns family, never a legacy delivery record.
      if (run["lifecycle"] === "completed" && run["handoffProtocol"] !== "supervised_v0_2") {
        const deliveries = isRecord((doc as { handoffDeliveries?: unknown }).handoffDeliveries)
          ? ((doc as { handoffDeliveries: Record<string, Record<string, unknown>> }).handoffDeliveries[planID] as Record<string, unknown> | undefined) ?? {}
          : {};
        const hasDelivered = Object.values(deliveries).some(
          (delivery) => isRecord(delivery) && delivery["state"] === "delivered",
        );
        if (!hasDelivered) {
          throw corrupt(`completed run ${planID} has no delivered handoff delivery`, { planID });
        }
      }
    }
  }
  // An approved final_plan proposal must have its final commit (§74).
  for (const [planID, family] of Object.entries(proposals)) {
    if (!isRecord(family)) continue;
    const commitByProposalFamily = isRecord(doc.commitByProposal) ? doc.commitByProposal : {};
    const commitFamily = isRecord(commits[planID]) ? (commits[planID] as Record<string, unknown>) : {};
    for (const [proposalID, proposal] of Object.entries(family)) {
      if (!isRecord(proposal) || proposal["type"] !== "final_plan" || proposal["status"] !== "approved") continue;
      const commitID = commitByProposalFamily[`${planID}:${proposalID}`];
      const commit = typeof commitID === "string" ? commitFamily[commitID] : undefined;
      if (!isRecord(commit)) {
        throw corrupt(`approved final_plan proposal ${proposalID} has no corresponding final commit`, { planID });
      }
      const changes = commit["changes"];
      if (
        !Array.isArray(changes) ||
        !changes.some((change) => isRecord(change) && change["kind"] === "add_final_plan")
      ) {
        throw corrupt(`final commit ${String(commitID)} does not record add_final_plan`, { planID });
      }
    }
  }

  // -- Phase 2J runtime handoff (fail-closed, §86/§87/§122/§123) --------------
  // ADDITIVE families (pre-2J documents = "no handoff has ever been prepared").
  // The handoff projection must equal the committed FinalPlan; the delivery
  // must obey the state machine — a receipt on a non-delivered state, a
  // delivered without a receipt, or a wrong session/key all fail closed. No
  // silent delivery repair happens here (§88): dispatching stays dispatching.
  const executionHandoffs = isRecord(doc.executionHandoffs) ? doc.executionHandoffs : {};
  const handoffDeliveries = isRecord(doc.handoffDeliveries) ? doc.handoffDeliveries : {};

  for (const [planID, family] of Object.entries(executionHandoffs)) {
    if (!isRecord(family)) throw corrupt(`execution handoff family ${planID} is not an object`);
    if (Object.keys(family).length > 1) {
      throw corrupt(`plan ${planID} has ${Object.keys(family).length} canonical ExecutionHandoffs (one per FinalPlan, §16)`, { planID });
    }
    const planFamily = isRecord(finalPlans[planID]) ? (finalPlans[planID] as Record<string, unknown>) : {};
    const run = runs[planID];
    for (const [handoffID, handoff] of Object.entries(family)) {
      if (!isRecord(handoff)) throw corrupt(`execution handoff ${handoffID} is not an object`);
      if (handoff["id"] !== handoffID) {
        throw corrupt(`execution handoff key ${handoffID} does not match its identity`, { planID });
      }
      if (computeExecutionHandoffHashFromRecord(handoff as unknown as Parameters<typeof computeExecutionHandoffHashFromRecord>[0]) !== handoff["hash"]) {
        throw corrupt(`execution handoff ${handoffID} content does not recompute to its frozen hash`, { planID });
      }
      if (!isRecord(run)) throw corrupt(`execution handoff ${handoffID} references missing run ${planID}`, { planID });
      if (handoff["sessionID"] !== run["sessionID"]) {
        throw corrupt(`execution handoff ${handoffID} is bound to another session than run ${planID}`, { planID });
      }
      const planRef = isRecord(handoff["finalPlan"]) ? (handoff["finalPlan"] as Record<string, unknown>) : undefined;
      const planKey = planRef ? `${planRef["id"]}@${planRef["revision"]}` : undefined;
      const finalPlan = planKey && isRecord(planFamily[planKey]) ? (planFamily[planKey] as Record<string, unknown>) : undefined;
      if (!finalPlan || finalPlan["hash"] !== handoff["finalPlanHash"] || finalPlan["status"] !== "approved") {
        throw corrupt(`execution handoff ${handoffID} references a missing/mismatched FinalPlan ${String(planKey)}`, { planID });
      }
      if (handoff["finalCommit"] !== run["headCommit"] || (isRecord(handoff["finalSnapshot"]) ? (handoff["finalSnapshot"] as Record<string, unknown>)["id"] : undefined) !== run["headSnapshot"]) {
        throw corrupt(`execution handoff ${handoffID} final commit/snapshot disagrees with run ${planID} HEAD`, { planID });
      }
      // §86: the projection must equal the deterministic FinalPlan projection.
      const docEqual3 = (a: unknown, b: unknown): boolean => stableStringifyForDoc(a) === stableStringifyForDoc(b);
      if (
        !docEqual3(handoff["sections"], finalPlan["sections"]) ||
        !docEqual3(handoff["criticalDecisions"], finalPlan["decisions"]) ||
        !docEqual3(handoff["implementationSteps"], finalPlan["implementationOrder"]) ||
        !docEqual3(handoff["knownLimitations"], (Array.isArray(finalPlan["limitations"]) ? finalPlan["limitations"] : []).map((limitation) => (isRecord(limitation) ? limitation["statement"] : ""))) ||
        !docEqual3(handoff["architecture"], finalPlan["architecture"]) ||
        !docEqual3(handoff["hardConstraints"], (Array.isArray(finalPlan["constraints"]) ? finalPlan["constraints"] : []).filter(
          (constraint) => isRecord(constraint) && constraint["severity"] === "hard" && constraint["status"] === "active",
        ))
      ) {
        throw corrupt(`execution handoff ${handoffID} is not the exact deterministic projection of its FinalPlan`, { planID });
      }
    }
  }

  for (const [planID, family] of Object.entries(handoffDeliveries)) {
    if (!isRecord(family)) throw corrupt(`handoff delivery family ${planID} is not an object`);
    const handoffFamily = isRecord(executionHandoffs[planID]) ? (executionHandoffs[planID] as Record<string, unknown>) : {};
    const run = runs[planID];
    for (const [handoffID, delivery] of Object.entries(family)) {
      if (!isRecord(delivery)) throw corrupt(`handoff delivery ${handoffID} is not an object`);
      const handoff = isRecord(handoffFamily[handoffID]) ? (handoffFamily[handoffID] as Record<string, unknown>) : undefined;
      if (!handoff) {
        throw corrupt(`handoff delivery ${handoffID} references missing execution handoff`, { planID });
      }
      if (delivery["handoffHash"] !== handoff["hash"]) {
        throw corrupt(`handoff delivery ${handoffID} carries a mismatched handoff hash`, { planID });
      }
      const state = delivery["state"];
      if (state !== "prepared" && state !== "dispatching" && state !== "delivered") {
        throw corrupt(`handoff delivery ${handoffID} carries an invalid state ${String(state)}`, { planID });
      }
      if (typeof delivery["deliveryKey"] !== "string" || !isRecord(run)) {
        throw corrupt(`handoff delivery ${handoffID} has a malformed deliveryKey or run binding`, { planID });
      }
      if (delivery["deliveryKey"] !== handoffDeliveryKey(planID as never, handoffID as never, handoff["hash"] as string)) {
        throw corrupt(`handoff delivery ${handoffID} carries a non-deterministic deliveryKey`, { planID });
      }
      if (delivery["sessionID"] !== run["sessionID"]) {
        throw corrupt(`handoff delivery ${handoffID} is bound to another session than run ${planID}`, { planID });
      }
      if (typeof delivery["attempt"] !== "number" || (delivery["attempt"] as number) < 0) {
        throw corrupt(`handoff delivery ${handoffID} has a malformed attempt counter`, { planID });
      }
      const receipt = isRecord(delivery["hostReceipt"]) ? (delivery["hostReceipt"] as Record<string, unknown>) : undefined;
      if (state === "delivered") {
        if (!receipt || typeof receipt["sessionID"] !== "string" || typeof receipt["messageID"] !== "string" || receipt["messageID"].length === 0) {
          throw corrupt(`delivered handoff delivery ${handoffID} has no valid host receipt`, { planID });
        }
        if (receipt["sessionID"] !== run["sessionID"] || delivery["sessionID"] !== run["sessionID"]) {
          throw corrupt(`handoff delivery ${handoffID} receipt session mismatches the run's trusted session`, { planID });
        }
        if (typeof delivery["deliveredAt"] !== "string") {
          throw corrupt(`delivered handoff delivery ${handoffID} is missing deliveredAt`, { planID });
        }
      } else if (receipt !== undefined) {
        // §87: a prepared/dispatching delivery must not carry a fake receipt.
        throw corrupt(`${String(state)} handoff delivery ${handoffID} carries a host receipt before confirmation`, { planID });
      }
    }
  }

  // -- v0.2.0 Phase 1 ExecutionRun foundation (fail-closed) -------------------
  // ADDITIVE family (pre-execution documents = "no ExecutionRun was ever
  // prepared"). The authority binding is storage-validated: exact FinalPlan
  // identity + hash, non-empty workspace, known lifecycle, positive revision,
  // resolvable handoff-identity index, existing source PlanningRun. A
  // workspace-less run, an unknown lifecycle string, or a dangling index
  // entry fails store open — never repaired, never normalized.
  const executionRuns = isRecord(doc.executionRuns) ? doc.executionRuns : {};
  const executionRunByHandoffKey = isRecord(doc.executionRunByHandoffKey) ? doc.executionRunByHandoffKey : {};
  const seenHandoffIndexKeys = new Set<string>();

  for (const [executionRunID, executionRun] of Object.entries(executionRuns)) {
    if (!isRecord(executionRun)) throw corrupt(`execution run ${executionRunID} is not an object`);
    if (executionRun["id"] !== executionRunID) {
      throw corrupt(`execution run key ${executionRunID} does not match its identity`);
    }
    const lifecycle = executionRun["lifecycle"];
    if (typeof lifecycle !== "string" || !(EXECUTION_LIFECYCLES as readonly string[]).includes(lifecycle)) {
      throw corrupt(`execution run ${executionRunID} carries an invalid lifecycle ${String(lifecycle)}`);
    }
    if (typeof executionRun["revision"] !== "number" || !Number.isInteger(executionRun["revision"]) || (executionRun["revision"] as number) < 1) {
      throw corrupt(`execution run ${executionRunID} has a malformed revision`);
    }
    if (typeof executionRun["createdAt"] !== "string" || typeof executionRun["updatedAt"] !== "string") {
      throw corrupt(`execution run ${executionRunID} is missing its timestamps`);
    }
    const planID = executionRun["planID"];
    if (typeof planID !== "string" || !isRecord(runs[planID])) {
      throw corrupt(`execution run ${executionRunID} references missing PlanningRun ${String(planID)}`);
    }
    const workspace = isRecord(executionRun["workspace"]) ? (executionRun["workspace"] as Record<string, unknown>) : undefined;
    if (!workspace || typeof workspace["key"] !== "string" || workspace["key"].length === 0) {
      throw corrupt(`execution run ${executionRunID} has no stable WorkspaceIdentity binding`);
    }
    const finalPlan = isRecord(executionRun["finalPlan"]) ? (executionRun["finalPlan"] as Record<string, unknown>) : undefined;
    if (!finalPlan || typeof finalPlan["id"] !== "string" || typeof finalPlan["revision"] !== "number") {
      throw corrupt(`execution run ${executionRunID} is missing its exact FinalPlan identity`);
    }
    if (typeof executionRun["finalPlanHash"] !== "string" || (executionRun["finalPlanHash"] as string).length === 0) {
      throw corrupt(`execution run ${executionRunID} is missing its FinalPlan content hash binding`);
    }
    const planFamily = isRecord(finalPlans[planID]) ? (finalPlans[planID] as Record<string, unknown>) : {};
    const planRecord = planFamily[`${finalPlan["id"]}@${finalPlan["revision"]}`];
    if (!isRecord(planRecord) || planRecord["hash"] !== executionRun["finalPlanHash"]) {
      throw corrupt(
        `execution run ${executionRunID} FinalPlan binding ${String(finalPlan["id"])}@${String(finalPlan["revision"])} does not resolve to the committed plan with the bound hash`,
      );
    }
    const planningBaseline = isRecord(executionRun["planningBaseline"]) ? (executionRun["planningBaseline"] as Record<string, unknown>) : undefined;
    if (!planningBaseline || !isRecord(planningBaseline["snapshot"]) || typeof (planningBaseline["snapshot"] as Record<string, unknown>)["id"] !== "string") {
      throw corrupt(`execution run ${executionRunID} has a malformed planning baseline`);
    }
    const finalCommit = planningBaseline["finalCommit"];
    if (finalCommit !== null && typeof finalCommit !== "string") {
      throw corrupt(`execution run ${executionRunID} planning baseline carries a malformed finalCommit`);
    }
    const executionStartBaseline = isRecord(executionRun["executionStartBaseline"])
      ? (executionRun["executionStartBaseline"] as Record<string, unknown>)
      : undefined;
    if (!executionStartBaseline || typeof executionStartBaseline["workspaceFingerprint"] !== "string" || (executionStartBaseline["workspaceFingerprint"] as string).length === 0) {
      throw corrupt(`execution run ${executionRunID} has no execution-start baseline`);
    }
    const handoffKey = executionRun["initialHandoffKey"];
    if (typeof handoffKey !== "string" || handoffKey.length === 0) {
      throw corrupt(`execution run ${executionRunID} is missing its initial-handoff identity`);
    }
    const indexKey = `${planID}:${handoffKey}`;
    if (executionRunByHandoffKey[indexKey] !== executionRunID) {
      throw corrupt(`execution run ${executionRunID} is not indexed under its initial-handoff identity`);
    }
    if (seenHandoffIndexKeys.has(indexKey)) {
      throw corrupt(`duplicate initial-handoff ExecutionRun for ${indexKey}`);
    }
    seenHandoffIndexKeys.add(indexKey);
  }

  for (const [indexKey, entry] of Object.entries(executionRunByHandoffKey)) {
    if (typeof entry !== "string" || !isRecord(executionRuns[entry])) {
      throw corrupt(`execution handoff index ${indexKey} references missing execution run ${String(entry)}`);
    }
  }

  // -- v0.2.0 Phase 2 SupervisorBinding foundation (fail-closed) --------------
  // ADDITIVE family (pre-Phase-2 documents = "no supervisor ever attached").
  // The fencing shape is storage-validated: an existing ExecutionRun
  // reference, workspace EQUALITY with the bound run, a monotonic integer
  // generation, a structurally valid trusted owner, and a valid attachment
  // state. A dangling binding, generation 0/non-integer, a workspace
  // mismatch, or an unknown state fails store open — never repaired.
  const supervisorBindings = isRecord(doc.supervisorBindings) ? doc.supervisorBindings : {};
  for (const [executionRunID, binding] of Object.entries(supervisorBindings)) {
    if (!isRecord(binding)) throw corrupt(`supervisor binding ${executionRunID} is not an object`);
    if (binding["executionRunID"] !== executionRunID) {
      throw corrupt(`supervisor binding key ${executionRunID} does not match its identity`);
    }
    const run = executionRuns[executionRunID];
    if (!isRecord(run)) {
      throw corrupt(`supervisor binding ${executionRunID} references missing execution run`);
    }
    if (typeof binding["generation"] !== "number" || !Number.isInteger(binding["generation"]) || (binding["generation"] as number) < 1) {
      throw corrupt(`supervisor binding ${executionRunID} has a malformed generation (must be an integer >= 1)`);
    }
    if (typeof binding["ownerSessionID"] !== "string" || (binding["ownerSessionID"] as string).length === 0) {
      throw corrupt(`supervisor binding ${executionRunID} has no valid trusted owner session identity`);
    }
    const state = binding["state"];
    if (state !== "attached" && state !== "detached") {
      throw corrupt(`supervisor binding ${executionRunID} carries an invalid attachment state ${String(state)}`);
    }
    const bindingWorkspace = isRecord(binding["workspace"]) ? (binding["workspace"] as Record<string, unknown>) : undefined;
    if (!bindingWorkspace || typeof bindingWorkspace["key"] !== "string" || (bindingWorkspace["key"] as string).length === 0) {
      throw corrupt(`supervisor binding ${executionRunID} has no stable WorkspaceIdentity binding`);
    }
    const runWorkspace = isRecord(run["workspace"]) ? (run["workspace"] as Record<string, unknown>) : undefined;
    if (!runWorkspace || stableStringifyForDoc(bindingWorkspace) !== stableStringifyForDoc(runWorkspace)) {
      throw corrupt(`supervisor binding ${executionRunID} workspace disagrees with its ExecutionRun workspace`);
    }
    if (typeof binding["createdAt"] !== "string" || typeof binding["updatedAt"] !== "string") {
      throw corrupt(`supervisor binding ${executionRunID} is missing its timestamps`);
    }
  }

  // -- v0.2.0 Phase 3 ExecutionStage / VerificationWindow (fail-closed) -------
  // ADDITIVE families (pre-Phase-3 documents = "no structural execution state
  // exists"). The full structural graph is validated: references resolve, the
  // single-active-Stage and single-open-Window invariants hold, run
  // activeStage/openWindow refs agree with object truth, dependencies are
  // acyclic/self/cross-run-free, candidateRevision is a non-negative integer,
  // and baseAcceptedState anchors the window's own run (execution_start only
  // in this schema version — there is no ExecutionCommit to anchor to).
  const executionStages = isRecord(doc.executionStages)
    ? (doc.executionStages as Record<string, Record<string, unknown>>)
    : {};
  const verificationWindows = isRecord(doc.verificationWindows)
    ? (doc.verificationWindows as Record<string, Record<string, unknown>>)
    : {};

  /** Per-run active/open structure tallies for the invariants below. */
  const activeStageByRun = new Map<string, string>();
  const openWindowByRun = new Map<string, string>();

  for (const [stageID, stage] of Object.entries(executionStages)) {
    if (!isRecord(stage)) throw corrupt(`execution stage ${stageID} is not an object`);
    if (stage["id"] !== stageID) throw corrupt(`execution stage key ${stageID} does not match its identity`);
    const runID = stage["executionRunID"];
    if (typeof runID !== "string" || !isRecord(executionRuns[runID])) {
      throw corrupt(`execution stage ${stageID} references missing execution run ${String(runID)}`);
    }
    const status = stage["status"];
    if (status !== "pending" && status !== "active" && status !== "completed" && status !== "superseded") {
      throw corrupt(`execution stage ${stageID} carries an invalid status ${String(status)}`);
    }
    // Phase 6B §59 — kind vocabulary + the final_closure invariants. Absent
    // kind = ordinary (legacy durability, never rewritten). A final_closure
    // Stage can never be superseded (§11), and only ONE may exist per run.
    if (stage["kind"] !== undefined && !(EXECUTION_STAGE_KINDS as readonly string[]).includes(stage["kind"] as string)) {
      throw corrupt(`execution stage ${stageID} carries an invalid kind ${String(stage["kind"])}`);
    }
    if (typeof stage["revision"] !== "number" || !Number.isInteger(stage["revision"]) || (stage["revision"] as number) < 1) {
      throw corrupt(`execution stage ${stageID} has a malformed revision`);
    }
    if (typeof stage["title"] !== "string" || typeof stage["objective"] !== "string") {
      throw corrupt(`execution stage ${stageID} is missing its title/objective`);
    }
    if (!Array.isArray(stage["planRefs"])) throw corrupt(`execution stage ${stageID} has a malformed planRefs array`);
    for (const ref of stage["planRefs"] as unknown[]) {
      if (!isRecord(ref) || typeof ref["kind"] !== "string") {
        throw corrupt(`execution stage ${stageID} has a malformed planRef`);
      }
    }
    if (!Array.isArray(stage["dependsOn"])) throw corrupt(`execution stage ${stageID} has a malformed dependsOn array`);
    if (typeof stage["createdAt"] !== "string" || typeof stage["updatedAt"] !== "string") {
      throw corrupt(`execution stage ${stageID} is missing its timestamps`);
    }
    if (status === "active") {
      if (activeStageByRun.has(runID)) {
        throw corrupt(`execution run ${runID} has two active Stages (${String(activeStageByRun.get(runID))}, ${stageID})`);
      }
      activeStageByRun.set(runID, stageID);
    }
  }

  // Stage dependency graph: refs resolve to same-run Stages, no cycles.
  for (const [stageID, stage] of Object.entries(executionStages)) {
    const runID = stage["executionRunID"] as string;
    for (const dep of stage["dependsOn"] as unknown[]) {
      if (typeof dep !== "string") throw corrupt(`execution stage ${stageID} has a malformed dependency ref`);
      if (dep === stageID) throw corrupt(`execution stage ${stageID} depends on itself`);
      const depStage = executionStages[dep];
      if (!isRecord(depStage)) throw corrupt(`execution stage ${stageID} depends on missing Stage ${dep}`);
      if (depStage["executionRunID"] !== runID) {
        throw corrupt(`execution stage ${stageID} depends on Stage ${dep} from another ExecutionRun`);
      }
    }
  }
  {
    const state = new Map<string, "visiting" | "done">();
    const path: string[] = [];
    const visit = (id: string): void => {
      const current = state.get(id);
      if (current === "done") return;
      if (current === "visiting") {
        const start = path.indexOf(id);
        const cycle = start >= 0 ? [...path.slice(start), id] : [id];
        throw corrupt(`execution stage dependency cycle: ${cycle.join(" -> ")}`);
      }
      state.set(id, "visiting");
      path.push(id);
      for (const dep of executionStages[id]!["dependsOn"] as string[]) {
        if (isRecord(executionStages[dep])) visit(dep);
      }
      path.pop();
      state.set(id, "done");
    };
    for (const id of Object.keys(executionStages)) visit(id);
  }

  for (const [windowID, window] of Object.entries(verificationWindows)) {
    if (!isRecord(window)) throw corrupt(`verification window ${windowID} is not an object`);
    if (window["id"] !== windowID) throw corrupt(`verification window key ${windowID} does not match its identity`);
    const runID = window["executionRunID"];
    if (typeof runID !== "string" || !isRecord(executionRuns[runID])) {
      throw corrupt(`verification window ${windowID} references missing execution run ${String(runID)}`);
    }
    const stageID = window["stageID"];
    const stage = typeof stageID === "string" ? executionStages[stageID] : undefined;
    if (!isRecord(stage)) throw corrupt(`verification window ${windowID} references missing Stage ${String(stageID)}`);
    if (stage["executionRunID"] !== runID) {
      throw corrupt(`verification window ${windowID} belongs to a Stage from another ExecutionRun`);
    }
    const state = window["state"];
    if (state !== "open" && state !== "closed") {
      throw corrupt(`verification window ${windowID} carries an invalid state ${String(state)}`);
    }
    if (
      typeof window["candidateRevision"] !== "number" ||
      !Number.isInteger(window["candidateRevision"]) ||
      (window["candidateRevision"] as number) < 0
    ) {
      throw corrupt(`verification window ${windowID} has a malformed candidateRevision`);
    }
    if (typeof window["revision"] !== "number" || !Number.isInteger(window["revision"]) || (window["revision"] as number) < 1) {
      throw corrupt(`verification window ${windowID} has a malformed revision`);
    }
    const base = isRecord(window["baseAcceptedState"]) ? (window["baseAcceptedState"] as Record<string, unknown>) : undefined;
    // Shape-only here (commits parse later): execution_commit anchor existence
    // is proven in the Phase 5 acceptance block below.
    if (
      !base ||
      (base["kind"] !== "execution_start" && base["kind"] !== "execution_commit") ||
      (base["kind"] === "execution_start" && base["executionRunID"] !== runID)
    ) {
      throw corrupt(`verification window ${windowID} has an invalid baseAcceptedState anchor`);
    }
    if (typeof window["createdAt"] !== "string" || typeof window["updatedAt"] !== "string") {
      throw corrupt(`verification window ${windowID} is missing its timestamps`);
    }
    if (state === "open") {
      if (openWindowByRun.has(runID)) {
        throw corrupt(`execution run ${runID} has two open VerificationWindows (${String(openWindowByRun.get(runID))}, ${windowID})`);
      }
      openWindowByRun.set(runID, windowID);
      // An OPEN window belongs to the ACTIVE stage — except on a terminal
      // run, where the structure is frozen history (never cleaned up).
      const run = executionRuns[runID];
      const terminal = run["lifecycle"] === "completed" || run["lifecycle"] === "replan_required" || run["lifecycle"] === "aborted";
      if (!terminal) {
        if (stage["status"] !== "active") {
          throw corrupt(`open verification window ${windowID} belongs to non-active Stage ${String(stageID)}`);
        }
      }
    }
  }

  // run.activeStage / run.openWindow must agree with object truth in BOTH
  // directions (terminal runs keep frozen history; consistency is still
  // required — the refs must resolve and match status).
  for (const [runID, runEntry] of Object.entries(executionRuns)) {
    const runRecord = runEntry as Record<string, unknown>;
    const terminal =
      runRecord["lifecycle"] === "completed" || runRecord["lifecycle"] === "replan_required" || runRecord["lifecycle"] === "aborted";
    const runActiveStage = runRecord["activeStage"];
    if (runActiveStage !== undefined && runActiveStage !== null) {
      if (typeof runActiveStage !== "string" || !isRecord(executionStages[runActiveStage])) {
        throw corrupt(`execution run ${runID} activeStage references missing Stage ${String(runActiveStage)}`);
      }
      if (executionStages[runActiveStage]!["executionRunID"] !== runID) {
        throw corrupt(`execution run ${runID} activeStage references a Stage from another ExecutionRun`);
      }
      if (executionStages[runActiveStage]!["status"] !== "active") {
        throw corrupt(`execution run ${runID} activeStage references ${String(runActiveStage)} in status ${String(executionStages[runActiveStage]!["status"])}`);
      }
    }
    const runOpenWindow = runRecord["openWindow"];
    if (runOpenWindow !== undefined && runOpenWindow !== null) {
      if (typeof runOpenWindow !== "string" || !isRecord(verificationWindows[runOpenWindow])) {
        throw corrupt(`execution run ${runID} openWindow references missing Window ${String(runOpenWindow)}`);
      }
      if (verificationWindows[runOpenWindow]!["executionRunID"] !== runID) {
        throw corrupt(`execution run ${runID} openWindow references a Window from another ExecutionRun`);
      }
      if (verificationWindows[runOpenWindow]!["state"] !== "open") {
        throw corrupt(`execution run ${runID} openWindow references closed Window ${String(runOpenWindow)}`);
      }
    }
    // Reverse direction (non-terminal runs only — a terminal run may have
    // frozen an open window whose closure awaits the future ExecutionCommit;
    // the openWindowByRun tally above already proved uniqueness).
    const talliedActive = activeStageByRun.get(runID);
    if (talliedActive !== undefined && talliedActive !== runActiveStage) {
      if (!terminal || runActiveStage === undefined || runActiveStage === null) {
        throw corrupt(`execution run ${runID} has active Stage ${talliedActive} but activeStage disagrees`);
      }
    }
    const talliedOpen = openWindowByRun.get(runID);
    if (talliedOpen !== undefined && talliedOpen !== runOpenWindow) {
      if (!terminal || runOpenWindow === undefined || runOpenWindow === null) {
        throw corrupt(`execution run ${runID} has open Window ${talliedOpen} but openWindow disagrees`);
      }
    }
    // Phase 6B §59 — final_closure per-run invariants (frozen terminal history
    // like `replan_required with an active final_closure` stays legal).
    const runStages = Object.entries(executionStages).filter(([, stage]) => isRecord(stage) && stage["executionRunID"] === runID);
    const closures = runStages.filter(([, stage]) => executionStageKindOf(stage as never) === "final_closure");
    if (closures.length > 1) {
      throw corrupt(`execution run ${runID} has ${closures.length} final_closure Stages (at most one exists)`);
    }
    for (const [closureID, closure] of closures) {
      if ((closure as Record<string, unknown>)["status"] === "superseded") {
        throw corrupt(`final_closure Stage ${closureID} is superseded (final closure can never be superseded)`);
      }
      // The state combination "final_closure exists + ordinary pending/active"
      // can never arise legally (readiness gates prepare/activate) — fail closed.
      const openOrdinary = runStages.filter(
        ([id, stage]) =>
          id !== closureID &&
          executionStageKindOf(stage as never) === "ordinary" &&
          !["superseded", "completed"].includes((stage as Record<string, unknown>)["status"] as string),
      );
      if (openOrdinary.length > 0) {
        throw corrupt(
          `execution run ${runID} carries final_closure Stage ${closureID} alongside open ordinary Stage(s) ${openOrdinary.map(([id]) => id).join(", ")} — impossible state combination`,
        );
      }
    }
  }

  // -- v0.2.0 Phase 4 worker protocol (fail-closed, directive sections 46-48) -
  // ADDITIVE families (pre-Phase-4 documents = "no directive was ever
  // issued"). Hash recomputation, exact run/FinalPlan/Stage/Window bindings,
  // one Attempt per exact Directive revision, one running Attempt per run,
  // attempt/report state consistency, report provenance arithmetic, and the
  // blocker/mutation vocabularies all fail closed. Staleness of a
  // Directive's baseCandidateRevision against the CURRENT window is
  // legitimate history and is deliberately NOT an error.
  const executionDirectives = isRecord(doc.executionDirectives)
    ? (doc.executionDirectives as Record<string, Record<string, unknown>>)
    : {};
  const executionAttempts = isRecord(doc.executionAttempts)
    ? (doc.executionAttempts as Record<string, Record<string, unknown>>)
    : {};
  const executionReports = isRecord(doc.executionReports)
    ? (doc.executionReports as Record<string, Record<string, unknown>>)
    : {};
  const executionAttemptByDirective = isRecord(doc.executionAttemptByDirective)
    ? (doc.executionAttemptByDirective as Record<string, string>)
    : {};

  const seenDirectiveKeys = new Set<string>();
  for (const [key, directive] of Object.entries(executionDirectives)) {
    if (!isRecord(directive)) throw corrupt(`execution directive ${key} is not an object`);
    const id = directive["id"];
    const revision = directive["revision"];
    if (typeof id !== "string" || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
      throw corrupt(`execution directive ${key} has a malformed identity`);
    }
    if (key !== `${id}@${revision}`) throw corrupt(`execution directive key ${key} does not match its identity`);
    if (seenDirectiveKeys.has(key)) throw corrupt(`duplicate execution directive ${key}`);
    seenDirectiveKeys.add(key);
    if (computeExecutionDirectiveHashFromRecord(directive as never) !== directive["hash"]) {
      throw corrupt(`execution directive ${key} content does not recompute to its canonical hash`);
    }
    const runID = directive["executionRunID"];
    const run = typeof runID === "string" ? executionRuns[runID] : undefined;
    if (!isRecord(run)) throw corrupt(`execution directive ${key} references missing execution run ${String(runID)}`);
    const planRef = isRecord(directive["finalPlan"]) ? (directive["finalPlan"] as Record<string, unknown>) : undefined;
    // FinalPlans are committed per PLANNING run: resolve the execution run's source plan first.
    const planID = isRecord(run["planID"]) ? undefined : (run["planID"] as string);
    const planFamily = typeof planID === "string" && isRecord(finalPlans[planID]) ? (finalPlans[planID] as Record<string, unknown>) : {};
    const planRecord =
      planRef && typeof planRef["id"] === "string" && typeof planRef["revision"] === "number"
        ? planFamily[`${planRef["id"]}@${planRef["revision"]}`]
        : undefined;
    const runFinalPlan = isRecord(run["finalPlan"]) ? (run["finalPlan"] as Record<string, unknown>) : undefined;
    const planBindingOk =
      !!planRef &&
      isRecord(planRecord) &&
      typeof directive["finalPlanHash"] === "string" &&
      planRecord["hash"] === directive["finalPlanHash"] &&
      !!runFinalPlan &&
      runFinalPlan["id"] === planRef["id"] &&
      runFinalPlan["revision"] === planRef["revision"];
    if (!planBindingOk) {
      throw corrupt(`execution directive ${key} FinalPlan binding disagrees with the run's exact binding`);
    }
    const stageID = directive["stageID"];
    const stage = typeof stageID === "string" ? executionStages[stageID] : undefined;
    if (!isRecord(stage) || stage["executionRunID"] !== runID) {
      throw corrupt(`execution directive ${key} references a missing/foreign Stage ${String(stageID)}`);
    }
    const windowID = directive["windowID"];
    const window = typeof windowID === "string" ? verificationWindows[windowID] : undefined;
    if (!isRecord(window) || window["executionRunID"] !== runID || window["stageID"] !== stageID) {
      throw corrupt(`execution directive ${key} references a Window that does not belong to the bound Stage`);
    }
    if (stableStringifyForDoc(directive["baseAcceptedState"]) !== stableStringifyForDoc(window["baseAcceptedState"])) {
      throw corrupt(`execution directive ${key} baseAcceptedState does not match its window's anchor`);
    }
    if (
      typeof directive["baseCandidateRevision"] !== "number" ||
      !Number.isInteger(directive["baseCandidateRevision"]) ||
      (directive["baseCandidateRevision"] as number) < 0
    ) {
      throw corrupt(`execution directive ${key} has a malformed baseCandidateRevision`);
    }
    if (!(EXECUTION_DIRECTIVE_KINDS as readonly string[]).includes(directive["kind"] as string)) {
      throw corrupt(`execution directive ${key} carries an invalid kind ${String(directive["kind"])}`);
    }
    if (!(DIRECTIVE_CANDIDATE_EFFECTS as readonly string[]).includes(directive["candidateEffect"] as string)) {
      throw corrupt(`execution directive ${key} carries an invalid candidateEffect ${String(directive["candidateEffect"])}`);
    }
    if (!Array.isArray(directive["planRefs"])) throw corrupt(`execution directive ${key} has a malformed planRefs array`);
    for (const ref of directive["planRefs"] as unknown[]) {
      if (!isRecord(ref) || typeof ref["kind"] !== "string") throw corrupt(`execution directive ${key} has a malformed planRef`);
    }
    const envelope = isRecord(directive["capabilityEnvelope"]) ? (directive["capabilityEnvelope"] as Record<string, unknown>) : undefined;
    if (!envelope || EXECUTION_CAPABILITIES.some((capability) => typeof envelope[capability] !== "boolean")) {
      throw corrupt(`execution directive ${key} has an invalid capability envelope`);
    }
    // Phase 6A — purpose/conflict/reconciliation extension shapes (semantic
    // content; deep cross-record checks run in the Phase 6A block below).
    if (directive["verificationPurpose"] !== undefined && !(VERIFICATION_PURPOSES as readonly string[]).includes(directive["verificationPurpose"] as string)) {
      throw corrupt(`execution directive ${key} carries an invalid verificationPurpose`);
    }
    if (directive["conflictID"] !== undefined && directive["verificationPurpose"] !== "conflict_resolution") {
      throw corrupt(`execution directive ${key} carries conflictID without verificationPurpose=conflict_resolution`);
    }
    if (directive["reconciliationTargets"] !== undefined) {
      const targets = directive["reconciliationTargets"];
      if (directive["kind"] !== "inspection" || directive["candidateEffect"] !== "non_mutating" || !Array.isArray(targets)) {
        throw corrupt(`execution directive ${key} has malformed reconciliationTargets (inspection-kind, non-mutating, array required)`);
      }
      if (envelope["repositoryRead"] !== true || RECONCILIATION_FORBIDDEN_CAPABILITIES.some((capability) => envelope[capability] === true)) {
        throw corrupt(`execution directive ${key} reconciliation inspection violates the non-mutating capability constraints`);
      }
    }
    if (typeof directive["createdAt"] !== "string") throw corrupt(`execution directive ${key} is missing createdAt`);
  }

  const runningByRun = new Map<string, string>();
  const seenAttemptDirective = new Set<string>();
  for (const [attemptID, attempt] of Object.entries(executionAttempts)) {
    if (!isRecord(attempt)) throw corrupt(`execution attempt ${attemptID} is not an object`);
    if (attempt["id"] !== attemptID) throw corrupt(`execution attempt key ${attemptID} does not match its identity`);
    const runID = attempt["executionRunID"];
    const directiveRecord = isRecord(attempt["directive"]) ? (attempt["directive"] as Record<string, unknown>) : undefined;
    const directiveKey = directiveRecord ? `${String(directiveRecord["id"])}@${String(directiveRecord["revision"])}` : "none";
    const directive = executionDirectives[directiveKey];
    if (!isRecord(directive)) throw corrupt(`execution attempt ${attemptID} references missing Directive revision ${directiveKey}`);
    if (directiveRecord!["hash"] !== directive["hash"]) throw corrupt(`execution attempt ${attemptID} Directive hash mismatch`);
    if (
      attempt["executionRunID"] !== directive["executionRunID"] ||
      attempt["stageID"] !== directive["stageID"] ||
      attempt["windowID"] !== directive["windowID"]
    ) {
      throw corrupt(`execution attempt ${attemptID} run/stage/window disagree with its Directive`);
    }
    if (!(WORKER_ROLES as readonly string[]).includes(attempt["workerRole"] as string)) {
      throw corrupt(`execution attempt ${attemptID} carries an invalid worker role ${String(attempt["workerRole"])}`);
    }
    if (!(EXECUTION_ATTEMPT_STATES as readonly string[]).includes(attempt["state"] as string)) {
      throw corrupt(`execution attempt ${attemptID} carries an invalid state ${String(attempt["state"])}`);
    }
    if (!(DIRECTIVE_CANDIDATE_EFFECTS as readonly string[]).includes(attempt["candidateEffect"] as string)) {
      throw corrupt(`execution attempt ${attemptID} carries an invalid candidateEffect`);
    }
    if (typeof attempt["startedAt"] !== "string") throw corrupt(`execution attempt ${attemptID} is missing startedAt`);
    const indexKey = `${String(runID)}:${directiveKey}`;
    if (executionAttemptByDirective[indexKey] !== attemptID) {
      throw corrupt(`execution attempt ${attemptID} is not indexed under its exact Directive revision (or duplicates it)`);
    }
    if (seenAttemptDirective.has(indexKey)) throw corrupt(`multiple Attempts for the same Directive revision ${directiveKey}`);
    seenAttemptDirective.add(indexKey);
    if (attempt["state"] === "running") {
      if (runningByRun.has(String(runID))) {
        throw corrupt(`execution run ${String(runID)} has multiple running Attempts`);
      }
      runningByRun.set(String(runID), attemptID);
      if (attempt["endedAt"] !== undefined) throw corrupt(`a running execution attempt ${attemptID} must not carry endedAt`);
    }
  }

  const reportByAttempt = new Map<string, string>();
  for (const [reportID, report] of Object.entries(executionReports)) {
    if (!isRecord(report)) throw corrupt(`execution report ${reportID} is not an object`);
    if (report["id"] !== reportID) throw corrupt(`execution report key ${reportID} does not match its identity`);
    const attemptID = report["attemptID"];
    const attempt = typeof attemptID === "string" ? executionAttempts[attemptID] : undefined;
    if (!isRecord(attempt)) throw corrupt(`execution report ${reportID} references missing Attempt ${String(attemptID)}`);
    const reportDirective = isRecord(report["directive"]) ? (report["directive"] as Record<string, unknown>) : undefined;
    const attemptDirective = isRecord(attempt["directive"]) ? (attempt["directive"] as Record<string, unknown>) : undefined;
    if (
      !reportDirective ||
      !attemptDirective ||
      reportDirective["id"] !== attemptDirective["id"] ||
      reportDirective["revision"] !== attemptDirective["revision"] ||
      reportDirective["hash"] !== attemptDirective["hash"]
    ) {
      throw corrupt(`execution report ${reportID} references the wrong Directive revision/hash`);
    }
    if (report["workerRole"] !== attempt["workerRole"]) {
      throw corrupt(`execution report ${reportID} worker role mismatches its Attempt`);
    }
    if (!(EXECUTION_REPORT_RESULTS as readonly string[]).includes(report["result"] as string)) {
      throw corrupt(`execution report ${reportID} carries an invalid result ${String(report["result"])}`);
    }
    const blockers = Array.isArray(report["blockers"]) ? (report["blockers"] as unknown[]) : undefined;
    if (!blockers) throw corrupt(`execution report ${reportID} has a malformed blockers array`);
    for (const blocker of blockers) {
      if (!isRecord(blocker) || !(EXECUTION_BLOCKER_KINDS as readonly string[]).includes(blocker["kind"] as string)) {
        throw corrupt(`execution report ${reportID} carries an invalid blocker entry`);
      }
    }
    if (report["result"] === "blocked" && blockers.length === 0) {
      throw corrupt(`execution report ${reportID} is blocked without a structured blocker`);
    }
    if (report["result"] !== "blocked" && blockers.length > 0) {
      throw corrupt(`execution report ${reportID} carries blockers on a non-blocked result`);
    }
    if (!(CANDIDATE_MUTATIONS as readonly string[]).includes(report["candidateMutation"] as string)) {
      throw corrupt(`execution report ${reportID} carries an invalid candidateMutation`);
    }
    const base = report["baseCandidateRevision"];
    const resulting = report["resultingCandidateRevision"];
    if (typeof base !== "number" || !Number.isInteger(base) || base < 0 || typeof resulting !== "number" || !Number.isInteger(resulting)) {
      throw corrupt(`execution report ${reportID} has malformed candidate revision provenance`);
    }
    if (report["candidateMutation"] === "changed" && resulting !== base + 1) {
      throw corrupt(`execution report ${reportID} provenance impossible (changed must advance exactly +1)`);
    }
    if (report["candidateMutation"] === "none" && resulting !== base) {
      throw corrupt(`execution report ${reportID} provenance impossible (no mutation must keep the revision)`);
    }
    const directiveForBase = executionDirectives[`${String(attemptDirective!["id"])}@${String(attemptDirective!["revision"])}`];
    if (isRecord(directiveForBase) && base < (directiveForBase["baseCandidateRevision"] as number)) {
      throw corrupt(`execution report ${reportID} candidate revision provenance is impossible (precedes the Directive base)`);
    }
    // Phase 6A §32/§47 — the optional extensions are legal ONLY on matching
    // directives, and a reconciliation inspection report MUST observe.
    if (report["conflictResolutionOutcome"] !== undefined) {
      if (!isRecord(directiveForBase) || directiveForBase["verificationPurpose"] !== "conflict_resolution") {
        throw corrupt(`execution report ${reportID} carries conflictResolutionOutcome on a non-conflict-resolution Directive`);
      }
      assertConflictResolutionOutcomeVocabulary(report["conflictResolutionOutcome"] as string);
    }
    if (report["reconciliationObservation"] !== undefined) {
      if (!isRecord(directiveForBase) || !Array.isArray(directiveForBase["reconciliationTargets"])) {
        throw corrupt(`execution report ${reportID} carries reconciliationObservation on a non-reconciliation Directive`);
      }
      assertReconciliationObservationVocabulary(report["reconciliationObservation"] as string);
    }
    if (isRecord(directiveForBase) && Array.isArray(directiveForBase["reconciliationTargets"]) && report["reconciliationObservation"] === undefined) {
      throw corrupt(`execution report ${reportID} answers a reconciliation inspection without a reconciliationObservation`);
    }
    if (typeof report["createdAt"] !== "string") throw corrupt(`execution report ${reportID} is missing createdAt`);
    if (reportByAttempt.has(String(attemptID))) throw corrupt(`duplicate Report for Attempt ${String(attemptID)}`);
    reportByAttempt.set(String(attemptID), reportID);
  }

  for (const [attemptID, attempt] of Object.entries(executionAttempts)) {
    const hasReport = reportByAttempt.has(attemptID);
    if (attempt["state"] === "reported" && !hasReport) {
      throw corrupt(`reported execution attempt ${attemptID} has no durable Report`);
    }
    if (attempt["state"] === "indeterminate" && hasReport) {
      throw corrupt(`indeterminate execution attempt ${attemptID} carries a Report`);
    }
    if (attempt["state"] !== "running" && typeof attempt["endedAt"] !== "string") {
      throw corrupt(`terminal execution attempt ${attemptID} is missing endedAt`);
    }
  }

  for (const [indexKey, attemptID] of Object.entries(executionAttemptByDirective)) {
    if (!isRecord(executionAttempts[attemptID])) {
      throw corrupt(`execution attempt index ${indexKey} references missing attempt ${String(attemptID)}`);
    }
  }


  // -- v0.2.0 Phase 6A escalation families (declared early: the Phase 5 commit
  // loop validates reconciliationRefs against them) -----------------------------
  const executionIssues = isRecord(doc.executionIssues)
    ? (doc.executionIssues as Record<string, Record<string, unknown>>)
    : {};
  const issueByExecutionRun = isRecord(doc.issueByExecutionRun)
    ? (doc.issueByExecutionRun as Record<string, string>)
    : {};
  const verificationConflicts = isRecord(doc.verificationConflicts)
    ? (doc.verificationConflicts as Record<string, Record<string, unknown>>)
    : {};
  const attemptReconciliations = isRecord(doc.attemptReconciliations)
    ? (doc.attemptReconciliations as Record<string, Record<string, unknown>>)
    : {};
  const reconciliationByAttempt = isRecord(doc.reconciliationByAttempt)
    ? (doc.reconciliationByAttempt as Record<string, string>)
    : {};

  // -- v0.2.0 Phase 5 acceptance layer (fail-closed, directive SS51-SS53) ------
  // ADDITIVE families (pre-Phase-5 documents = "nothing was ever accepted").
  // The full accepted-state graph is validated: assessment bindings and
  // obligation subsets, accept-only commits, candidate/parent agreement, the
  // linear commit chain with acceptedHead at its tip, one commit per window,
  // window bases that may now anchor to a commit of the same run, and
  // completed Stages carrying closure provenance with full obligation
  // coverage — fail closed, never repaired.
  const supervisorAssessments = isRecord(doc.supervisorAssessments)
    ? (doc.supervisorAssessments as Record<string, Record<string, unknown>>)
    : {};
  const executionCommits = isRecord(doc.executionCommits)
    ? (doc.executionCommits as Record<string, Record<string, unknown>>)
    : {};
  const executionCommitByWindow = isRecord(doc.executionCommitByWindow)
    ? (doc.executionCommitByWindow as Record<string, string>)
    : {};
  const executionCommitByAssessment = isRecord(doc.executionCommitByAssessment)
    ? (doc.executionCommitByAssessment as Record<string, string>)
    : {};

  // Window bases anchored to a commit: the commit must exist and belong to the same run (SS52).
  for (const [windowID, win] of Object.entries(verificationWindows)) {
    if (!isRecord(win)) continue;
    const base = isRecord(win["baseAcceptedState"]) ? (win["baseAcceptedState"] as Record<string, unknown>) : undefined;
    if (base && base["kind"] === "execution_commit") {
      const anchor = typeof base["executionCommitID"] === "string" ? executionCommits[base["executionCommitID"]] : undefined;
      if (!isRecord(anchor) || anchor["executionRunID"] !== win["executionRunID"]) {
        throw corrupt(`verification window ${windowID} anchors a missing/foreign execution commit ${String(base["executionCommitID"])}`);
      }
    }
  }

  const commitIDsByRun = new Map<string, string[]>();
  for (const [assessmentID, assessment] of Object.entries(supervisorAssessments)) {
    if (!isRecord(assessment)) throw corrupt(`supervisor assessment ${assessmentID} is not an object`);
    if (assessment["id"] !== assessmentID) throw corrupt(`supervisor assessment key ${assessmentID} does not match its identity`);
    const runID = assessment["executionRunID"];
    if (typeof runID !== "string" || !isRecord(executionRuns[runID])) {
      throw corrupt(`supervisor assessment ${assessmentID} references missing execution run ${String(runID)}`);
    }
    const stageID = assessment["stageID"];
    const stage = typeof stageID === "string" ? executionStages[stageID] : undefined;
    if (!isRecord(stage) || stage["executionRunID"] !== runID) {
      throw corrupt(`supervisor assessment ${assessmentID} references a missing/foreign Stage`);
    }
    const windowID = assessment["windowID"];
    const win = typeof windowID === "string" ? verificationWindows[windowID] : undefined;
    if (!isRecord(win) || win["executionRunID"] !== runID || win["stageID"] !== stageID) {
      throw corrupt(`supervisor assessment ${assessmentID} references a Window outside its Stage/Run`);
    }
    if (typeof assessment["candidateRevision"] !== "number" || !Number.isInteger(assessment["candidateRevision"]) || (assessment["candidateRevision"] as number) < 0) {
      throw corrupt(`supervisor assessment ${assessmentID} has a malformed candidateRevision`);
    }
    if (!(ASSESSMENT_DISPOSITIONS as readonly string[]).includes(assessment["disposition"] as string)) {
      throw corrupt(`supervisor assessment ${assessmentID} carries an invalid disposition`);
    }
    if (!(ASSESSMENT_ACCEPTANCE_SCOPES as readonly string[]).includes(assessment["acceptanceScope"] as string)) {
      throw corrupt(`supervisor assessment ${assessmentID} carries an invalid acceptanceScope`);
    }
    for (const ref of (Array.isArray(assessment["reportRefs"]) ? assessment["reportRefs"] : []) as unknown[]) {
      const reportID = typeof ref === "string" ? ref : isRecord(ref) ? ref["id"] : undefined;
      const report = typeof reportID === "string" ? executionReports[reportID] : undefined;
      if (!isRecord(report)) throw corrupt(`supervisor assessment ${assessmentID} references missing Report ${String(reportID)}`);
      const attemptID = report["attemptID"];
      const attempt = typeof attemptID === "string" ? executionAttempts[attemptID] : undefined;
      if (!isRecord(attempt) || attempt["windowID"] !== windowID) {
        throw corrupt(`supervisor assessment ${assessmentID} references a Report outside its Window`);
      }
    }
    if (typeof assessment["hash"] !== "string" || computeSupervisorAssessmentHashFromRecord(assessment as never) !== assessment["hash"]) {
      throw corrupt(`supervisor assessment ${assessmentID} content does not recompute to its canonical hash`);
    }
    if (typeof assessment["createdAt"] !== "string") throw corrupt(`supervisor assessment ${assessmentID} is missing createdAt`);
    // SS79: covered obligations must be exact Stage obligations.
    const stageObligationIDs = new Set(
      ((isRecord(stage["completionObligations"]) ? Object.values(stage["completionObligations"]) : (Array.isArray(stage["completionObligations"]) ? stage["completionObligations"] : [])) as unknown[]).map(
        (obligation) => (isRecord(obligation) ? String(obligation["id"]) : ""),
      ),
    );
    for (const ref of (Array.isArray(assessment["coveredObligations"]) ? assessment["coveredObligations"] : []) as unknown[]) {
      if (typeof ref !== "string" || !stageObligationIDs.has(ref)) {
        throw corrupt(`supervisor assessment ${assessmentID} covers unknown Stage obligation ${String(ref)}`);
      }
    }
  }

  const commitByWindowTally = new Map<string, string>();
  const parentTally = new Map<string, string>();
  for (const [commitID, commit] of Object.entries(executionCommits)) {
    if (!isRecord(commit)) throw corrupt(`execution commit ${commitID} is not an object`);
    if (commit["id"] !== commitID) throw corrupt(`execution commit key ${commitID} does not match its identity`);
    const runID = commit["executionRunID"];
    if (typeof runID !== "string" || !isRecord(executionRuns[runID])) {
      throw corrupt(`execution commit ${commitID} references missing execution run ${String(runID)}`);
    }
    const stageID = commit["stageID"];
    const stage = typeof stageID === "string" ? executionStages[stageID] : undefined;
    if (!isRecord(stage) || stage["executionRunID"] !== runID) {
      throw corrupt(`execution commit ${commitID} references missing Stage ${String(stageID)}`);
    }
    const windowID = commit["windowID"];
    const win = typeof windowID === "string" ? verificationWindows[windowID] : undefined;
    if (!isRecord(win) || win["executionRunID"] !== runID || win["stageID"] !== stageID) {
      throw corrupt(`execution commit ${commitID} references a Window outside its Stage/Run`);
    }
    // One commit per window + the window must actually be closed.
    if (win["state"] !== "closed") throw corrupt(`execution commit ${commitID} references a Window that is not closed`);
    if (executionCommitByWindow[windowID as string] !== commitID) {
      throw corrupt(`execution commit ${commitID} is not indexed as its window's commit`);
    }
    if (commitByWindowTally.has(windowID as string)) {
      throw corrupt(`two execution commits for Window ${String(windowID)}`);
    }
    commitByWindowTally.set(windowID as string, commitID);
    // The assessment must exist, be accept, and agree on window+candidate.
    const assessmentID = commit["supervisorAssessmentID"];
    const assessment = typeof assessmentID === "string" ? supervisorAssessments[assessmentID] : undefined;
    if (!isRecord(assessment)) throw corrupt(`execution commit ${commitID} references missing SupervisorAssessment ${String(assessmentID)}`);
    if (assessment["disposition"] !== "accept") {
      throw corrupt(`execution commit ${commitID} is backed by a non-accept assessment`);
    }
    if (executionCommitByAssessment[assessmentID as string] !== commitID) {
      throw corrupt(`execution commit ${commitID} is not indexed under its assessment`);
    }
    if (
      assessment["executionRunID"] !== runID ||
      assessment["stageID"] !== stageID ||
      assessment["windowID"] !== windowID ||
      assessment["candidateRevision"] !== commit["candidateRevision"] ||
      win["candidateRevision"] !== commit["candidateRevision"]
    ) {
      throw corrupt(`execution commit ${commitID} candidate/window binding disagrees with its assessment or window`);
    }
    // Parent: copied from the window base + linear within the run.
    if (stableStringifyForDoc(commit["parentAcceptedState"]) !== stableStringifyForDoc(win["baseAcceptedState"])) {
      throw corrupt(`execution commit ${commitID} parentAcceptedState disagrees with its window anchor`);
    }
    const parent = commit["parentAcceptedState"];
    if (isRecord(parent) && parent["kind"] === "execution_commit") {
      const parentID = parent["executionCommitID"];
      const parentCommit = typeof parentID === "string" ? executionCommits[parentID] : undefined;
      if (!isRecord(parentCommit) || parentCommit["executionRunID"] !== runID) {
        throw corrupt(`execution commit ${commitID} parents a missing/foreign commit ${String(parentID)}`);
      }
      parentTally.set(String(parentID), commitID);
    }
    // Satisfied obligations ⊆ Stage obligations.
    const stageObligationIDs = new Set(
      ((Array.isArray(stage["completionObligations"]) ? stage["completionObligations"] : []) as unknown[]).map(
        (obligation) => (isRecord(obligation) ? String(obligation["id"]) : ""),
      ),
    );
    for (const ref of (Array.isArray(commit["satisfiedObligations"]) ? commit["satisfiedObligations"] : []) as unknown[]) {
      if (typeof ref !== "string" || !stageObligationIDs.has(ref)) {
        throw corrupt(`execution commit ${commitID} satisfies unknown Stage obligation ${String(ref)}`);
      }
    }
    // Phase 6A §90 — reconciliation provenance must resolve to reconciliations
    // of the committed window (optional additive field).
    for (const ref of (Array.isArray(commit["reconciliationRefs"]) ? commit["reconciliationRefs"] : []) as unknown[]) {
      const reconciliation = typeof ref === "string" ? attemptReconciliations[ref] : undefined;
      if (!isRecord(reconciliation) || reconciliation["windowID"] !== windowID) {
        throw corrupt(`execution commit ${commitID} references missing/foreign reconciliation ${String(ref)}`);
      }
    }
    if (typeof commit["createdAt"] !== "string") throw corrupt(`execution commit ${commitID} is missing createdAt`);
    if (!Array.isArray(commit["reportRefs"]) || !Array.isArray(commit["directiveRefs"])) {
      throw corrupt(`execution commit ${commitID} has malformed window provenance`);
    }
    const runCommits = commitIDsByRun.get(runID as string) ?? [];
    runCommits.push(commitID);
    commitIDsByRun.set(runID as string, runCommits);
  }

  // Linear chain + acceptedHead at the tip, per run.
  for (const [runID, commitIDs] of commitIDsByRun) {
    const run = executionRuns[runID];
    // Exactly one chain tip (a commit nobody parents).
    const tips = commitIDs.filter((id) => !parentTally.has(id));
    if (tips.length !== 1) {
      throw corrupt(`execution run ${runID} commit chain is not linear (${tips.length} tips)`);
    }
    const tip = tips[0]!;
    const acceptedHead = isRecord(run) ? run["acceptedHead"] : undefined;
    if (acceptedHead === undefined || acceptedHead === null) {
      throw corrupt(`execution run ${runID} has commits but no acceptedHead`);
    }
    if (acceptedHead !== tip) {
      throw corrupt(`execution run ${runID} acceptedHead ${String(acceptedHead)} is not the chain tip ${tip}`);
    }
  }

  // Completed Stages need closure provenance: a stageCompleted commit whose
  // obligation union (with prior accepted commits) covers ALL obligations.
  for (const [stageID, stage] of Object.entries(executionStages)) {
    if (stage["status"] !== "completed") continue;
    const runID = stage["executionRunID"];
    const closureCommit = Object.values(executionCommits).find(
      (commit) => isRecord(commit) && commit["stageID"] === stageID && commit["executionRunID"] === runID && commit["stageCompleted"] === true,
    );
    if (!closureCommit) {
      throw corrupt(`completed execution stage ${stageID} has no closure commit`);
    }
    const covered = new Set<string>();
    for (const commit of Object.values(executionCommits)) {
      if (isRecord(commit) && commit["executionRunID"] === runID && commit["stageID"] === stageID) {
        for (const ref of (Array.isArray(commit["satisfiedObligations"]) ? commit["satisfiedObligations"] : []) as unknown[]) {
          covered.add(String(ref));
        }
      }
    }
    const allCovered = ((Array.isArray(stage["completionObligations"]) ? stage["completionObligations"] : []) as unknown[]).every(
      (obligation) => covered.has(String(isRecord(obligation) ? obligation["id"] : "")),
    );
    if (!allCovered) {
      throw corrupt(`completed execution stage ${stageID} lacks full obligation coverage in its accepted commits`);
    }
    // run.activeStage must be absent for its completed stage's run when that stage was the active one.
    const runRecord = typeof runID === "string" ? executionRuns[runID] : undefined;
    if (isRecord(runRecord) && runRecord["activeStage"] === stageID) {
      throw corrupt(`execution run ${runID} still points activeStage at completed Stage ${stageID}`);
    }
  }

  // Acceptance indexes must resolve (a closed committed window always keeps its commit).
  for (const [windowID, commitID] of Object.entries(executionCommitByWindow)) {
    if (!isRecord(executionCommits[commitID])) {
      throw corrupt(`execution commit index for window ${windowID} references missing commit ${String(commitID)}`);
    }
  }
  for (const [assessmentID, commitID] of Object.entries(executionCommitByAssessment)) {
    if (!isRecord(executionCommits[commitID])) {
      throw corrupt(`execution commit index for assessment ${assessmentID} references missing commit ${String(commitID)}`);
    }
  }

  // -- v0.2.0 Phase 6A escalation control plane (fail-closed, §59-§62) --------
  // ADDITIVE families (pre-Phase-6A documents = "nothing ever escalated";
  // the family records themselves were declared before the Phase 5 block).
  // The full escalation graph is validated: bidirectional issue↔replan_required
  // consistency, request_replan source assessments bound to the exact captured
  // candidate, exact FinalPlan-reachable affected refs, accepted-history
  // snapshots, exact evidence refs, resolver uniqueness/role/purpose/candidate
  // binding, deterministic neutralization, and reconciliation targets/
  // observation/revision arithmetic — fail closed, never repaired.

  /** Resolve the committed FinalPlan record behind an execution run (same provenance chain as the Directive loop). */
  const finalPlanRecordForRun = (runRecord: Record<string, unknown>): Record<string, unknown> | undefined => {
    const runFinalPlan = isRecord(runRecord["finalPlan"]) ? (runRecord["finalPlan"] as Record<string, unknown>) : undefined;
    const planID = runRecord["planID"];
    const planFamily = typeof planID === "string" && isRecord(finalPlans[planID]) ? (finalPlans[planID] as Record<string, unknown>) : undefined;
    if (!runFinalPlan || !planFamily) return undefined;
    const record = planFamily[`${String(runFinalPlan["id"])}@${String(runFinalPlan["revision"])}`];
    return isRecord(record) ? record : undefined;
  };

  const shapeCheckEvidenceRef = (value: unknown, where: string): void => {
    try {
      assertVerificationEvidenceRef(value);
    } catch {
      throw corrupt(`${where} carries a malformed verification evidence ref`);
    }
  };

  for (const [issueID, issue] of Object.entries(executionIssues)) {
    if (!isRecord(issue)) throw corrupt(`execution issue ${issueID} is not an object`);
    if (issue["id"] !== issueID) throw corrupt(`execution issue key ${issueID} does not match its identity`);
    const runID = issue["executionRunID"];
    const run = typeof runID === "string" ? executionRuns[runID] : undefined;
    if (!isRecord(run)) throw corrupt(`execution issue ${issueID} references missing execution run ${String(runID)}`);
    // §60 — an issue can only exist on a terminal replan_required run, and the
    // run must index it back (bidirectional consistency for new data).
    if (run["lifecycle"] !== "replan_required") {
      throw corrupt(`execution issue ${issueID} is attached to a ${String(run["lifecycle"])} run`);
    }
    if (issueByExecutionRun[String(runID)] !== issueID) {
      throw corrupt(`execution issue ${issueID} is not indexed as its run's issue`);
    }
    // §59 — the exact FinalPlan binding must be preserved in the issue.
    const runFinalPlan = isRecord(run["finalPlan"]) ? (run["finalPlan"] as Record<string, unknown>) : undefined;
    const issueFinalPlan = isRecord(issue["finalPlanRef"]) ? (issue["finalPlanRef"] as Record<string, unknown>) : undefined;
    if (
      !runFinalPlan ||
      !issueFinalPlan ||
      issueFinalPlan["id"] !== runFinalPlan["id"] ||
      issueFinalPlan["revision"] !== runFinalPlan["revision"]
    ) {
      throw corrupt(`execution issue ${issueID} FinalPlan ref disagrees with the run's binding`);
    }
    // §59 — the source assessment must be a request_replan judgment of this run.
    const sourceAssessmentID = issue["sourceAssessmentID"];
    const assessment = typeof sourceAssessmentID === "string" ? supervisorAssessments[sourceAssessmentID] : undefined;
    if (!isRecord(assessment)) {
      throw corrupt(`execution issue ${issueID} references missing source assessment ${String(sourceAssessmentID)}`);
    }
    if (assessment["executionRunID"] !== runID || assessment["disposition"] !== "request_replan") {
      throw corrupt(`execution issue ${issueID} source assessment is not a request_replan judgment of its run`);
    }
    if (
      issue["activeStageID"] !== assessment["stageID"] ||
      issue["openWindowID"] !== assessment["windowID"] ||
      issue["candidateRevision"] !== assessment["candidateRevision"]
    ) {
      throw corrupt(`execution issue ${issueID} captured candidate context disagrees with its source assessment`);
    }
    if (run["activeStage"] !== issue["activeStageID"] || run["openWindow"] !== issue["openWindowID"]) {
      throw corrupt(`execution issue ${issueID} captured structure disagrees with the terminal run's frozen structure`);
    }
    if (typeof issue["reason"] !== "string" || (issue["reason"] as string).length === 0) {
      throw corrupt(`execution issue ${issueID} has a malformed reason`);
    }
    // §59 — affectedPlanRefs must resolve exactly inside the bound FinalPlan.
    const planRecord = finalPlanRecordForRun(run);
    const affected = Array.isArray(issue["affectedPlanRefs"]) ? (issue["affectedPlanRefs"] as unknown[]) : undefined;
    if (!planRecord || !affected) {
      throw corrupt(`execution issue ${issueID} has malformed affectedPlanRefs or an unresolvable FinalPlan record`);
    }
    try {
      validateExecutionPlanRefs(affected as never, planRecord as never);
    } catch {
      throw corrupt(`execution issue ${issueID} affectedPlanRefs do not resolve inside the bound FinalPlan`);
    }
    // reportRefs must be provenance of this run.
    for (const ref of (Array.isArray(issue["reportRefs"]) ? issue["reportRefs"] : []) as unknown[]) {
      const report = typeof ref === "string" ? executionReports[ref] : undefined;
      const attemptID = isRecord(report) ? report["attemptID"] : undefined;
      const attempt = typeof attemptID === "string" ? executionAttempts[attemptID] : undefined;
      if (!isRecord(report) || !isRecord(attempt) || attempt["executionRunID"] !== runID) {
        throw corrupt(`execution issue ${issueID} references missing/foreign Report ${String(ref)}`);
      }
    }
    // §59 — accepted-history snapshot: the chain tip and the FULL chain.
    if ((issue["acceptedHead"] ?? undefined) !== (run["acceptedHead"] ?? undefined)) {
      throw corrupt(`execution issue ${issueID} acceptedHead snapshot disagrees with the run`);
    }
    const runCommits = Object.entries(executionCommits)
      .filter(([, commit]) => isRecord(commit) && commit["executionRunID"] === runID)
      .map(([commitKey]) => commitKey);
    const issueCommitRefs = (Array.isArray(issue["acceptedCommitRefs"]) ? issue["acceptedCommitRefs"] : []) as unknown[];
    if (
      issueCommitRefs.length !== runCommits.length ||
      !issueCommitRefs.every((ref) => typeof ref === "string" && runCommits.includes(ref)) ||
      (run["acceptedHead"] !== undefined && !issueCommitRefs.includes(run["acceptedHead"] as string))
    ) {
      throw corrupt(`execution issue ${issueID} accepted commit history is impossible`);
    }
    for (const ref of issueCommitRefs) {
      const commit = executionCommits[ref as string];
      if (!isRecord(commit) || commit["executionRunID"] !== runID) {
        throw corrupt(`execution issue ${issueID} accepted commit ${String(ref)} is missing/foreign`);
      }
    }
    const stageRef = issue["activeStageID"];
    if (stageRef !== undefined && (typeof stageRef !== "string" || executionStages[stageRef]?.["executionRunID"] !== runID)) {
      throw corrupt(`execution issue ${issueID} references a missing/foreign Stage ${String(stageRef)}`);
    }
    const windowRef = issue["openWindowID"];
    if (windowRef !== undefined && (typeof windowRef !== "string" || verificationWindows[windowRef]?.["executionRunID"] !== runID)) {
      throw corrupt(`execution issue ${issueID} references a missing/foreign Window ${String(windowRef)}`);
    }
    for (const ref of (Array.isArray(issue["verificationConflictRefs"]) ? issue["verificationConflictRefs"] : []) as unknown[]) {
      const conflict = typeof ref === "string" ? verificationConflicts[ref] : undefined;
      if (!isRecord(conflict) || conflict["executionRunID"] !== runID) {
        throw corrupt(`execution issue ${issueID} references missing/foreign conflict ${String(ref)}`);
      }
    }
    for (const ref of (Array.isArray(issue["unresolvedIndeterminateAttemptRefs"]) ? issue["unresolvedIndeterminateAttemptRefs"] : []) as unknown[]) {
      const attempt = typeof ref === "string" ? executionAttempts[ref] : undefined;
      if (!isRecord(attempt) || attempt["executionRunID"] !== runID || attempt["state"] !== "indeterminate") {
        throw corrupt(`execution issue ${issueID} references a missing/non-indeterminate Attempt ${String(ref)}`);
      }
      if (reconciliationByAttempt[ref as string] !== undefined) {
        throw corrupt(`execution issue ${issueID} lists reconciled Attempt ${String(ref)} as unresolved`);
      }
    }
    if (typeof issue["hash"] !== "string" || computeExecutionIssueHashFromRecord(issue as never) !== issue["hash"]) {
      throw corrupt(`execution issue ${issueID} content does not recompute to its canonical hash`);
    }
    if (typeof issue["createdAt"] !== "string") throw corrupt(`execution issue ${issueID} is missing createdAt`);
  }

  // §60 — every replan_required run carries exactly one valid terminal issue.
  for (const [runID, run] of Object.entries(executionRuns)) {
    if (!isRecord(run) || run["lifecycle"] !== "replan_required") continue;
    const issueID = issueByExecutionRun[runID];
    if (typeof issueID !== "string" || !isRecord(executionIssues[issueID])) {
      throw corrupt(`replan_required execution run ${runID} has no durable ExecutionIssue`);
    }
  }

  // Resolver-uniqueness scan: at most ONE conflict_resolution Directive per
  // conflict, and it must be the recorded binding (§29/§61/§92).
  const resolversByConflict = new Map<string, string[]>();
  for (const [key, directive] of Object.entries(executionDirectives)) {
    if (!isRecord(directive) || directive["verificationPurpose"] !== "conflict_resolution") continue;
    const conflictID = directive["conflictID"];
    if (typeof conflictID !== "string") {
      throw corrupt(`conflict-resolution directive ${key} carries no conflictID`);
    }
    const conflict = verificationConflicts[conflictID];
    if (!isRecord(conflict)) {
      throw corrupt(`conflict-resolution directive ${key} references missing conflict ${conflictID}`);
    }
    const list = resolversByConflict.get(conflictID) ?? [];
    list.push(key);
    resolversByConflict.set(conflictID, list);
  }
  for (const [conflictID, resolverKeys] of resolversByConflict) {
    if (resolverKeys.length > 1) {
      throw corrupt(`verification conflict ${conflictID} has ${resolverKeys.length} conflict-resolution Directives (exactly one is the hard limit)`);
    }
    const conflict = verificationConflicts[conflictID]!;
    const binding = conflict["resolutionDirectiveRef"];
    if (isRecord(binding)) {
      const boundKey = `${String(binding["id"])}@${String(binding["revision"])}`;
      if (boundKey !== resolverKeys[0]) {
        throw corrupt(`verification conflict ${conflictID} resolver binding disagrees with the durable conflict-resolution Directive`);
      }
    }
  }

  for (const [conflictID, conflict] of Object.entries(verificationConflicts)) {
    if (!isRecord(conflict)) throw corrupt(`verification conflict ${conflictID} is not an object`);
    if (conflict["id"] !== conflictID) throw corrupt(`verification conflict key ${conflictID} does not match its identity`);
    const runID = conflict["executionRunID"];
    const run = typeof runID === "string" ? executionRuns[runID] : undefined;
    if (!isRecord(run)) throw corrupt(`verification conflict ${conflictID} references missing execution run ${String(runID)}`);
    const stageID = conflict["stageID"];
    const stage = typeof stageID === "string" ? executionStages[stageID] : undefined;
    if (!isRecord(stage) || stage["executionRunID"] !== runID) {
      throw corrupt(`verification conflict ${conflictID} references a missing/foreign Stage`);
    }
    const windowID = conflict["windowID"];
    const win = typeof windowID === "string" ? verificationWindows[windowID] : undefined;
    if (!isRecord(win) || win["executionRunID"] !== runID || win["stageID"] !== stageID) {
      throw corrupt(`verification conflict ${conflictID} references a Window outside its Stage/Run`);
    }
    const candidateRevision = conflict["candidateRevision"];
    if (typeof candidateRevision !== "number" || !Number.isInteger(candidateRevision) || candidateRevision < 0) {
      throw corrupt(`verification conflict ${conflictID} has a malformed candidateRevision`);
    }
    // History is legal; the FUTURE is not — a conflict can never bind beyond its window.
    if (candidateRevision > (win["candidateRevision"] as number)) {
      throw corrupt(`verification conflict ${conflictID} binds candidateRevision beyond its window`);
    }
    shapeCheckEvidenceRef(conflict["evidenceA"], `verification conflict ${conflictID} evidenceA`);
    shapeCheckEvidenceRef(conflict["evidenceB"], `verification conflict ${conflictID} evidenceB`);
    if (stableStringifyForDoc(conflict["evidenceA"]) === stableStringifyForDoc(conflict["evidenceB"])) {
      throw corrupt(`verification conflict ${conflictID} evidence A and B are the same ref`);
    }
    for (const side of ["evidenceA", "evidenceB"] as const) {
      const ref = conflict[side] as Record<string, unknown>;
      const report = typeof ref["reportID"] === "string" ? executionReports[ref["reportID"]] : undefined;
      const attemptID = isRecord(report) ? report["attemptID"] : undefined;
      const attempt = typeof attemptID === "string" ? executionAttempts[attemptID] : undefined;
      if (!isRecord(report) || !isRecord(attempt) || attempt["windowID"] !== windowID) {
        throw corrupt(`verification conflict ${conflictID} ${side} references a Report outside its Window`);
      }
      if (report["baseCandidateRevision"] !== candidateRevision) {
        throw corrupt(`verification conflict ${conflictID} ${side} evidence binds a different candidate than the conflict`);
      }
      if (ref["kind"] === "finding" && (ref["findingIndex"] as number) >= (Array.isArray(report["findings"]) ? (report["findings"] as unknown[]).length : 0)) {
        throw corrupt(`verification conflict ${conflictID} ${side} findingIndex is out of bounds`);
      }
    }
    if (
      typeof conflict["claimA"] !== "string" || (conflict["claimA"] as string).length === 0 ||
      typeof conflict["claimB"] !== "string" || (conflict["claimB"] as string).length === 0 ||
      typeof conflict["resolutionQuestion"] !== "string" || (conflict["resolutionQuestion"] as string).length === 0
    ) {
      throw corrupt(`verification conflict ${conflictID} has malformed claims/question`);
    }
    if (!(VERIFICATION_CONFLICT_STATUSES as readonly string[]).includes(conflict["status"] as string)) {
      throw corrupt(`verification conflict ${conflictID} carries an invalid status`);
    }
    const outcome = conflict["resolutionOutcome"];
    if (outcome !== undefined) {
      if (!(CONFLICT_RESOLUTION_OUTCOMES as readonly string[]).includes(outcome as string)) {
        throw corrupt(`verification conflict ${conflictID} carries an invalid resolutionOutcome`);
      }
    }
    if (conflict["status"] === "open") {
      if (conflict["resolutionReportRef"] !== undefined || outcome !== undefined || conflict["resolvedAt"] !== undefined) {
        throw corrupt(`open verification conflict ${conflictID} carries finalization state`);
      }
    } else {
      // Terminal conflicts must carry their consumed resolver (§61).
      const reportRef = conflict["resolutionReportRef"];
      const report = typeof reportRef === "string" ? executionReports[reportRef] : undefined;
      if (!isRecord(report)) {
        throw corrupt(`terminal verification conflict ${conflictID} has no consumed resolution Report`);
      }
      if (typeof conflict["resolvedAt"] !== "string") {
        throw corrupt(`terminal verification conflict ${conflictID} is missing resolvedAt`);
      }
      const attemptID = report["attemptID"];
      const attempt = typeof attemptID === "string" ? executionAttempts[attemptID] : undefined;
      const attemptDirective = isRecord(attempt) && isRecord(attempt["directive"]) ? (attempt["directive"] as Record<string, unknown>) : undefined;
      const resolverDirective = attemptDirective ? executionDirectives[`${String(attemptDirective["id"])}@${String(attemptDirective["revision"])}`] : undefined;
      if (
        !isRecord(attempt) ||
        !isRecord(resolverDirective) ||
        resolverDirective["verificationPurpose"] !== "conflict_resolution" ||
        resolverDirective["conflictID"] !== conflictID ||
        report["workerRole"] !== "verifier" ||
        report["baseCandidateRevision"] !== candidateRevision
      ) {
        throw corrupt(`verification conflict ${conflictID} resolution Report has the wrong role/kind/purpose/candidate`);
      }
      const neutralized = (Array.isArray(conflict["neutralizedEvidenceRefs"]) ? conflict["neutralizedEvidenceRefs"] : []) as unknown[];
      if (conflict["status"] === "resolved") {
        if (
          report["result"] !== "completed" ||
          report["candidateMutation"] !== "none" ||
          outcome === undefined ||
          outcome === "unresolved"
        ) {
          throw corrupt(`resolved verification conflict ${conflictID} was finalized by a non-adjudicating report`);
        }
        const derived = neutralizedEvidenceForOutcome(outcome as never, conflict["evidenceA"] as never, conflict["evidenceB"] as never);
        if (
          neutralized.length !== derived.length ||
          !neutralized.every((ref) => derived.some((candidate) => stableStringifyForDoc(candidate) === stableStringifyForDoc(ref)))
        ) {
          throw corrupt(`verification conflict ${conflictID} neutralized evidence does not match the deterministic outcome rule`);
        }
      } else {
        // verification_blocked: no neutralization may have happened.
        if (neutralized.length > 0) {
          throw corrupt(`verification_blocked conflict ${conflictID} carries neutralized evidence`);
        }
        if (report["result"] === "completed" && outcome !== "unresolved") {
          throw corrupt(`verification_blocked conflict ${conflictID} was blocked by an adjudicating report`);
        }
      }
    }
    if (typeof conflict["createdAt"] !== "string") throw corrupt(`verification conflict ${conflictID} is missing createdAt`);
  }

  const coverageTally = new Map<string, string>();
  for (const [reconciliationID, reconciliation] of Object.entries(attemptReconciliations)) {
    if (!isRecord(reconciliation)) throw corrupt(`attempt reconciliation ${reconciliationID} is not an object`);
    if (reconciliation["id"] !== reconciliationID) throw corrupt(`attempt reconciliation key ${reconciliationID} does not match its identity`);
    const runID = reconciliation["executionRunID"];
    const run = typeof runID === "string" ? executionRuns[runID] : undefined;
    if (!isRecord(run)) throw corrupt(`attempt reconciliation ${reconciliationID} references missing execution run ${String(runID)}`);
    const stageID = reconciliation["stageID"];
    const stage = typeof stageID === "string" ? executionStages[stageID] : undefined;
    if (!isRecord(stage) || stage["executionRunID"] !== runID) {
      throw corrupt(`attempt reconciliation ${reconciliationID} references a missing/foreign Stage`);
    }
    const windowID = reconciliation["windowID"];
    const win = typeof windowID === "string" ? verificationWindows[windowID] : undefined;
    if (!isRecord(win) || win["executionRunID"] !== runID || win["stageID"] !== stageID) {
      throw corrupt(`attempt reconciliation ${reconciliationID} references a Window outside its Stage/Run`);
    }
    // §62 — targets: existing, same window, and STILL indeterminate (terminal
    // immutable history — reconciliation never mutates the Attempt).
    const targets = Array.isArray(reconciliation["targetAttemptIDs"]) ? (reconciliation["targetAttemptIDs"] as unknown[]) : [];
    if (targets.length === 0) throw corrupt(`attempt reconciliation ${reconciliationID} carries no targets`);
    for (const ref of targets) {
      const attempt = typeof ref === "string" ? executionAttempts[ref] : undefined;
      if (!isRecord(attempt) || attempt["windowID"] !== windowID || attempt["state"] !== "indeterminate") {
        throw corrupt(`attempt reconciliation ${reconciliationID} references a missing/cross-window/non-indeterminate target ${String(ref)}`);
      }
    }
    // §62 — the inspection must be a real non-mutating reconciliation inspection.
    const directiveRef = isRecord(reconciliation["inspectionDirectiveRef"]) ? (reconciliation["inspectionDirectiveRef"] as Record<string, unknown>) : undefined;
    const inspectionDirective = directiveRef ? executionDirectives[`${String(directiveRef["id"])}@${String(directiveRef["revision"])}`] : undefined;
    if (
      !directiveRef ||
      !isRecord(inspectionDirective) ||
      inspectionDirective["windowID"] !== windowID ||
      inspectionDirective["kind"] !== "inspection" ||
      inspectionDirective["candidateEffect"] !== "non_mutating" ||
      !Array.isArray(inspectionDirective["reconciliationTargets"])
    ) {
      throw corrupt(`attempt reconciliation ${reconciliationID} inspection Directive is not a reconciliation inspection of its Window`);
    }
    const inspectionEnvelope = isRecord(inspectionDirective["capabilityEnvelope"]) ? (inspectionDirective["capabilityEnvelope"] as Record<string, unknown>) : undefined;
    if (
      !inspectionEnvelope ||
      inspectionEnvelope["repositoryRead"] !== true ||
      RECONCILIATION_FORBIDDEN_CAPABILITIES.some((capability) => inspectionEnvelope[capability] === true)
    ) {
      throw corrupt(`attempt reconciliation ${reconciliationID} inspection Directive violates reconciliation capability constraints`);
    }
    if (typeof directiveRef["hash"] === "string" && directiveRef["hash"] !== inspectionDirective["hash"]) {
      throw corrupt(`attempt reconciliation ${reconciliationID} inspection Directive hash mismatch`);
    }
    const inspectionAttemptID = reconciliation["inspectionAttemptID"];
    const inspectionAttempt = typeof inspectionAttemptID === "string" ? executionAttempts[inspectionAttemptID] : undefined;
    if (
      !isRecord(inspectionAttempt) ||
      inspectionAttempt["state"] !== "reported" ||
      !isRecord(inspectionAttempt["directive"]) ||
      (inspectionAttempt["directive"] as Record<string, unknown>)["id"] !== directiveRef["id"] ||
      (inspectionAttempt["directive"] as Record<string, unknown>)["revision"] !== directiveRef["revision"]
    ) {
      throw corrupt(`attempt reconciliation ${reconciliationID} references the wrong inspection Attempt`);
    }
    const inspectionReportID = reconciliation["inspectionReportID"];
    const report = typeof inspectionReportID === "string" ? executionReports[inspectionReportID] : undefined;
    if (
      !isRecord(report) ||
      report["attemptID"] !== inspectionAttemptID ||
      report["result"] !== "completed" ||
      report["candidateMutation"] !== "none"
    ) {
      throw corrupt(`attempt reconciliation ${reconciliationID} references a missing/mutating/incomplete inspection Report`);
    }
    if (!SUCCESSFUL_RECONCILIATION_OBSERVATIONS.includes(report["reconciliationObservation"] as never)) {
      throw corrupt(`attempt reconciliation ${reconciliationID} inspection Report observation is not unchanged/changed`);
    }
    if (report["reconciliationObservation"] !== reconciliation["observation"]) {
      throw corrupt(`attempt reconciliation ${reconciliationID} observation disagrees with its inspection Report`);
    }
    const base = reconciliation["baseCandidateRevision"];
    const resulting = reconciliation["resultingCandidateRevision"];
    if (typeof base !== "number" || typeof resulting !== "number" || !Number.isInteger(base) || !Number.isInteger(resulting)) {
      throw corrupt(`attempt reconciliation ${reconciliationID} has malformed revision arithmetic`);
    }
    if (reconciliation["observation"] === "unchanged" && resulting !== base) {
      throw corrupt(`unchanged attempt reconciliation ${reconciliationID} must not advance the candidate revision`);
    }
    if (reconciliation["observation"] === "changed" && resulting !== base + 1) {
      throw corrupt(`changed attempt reconciliation ${reconciliationID} must advance the candidate revision exactly +1`);
    }
    if (base !== report["baseCandidateRevision"] || (resulting as number) > (win["candidateRevision"] as number)) {
      throw corrupt(`attempt reconciliation ${reconciliationID} revision arithmetic disagrees with its report or window`);
    }
    if (typeof reconciliation["createdAt"] !== "string") throw corrupt(`attempt reconciliation ${reconciliationID} is missing createdAt`);
    // One successful reconciliation per target, and the index must agree.
    for (const ref of targets) {
      if (reconciliationByAttempt[ref as string] !== reconciliationID) {
        throw corrupt(`attempt reconciliation ${reconciliationID} is not indexed for its target ${String(ref)}`);
      }
      if (coverageTally.has(ref as string)) {
        throw corrupt(`execution attempt ${String(ref)} is covered by two successful reconciliations`);
      }
      coverageTally.set(ref as string, reconciliationID);
    }
  }

  for (const [attemptID, reconciliationID] of Object.entries(reconciliationByAttempt)) {
    const reconciliation = attemptReconciliations[reconciliationID];
    const targets = isRecord(reconciliation) && Array.isArray(reconciliation["targetAttemptIDs"]) ? (reconciliation["targetAttemptIDs"] as unknown[]) : [];
    if (!isRecord(reconciliation) || !targets.includes(attemptID)) {
      throw corrupt(`reconciliation index for attempt ${attemptID} references missing/inconsistent reconciliation ${String(reconciliationID)}`);
    }
  }

  // -- v0.2.0 Phase 6B final closure & completion (fail-closed, SS59-SS63) ----
  // ADDITIVE families (pre-Phase-6B documents = "nothing ever completed
  // through the gate"). LEGACY rule (SS50): a completed run WITHOUT a
  // completion record is pre-6B history and loads unchanged. Every RECORD is
  // validated against the full final-closure provenance chain (SS61) and can
  // only exist on a completed run (SS62/SS63) — fail closed, never repaired.
  const executionCompletions = isRecord(doc.executionCompletions)
    ? (doc.executionCompletions as Record<string, Record<string, unknown>>)
    : {};
  const completionByExecutionRun = isRecord(doc.completionByExecutionRun)
    ? (doc.completionByExecutionRun as Record<string, string>)
    : {};

  for (const [completionID, completion] of Object.entries(executionCompletions)) {
    if (!isRecord(completion)) throw corrupt(`execution completion ${completionID} is not an object`);
    if (completion["id"] !== completionID) throw corrupt(`execution completion key ${completionID} does not match its identity`);
    const runID = completion["executionRunID"];
    const run = typeof runID === "string" ? executionRuns[runID] : undefined;
    if (!isRecord(run)) throw corrupt(`execution completion ${completionID} references missing execution run ${String(runID)}`);
    // SS62/SS63 — a record can ONLY exist on a completed run.
    if (run["lifecycle"] !== "completed") {
      throw corrupt(`execution completion ${completionID} exists against a ${String(run["lifecycle"])} run`);
    }
    // SS51 — the run must index this record back (new-protocol provenance).
    if (run["completionRecord"] !== undefined && run["completionRecord"] !== completionID) {
      throw corrupt(`execution run ${runID} completionRecord disagrees with its indexed completion`);
    }
    // SS61 — exact FinalPlan ref.
    const runFinalPlan = isRecord(run["finalPlan"]) ? (run["finalPlan"] as Record<string, unknown>) : undefined;
    const planRef = isRecord(completion["finalPlanRef"]) ? (completion["finalPlanRef"] as Record<string, unknown>) : undefined;
    if (!runFinalPlan || !planRef || planRef["id"] !== runFinalPlan["id"] || planRef["revision"] !== runFinalPlan["revision"]) {
      throw corrupt(`execution completion ${completionID} FinalPlan ref disagrees with the run's binding`);
    }
    // SS61 — exact final closure Stage.
    const closureStageID = completion["finalClosureStageID"];
    const closureStage = typeof closureStageID === "string" ? executionStages[closureStageID] : undefined;
    if (
      !isRecord(closureStage) ||
      closureStage["executionRunID"] !== runID ||
      executionStageKindOf(closureStage as never) !== "final_closure" ||
      closureStage["status"] !== "completed"
    ) {
      throw corrupt(`execution completion ${completionID} references a missing/foreign/incomplete final closure Stage ${String(closureStageID)}`);
    }
    // SS61 — exact final Window (closed, of the closure Stage).
    const finalWindowID = completion["finalWindowID"];
    const finalWindow = typeof finalWindowID === "string" ? verificationWindows[finalWindowID] : undefined;
    if (!isRecord(finalWindow) || finalWindow["executionRunID"] !== runID || finalWindow["stageID"] !== closureStageID || finalWindow["state"] !== "closed") {
      throw corrupt(`execution completion ${completionID} references a missing/unclosed final Window ${String(finalWindowID)}`);
    }
    // SS61 — the final Commit: exists, is the run's acceptedHead, completed the
    // closure Stage, closes the final Window.
    const finalCommitID = completion["finalCommitID"];
    const finalCommit = typeof finalCommitID === "string" ? executionCommits[finalCommitID] : undefined;
    if (!isRecord(finalCommit)) {
      throw corrupt(`execution completion ${completionID} references missing final Commit ${String(finalCommitID)}`);
    }
    if (finalCommit["stageID"] !== closureStageID || finalCommit["stageCompleted"] !== true || finalCommit["windowID"] !== finalWindowID) {
      throw corrupt(`execution completion ${completionID} final Commit did not complete the closure Stage through the final Window`);
    }
    if (run["acceptedHead"] !== finalCommitID) {
      throw corrupt(`execution completion ${completionID} final Commit is not the run's acceptedHead`);
    }
    if (completion["acceptedHead"] !== finalCommitID) {
      throw corrupt(`execution completion ${completionID} acceptedHead snapshot disagrees with the final Commit`);
    }
    // SS61 — the final Assessment: the Commit's own, accept, stage scope, exact candidate.
    const finalAssessmentID = completion["finalAssessmentID"];
    const finalAssessment = typeof finalAssessmentID === "string" ? supervisorAssessments[finalAssessmentID] : undefined;
    if (
      !isRecord(finalAssessment) ||
      finalAssessmentID !== finalCommit["supervisorAssessmentID"] ||
      finalAssessment["disposition"] !== "accept" ||
      finalAssessment["acceptanceScope"] !== "stage" ||
      finalAssessment["windowID"] !== finalWindowID ||
      finalAssessment["candidateRevision"] !== finalCommit["candidateRevision"]
    ) {
      throw corrupt(`execution completion ${completionID} references a wrong/mismatched final Assessment ${String(finalAssessmentID)}`);
    }
    if (typeof completion["completedAt"] !== "string") throw corrupt(`execution completion ${completionID} is missing completedAt`);
    if (typeof completion["hash"] !== "string" || computeExecutionCompletionHashFromRecord(completion as never) !== completion["hash"]) {
      throw corrupt(`execution completion ${completionID} content does not recompute to its canonical hash`);
    }
  }

  // SS62 — a run-level completionRecord ref must resolve to a real record
  // (new-protocol provenance is never dangling; legacy runs carry none).
  for (const [runID, run] of Object.entries(executionRuns)) {
    if (!isRecord(run)) continue;
    const ref = run["completionRecord"];
    if (ref !== undefined && !isRecord(executionCompletions[ref as string])) {
      throw corrupt(`execution run ${runID} carries a dangling completionRecord ${String(ref)}`);
    }
  }

  // SS58 — one v0.2 record per run; the index must agree with the records.
  const completionTally = new Map<string, string>();
  for (const [completionID, completion] of Object.entries(executionCompletions)) {
    const runID = isRecord(completion) ? completion["executionRunID"] : undefined;
    if (typeof runID !== "string") continue;
    if (completionTally.has(runID)) {
      throw corrupt(`execution run ${runID} has two completion records (${String(completionTally.get(runID))}, ${completionID})`);
    }
    completionTally.set(runID, completionID);
    if (completionByExecutionRun[runID] !== completionID) {
      throw corrupt(`execution completion ${completionID} is not indexed as its run's completion`);
    }
  }
  for (const [runID, completionID] of Object.entries(completionByExecutionRun)) {
    const record = executionCompletions[completionID];
    if (!isRecord(record) || record["executionRunID"] !== runID) {
      throw corrupt(`completion index for run ${runID} references missing/foreign completion ${String(completionID)}`);
    }
  }
}

/**
 * Hash over a stored proposal's canonical payload WITHOUT importing the
 * transaction engine — the exact same canonical serialization as
 * transaction/hash.ts (stableStringify: sorted keys, undefined dropped).
 */
function approvalHashForDoc(proposal: Record<string, unknown>): string {
  const payload = {
    id: proposal["id"],
    revision: proposal["revision"],
    type: proposal["type"],
    scope: proposal["scope"],
    title: proposal["title"],
    summary: proposal["summary"],
    changes: proposal["changes"],
    dependencies: proposal["dependencies"],
    impact: proposal["impact"],
    createdFrom: proposal["createdFrom"],
  };
  return createHash("sha256").update(stableStringifyForDoc(payload)).digest("hex");
}

function stableStringifyForDoc(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringifyForDoc).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringifyForDoc(v)}`).join(",")}}`;
}

