/**
 * Phase 16 MCP tool surface (Phase 16 §48 — the frozen v0.1 logical surface
 * completed; earlier phases §87/§95).
 *
 * The surface, in registration order:
 *   start_or_resume  (entry, requires a signed EntryIntent from /phase-plan)
 *   get_state        (read-only, session-scoped; final-stage FinalPlan +
 *                     handoff authorization projection, §61)
 *   get_context      (read-only structured context projection + epoch;
 *                     detail=validation returns the frozen bundle, §32–§34;
 *                     detail=final returns the FinalPlanCandidate world, §43)
 *   read_memory      (read-only exact MemoryRef retrieval)
 *   list_observations(read-only Observation ledger summaries, §21/§22)
 *   promote_evidence (explicit Observation→Evidence promotion, §28/§44/§45)
 *   revalidate_evidence (Evidence freshness revalidation, Phase 10 §20–§29)
 *   select_section   (durable active-Section selection, Detail stage)
 *   prepare_proposal (the production model-facing prepare surface, §21)
 *   approve_proposal (the Formal Approval bridge into the Phase 6 engine,
 *                     marked anthropic/requiresUserInteraction=true; also the
 *                     sole Final Approval path, §46)
 *   submit_synthesis (main-agent manifest submission, §41–§45)
 *   submit_validation(VALIDATOR-ONLY report submission, §52–§58 — the signed
 *                     HostContext must attest agent_type=phase-plan:validator)
 *   request_reopen   (main-agent reopen from synthesis/validation/final,
 *                     §59–§67/§65)
 *   request_finalization (main-agent deterministic FinalizationGate + frozen
 *                     FinalPlanCandidate + final Proposal, Phase 13 §26–§29)
 *   handoff         (sole Plan → Build delivery of the approved FinalPlan,
 *                     Phase 14)
 *   report_execution_issue (Build's sole defect report against the delivered
 *                     contract, Phase 15 §12)
 *   takeover_run    (explicit human-authorized ownership transfer of another
 *                     session's ACTIVE run, G → G+1, Phase 16 §8–§26)
 *   abort_run       (explicit human-authorized terminal abort of the current
 *                     session's active run; history preserved, never Build,
 *                     Phase 16 §27–§42)
 *
 * Exactly eighteen tools — the frozen v0.1 logical surface (Phase 16 §48).
 *
 * Authority model: every handler verifies the hook-signed HostContext first
 * (signature → tool binding → business-input hash). The MCP process's own
 * environment — including CLAUDE_CODE_SESSION_ID — is NEVER authority
 * (directive §19/§26). Tool visibility is not authority: stage/lifecycle/
 * binding/HEAD/proposal state is revalidated by the application services and
 * the Phase 6 engine on every call, and submit_validation re-derives the
 * validator attestation from the signed envelope, never from model input
 * (§5/§53/§54). Read tools accept a read-only HostContext without requiring
 * permission_mode=plan (§39) but never widen scope: the run is resolved from
 * the signed session + workspace, never from model input. prepare_proposal
 * carries NO human approval (§21/§61): Formal Approval still happens only
 * through approve_proposal, and validator findings never need one (§52).
 * request_finalization carries NO human approval either (§28): the REAL user
 * interaction stays with approve_proposal on the exact final Proposal (§46).
 */

import { getWorkspaceById } from "../store/repositories.js";
import { getAwaitingProposalRecord } from "../store/proposals.js";
import { getHeadCommitRecord, getHeadPairInTx } from "../store/plan-commits.js";
import { getPlanningRunRecord, listPlanningRunsForWorkspaceRecord } from "../store/planning-runs.js";
import { getActiveSection, listSectionWorkflowStates } from "../store/section-workflow.js";
import { createSectionWorkflowService } from "../application/section-workflow-service.js";
import { createSynthesisService } from "../application/synthesis-service.js";
import { createFinalizationService, loadFinalizationContextInTx } from "../application/finalization-service.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import { renderFinalPlanCandidateMarkdown } from "../core/finalization.js";
import { renderExecutionContract, type ExecutionHandoffV1 } from "../core/execution-handoff.js";
import { createHandoffService, parseFinalPlanCanonical } from "../application/handoff-service.js";
import { createExecutionIssueService } from "../application/execution-issue-service.js";
import { createSuccessorRunService } from "../application/successor-run-service.js";
import { listOpenExecutionIssuesInTx } from "../store/execution-issues.js";
import {
  getPlanningRunBaselineForSuccessorInTx,
  listBaselineScopesInTx,
  getBaselineMaterializationInTx,
} from "../store/successor-baselines.js";
import {
  EXECUTION_ISSUE_KINDS,
  EXECUTION_ISSUE_REF_TYPES,
  isExecutionIssueKind,
  isExecutionIssueRefType,
  type ExecutionIssueAffectedRef,
  type ExecutionIssueKind,
} from "../core/execution-issue.js";
import { getExecutionHandoffInTx, getExecutionHandoffStateInTx, findAttachedExecutionBindingForSessionInTx } from "../store/execution.js";
import { getExecutionRunInTx, listExecutionRunsBySourcePlanningRunInTx } from "../store/execution-runs.js";
import { getSupervisorBindingInTx } from "../store/supervisor-bindings.js";
import { assertExecutionHostContextForTool, parseSignedHostContext, type ExecutionHostContextV1 } from "../host/execution-context.js";
import { assertWorkerHostContextForTool } from "../host/worker-context.js";
import {
  claimWorkerAttemptInTx,
  loadWorkerAssignment,
  startWorkerAttemptAndPrepareLaunchInTx,
  submitWorkerReportAndFinishInTx,
} from "../application/worker-runtime-service.js";
import {
  issueExecutionDirectiveInTx,
  type IssueExecutionDirectiveInput,
} from "../application/execution-directive-service.js";
import {
  loadExecutionAcceptanceContextInTx,
  normalizeSnakeRecord,
  submitSupervisorAssessmentInTx,
} from "../application/acceptance-service.js";
import {
  loadVerificationPolicyStateInTx,
} from "../application/verification-policy-service.js";
import {
  declareVerificationConflictInTx,
  resolveVerificationConflictInTx,
} from "../application/verification-conflict-service.js";
import {
  activateExecutionStageInTx,
  continueExecutionStageInTx,
  loadExecutionProgressionContextInTx,
} from "../application/execution-progression-service.js";
import { requestExecutionReplanInTx } from "../application/execution-replan-service.js";
import {
  beginExecutionFinalClosureInTx,
  loadExecutionFinalClosureContextInTx,
} from "../application/final-closure-service.js";
import {
  issueAttemptReconciliationInTx,
  loadAttemptRecoveryContextInTx,
  resolveIndeterminateAttemptInTx,
  retryUnclaimedLaunchInTx,
} from "../application/attempt-recovery-service.js";
import {
  SUPERVISOR_ASSESSMENT_DISPOSITIONS,
  type SupervisorAssessmentDisposition,
} from "../core/supervisor-assessment.js";
import type { DirectivePlanRef, ExecutionDirective, ExecutionDirectiveKind } from "../core/execution-directive.js";
import type { ExecutionReportResult } from "../core/execution-report.js";
import type { StartExecutionAttemptInput } from "../application/execution-attempt-service.js";
import type { SubmitExecutionReportInput } from "../application/execution-report-service.js";
import { assertWritableBindingInTx, getBinding } from "../store/session-bindings.js";
import { createRunControlService } from "../application/run-control-service.js";
import { createExecutionAbortService } from "../application/execution-abort-service.js";
import { createReexecutionService } from "../application/reexecution-service.js";
import { runControlRequestHash } from "../store/run-control.js";
import {
  getLatestSynthesisInputInTx,
  getSynthesisManifestByInputInTx,
  getValidationReportByManifestInTx,
  listValidationFindingsInTx,
} from "../store/synthesis.js";
import { createProposalService } from "../application/proposal-service.js";
import type { ProposalScope, ProposalType, RawProposalChange } from "../core/proposal.js";
import type { ProposalEvidenceRef } from "../core/proposal-canonical.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { BlobStore } from "../store/blob-store.js";
import type { PlanningRun } from "../core/planning-run.js";
import type { BindingSnapshot } from "../store/session-bindings.js";
import { isMemoryArtifactKind } from "../core/memory-refs.js";
import type { MemoryRef } from "../core/memory-refs.js";
import { createBindingService } from "../session/binding-service.js";
import { createPlanningRunService } from "../application/planning-run-service.js";
import { createPlanCommitEngine } from "../application/plan-commit-engine.js";
import { createEvidenceService, type PromoteEvidenceRequest } from "../application/evidence-service.js";
import { createEvidenceFreshnessService, type RevalidationAssessment } from "../application/evidence-freshness-service.js";
import { listObservationSummaries } from "../application/observation-service.js";
import { OBSERVATION_CLASSES, type ObservationClass } from "../observations/types.js";
import { createStoreContextSource } from "../application/context-read-model.js";
import { assembleContext } from "../context/assembler.js";
import { buildRecoveryCapsule } from "../context/capsule.js";
import {
  CONTEXT_DETAILS,
  DEFAULT_MEMORY_DETAIL,
  isContextDetail,
  isMemoryDetailLevel,
  type ContextDetail,
  type MemoryDetailLevel,
} from "../context/detail-level.js";
import { findAttachedActiveRun, findDetachedActiveRun, listSessionRuns } from "../session/session-lookup.js";
import { RuntimeError } from "../runtime/errors.js";
import { assertHostContextForTool } from "../host/host-context.js";
import { entryIntentIsCurrent, verifyEntryIntent } from "../host/entry-intent.js";

export interface PhasePlanToolContext {
  store: PlanStore;
  secret: Buffer;
  clock: StoreClock;
  /** Content-addressed Observation payload store (plugin-data rooted). */
  blobs: BlobStore;
}

export interface PhasePlanToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Reserved host metadata (directive §28): real JSON boolean true. */
  _meta?: Record<string, unknown>;
}

export const REQUIRES_USER_INTERACTION_META = { "anthropic/requiresUserInteraction": true } as const;

export const PHASE_PLAN_TOOLS: readonly PhasePlanToolDefinition[] = [
  {
    name: "start_or_resume",
    description:
      "Enter Phase Plan: start a new planning run or resume the current session's active run. "
      + "Requires the signed _entryIntent token injected by the /phase-plan skill invocation; "
      + "the token cannot be fabricated. Returns started/resumed/selection_required state.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Planning goal; required when starting a new run." },
        action: { type: "string", enum: ["auto", "start_new"], description: "Defaults to auto." },
        _entryIntent: { type: "string", description: "Signed entry token from the /phase-plan expansion (do not modify)." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_entryIntent"],
      additionalProperties: false,
    },
  },
  {
    name: "get_state",
    description:
      "Read the current session's Phase Plan state: run, binding, HEAD commit/snapshot pair, and the awaiting proposal summary. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "get_context",
    description:
      "Read the current session's authoritative Phase Plan context projection (run, HEAD, committed memory, awaiting proposal, available operations) "
      + "with its deterministic context_epoch. detail=recovery also returns the rendered Recovery Capsule. Read-only; never accepts a run id.",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "string", enum: [...CONTEXT_DETAILS], description: '"recovery" includes the rendered Recovery Capsule; defaults to "current".' },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "read_memory",
    description:
      "Read one exact immutable Plan Memory revision of the current run by MemoryRef (kind + artifact id + revision). "
      + "There is no latest/current/fuzzy lookup: take exact refs from get_context/HEAD. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["constraint", "decision", "architecture", "section", "open_question", "conflict"] },
        id: { type: "string", description: "Artifact id within the current run." },
        revision: { type: "integer", minimum: 1 },
        detail: {
          type: "string",
          enum: ["identity", "summary", "full", "contract"],
          description: 'Defaults to "summary"; "contract" is only valid for sections.',
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["kind", "id", "revision", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "list_observations",
    description:
      "List the current run's captured Observations (actual host tool results recorded by the PostToolUse hook): "
      + "class, tool, captured-at, normalized input, payload hash/size, promotability, and any promoted Evidence references. "
      + "Summaries only — never whole payloads. Read-only; never accepts a run id.",
    inputSchema: {
      type: "object",
      properties: {
        class: { type: "string", enum: [...OBSERVATION_CLASSES], description: "Filter by observation class." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size; defaults to 20." },
        after: { type: "string", description: "Opaque ledger cursor from a previous page (observation_seq-based)." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "promote_evidence",
    description:
      "Promote captured Observations (or exact upstream Evidence revisions) into one durable, immutable Evidence claim. "
      + "Reference observations by id — payload/source provenance is rebuilt server-side and can never be model-authored. "
      + "Records provenance only; design consequences still require a Proposal and explicit human approval.",
    inputSchema: {
      type: "object",
      properties: {
        claim: { type: "string", description: "The planning-relevant claim this Evidence asserts (non-empty)." },
        kind: { type: "string", enum: ["source_fact", "locator_fact", "execution_result", "derived_claim"] },
        scope: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["global", "architecture"] },
          },
          required: ["type"],
          additionalProperties: false,
          description: "Evidence scope; section scope is not available in this phase.",
        },
        confidence: { type: "string", enum: ["direct", "derived", "uncertain"] },
        criticality: { type: "string", enum: ["critical", "supporting", "informational"] },
        observation_refs: {
          type: "array",
          items: { type: "string" },
          description: "Observation ids cited as provenance (required for confidence=direct).",
        },
        derived_from: {
          type: "array",
          items: {
            type: "object",
            properties: {
              evidence_id: { type: "string" },
              revision: { type: "integer", minimum: 1 },
            },
            required: ["evidence_id", "revision"],
            additionalProperties: false,
          },
          description: "Exact upstream Evidence revisions (required for confidence=derived; never 'latest').",
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["claim", "kind", "scope", "confidence", "criticality", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "revalidate_evidence",
    description:
      "Revalidate one exact Evidence revision. mode=check deterministically re-compares the current whole-file source "
      + "hashes against the capture-time fingerprints (fingerprint-validated Evidence only). mode=assess records a "
      + "semantic assessment (confirmed/contradicted/uncertain) backed by NEW provenance: confirmed supersedes the old "
      + "revision with a fresh replacement, contradicted invalidates, uncertain keeps it needing validation. "
      + "There is no state-setting primitive: Core derives every state change.",
    inputSchema: {
      type: "object",
      properties: {
        evidence_id: { type: "string", description: "Evidence identity (ev_…) to revalidate." },
        revision: { type: "integer", minimum: 1, description: "Exact revision; must be the lineage-current one." },
        mode: { type: "string", enum: ["check", "assess"], description: "Deterministic fingerprint check, or semantic assessment." },
        assessment: {
          type: "string",
          enum: ["confirmed", "contradicted", "uncertain"],
          description: "Required for mode=assess; ignored (rejected) for mode=check.",
        },
        observation_refs: {
          type: "array",
          items: { type: "string" },
          description: "New Observation ids backing the assessment (required for mode=assess).",
        },
        derived_from: {
          type: "array",
          items: {
            type: "object",
            properties: {
              evidence_id: { type: "string" },
              revision: { type: "integer", minimum: 1 },
            },
            required: ["evidence_id", "revision"],
            additionalProperties: false,
          },
          description: "Alternative provenance: exact upstream Evidence revisions backing the assessment.",
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["evidence_id", "revision", "mode", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "select_section",
    description:
      "Select the Section you will work on (Detail stage only). Sets the run's durable active Section; the run revision "
      + "advances exactly once per scope change, fencing any awaiting proposal. Re-selecting the already-active Section is "
      + "idempotent. Supply only the section id — run identity and revision are server-derived.",
    inputSchema: {
      type: "object",
      properties: {
        section_id: { type: "string", description: "Section artifact id from the current HEAD snapshot (e.g. SEC-1)." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["section_id", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_proposal",
    description:
      "Freeze your proposed design changes into an awaiting-approval Proposal (the first half of Proposal → human Approval → "
      + "PlanCommit). Everything authoritative is server-derived: ids, revisions, base run revision, and HEAD. "
      + "proposal_type: design_checkpoint | architecture_completion | section_completion | amendment. scope.kind: architecture | "
      + "detail | section. Changing a completed section requires an explicit REOPEN_SECTION change in the same proposal. "
      + "proposal_id (optional): revise the run's AWAITING proposal to a new revision (@N superseded, @N+1 frozen) — the "
      + "sanctioned recovery when its required evidence went stale and approval is refused EVIDENCE_NEEDS_VALIDATION. "
      + "This tool is NOT the human approval — call approve_proposal afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_type: { type: "string", enum: ["design_checkpoint", "architecture_completion", "section_completion", "amendment"] },
        proposal_id: { type: "string", description: "Optional: revise THIS awaiting proposal instead of preparing a new one." },
        scope: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["architecture", "detail", "section"] },
            section_id: { type: "string", description: "Required when kind=section." },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        title: { type: "string" },
        summary: { type: "string" },
        changes: {
          type: "array",
          description:
            "Normalized-change requests (op + typed content + compactProjection). New sections may carry a request-local "
            + "localRef alias other changes can depend on; aliases never persist. COMPLETE_SECTION/REOPEN_SECTION carry "
            + "{op, sectionId, compactProjection} and are resolved to exact revisions server-side.",
          items: { type: "object" },
        },
        required_evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              evidence_id: { type: "string" },
              revision: { type: "integer", minimum: 1 },
            },
            required: ["evidence_id", "revision"],
            additionalProperties: false,
          },
          description: "Exact Evidence revisions this proposal rests on; critical ones must be fresh now.",
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["proposal_type", "scope", "title", "summary", "changes", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "approve_proposal",
    description:
      "Formally approve the run's awaiting proposal with EXACT id/revision/hash and commit it as an immutable PlanCommit. "
      + "This tool always requires explicit human approval and cannot be pre-authorized.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: { type: "string" },
        proposal_revision: { type: "integer", minimum: 1 },
        proposal_hash: { type: "string" },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["proposal_id", "proposal_revision", "proposal_hash", "_hostContext"],
      additionalProperties: false,
    },
    _meta: REQUIRES_USER_INTERACTION_META,
  },
  {
    name: "submit_synthesis",
    description:
      "Submit your derived SynthesisManifest for the run's frozen SynthesisInput (synthesis stage only, plan mode required). "
      + "Every cross-section link, implementation step, and limitation must cite exact refs from the frozen input "
      + "(get_context(detail=validation)). The manifest is immutable once accepted and the run advances to validation. "
      + "This is NOT a design approval and moves no HEAD.",
    inputSchema: {
      type: "object",
      properties: {
        input_id: { type: "string", description: "The frozen SynthesisInput id from get_context (synin_…)." },
        input_hash: { type: "string", description: "The frozen input's hash (sha256:…)." },
        cross_section_links: {
          type: "array",
          description: "Derived statements connecting approved design facts; each cites non-empty exact supportingRefs.",
          items: { type: "object" },
        },
        implementation_order: {
          type: "array",
          description: "Implementation steps with manifest-local stepId, dependsOn (acyclic), and exact supportingRefs.",
          items: { type: "object" },
        },
        limitations: {
          type: "array",
          description: "Derived limitation statements; each cites non-empty exact supportingRefs.",
          items: { type: "object" },
        },
        unresolved_findings: {
          type: "array",
          description: "Findings you (the synthesizer) could not resolve: contradiction | missing_design | missing_dependency | coverage_gap | limitation.",
          items: { type: "object" },
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["input_id", "input_hash", "cross_section_links", "implementation_order", "limitations", "unresolved_findings", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_validation",
    description:
      "VALIDATOR-ONLY: persist the SemanticValidationReport for the run's current manifest (validation stage only). "
      + "Findings vocabulary is frozen: unsupported_new_fact | contradiction | missing_design | missing_dependency | "
      + "incorrect_derivation | coverage_gap | clean. clean must be the sole finding. Only the phase-plan validator "
      + "subagent's signed context is accepted; the report never moves stage, run revision, or HEAD, and needs no approval.",
    inputSchema: {
      type: "object",
      properties: {
        manifest_id: { type: "string", description: "The current SynthesisManifest id (synm_…)." },
        manifest_hash: { type: "string", description: "The manifest's hash (sha256:…)." },
        input_id: { type: "string", description: "The frozen SynthesisInput id the manifest was derived from." },
        input_hash: { type: "string", description: "The frozen input's hash (sha256:…)." },
        findings: {
          type: "array",
          description: "[clean] exactly, or one-or-more non-clean findings with summary, detail, and exact bundle refs.",
          items: { type: "object" },
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["manifest_id", "manifest_hash", "input_id", "input_hash", "findings", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "request_reopen",
    description:
      "Reopen the planning run from synthesis/validation/final back into the normal design workflow (target: detail | architecture). " +
      "Main-agent capability; needs no formal approval. Moves the stage and run revision exactly once and marks the affected " +
      "completed Sections needs_review; committed Plan Memory and the historical synthesis/candidate records are never touched. At " +
      "validation stage you may pass finding_ids to scope the review to the findings' Sections (omit for full review). From final " +
      "this is legal only while the FinalPlan is NOT yet approved; it supersedes the awaiting final Proposal.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["detail", "architecture"] },
        reason: { type: "string", description: "Why the design workflow must re-run (recorded in the review events)." },
        finding_ids: {
          type: "array",
          description: "Validation-stage only: scope the review to the Sections named by these findings (vf_…).",
          items: { type: "string" },
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["target", "reason", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "request_finalization",
    description:
      "Run the deterministic FinalizationGate over the current planning world (validation stage only). On pass, the server " +
      "atomically freezes the immutable FinalPlanCandidate, the pre-approval Evidence Audit snapshot, and the exact final_plan " +
      "Proposal, and advances validation → final. This is NOT the human approval: present the candidate to the user, then call " +
      "approve_proposal with the exact final proposal id/revision/hash. Takes no business input — the gate cannot be bypassed " +
      "or configured (no force/skip flags exist).",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff",
    description:
      "Only valid after an approved Final Plan. Deterministically delivers the execution contract and completes "
      + "the planning lifecycle. Takes no business input — the ExecutionHandoff is a server-derived projection of the "
      + "approved FinalPlan (no force/bypass/skip fields exist). The host transitions this session to execution mode "
      + "during the call; Plan Memory becomes read-only afterward and Build continues in the same session.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "report_execution_issue",
    description:
      "During Build only: record that continuing implementation would require changing APPROVED planning semantics "
      + "(hard constraint, invariant, approved interface, SectionContract, Decision, explicit dependency, architecture "
      + "choice, critical repository assumption, missing design obligation). The issue is immutable and binds exact "
      + "FinalPlan refs (id@revision). Reporting pauses repository mutation until the user explicitly re-enters "
      + "planning via /phase-plan. Not a bug report and not design authorization.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "hard_constraint",
            "invariant",
            "approved_interface",
            "section_contract",
            "approved_decision",
            "explicit_dependency",
            "architecture_choice",
            "critical_repository_assumption",
            "missing_design_obligation",
          ],
        },
        summary: { type: "string", description: "One-line statement of the semantic conflict." },
        detail: { type: "string", description: "What was discovered, why implementation-as-approved cannot continue." },
        affected_refs: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["architecture", "section", "section_contract", "decision", "constraint"] },
              id: { type: "string" },
              revision: { type: "integer", minimum: 1 },
            },
            required: ["type", "id", "revision"],
            additionalProperties: false,
          },
          description: "EXACT approved FinalPlan closure refs (SEC-A@4, never SEC-A or SEC-A@3).",
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["kind", "summary", "detail", "affected_refs", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "takeover_run",
    description:
      "Take over an active PlanningRun owned by another (lost/other) session in this workspace, after the user explicitly "
      + "selects the exact run from selection_required. Ownership moves to this session with binding generation G → G+1 and "
      + "the previous owner is fenced immediately — even while still alive (no liveness checks exist). Control-plane only: "
      + "the run's revision, stage, HEAD, Plan Memory, Proposals, and Evidence are untouched and no new run is created. "
      + "If the named run's planning lifecycle is completed but its ExecutionRun is ACTIVE, this performs the explicit "
      + "execution-supervision takeover instead: supervision ownership moves to this session with the supervision generation "
      + "advanced by exactly one (an unbound run establishes generation 1) and the prior generation is permanently fenced. "
      + "This tool always requires explicit human approval and cannot be pre-authorized.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The exact active run id from selection_required (plan_…)." },
        expected_binding_generation: {
          type: "integer",
          minimum: 1,
          description:
            "The binding generation reported in selection_required or the execution recovery context; a stale-precondition "
            + "fence, never authority. For an execution-supervision takeover this is the SUPERVISION generation (an unbound "
            + "run establishes generation 1 regardless).",
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["run_id", "expected_binding_generation", "_hostContext"],
      additionalProperties: false,
    },
    _meta: REQUIRES_USER_INTERACTION_META,
  },
  {
    name: "abort_run",
    description:
      "Terminate the CURRENT session's active PlanningRun at the user's explicit request. The run becomes terminal (aborted): "
      + "the run revision advances exactly once, the planning binding detaches, every Proposal/Approval/Commit/Memory/Evidence "
      + "is preserved as immutable history, and NO Build authority is created (an approved FinalPlan stays unused history). "
      + "The session leaves Plan Mode; a later /phase-plan starts a NEW ordinary run. This tool always requires explicit human "
      + "approval and cannot be pre-authorized.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Optional audit note; never affects legality." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
    _meta: REQUIRES_USER_INTERACTION_META,
  },
  {
    name: "abort_execution_run",
    description:
      "Human-authorized terminal abort of an EXACT ExecutionRun (E13): the control-plane exception that stops the execution "
      + "protocol permanently. Unlike supervisor mutations it does NOT require current writable supervision ownership — a "
      + "detached, fenced, or recovery session may request it on the user's behalf, because the HUMAN authorization (mandatory "
      + "confirmation dialog) is the sole abort authority. abort means STOP: the open VerificationWindow (if any) closes as "
      + "aborted, prepared Worker launch credentials are revoked, claimed Workers lose all future Phase Plan authority, the "
      + "SupervisorBinding detaches, and the run becomes terminal (aborted) forever. It is NOT acceptance, failure, rollback, "
      + "or replanning: acceptedHead, candidateRevision, Stage states, Attempts, Reports, Commits, and Issues are preserved "
      + "exactly, the workspace is never rolled back, and no cleanup work is issued. The run_id must be the exact target "
      + "(never inferred); the reason is required and becomes durable provenance.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The EXACT ExecutionRun id to abort (from the recovery context or the user; never inferred)." },
        reason: { type: "string", description: "Required non-empty: why the user is aborting this run (durable audit provenance)." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
    required: ["run_id", "reason", "_hostContext"],
    additionalProperties: false,
  },
  _meta: REQUIRES_USER_INTERACTION_META,
  },
  {
    name: "reexecute_final_plan",
    description:
      "Human-authorized explicit reexecution (A1-II): create a NEW ExecutionRun of an EXACT previously executed FinalPlan "
      + "(id@revision + hash — no latest/current-plan resolution) in a workspace, after that FinalPlan's initial delivery is "
      + "complete. Reexecution is NOT replanning and NOT the initial handoff: it creates no PlanningRun, no FinalPlan, no "
      + "PlanCommit, no Approval, and no ExecutionIssue; it never reopens the completed source PlanningRun, never reactivates "
      + "or rebinds a prior ExecutionRun, never touches the initial handoff or ExecutionBinding history, and never inherits "
      + "execution memory (fresh acceptedHead, Stages, Windows, Directives, Attempts, Commits). The authorization target is "
      + "the exact FinalPlanRef + this workspace — you never name a predecessor run. The same workspace holds at most one "
      + "prepared|active ExecutionRun; terminal prior runs never block. Retrying the same authorized request converges on "
      + "the SAME new run; a changed target under the same operation id fails closed. This tool always requires explicit "
      + "human approval and cannot be pre-authorized.",
    inputSchema: {
      type: "object",
      properties: {
        source_planning_run_id: { type: "string", description: "The completed PlanningRun whose approved FinalPlan is being reexecuted (provenance plan_…)." },
        final_plan_id: { type: "string", description: "The EXACT committed FinalPlan id (never a latest/current resolution)." },
        final_plan_revision: { type: "integer", minimum: 1, description: "The EXACT committed FinalPlan revision." },
        final_plan_hash: { type: "string", description: "The EXACT committed FinalPlan hash; a mismatch fails closed." },
        reason: { type: "string", description: "Optional audit note; never affects legality." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["source_planning_run_id", "final_plan_id", "final_plan_revision", "final_plan_hash", "_hostContext"],
      additionalProperties: false,
    },
    _meta: REQUIRES_USER_INTERACTION_META,
  },

  {
    name: "issue_execution_directive",
    description:
      "Supervisor-only: issue an immutable ExecutionDirective revision under this session's fenced execution supervision. "
      + "Scope is explicit (E10): a STAGE directive binds stage_id (the current active Stage's open window); a FINAL-CLOSURE "
      + "directive omits stage_id and sets scope_kind='final_closure' (the open Final Closure Window — run-level integration, "
      + "inspection, verification, or semantic-preserving rework). Core binds the exact run/FinalPlan/scope/Window/candidateRevision "
      + "and accepted base; the capability envelope must be the complete explicit 8-field object. Once issued the revision is "
      + "immutable — changing instructions requires a new revision, and a logical directive can never switch scope (E10 §19).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["implementation", "inspection", "verification"] },
        stage_id: { type: "string", description: "The CURRENT active execution stage id. Omit exactly when scope_kind='final_closure'." },
        scope_kind: {
          type: "string",
          enum: ["final_closure"],
          description: "Final-closure scope: omit stage_id and set this to issue a run-level final-closure directive (E10 §5/§16).",
        },
        window_id: { type: "string", description: "The CURRENT open verification window id." },
        objective: { type: "string" },
        body: { type: "string", description: "Detailed worker instruction; structured fields stay the machine-checkable authority." },
        directive_id: { type: "string", description: "Logical directive id; generated when omitted." },
        revision: { type: "integer", minimum: 1, description: "Exact revision; defaults to the next revision of the logical directive." },
        final_plan_ref: {
          type: "object",
          properties: { id: { type: "string" }, revision: { type: "integer", minimum: 1 }, hash: { type: "string" } },
          required: ["id", "revision", "hash"],
          additionalProperties: false,
          description: "Optional; must equal the run's permanent FinalPlan binding when supplied.",
        },
        base_candidate_revision: { type: "integer", minimum: 0, description: "Optional; must equal the window's current revision when supplied." },
        plan_refs: {
          type: "array",
          items: {
            type: "object",
            properties: { kind: { type: "string" }, id: { type: "string" }, revision: { type: "integer", minimum: 1 } },
            required: ["kind", "id", "revision"],
            additionalProperties: false,
          },
          description: "Exact approved plan refs provable from the bound FinalPlan.",
        },
        expected_execution_scope: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "string" } },
            symbols: { type: "array", items: { type: "string" } },
            callPaths: { type: "array", items: { type: "string" } },
            tests: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
          description: "Guidance only — never a path allowlist.",
        },
        capability_envelope: {
          type: "object",
          properties: {
            repositoryRead: { type: "boolean" },
            repositoryWrite: { type: "boolean" },
            commandExecution: { type: "boolean" },
            networkAccess: { type: "boolean" },
            dependencyMutation: { type: "boolean" },
            gitCommit: { type: "boolean" },
            gitPush: { type: "boolean" },
            externalServiceMutation: { type: "boolean" },
          },
          required: [
            "repositoryRead",
            "repositoryWrite",
            "commandExecution",
            "networkAccess",
            "dependencyMutation",
            "gitCommit",
            "gitPush",
            "externalServiceMutation",
          ],
          additionalProperties: false,
          description: "Complete, explicit, role-independent. commandExecution=true with any restricted semantic category refuses to launch (unenforceable).",
        },
        invariants: { type: "array", items: { type: "object", properties: { statement: { type: "string" } }, required: ["statement"], additionalProperties: false } },
        required_actions: { type: "array", items: { type: "object", properties: { action: { type: "string" }, detail: { type: ["string", "null"] } }, required: ["action", "detail"], additionalProperties: false } },
        forbidden_actions: { type: "array", items: { type: "object", properties: { action: { type: "string" }, detail: { type: ["string", "null"] } }, required: ["action", "detail"], additionalProperties: false } },
        validation_requirements: { type: "array", items: { type: "object", properties: { requirement: { type: "string" }, detail: { type: ["string", "null"] } }, required: ["requirement", "detail"], additionalProperties: false } },
        deliverables: { type: "array", items: { type: "object", properties: { name: { type: "string" }, detail: { type: ["string", "null"] } }, required: ["name", "detail"], additionalProperties: false } },
        stop_conditions: { type: "array", items: { type: "object", properties: { condition: { type: "string" }, detail: { type: ["string", "null"] } }, required: ["condition", "detail"], additionalProperties: false } },
        report_contract: {
          type: "object",
          properties: {
            requireActionsPerformed: { type: "boolean" },
            requireFilesExamined: { type: "boolean" },
            requireFilesChanged: { type: "boolean" },
            requireCommandsRun: { type: "boolean" },
            requireTestsRun: { type: "boolean" },
            requireFindings: { type: "boolean" },
            requireDeviations: { type: "boolean" },
            requireBlockers: { type: "boolean" },
            requireDeliverables: { type: "boolean" },
          },
          required: [
            "requireActionsPerformed",
            "requireFilesExamined",
            "requireFilesChanged",
            "requireCommandsRun",
            "requireTestsRun",
            "requireFindings",
            "requireDeviations",
            "requireBlockers",
            "requireDeliverables",
          ],
          additionalProperties: false,
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["kind", "window_id", "objective", "body", "capability_envelope", "report_contract", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "start_worker_attempt",
    description:
      "Supervisor-only: start the one logical running Attempt for an exact Directive revision and prepare the one-time worker "
      + "launch package. Returns the plaintext launch token EXACTLY ONCE (only its hash is durable). Launch the native "
      + "phase-plan execution-worker subagent with ONLY attempt_id + launch_token + claim instruction — never the Directive. "
      + "An already claimed/finished attempt cannot be relaunched; an unenforceable capability envelope refuses here.",
    inputSchema: {
      type: "object",
      properties: {
        directive_id: { type: "string" },
        directive_revision: { type: "integer", minimum: 1 },
        directive_hash: { type: "string", description: "The exact issued revision hash — a mismatched hash is refused." },
        worker_role: { type: "string", enum: ["executor", "verifier"] },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["directive_id", "directive_revision", "directive_hash", "worker_role", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "worker_claim",
    description:
      "ExecutionWorker-only: claim your exact Attempt with the one-time launch token from your launch package. The worker "
      + "session identity is the signed host subagent identity — a second session can never claim the same attempt. After a "
      + "successful claim, load your assignment and never accept the launch prompt as authority.",
    inputSchema: {
      type: "object",
      properties: {
        attempt_id: { type: "string" },
        launch_token: { type: "string", description: "The one-time token from your launch package; consumed by this call." },
        _hostContext: { type: "string", description: "Signed worker host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["attempt_id", "launch_token", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "worker_get_assignment",
    description:
      "ExecutionWorker-only: load your exact assignment — the bound Directive (id/revision/hash/kind/objective/envelope/body/"
      + "report contract), ONLY your Directive's resolved approved plan refs, run/stage/window identity, and the accepted base. "
      + "No other Plan Memory, no supervisor reasoning, and (for verifiers) no Executor context is included — by design.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed worker host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "worker_submit_report",
    description:
      "ExecutionWorker-only: submit exactly one structured ExecutionReport for YOUR claimed attempt (identity is derived from "
      + "your claim, never from arguments). result=blocked requires at least one structured blocker; blockers are invalid on "
      + "non-blocked results. candidate_mutated=true atomically advances the window candidateRevision. The report is immutable; "
      + "the invocation finishes on success — return a compact acknowledgement afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        result: { type: "string", enum: ["completed", "partial", "blocked", "failed"] },
        candidate_mutated: { type: "boolean", description: "Explicit factual record: did this attempt change the current candidate? Never inferred." },
        actions_performed: { type: "array", items: { type: "object", properties: { action: { type: "string" }, detail: { type: ["string", "null"] } }, required: ["action", "detail"], additionalProperties: false } },
        files_examined: { type: "array", items: { type: "string" } },
        files_changed: { type: "array", items: { type: "string" } },
        commands_run: { type: "array", items: { type: "object", properties: { command: { type: "string" }, detail: { type: ["string", "null"] } }, required: ["command", "detail"], additionalProperties: false } },
        tests_run: { type: "array", items: { type: "object", properties: { name: { type: "string" }, outcome: { type: "string" }, detail: { type: ["string", "null"] } }, required: ["name", "outcome", "detail"], additionalProperties: false } },
        findings: { type: "array", items: { type: "object", properties: { summary: { type: "string" }, details: { type: ["string", "null"] } }, required: ["summary", "details"], additionalProperties: false } },
        deviations: { type: "array", items: { type: "object", properties: { summary: { type: "string" }, details: { type: ["string", "null"] } }, required: ["summary", "details"], additionalProperties: false } },
        blockers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: [
                  "MISSING_CONTEXT",
                  "AMBIGUOUS_DIRECTIVE",
                  "REPOSITORY_MISMATCH",
                  "UNEXPECTED_SCOPE",
                  "CONFLICTING_REQUIREMENTS",
                  "MISSING_PREREQUISITE",
                  "EXECUTION_ENVIRONMENT_BLOCKER",
                ],
              },
              summary: { type: "string" },
              details: { type: ["string", "null"] },
              relevantRefs: {
                type: "array",
                items: {
                  type: "object",
                  properties: { kind: { type: "string" }, id: { type: "string" }, revision: { type: "integer", minimum: 1 } },
                  required: ["kind", "id", "revision"],
                  additionalProperties: false,
                },
              },
            },
            required: ["kind", "summary", "details", "relevantRefs"],
            additionalProperties: false,
          },
        },
        deliverables: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              ref: { type: ["object", "null"], properties: { kind: { type: "string" }, id: { type: "string" }, revision: { type: "integer", minimum: 1 } }, required: ["kind", "id", "revision"], additionalProperties: false },
              detail: { type: ["string", "null"] },
            },
            required: ["name", "ref", "detail"],
            additionalProperties: false,
          },
        },
        _hostContext: { type: "string", description: "Signed worker host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["result", "candidate_mutated", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "get_execution_acceptance_context",
    description:
      "Supervisor-only: the canonical acceptance context for the current candidate — accepted head, active stage, open window "
      + "(with its durable accepted base and candidateRevision), every Directive/Attempt/Report of the window split into "
      + "current-candidate vs historical evidence, per-report worker-role/result/mutation/session facts, qualifying fresh "
      + "verification, and existing SupervisorAssessments (current vs stale). Store-derived facts only — no repository reads, "
      + "no worker or supervisor hidden reasoning. After a commit this reports the post-commit acceptance boundary (no open window).",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_supervisor_assessment",
    description:
      "Supervisor-only: submit one immutable semantic assessment of the current candidate. disposition=rework | "
      + "need_more_verification | blocked | request_replan persists the judgment ONLY — no state mutation. disposition=accept "
      + "runs the Core acceptance gate: every current-candidate report must carry exactly one judgment (negative results may "
      + "only be blocking/superseded), no blocking judgment may remain, fresh independent E5-verifier evidence must cover the "
      + "exact candidate, and Core then atomically creates the ExecutionCommit, closes the window, and advances acceptedHead. "
      + "You never create commits or set the accepted head directly.",
    inputSchema: {
      type: "object",
      properties: {
        disposition: { type: "string", enum: ["accept", "rework", "need_more_verification", "blocked", "request_replan"] },
        rationale: { type: "string", description: "Non-empty audit provenance for this judgment; never parsed by Core." },
        report_judgments: {
          type: "array",
          description: "Exactly one judgment per current-candidate report (required for accept).",
          items: {
            type: "object",
            properties: {
              report_id: { type: "string" },
              disposition: { type: "string", enum: ["supporting", "informational", "superseded", "blocking"] },
              superseded_by_report_id: { type: "string", description: "Required for superseded: a LATER current-candidate report in this window." },
              rationale: { type: "string", description: "Required non-empty for superseded." },
            },
            required: ["report_id", "disposition"],
            additionalProperties: false,
          },
        },
        covered_obligations: {
          type: "array",
          description: "Structured acceptance provenance resolving into existing Directive validationRequirements / approved plan refs / the active Stage's immutable objective (E7 §5).",
          items: {
            type: "object",
            properties: {
              source: { type: "string", enum: ["directive_validation_requirement", "plan_ref", "stage_objective"] },
              directive_id: { type: "string" },
              directive_revision: { type: "integer", minimum: 1 },
              index: { type: "integer", minimum: 0 },
              ref: { type: "object", properties: { kind: { type: "string" }, id: { type: "string" }, revision: { type: "integer", minimum: 1 } }, required: ["kind", "id", "revision"], additionalProperties: false },
              stage_id: { type: "string", description: "For stage_objective: the exact active Stage whose satisfaction this accepted candidate asserts." },
              objective_hash: { type: "string", description: "For stage_objective: the deterministic sha256 over the Stage's immutable semantics (from the acceptance context)." },
              contentHash: { type: "string" },
            },
            required: ["source", "contentHash"],
            additionalProperties: false,
          },
        },
        plan_refs: {
          type: "array",
          items: {
            type: "object",
            properties: { kind: { type: "string" }, id: { type: "string" }, revision: { type: "integer", minimum: 1 } },
            required: ["kind", "id", "revision"],
            additionalProperties: false,
          },
          description: "Optional exact approved plan refs the assessment rests on.",
        },
        expected_candidate_revision: {
          type: "integer",
          minimum: 0,
          description: "The window candidateRevision you assessed; a stale value is refused (SUPERVISOR_ASSESSMENT_STALE).",
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["disposition", "rationale", "expected_candidate_revision", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "get_execution_progression_context",
    description:
      "Supervisor-only: the canonical execution progression state after an accepted commit — accepted head, active stage, open "
      + "window, latest commit, every pending/completed Stage, and the dependency-derived eligible vs ineligible pending Stages "
      + "(with unsatisfied predecessor step ids), plus the progression boundary: active_candidate | post_commit_same_stage | "
      + "between_stages | all_stages_completed. Eligibility follows ONLY the approved explicit dependsOn edges — ordinal is never "
      + "a dependency. default_suggested_stage is a UX hint (lowest ordinal), never authority: you select the next Stage.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "continue_execution_stage",
    description:
      "Supervisor-only, post-commit: explicitly continue the ACTIVE Stage by opening a NEW verification window at "
      + "candidateRevision 0 rooted in the exact acceptedHead. Requires an active Stage, no open window, no running Attempt, and "
      + "a latest accepted Commit belonging to this Stage. Pure orchestration: the acceptedHead is never touched; issue new "
      + "Directives through the normal E4 protocol.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "activate_execution_stage",
    description:
      "Supervisor-only, between stages: activate one eligible pending Stage you select by stage_id (Core validates the exact "
      + "explicit dependencies; ordinal never decides). Atomically transitions pending → active and opens the Stage's first "
      + "verification window at candidateRevision 0 rooted in the exact acceptedHead. Requires no active Stage, no open window, "
      + "no running Attempt, and an existing acceptedHead.",
    inputSchema: {
      type: "object",
      properties: {
        target_stage_id: { type: "string", description: "The exact pending Stage to activate (from get_execution_progression_context eligible stages)." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["target_stage_id", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "get_execution_final_closure_context",
    description:
      "Supervisor-only (E10 §55): the run-level final-closure surface. Returns the run identity, the exact FinalPlan ref, the "
      + "acceptedHead, every ordinary Stage with its completion provenance and objective hash, the Final Closure Window state "
      + "(absent/open with its exact candidate revision), the Core-derived execution_run_completion obligation and the exact "
      + "verify_execution_completion requirement your final VerificationDirective must carry, the verification policy state, "
      + "current conflicts, and the completion blockers (running/indeterminate attempts, incomplete stages). Store-derived only — "
      + "no repository access, no hidden reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "begin_execution_final_closure",
    description:
      "Supervisor-only (E10 §9/§10), explicit: open the run-level Final Closure Window after ALL ordinary Stages are completed. "
      + "Never auto-started — you decide when the all_stages_completed boundary enters final closure. One atomic transaction "
      + "validates the boundary (active run, acceptedHead exists, no active/pending Stage, exact completion provenance, no open "
      + "window, no running Attempt) and creates the window scoped final_closure (NO Stage — never a synthetic one) at "
      + "candidateRevision 0 rooted in the exact acceptedHead. Returns the Core-derived execution_run_completion obligation and "
      + "the exact verifier requirement. Opening the window never completes the run: run the final window protocol (integration, "
      + "rework if needed, fresh final verifier), then submit an accept assessment carrying the exact completion obligation.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "get_attempt_recovery_context",
    description:
      "Supervisor-only (E11 §46): the run-level attempt-recovery surface. For every nonterminal Attempt it returns the "
      + "logical state (running | indeterminate), the Store-derived runtime state (prepared-unclaimed | claimed | "
      + "reported-but-runtime-not-finished | authoritative-stop | liveness-unknown), the reconciliation state (not-required | "
      + "required | in-progress | resolved-*), the ORIGINAL Directive ref/hash/kind/baseCandidateRevision, the side-effect "
      + "capability classification, the bound reconciliation Directive revisions with their Reports, whether a deterministic "
      + "no_effect_by_capability resolution is available, and whether ordinary execution is currently fenced. Store-derived "
      + "projection only — never authority, no launch secrets, no hidden Worker context.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "retry_unclaimed_worker_launch",
    description:
      "Supervisor-only (E11 §40/§41): transport recovery for a crash BEFORE the Worker claimed — the SAME logical Attempt "
      + "and invocation binding receive a freshly rotated one-time launch credential (the old token stops working). Requires "
      + "the Attempt still running, the invocation still prepared and unclaimed, and the Directive still exact/current for "
      + "the open window. Never creates a second Attempt; never a semantic retry.",
    inputSchema: {
      type: "object",
      properties: {
        attempt_id: { type: "string", description: "The exact running Attempt whose prepared unclaimed launch is retried." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["attempt_id", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "issue_attempt_reconciliation",
    description:
      "Supervisor-only (E11 §11/§12): bind an indeterminate Attempt to a NEW logical reconciliation inspection Directive. "
      + "One atomic transaction issues the exact kind=inspection Directive on the CURRENT open window (stage or final_closure "
      + "scope — never a synthetic Stage/Window), carrying the hash-covered requiredAction reconcile_indeterminate_attempt:"
      + "<attemptId>, and persists the immutable binding. The target must be indeterminate, unresolved, and belong to the "
      + "current window. Run the inspection through the normal E5 worker protocol, then resolve_indeterminate_attempt.",
    inputSchema: {
      type: "object",
      properties: {
        attempt_id: { type: "string", description: "The exact indeterminate Attempt to reconcile." },
        objective: { type: "string" },
        body: { type: "string", description: "Detailed inspection instruction: establish CURRENT repository reality for the uncertain Attempt." },
        capability_envelope: {
          type: "object",
          properties: {
            repositoryRead: { type: "boolean" },
            repositoryWrite: { type: "boolean" },
            commandExecution: { type: "boolean" },
            networkAccess: { type: "boolean" },
            dependencyMutation: { type: "boolean" },
            gitCommit: { type: "boolean" },
            gitPush: { type: "boolean" },
            externalServiceMutation: { type: "boolean" },
          },
          required: [
            "repositoryRead",
            "repositoryWrite",
            "commandExecution",
            "networkAccess",
            "dependencyMutation",
            "gitCommit",
            "gitPush",
            "externalServiceMutation",
          ],
          additionalProperties: false,
          description: "Complete, explicit. Reconciliation inspections are read-only in practice; any side-effect-capable grant is deliberate Supervisor authority.",
        },
        report_contract: {
          type: "object",
          properties: {
            requireActionsPerformed: { type: "boolean" },
            requireFilesExamined: { type: "boolean" },
            requireFilesChanged: { type: "boolean" },
            requireCommandsRun: { type: "boolean" },
            requireTestsRun: { type: "boolean" },
            requireFindings: { type: "boolean" },
            requireDeviations: { type: "boolean" },
            requireBlockers: { type: "boolean" },
            requireDeliverables: { type: "boolean" },
          },
          required: [
            "requireActionsPerformed",
            "requireFilesExamined",
            "requireFilesChanged",
            "requireCommandsRun",
            "requireTestsRun",
            "requireFindings",
            "requireDeviations",
            "requireBlockers",
            "requireDeliverables",
          ],
          additionalProperties: false,
        },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["attempt_id", "objective", "body", "capability_envelope", "report_contract", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_indeterminate_attempt",
    description:
      "Supervisor-only (E11 §24–§29): the FINAL immutable reconciliation of an indeterminate Attempt. resolution=no_effect: "
      + "the inspection proved no durable effect; candidateRevision unchanged. resolution=no_effect_by_capability: the "
      + "deterministic capability proof — allowed ONLY when the interrupted Directive's effective envelope was provably "
      + "non-mutating and the candidate never moved; no inspection Worker needed. resolution=candidate_changed: the "
      + "inspection found previously unaccounted durable mutation — candidateRevision advances N→N+1 exactly once under the "
      + "same CAS discipline as Report-driven mutation, making all verification at N stale. The original Attempt stays "
      + "indeterminate forever; no Report is fabricated; no replay happens.",
    inputSchema: {
      type: "object",
      properties: {
        attempt_id: { type: "string" },
        resolution: { type: "string", enum: ["no_effect", "no_effect_by_capability", "candidate_changed"] },
        inspection_report_id: {
          type: "string",
          description: "The exact completed non-mutating reconciliation inspection Report. Required for no_effect and candidate_changed; forbidden for no_effect_by_capability.",
        },
        rationale: { type: "string", description: "Non-empty audit provenance for the semantic judgment." },
        expected_candidate_revision: { type: "integer", minimum: 0, description: "Stale-precondition fence over the open window's current revision." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["attempt_id", "resolution", "rationale", "expected_candidate_revision", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "request_execution_replan",
    description:
      "Supervisor-only, terminal: declare that the current immutable FinalPlan can no longer provide a legal, sufficiently-defined "
      + "continuation without a new normative decision, and terminate execution. One atomic Core transaction persists the immutable "
      + "ExecutionIssue snapshot (accepted history + exact execution context), terminal-closes the open window (NO commit is fabricated), "
      + "transitions the run active → replan_required (terminal forever), and detaches your supervisor binding. This is a semantic "
      + "judgment — never a response to difficulty, defects, failed tests, verification debt, or conflicts. Afterwards invoke /phase-plan: "
      + "a NEW PlanningRun is created from the old FinalPlan baseline; the old run never resumes.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Non-empty statement of the normative insufficiency — the durable semantic intent." },
        affected_normative_refs: {
          type: "array",
          minItems: 1,
          description: "Exact Plan refs reachable from the bound FinalPlan (architecture/section/section_contract/decision/constraint, exact revision) — at least one anchor.",
          items: {
            type: "object",
            properties: { type: { type: "string" }, id: { type: "string" }, revision: { type: "integer", minimum: 1 } },
            required: ["type", "id", "revision"],
            additionalProperties: false,
          },
        },
        relevant_report_refs: { type: "array", items: { type: "string" }, description: "Exact ExecutionReport ids of THIS run that evidence the insufficiency (any state)." },
        trigger_assessment_id: { type: "string", description: "Optional: an immutable request_replan SupervisorAssessment as trigger provenance." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["reason", "affected_normative_refs", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "get_verification_policy_context",
    description:
      "Supervisor-only: the deterministic verification-pressure state of the current candidate — latestVerifiedRevision, "
      + "unverifiedMutationSpan out of the frozen bound (3), whether verificationRequired, the machine-readable reason "
      + "(immediate | max_unverified_span | unexpected_mutation | legacy_policy_unknown), the blocking report ref, the "
      + "qualifying normal-verification reports, and whether legacy policy-unknown mutation is present. Derived from Store "
      + "facts on every read; never authoritative, never cached.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "declare_verification_conflict",
    description:
      "Supervisor-only: declare ONE durable verification conflict when two or more trusted current-candidate reports make "
      + "materially mutually exclusive claims about an acceptance-relevant fact. Core validates structure only — exact "
      + "current-candidate report binding, two claim variants, deterministic duplicate fingerprint. The conflict is created "
      + "open; nothing launches automatically. Ordinary executor-completed/verifier-defect evidence is NOT a conflict.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "Neutral statement of the disputed acceptance-relevant fact." },
        claims: {
          type: "array",
          minItems: 2,
          description: "The mutually exclusive claim variants (>= 2), each bound to its exact source report ids.",
          items: {
            type: "object",
            properties: {
              variant: { type: "string", description: "Stable variant label, e.g. A / B." },
              statement: { type: "string", description: "Neutral statement of this side's claim." },
              source_report_ids: { type: "array", minItems: 1, items: { type: "string" } },
            },
            required: ["variant", "statement", "source_report_ids"],
            additionalProperties: false,
          },
        },
        rationale: { type: "string", description: "Optional audit provenance for the declaration." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["fact", "claims", "_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_verification_conflict",
    description:
      "Supervisor-only: settle the ONE dedicated conflict-resolution verifier's report — outcome=resolved or "
      + "verification_blocked, with a non-empty rationale naming the exact resolution report id. Core validates the report is "
      + "the resolver's exact completed non-mutating report; it never infers the outcome from findings. verification_blocked "
      + "blocks commits for this candidate but never deadlocks rework or inspection.",
    inputSchema: {
      type: "object",
      properties: {
        conflict_id: { type: "string" },
        outcome: { type: "string", enum: ["resolved", "verification_blocked"] },
        resolution_report_id: { type: "string", description: "The exact report id of the dedicated resolver attempt." },
        rationale: { type: "string", description: "Required non-empty audit provenance for the outcome." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["conflict_id", "outcome", "resolution_report_id", "rationale", "_hostContext"],
      additionalProperties: false,
    },
  },

];

function inputInvalid(message: string, cause?: string): RuntimeError {
  return new RuntimeError("MCP_INPUT_INVALID", message, cause === undefined ? {} : { cause });
}

function domainError(code: RuntimeError["code"], message: string): RuntimeError {
  return new RuntimeError(code, message);
}

/**
 * Strict business-schema enforcement (directive §27/§29): only the declared
 * business fields plus reserved host fields may be present. A model-supplied
 * session/workspace/generation/actor/authorizationRequestId/approved/force
 * field is REJECTED, never silently stripped.
 */
function assertExactBusinessFields(args: Record<string, unknown>, allowed: readonly string[]): void {
  const reserved = new Set(["_hostContext", "_entryIntent"]);
  const offending = Object.keys(args).filter((key) => !allowed.includes(key) && !reserved.has(key));
  if (offending.length > 0) {
    throw inputInvalid(
      `approve_proposal/start_or_resume business input accepts only [${allowed.join(", ")}]; rejected fields: ${offending.join(", ")}`,
      "model-supplied authority fields (session/workspace/generation/actor/authorizationRequestId/approved/force) are never accepted",
    );
  }
}

function requireHostContext(args: Record<string, unknown>): string {
  const token = args._hostContext;
  if (typeof token !== "string" || token === "") {
    throw domainError(
      "HOST_CONTEXT_REQUIRED",
      "no signed host context was injected for this call; the PreToolUse hook is required (model-supplied context is never authority)",
    );
  }
  return token;
}

function verifyEntryIntentCurrent(secret: Buffer, rawToken: unknown, current: { sessionId: string; promptId?: string }): void {
  if (typeof rawToken !== "string" || rawToken === "") {
    throw domainError("ENTRY_INTENT_REQUIRED", "start_or_resume requires the signed entry token from the /phase-plan skill invocation");
  }
  const intent = verifyEntryIntent(secret, rawToken);
  if (!entryIntentIsCurrent(intent, current)) {
    throw domainError("ENTRY_INTENT_INVALID", "entry intent is bound to a different session or prompt");
  }
}

function runView(run: PlanningRun): Record<string, unknown> {
  return { id: run.runId, lifecycle: run.lifecycle, stage: run.stage, revision: run.revision, goal: run.goal };
}

function bindingView(binding: BindingSnapshot): Record<string, unknown> {
  return { generation: binding.generation, state: binding.state };
}

/** §25: selectable run metadata — never other sessions' session ids. */
function selectableRunView(run: PlanningRun): Record<string, unknown> {
  return { run_id: run.runId, stage: run.stage, revision: run.revision, lifecycle: run.lifecycle, created_at: run.createdAt };
}

// ---------------------------------------------------------------------------
// start_or_resume (directive §24 Case A–E, §25)
// ---------------------------------------------------------------------------

export function handleStartOrResume(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["goal", "action", "_entryIntent"]);
  const args = rawArgs;
  const token = requireHostContext(args);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "start_or_resume", businessInput: args });

  const workspace = getWorkspaceById(ctx.store, envelope.workspaceId);
  if (workspace === null) {
    throw domainError("HOST_CONTEXT_WORKSPACE_MISMATCH", `host context workspace '${envelope.workspaceId}' is not in the catalog`);
  }

  // §22/§23 — a Build-bound session with at least one open ExecutionIssue and
  // a fresh /phase-plan EntryIntent creates the SUCCESSOR PlanningRun from the
  // immutable FinalPlan baseline. Without an open issue the Phase 14 wall
  // stands: no silently "baselined on nothing" successor. Other sessions in
  // this workspace are unaffected (§84 — never a workspace lock).
  // A host restart cycles the session's planning life: SessionEnd detaches the
  // successor planning binding and SessionStart recovery re-attaches the
  // delivered execution binding. Either planning-binding state (attached or
  // detached) means the session already moved on to the successor — that
  // resume (Case A/B below) must win over the successor fence here, otherwise
  // /phase-plan could never re-enter after a restart.
  const ownsPlanningLife =
    findAttachedActiveRun(ctx.store, envelope.sessionId) !== null
    || findDetachedActiveRun(ctx.store, envelope.sessionId, envelope.workspaceId) !== null;
  const execBound = ctx.store.withRead((tx) => findAttachedExecutionBindingForSessionInTx(tx, envelope.sessionId));
  if (execBound !== null && !ownsPlanningLife) {
    // §24 — explicit user intent first: even the successor path requires the
    // fresh signed EntryIntent from this session's /phase-plan expansion.
    verifyEntryIntentCurrent(ctx.secret, args._entryIntent, { sessionId: envelope.sessionId, promptId: envelope.promptId });
    const successors = createSuccessorRunService(ctx.store, ctx.clock);
    const classified = successors.classifySuccessorEntry(envelope.workspaceId, envelope.sessionId);
    if (classified.successorRunId !== null) {
      throw new RuntimeError(
        "SUCCESSOR_RUN_ALREADY_STARTED",
        "the successor PlanningRun for this delivered contract already exists; resume it with the successor session binding",
        { detail: { successorRunId: classified.successorRunId } },
      );
    }
    if (classified.openIssues === 0) {
      throw new RuntimeError(
        "EXECUTION_ISSUE_REQUIRED",
        "this session is bound to a delivered execution contract; report an ExecutionIssue "
          + "(phase_plan.report_execution_issue) before /phase-plan can create a successor run",
        { detail: { finalPlanId: execBound.finalPlanId } },
      );
    }
    const created = successors.createSuccessor({
      workspaceId: envelope.workspaceId,
      sessionId: envelope.sessionId,
    });
    return {
      status: "started_successor",
      started: true,
      run: runView(created.successorRun),
      binding: created.planningBinding,
      initialStage: created.initialStage,
      baseline: {
        baseline_id: created.baseline.baselineId,
        baseline_hash: created.baseline.baselineHash,
        issue_set_hash: created.baseline.issueSetHash,
        predecessor_run_id: created.baseline.predecessorRunId,
        final_plan: {
          id: created.baseline.finalPlanId,
          hash: created.baseline.finalPlanHash,
        },
        repository_at_replan_start: created.baseline.repositoryAtReplanStart,
      },
      executionIssues: created.adoptedIssues.map((issue) => ({
        issue_id: issue.issueId,
        issue_hash: issue.issueHash,
        kind: issue.kind,
        affected_refs: issue.affectedRefs,
      })),
      affectedScope: {
        stage: created.affectedScope.initialStage,
        needsReviewSections: created.affectedScope.needsReviewSections,
        inheritedCompletedSections: created.affectedScope.inheritedCompletedSections,
      },
      predecessorExecutionBinding: created.predecessorExecutionBinding,
      // §25/§70 — the old run is NOT resumed: it stays completed forever.
      next:
        "successor PlanningRun started from the immutable baseline; the predecessor run remains completed. "
        + "Re-opened scope is needs_review — select an affected section or prepare the first baseline-bound proposal.",
    };
  }

  // E9 §30–§33 — the CONTROLLED RETURN: a supervisor-bound session over a
  // replan_required ExecutionRun with a pending replan ExecutionIssue enters
  // formal planning; the successor PlanningRun is created from the OLD
  // immutable FinalPlan. Core resolves the exact issue (a workspace with
  // several pending replan issues is ambiguous, never guessed).
  if (!ownsPlanningLife) {
    const classifiedReplan = createSuccessorRunService(ctx.store, ctx.clock).classifyReplanEntry(envelope.workspaceId, envelope.sessionId);
    if (classifiedReplan.ambiguous) {
      throw new RuntimeError(
        "EXECUTION_ISSUE_AMBIGUOUS",
        "multiple pending replan ExecutionIssues exist in this workspace; re-enter through the exact issue's entry flow (E9 §33)",
      );
    }
    if (classifiedReplan.replanRunId !== null) {
      verifyEntryIntentCurrent(ctx.secret, args._entryIntent, { sessionId: envelope.sessionId, promptId: envelope.promptId });
      const successors = createSuccessorRunService(ctx.store, ctx.clock);
      try {
        const created = successors.createSuccessor({ workspaceId: envelope.workspaceId, sessionId: envelope.sessionId });
        return {
          status: "started_successor",
          started: true,
          run: runView(created.successorRun),
          binding: created.planningBinding,
          initialStage: created.initialStage,
          baseline: {
            baseline_id: created.baseline.baselineId,
            baseline_hash: created.baseline.baselineHash,
            issue_set_hash: created.baseline.issueSetHash,
            predecessor_run_id: created.baseline.predecessorRunId,
            final_plan: { id: created.baseline.finalPlanId, hash: created.baseline.finalPlanHash },
            repository_at_replan_start: created.baseline.repositoryAtReplanStart,
          },
          replan: created.replan ?? null,
          affectedScope: {
            stage: created.affectedScope.initialStage,
            needsReviewSections: created.affectedScope.needsReviewSections,
            inheritedCompletedSections: created.affectedScope.inheritedCompletedSections,
          },
          next:
            "successor PlanningRun started from the OLD immutable FinalPlan baseline (E9 §30). The old ExecutionRun stays replan_required forever; "
            + "the replan ExecutionIssue is adopted as provenance, and only the affected normative scope is reopened (needs_review).",
        };
      } catch (err) {
        // E9 §32 — idempotent re-entry: the successor already exists; converge.
        if (err instanceof RuntimeError && err.code === "SUCCESSOR_RUN_ALREADY_STARTED") {
          return {
            status: "successor_exists",
            successor_run_id: classifiedReplan.successorRunId,
            replan: { issue_id: classifiedReplan.issueId, predecessor_run_id: classifiedReplan.replanRunId },
            next: "The successor PlanningRun already exists for this replan issue — resume it with its session binding.",
          };
        }
        throw err;
      }
    }
  }

  verifyEntryIntentCurrent(ctx.secret, args._entryIntent, { sessionId: envelope.sessionId, promptId: envelope.promptId });

  const action = args.action === undefined ? "auto" : args.action;
  if (action !== "auto" && action !== "start_new") {
    throw inputInvalid(`action must be "auto" or "start_new", received ${JSON.stringify(args.action)}`);
  }
  const goal = args.goal;
  if (goal !== undefined && (typeof goal !== "string" || goal.trim() === "")) {
    throw inputInvalid("goal must be a non-empty string when present");
  }

  const runs = createPlanningRunService(ctx.store, ctx.clock);
  const bindings = createBindingService(ctx.store, ctx.clock);

  // Case A — exact session attached to an active run in this workspace.
  const attached = findAttachedActiveRun(ctx.store, envelope.sessionId);
  if (attached !== null && attached.run !== null) {
    if (attached.binding.workspaceId !== envelope.workspaceId) {
      throw domainError(
        "WORKSPACE_MISMATCH",
        "the current session owns an active run bound to a different workspace; return to that workspace or take over explicitly",
      );
    }
    return { status: "resumed", started: false, reattached: false, run: runView(attached.run), binding: bindingView(attached.binding) };
  }

  // Case B — exact session has a detached active run in this workspace.
  const detached = findDetachedActiveRun(ctx.store, envelope.sessionId, envelope.workspaceId);
  if (detached !== null && detached.run !== null) {
    const reattached = bindings.reattach({
      runId: detached.binding.runId,
      workspaceId: envelope.workspaceId,
      sessionId: envelope.sessionId,
    });
    return {
      status: "resumed",
      started: false,
      reattached: true,
      run: runView(detached.run),
      binding: bindingView(reattached),
    };
  }

  const activeRuns = listPlanningRunsForWorkspaceRecord(ctx.store, envelope.workspaceId, { lifecycle: "active" });
  const ownRunIds = new Set(listSessionRuns(ctx.store, envelope.sessionId).map((entry) => entry.binding.runId));
  const otherSessionRuns = activeRuns.filter((run) => !ownRunIds.has(run.runId));

  // Case E — explicit start_new is allowed while the session owns nothing.
  if (action === "start_new") {
    return createNewRun(ctx, envelope.sessionId, envelope.workspaceId, runs, goal === undefined ? undefined : goal);
  }

  // Case D — auto never guesses among other sessions' runs.
  if (otherSessionRuns.length > 0) {
    // Phase 16 §13 — safe selection metadata: the exact run identity plus the
    // facts the user needs to choose (goal, binding epoch, HEAD summary).
    // NEVER another session's session id, host-context data, or plugin paths.
    const candidates = otherSessionRuns.map((run) => {
      const binding = getBinding(ctx.store, run.runId);
      const head = getHeadCommitRecord(ctx.store, run.runId);
      return {
        ...selectableRunView(run),
        goal: run.goal,
        binding: binding === null ? null : bindingView(binding),
        head:
          head === null
            ? null
            : { commit_id: head.commitId, snapshot_id: head.resultingSnapshotId },
      };
    });
    return {
      status: "selection_required",
      code: "RUN_SELECTION_REQUIRED",
      runs: candidates,
      takeover_required: true,
      message:
        "This workspace has active planning runs owned by other sessions. Phase Plan never attaches to them automatically; "
        + "present the candidates to the user, and after they select one call phase_plan.takeover_run with the exact "
        + "run_id and expected_binding_generation (takeover requires explicit user authorization), or pass action=start_new "
        + "with a goal to begin a new run.",
    };
  }

  // Case C — nothing relevant active: create a new run (goal required).
  return createNewRun(ctx, envelope.sessionId, envelope.workspaceId, runs, goal === undefined ? undefined : goal);
}

function createNewRun(
  ctx: PhasePlanToolContext,
  sessionId: string,
  workspaceId: string,
  runs: ReturnType<typeof createPlanningRunService>,
  goal: string | undefined,
): Record<string, unknown> {
  if (typeof goal !== "string" || goal.trim() === "") {
    throw domainError("INVALID_RUN_GOAL", "starting a new planning run requires a non-empty goal");
  }
  const created = runs.createPlanningRun({ workspaceId, sessionId, goal });
  return { status: "started", started: true, run: runView(created.run), binding: bindingView(created.binding) };
}

// ---------------------------------------------------------------------------
// Read-tool shared resolution (directive §21/§39/§40/§41)
// ---------------------------------------------------------------------------

/**
 * The current session's preferred run in the signed workspace — the ONLY run
 * a read tool can ever see. Attached-active wins; the session's own
 * detached-active run (awaiting re-entry) is still readable. Another
 * session's run is unreachable by construction, so /clear cannot leak the
 * prior session's context and read tools can never auto-takeover.
 */
function resolveCurrentRun(ctx: PhasePlanToolContext, sessionId: string, workspaceId: string) {
  const entries = listSessionRuns(ctx.store, sessionId).filter(
    (entry) => entry.binding.workspaceId === workspaceId,
  );
  return (
    entries.find((entry) => entry.binding.state === "attached" && entry.run?.lifecycle === "active") ??
    entries.find((entry) => entry.run?.lifecycle === "active") ??
    null
  );
}

// ---------------------------------------------------------------------------
// get_state (directive §26/§50) — read-only, current session+workspace scoped
// ---------------------------------------------------------------------------

export function handleGetState(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const token = requireHostContext(rawArgs);
  // §57/§58 — under the signed execution authority get_state returns the
  // compact Build view of the completed run; a Planning HostContext can never
  // reach it (domain-separated signatures, §54).
  const signed = parseSignedHostContext(ctx.secret, token);
  if (signed.authority === "execution") {
    const exec = assertExecutionHostContextForTool(ctx.secret, token, { tool: "get_state", businessInput: rawArgs });
    return executionBuildState(ctx, exec);
  }
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "get_state", businessInput: rawArgs });

  const preferred = resolveCurrentRun(ctx, envelope.sessionId, envelope.workspaceId);
  if (preferred === null || preferred.run === null) {
    return {};
  }
  const head = getHeadCommitRecord(ctx.store, preferred.run.runId);
  const awaiting = getAwaitingProposalRecord(ctx.store, preferred.run.runId);
  // Phase 11 §62 — compact workflow view: active Section + status counts,
  // never full Section contents.
  const activeSectionId = getActiveSection(ctx.store, preferred.run.runId);
  const workflowStates = listSectionWorkflowStates(ctx.store, preferred.run.runId);
  const sectionCounts = {
    open: workflowStates.filter((state) => state.status === "open").length,
    completed: workflowStates.filter((state) => state.status === "completed").length,
    needsReview: workflowStates.filter((state) => state.status === "needs_review").length,
  };
  // Phase 13 §61 — the final-stage projection is a DERIVED read view: an
  // approved FinalPlan deterministically authorizes handoff; Phase 13 itself
  // never delivers it and never creates a Handoff table (§59).
  const stageRunId = preferred.run.runId;
  const stage = preferred.run.stage;
  const finalPlanRow =
    stage === "final" ? ctx.store.withRead((tx) => getFinalPlanInTx(tx, stageRunId)) : null;
  return {
    run: {
      id: preferred.run.runId,
      lifecycle: preferred.run.lifecycle,
      stage: preferred.run.stage,
      revision: preferred.run.revision,
    },
    binding: {
      generation: preferred.binding.generation,
      state: preferred.binding.state,
    },
    ...(activeSectionId !== null || workflowStates.length > 0
      ? {
          ...(activeSectionId !== null ? { activeSection: { section_id: activeSectionId } } : {}),
          sectionCounts,
        }
      : {}),
    ...(head === null
      ? {}
      : { head: { snapshotId: head.resultingSnapshotId, commitId: head.commitId } }),
    ...(awaiting === null
      ? {}
      : {
          awaitingProposal: {
            id: awaiting.proposalId,
            revision: awaiting.revision,
            hash: awaiting.proposalHash,
            type: awaiting.type,
            title: awaiting.title,
          },
        }),
    ...(stage === "final"
      ? {
          ...(finalPlanRow !== null
            ? {
                finalPlan: {
                  id: finalPlanRow.finalPlanId,
                  revision: finalPlanRow.revision,
                  hash: finalPlanRow.finalPlanHash,
                  approved: true,
                },
              }
            : {}),
          // Phase 14 — the real delivery projection from the execution domain
          // (was the derived {authorized, delivered:false} view in Phase 13).
          handoff: (() => {
            const handoffView = ctx.store.withRead((tx) => {
              const row = getExecutionHandoffInTx(tx, stageRunId);
              if (row === null) return null;
              const state = getExecutionHandoffStateInTx(tx, stageRunId);
              return {
                authorized: true,
                handoff_id: row.handoffId,
                handoff_hash: row.handoffHash,
                delivered: state?.status === "delivered",
              };
            });
            return handoffView ?? { authorized: finalPlanRow !== null, delivered: false };
          })(),
        }
      : {}),
    // Phase 15 §78 — the successor projection: baseline lineage, adopted
    // issue count, materialization state, and the Core-derived scope.
    ...(() => {
      const currentRunId = preferred.run.runId;
      const currentStage = preferred.run.stage;
      const successorView = ctx.store.withRead((tx) => {
        const baseline = getPlanningRunBaselineForSuccessorInTx(tx, currentRunId);
        if (baseline === null) return null;
        const materialization = getBaselineMaterializationInTx(tx, baseline.baselineId);
        const scopes = listBaselineScopesInTx(tx, baseline.baselineId);
        return {
          predecessorFinalPlan: { id: baseline.finalPlanId, hash: baseline.finalPlanHash },
          predecessorRunId: baseline.predecessorRunId,
          baselineHash: baseline.baselineHash,
          issueCount: tx
            .prepare("SELECT COUNT(*) AS n FROM planning_run_baseline_issues WHERE baseline_id = ?")
            .get(baseline.baselineId) as { n: number },
          materialized: materialization !== null,
          initialStage: currentStage === "architecture" || currentStage === "detail" ? currentStage : currentStage,
          affectedScope: {
            needsReviewSections: scopes.filter((scope) => scope.scopeState === "needs_review").map((scope) => scope.sectionId),
            inheritedCompletedSections: scopes.filter((scope) => scope.scopeState === "inherited_completed").map((scope) => scope.sectionId),
          },
        };
      });
      if (successorView === null) return {};
      return {
        successor: {
          predecessorFinalPlan: successorView.predecessorFinalPlan,
          predecessorRunId: successorView.predecessorRunId,
          baselineHash: successorView.baselineHash,
          issueCount: successorView.issueCount.n,
          materialized: successorView.materialized,
          initialStage: successorView.initialStage,
          affectedScope: successorView.affectedScope,
        },
      };
    })(),
  };
}

// ---------------------------------------------------------------------------
// get_context (Phase 8 directive §20–§22) — read-only structured projection
// ---------------------------------------------------------------------------

export function handleGetContext(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["detail"]);

  let detail: ContextDetail = "current";
  if (rawArgs.detail !== undefined) {
    if (!isContextDetail(rawArgs.detail)) {
      throw inputInvalid(`detail must be one of: ${CONTEXT_DETAILS.join(", ")}`);
    }
    detail = rawArgs.detail;
  }

  const token = requireHostContext(rawArgs);
  // §59/§60 — under the signed execution authority get_context(detail=build)
  // returns the deterministic ExecutionHandoff projection; no other detail is
  // reachable (the planning workflow is terminal and its context stays closed).
  const signed = parseSignedHostContext(ctx.secret, token);
  if (signed.authority === "execution") {
    if (detail !== "build") {
      throw domainError(
        "CAPABILITY_NOT_AVAILABLE",
        `under the execution authority only detail="build" is available (requested '${detail}')`,
      );
    }
    const exec = assertExecutionHostContextForTool(ctx.secret, token, { tool: "get_context", businessInput: rawArgs });
    return executionBuildContext(ctx, exec);
  }
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "get_context", businessInput: rawArgs });

  // Phase 14 §59 / Phase 16 §66 — the Execution Contract projection exists
  // ONLY under the signed execution authority of a delivered handoff;
  // planning authority — including after an explicit abort — never reaches
  // Build context (abort is not a handoff).
  if (detail === "build") {
    throw domainError(
      "EXECUTION_CONTEXT_NOT_AVAILABLE",
      'detail="build" requires the execution authority of a delivered handoff; planning authority never reaches Build context',
    );
  }

  const preferred = resolveCurrentRun(ctx, envelope.sessionId, envelope.workspaceId);
  if (preferred === null || preferred.run === null) {
    // §40/§41 — no run selection by workspace, no takeover: an unbound (or
    // cleared) session simply has no context.
    return { status: "no_active_run" };
  }

  const source = createStoreContextSource(ctx.store);
  const context = assembleContext(source, preferred.run.runId);
  if (detail === "validation") {
    // §32–§34 — the authoritative frozen bundle, available at stage
    // synthesis/validation to the main agent AND the validator alike (the
    // authority difference lives in submit_validation's caller attestation,
    // never in read permissions). Projections only: no conversation, no
    // working drafts, no Observation payloads, no host tokens.
    if (context.run.stage !== "synthesis" && context.run.stage !== "validation") {
      throw domainError(
        "CAPABILITY_NOT_AVAILABLE",
        `detail="validation" is only available at stage synthesis or validation (run is at '${context.run.stage}')`,
      );
    }
    const bundleRunId = preferred.run.runId;
    const bundle = ctx.store.withRead((tx) => {
      const input = getLatestSynthesisInputInTx(tx, bundleRunId);
      if (input === null) {
        return { synthesis_input: null, synthesis_manifest: null, semantic_validation: null };
      }
      const manifest = getSynthesisManifestByInputInTx(tx, bundleRunId, input.inputId);
      const report = manifest === null ? null : getValidationReportByManifestInTx(tx, bundleRunId, manifest.manifestId);
      const findings = report === null ? [] : listValidationFindingsInTx(tx, bundleRunId, report.reportId);
      return {
        synthesis_input: {
          input_id: input.inputId,
          input_seq: input.inputSeq,
          input_hash: input.inputHash,
          base_head: { snapshot_id: input.baseHeadSnapshotId, commit_id: input.baseHeadCommitId },
          canonical: JSON.parse(input.canonicalJson) as unknown,
        },
        synthesis_manifest:
          manifest === null
            ? null
            : {
                manifest_id: manifest.manifestId,
                manifest_hash: manifest.manifestHash,
                input_hash: manifest.inputHash,
                canonical: JSON.parse(manifest.canonicalJson) as unknown,
              },
        semantic_validation:
          report === null
            ? null
            : {
                report_id: report.reportId,
                report_hash: report.reportHash,
                is_clean: report.isClean,
                canonical: JSON.parse(report.canonicalJson) as unknown,
                findings: findings.map((finding) => ({
                  finding_id: finding.findingId,
                  kind: finding.kind,
                  summary: finding.summary,
                  detail: finding.detail,
                  subject_refs: JSON.parse(finding.subjectRefsJson) as unknown,
                  supporting_refs: JSON.parse(finding.supportingRefsJson) as unknown,
                })),
              },
      };
    });
    return {
      status: "ok",
      context_epoch: context.epoch,
      bundle,
    };
  }
  if (detail === "final") {
    // §43 — the FinalPlanCandidate world at stage final: candidate + hash +
    // pre-approval Evidence Audit summary + the exact final Proposal +
    // validation summary + implementation order + limitations. The Markdown
    // block is a deterministic PROJECTION for user review — never authority
    // (§44/§80).
    if (context.run.stage !== "final") {
      throw domainError(
        "CAPABILITY_NOT_AVAILABLE",
        `detail="final" is only available at stage final (run is at '${context.run.stage}')`,
      );
    }
    const finalRunId = preferred.run.runId;
    const finalization = ctx.store.withRead((tx) => loadFinalizationContextInTx(tx, finalRunId));
    if (finalization.candidate === null) {
      throw domainError("FINAL_PLAN_CANDIDATE_REQUIRED", "this run has no FinalPlanCandidate at stage final");
    }
    const candidate = finalization.candidate.canonical;
    const approvedPlan = ctx.store.withRead((tx) => getFinalPlanInTx(tx, finalRunId));
    const finalProposal =
      approvedPlan !== null
        ? {
            proposal_id: approvedPlan.proposalId,
            revision: approvedPlan.proposalRevision,
            hash: approvedPlan.proposalHash,
            status: "approved" as const,
          }
        : context.working.awaitingProposal !== null
          ? {
              proposal_id: context.working.awaitingProposal.proposalId,
              revision: context.working.awaitingProposal.revision,
              hash: context.working.awaitingProposal.hash,
              status: "awaiting_approval" as const,
            }
          : null;
    return {
      status: "ok",
      context_epoch: context.epoch,
      finalization: {
        candidate: {
          candidate_id: finalization.candidate.candidateId,
          candidate_seq: finalization.candidate.candidateSeq,
          candidate_hash: finalization.candidate.candidateHash,
          base_head: { snapshot_id: candidate.baseHeadSnapshot, commit_id: candidate.baseHeadCommit },
          synthesis_input: candidate.synthesisInput,
          synthesis_manifest: candidate.synthesisManifest,
          semantic_validation: candidate.semanticValidation,
          architecture: candidate.architecture,
          sections: candidate.sections,
          decisions: candidate.decisions,
          constraints: candidate.constraints,
          implementation_order: candidate.implementationOrder,
          limitations: candidate.limitations,
          evidence_scope: candidate.evidenceScope,
        },
        evidence_audit:
          finalization.audit === null
            ? null
            : {
                audit_id: finalization.audit.auditId,
                audit_hash: finalization.audit.auditHash,
                purpose: finalization.audit.purpose,
                entries: finalization.audit.entries,
              },
        final_proposal: finalProposal,
        final_plan:
          approvedPlan === null
            ? null
            : { id: approvedPlan.finalPlanId, revision: approvedPlan.revision, hash: approvedPlan.finalPlanHash },
        ...(finalProposal !== null
          ? {
              markdown: renderFinalPlanCandidateMarkdown(candidate, {
                candidateId: finalization.candidate.candidateId,
                candidateHash: finalization.candidate.candidateHash,
                proposalId: finalProposal.proposal_id,
                proposalRevision: finalProposal.revision,
                proposalHash: finalProposal.hash,
              }),
            }
          : {}),
      },
    };
  }
  return {
    status: "ok",
    context_epoch: context.epoch,
    context,
    // Phase 15 §79 — the successor view: baseline FinalPlan, issue summaries,
    // the Core-derived affected scope, the repository at replan start, and the
    // local HEAD once materialized. Never a dump of predecessor history.
    ...(() => {
      const successorRunId = preferred.run.runId;
      const successorView = ctx.store.withRead((tx) => {
        const baseline = getPlanningRunBaselineForSuccessorInTx(tx, successorRunId);
        if (baseline === null) return null;
        const scopes = listBaselineScopesInTx(tx, baseline.baselineId);
        const issueRows = tx
          .prepare(
            "SELECT i.issue_id AS issueId, i.kind AS kind, i.summary AS summary FROM planning_run_baseline_issues bi "
            + "JOIN execution_issues i ON i.issue_id = bi.issue_id "
            + "WHERE bi.baseline_id = ? ORDER BY bi.position",
          )
          .all(baseline.baselineId) as Array<{ issueId: string; kind: string; summary: string }>;
        const materialization = getBaselineMaterializationInTx(tx, baseline.baselineId);
        const head = getHeadPairInTx(tx, successorRunId);
        return {
          baseline: {
            baseline_id: baseline.baselineId,
            baseline_hash: baseline.baselineHash,
            issue_set_hash: baseline.issueSetHash,
            finalPlan: { id: baseline.finalPlanId, hash: baseline.finalPlanHash },
            predecessorRunId: baseline.predecessorRunId,
            executionHandoff: { id: baseline.executionHandoffId, hash: baseline.executionHandoffHash },
            repositoryAtReplanStart:
              baseline.repositoryKind === "git"
                ? ({ kind: "git", revision: baseline.repositoryRevision } as const)
                : ({ kind: "directory", revision: null } as const),
          },
          executionIssues: issueRows.map((issue) => ({ issue_id: issue.issueId, kind: issue.kind, summary: issue.summary })),
          affectedScope: {
            needsReviewSections: scopes.filter((scope) => scope.scopeState === "needs_review").map((scope) => scope.sectionId),
            inheritedCompletedSections: scopes.filter((scope) => scope.scopeState === "inherited_completed").map((scope) => scope.sectionId),
          },
          materialized: materialization !== null,
          localHead: head === null ? null : { snapshotId: head.headSnapshotId, commitId: head.headCommitId },
        };
      });
      if (successorView === null) return {};
      return { successor: successorView };
    })(),
    ...(detail === "recovery" ? { recoveryCapsule: buildRecoveryCapsule(context).text } : {}),
  };
}

// ---------------------------------------------------------------------------
// read_memory (Phase 8 directive §23–§25) — read-only exact MemoryRef read
// ---------------------------------------------------------------------------

export function handleReadMemory(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["kind", "id", "revision", "detail"]);
  const token = requireHostContext(rawArgs);

  // §24 — exact refs only: kind/id/revision are required; no latest/current/
  // by-title/fuzzy authority shortcut exists, and run_id is not model input.
  if (typeof rawArgs.kind !== "string" || !isMemoryArtifactKind(rawArgs.kind)) {
    throw inputInvalid(`kind must be one of: constraint, decision, architecture, section, open_question, conflict`);
  }
  if (typeof rawArgs.id !== "string" || rawArgs.id.trim() === "") {
    throw inputInvalid("id must be a non-empty string");
  }
  if (typeof rawArgs.revision !== "number" || !Number.isInteger(rawArgs.revision) || rawArgs.revision < 1) {
    throw inputInvalid("revision must be a positive integer");
  }
  let detail: MemoryDetailLevel = DEFAULT_MEMORY_DETAIL;
  if (rawArgs.detail !== undefined) {
    if (!isMemoryDetailLevel(rawArgs.detail)) {
      throw inputInvalid(`detail must be one of: identity, summary, full, contract`);
    }
    detail = rawArgs.detail;
  }

  // §62–§66 — the authority decides FIRST: an execution token never reaches
  // the planning verifier (domain separation, §54) and vice versa. Under the
  // execution authority read_memory is exact-ref only AND limited to the
  // approved FinalPlan closure; historical revisions fail closed (§64).
  const execSigned = parseSignedHostContext(ctx.secret, token);
  if (execSigned.authority === "execution") {
    const exec = assertExecutionHostContextForTool(ctx.secret, token, { tool: "read_memory", businessInput: rawArgs });
    return executionReadMemory(ctx, exec, { kind: rawArgs.kind, id: rawArgs.id, revision: rawArgs.revision, detail });
  }
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "read_memory", businessInput: rawArgs });

  const preferred = resolveCurrentRun(ctx, envelope.sessionId, envelope.workspaceId);
  if (preferred === null || preferred.run === null) {
    return { status: "no_active_run" };
  }

  const ref: MemoryRef = { runId: preferred.run.runId, kind: rawArgs.kind, id: rawArgs.id, revision: rawArgs.revision };
  const view = createStoreContextSource(ctx.store).readRevision(ref);
  if (view === null) {
    // Phase 15 §44/§45 — before the first successor PlanCommit the baseline
    // FinalPlan design is readable READ-ONLY from the predecessor world under
    // authority="successor_baseline": exact FinalPlan-closure refs only, and
    // historical superseded revisions never resolve (§45).
    const baselineView = ctx.store.withRead((tx) => {
      const baseline = getPlanningRunBaselineForSuccessorInTx(tx, ref.runId);
      if (baseline === null) return { outcome: "none" as const };
      if (getBaselineMaterializationInTx(tx, baseline.baselineId) !== null) {
        // Materialized: local HEAD is the authority; a miss is a plain miss.
        return { outcome: "none" as const };
      }
      const plan = parseFinalPlanCanonical(
        (tx
          .prepare(
            "SELECT canonical_json AS canonicalJson FROM final_plans WHERE run_id = ? AND final_plan_id = ?",
          )
          .get(baseline.predecessorRunId, baseline.finalPlanId) as { canonicalJson: string } | undefined)
          ?.canonicalJson ?? "null",
        baseline.predecessorRunId,
      );
      try {
        createHandoffService(ctx.store, ctx.clock).assertExecutionMemoryRefInTx(plan, {
          kind: ref.kind,
          id: ref.id,
          revision: ref.revision,
        });
      } catch {
        return { outcome: "unauthorized" as const };
      }
      return {
        outcome: "ok" as const,
        predecessorRunId: baseline.predecessorRunId,
        baselineHash: baseline.baselineHash,
        baselineId: baseline.baselineId,
      };
    });
    if (baselineView.outcome === "ok") {
      const predecessorView = createStoreContextSource(ctx.store).readRevision({
        runId: baselineView.predecessorRunId,
        kind: ref.kind,
        id: ref.id,
        revision: ref.revision,
      });
      if (predecessorView !== null) {
        const refView = { runId: baselineView.predecessorRunId, kind: ref.kind, id: ref.id, revision: ref.revision };
        switch (detail) {
          case "identity":
            return { status: "ok", authority: "successor_baseline", baseline: { baseline_id: baselineView.baselineId, baseline_hash: baselineView.baselineHash }, ref: refView };
          case "summary":
            return { status: "ok", authority: "successor_baseline", baseline: { baseline_id: baselineView.baselineId, baseline_hash: baselineView.baselineHash }, ref: refView, compactProjection: predecessorView.compactProjection };
          case "contract":
            if (ref.kind !== "section") {
              throw domainError("CAPABILITY_NOT_AVAILABLE", `detail="contract" is only available for section artifacts (requested ${ref.kind})`);
            }
            return { status: "ok", authority: "successor_baseline", baseline: { baseline_id: baselineView.baselineId, baseline_hash: baselineView.baselineHash }, ref: refView, contract: predecessorView.contractJson === null ? null : JSON.parse(predecessorView.contractJson) };
          default:
            return {
              status: "ok",
              authority: "successor_baseline",
              baseline: { baseline_id: baselineView.baselineId, baseline_hash: baselineView.baselineHash },
              ref: refView,
              content: predecessorView.content,
              compactProjection: predecessorView.compactProjection,
              ...(predecessorView.contractJson === null ? {} : { contract: JSON.parse(predecessorView.contractJson) }),
            };
        }
      }
    }
    if (baselineView.outcome === "unauthorized") {
      throw domainError(
        "BASELINE_MEMORY_REF_NOT_AUTHORIZED",
        `${ref.kind} '${ref.id}'@${ref.revision} is not an exact ref of the baseline FinalPlan closure`,
      );
    }
    // The ref's run component comes from the signed session scope, so a miss
    // is a plain exact-revision miss — cross-run reads cannot reach here.
    throw domainError(
      "MEMORY_REVISION_NOT_FOUND",
      `no memory revision exists for ${ref.kind} '${ref.id}'@${ref.revision} in the current run`,
    );
  }

  const refView = { runId: ref.runId, kind: ref.kind, id: ref.id, revision: ref.revision };
  switch (detail) {
    case "identity":
      return { status: "ok", ref: refView };
    case "summary":
      return { status: "ok", ref: refView, compactProjection: view.compactProjection };
    case "full":
      return {
        status: "ok",
        ref: refView,
        content: view.content,
        compactProjection: view.compactProjection,
        ...(view.contractJson === null ? {} : { contract: JSON.parse(view.contractJson) }),
      };
    case "contract":
      // §25 — the frozen SectionContract is section-only; anything else is a
      // typed capability error, never a best-effort guess.
      if (ref.kind !== "section") {
        throw domainError("CAPABILITY_NOT_AVAILABLE", `detail="contract" is only available for section artifacts (requested ${ref.kind})`);
      }
      return {
        status: "ok",
        ref: refView,
        contract: view.contractJson === null ? null : JSON.parse(view.contractJson),
      };
  }
}

// ---------------------------------------------------------------------------
// list_observations (Phase 9 §21/§22) — read-only Observation ledger summaries
// ---------------------------------------------------------------------------

const OBSERVATION_CURSOR_PREFIX = "seq:";

function observationCursorOf(seq: number): string {
  return `${OBSERVATION_CURSOR_PREFIX}${seq}`;
}

function parseObservationCursor(after: unknown): number | undefined {
  if (typeof after !== "string" || after === "") {
    throw inputInvalid("after must be a non-empty ledger cursor string");
  }
  if (!after.startsWith(OBSERVATION_CURSOR_PREFIX)) {
    throw inputInvalid("after is not a valid ledger cursor");
  }
  const seq = Number(after.slice(OBSERVATION_CURSOR_PREFIX.length));
  if (!Number.isInteger(seq) || seq < 0) {
    throw inputInvalid("after is not a valid ledger cursor");
  }
  return seq;
}

export function handleListObservations(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["class", "limit", "after"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "list_observations", businessInput: rawArgs });

  let observationClass: ObservationClass | undefined;
  if (rawArgs.class !== undefined) {
    if (typeof rawArgs.class !== "string" || !(OBSERVATION_CLASSES as readonly string[]).includes(rawArgs.class)) {
      throw inputInvalid(`class must be one of: ${OBSERVATION_CLASSES.join(", ")}`);
    }
    observationClass = rawArgs.class as ObservationClass;
  }
  let limit = 20;
  if (rawArgs.limit !== undefined) {
    if (typeof rawArgs.limit !== "number" || !Number.isInteger(rawArgs.limit) || rawArgs.limit < 1 || rawArgs.limit > 100) {
      throw inputInvalid("limit must be an integer between 1 and 100");
    }
    limit = rawArgs.limit;
  }
  const afterSeq = rawArgs.after === undefined ? undefined : parseObservationCursor(rawArgs.after);

  const preferred = resolveCurrentRun(ctx, envelope.sessionId, envelope.workspaceId);
  if (preferred === null || preferred.run === null) {
    return { status: "no_active_run" };
  }
  const summaries = listObservationSummaries(ctx.store, preferred.run.runId, {
    ...(observationClass === undefined ? {} : { observationClass }),
    afterSeq,
    limit,
  });
  return {
    status: "ok",
    run: { id: preferred.run.runId, stage: preferred.run.stage, revision: preferred.run.revision },
    observations: summaries.map((summary) => ({
      observation_id: summary.observationId,
      observation_seq: summary.observationSeq,
      class: summary.observationClass,
      tool: summary.tool,
      captured_at: summary.capturedAt,
      input: summary.input,
      payload_size: summary.payloadSize,
      ...(summary.payloadHash === null ? {} : { payload_hash: summary.payloadHash }),
      promotable: summary.promotable,
      ...(summary.sanitized === null ? {} : { sanitized: summary.sanitized }),
      evidence_refs: summary.evidenceRefs,
    })),
    ...(summaries.length === limit && summaries.length > 0
      ? { next_after: observationCursorOf(summaries[summaries.length - 1]!.observationSeq) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// promote_evidence (Phase 9 §28/§44/§45) — explicit promotion into Evidence
// ---------------------------------------------------------------------------

export function handlePromoteEvidence(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, [
    "claim",
    "kind",
    "scope",
    "confidence",
    "criticality",
    "observation_refs",
    "derived_from",
  ]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "promote_evidence", businessInput: rawArgs });

  // §44 — the operation id derives from the SIGNED HostContext tool use, so
  // the model can neither fabricate one nor reuse another call's identity.
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }
  {
    const stageRun = getPlanningRunRecord(ctx.store, envelope.runId);
    if (stageRun !== null) assertMainCapabilityForStage(stageRun.stage, "promote_evidence");
  }

  const observationRefs =
    rawArgs.observation_refs === undefined
      ? []
      : rawArgs.observation_refs;
  if (!Array.isArray(observationRefs) || observationRefs.some((ref) => typeof ref !== "string")) {
    throw inputInvalid("observation_refs must be an array of observation ids");
  }
  const derivedFromRaw = rawArgs.derived_from === undefined ? [] : rawArgs.derived_from;
  if (!Array.isArray(derivedFromRaw)) {
    throw inputInvalid("derived_from must be an array of {evidence_id, revision}");
  }
  const derivedFrom = derivedFromRaw.map((ref) => {
    if (typeof ref !== "object" || ref === null) {
      throw inputInvalid("derived_from entries must be {evidence_id, revision} objects");
    }
    const record = ref as Record<string, unknown>;
    if (typeof record.evidence_id !== "string" || record.evidence_id === "") {
      throw inputInvalid("derived_from entries must carry a non-empty evidence_id");
    }
    if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 1) {
      throw inputInvalid("derived_from revision must be a positive integer");
    }
    return { evidenceId: record.evidence_id, revision: record.revision };
  });

  if (typeof rawArgs.claim !== "string") {
    throw inputInvalid("claim must be a string");
  }
  const request: PromoteEvidenceRequest = {
    claim: rawArgs.claim,
    kind: rawArgs.kind as PromoteEvidenceRequest["kind"],
    scope: rawArgs.scope as PromoteEvidenceRequest["scope"],
    confidence: rawArgs.confidence as PromoteEvidenceRequest["confidence"],
    criticality: rawArgs.criticality as PromoteEvidenceRequest["criticality"],
    observationRefs: observationRefs as string[],
    derivedFrom,
  };
  const service = createEvidenceService(ctx.store, ctx.blobs, ctx.clock);
  const result = service.promoteEvidence({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    request,
    operationId: `promote:${envelope.toolUseId}`,
  });
  return {
    status: "ok",
    idempotent: result.idempotent,
    evidence: {
      evidence_id: result.evidence.evidenceId,
      revision: result.evidence.revision,
      ref: `${result.evidence.evidenceId}@${result.evidence.revision}`,
      claim: result.evidence.claim,
      kind: result.evidence.kind,
      scope: result.evidence.scope,
      confidence: result.evidence.confidence,
      criticality: result.evidence.criticality,
      validation_strategy: result.evidence.validationStrategy,
      observation_refs: result.evidence.observationRefs,
      derived_from: result.evidence.derivedFrom,
      source_fingerprints: result.evidence.sourceFingerprints,
      created_at: result.evidence.createdAt,
    },
    freshness: {
      state: result.freshness.state,
      reason: result.freshness.reasonCode,
    },
  };
}

// ---------------------------------------------------------------------------
// revalidate_evidence (Phase 10 §20–§29) — freshness revalidation
// ---------------------------------------------------------------------------

export function handleRevalidateEvidence(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["evidence_id", "revision", "mode", "assessment", "observation_refs", "derived_from"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "revalidate_evidence", businessInput: rawArgs });

  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }
  {
    const stageRun = getPlanningRunRecord(ctx.store, envelope.runId);
    if (stageRun !== null) assertMainCapabilityForStage(stageRun.stage, "revalidate_evidence");
  }
  if (typeof rawArgs.evidence_id !== "string" || rawArgs.evidence_id === "") {
    throw inputInvalid("evidence_id must be a non-empty string");
  }
  if (typeof rawArgs.revision !== "number" || !Number.isInteger(rawArgs.revision) || rawArgs.revision < 1) {
    throw inputInvalid("revision must be a positive integer");
  }
  if (rawArgs.mode !== "check" && rawArgs.mode !== "assess") {
    throw inputInvalid("mode must be 'check' or 'assess'");
  }
  const observationRefs =
    rawArgs.observation_refs === undefined ? [] : rawArgs.observation_refs;
  if (!Array.isArray(observationRefs) || observationRefs.some((ref) => typeof ref !== "string")) {
    throw inputInvalid("observation_refs must be an array of observation ids");
  }
  const derivedFromRaw = rawArgs.derived_from === undefined ? [] : rawArgs.derived_from;
  if (!Array.isArray(derivedFromRaw)) {
    throw inputInvalid("derived_from must be an array of {evidence_id, revision}");
  }
  const derivedFrom = derivedFromRaw.map((ref) => {
    if (typeof ref !== "object" || ref === null) {
      throw inputInvalid("derived_from entries must be {evidence_id, revision} objects");
    }
    const record = ref as Record<string, unknown>;
    if (typeof record.evidence_id !== "string" || record.evidence_id === "") {
      throw inputInvalid("derived_from entries must carry a non-empty evidence_id");
    }
    if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 1) {
      throw inputInvalid("derived_from revision must be a positive integer");
    }
    return { evidenceId: record.evidence_id, revision: record.revision };
  });

  const service = createEvidenceFreshnessService(ctx.store, ctx.blobs, ctx.clock);
  const result = service.revalidateEvidence({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    bindingGeneration: envelope.bindingGeneration,
    request: {
      evidenceId: rawArgs.evidence_id,
      revision: rawArgs.revision,
      mode: rawArgs.mode,
      ...(rawArgs.assessment === undefined ? {} : { assessment: rawArgs.assessment as RevalidationAssessment }),
      observationRefs: observationRefs as string[],
      derivedFrom,
    },
    operationId: `revalidate:${envelope.toolUseId}`,
  });
  return {
    status: result.status,
    idempotent: result.idempotent,
    target: result.target,
    ...(result.replacement === undefined ? {} : { replacement: result.replacement }),
    ...(result.affected_derived === undefined
      ? {}
      : {
          affected_derived: result.affected_derived.map((ref) => ({
            evidence_id: ref.evidenceId,
            revision: ref.revision,
          })),
        }),
    reason: result.reason,
  };
}

// ---------------------------------------------------------------------------
// select_section (Phase 11 §10–§15) — durable active-Section selection
// ---------------------------------------------------------------------------

export function handleSelectSection(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["section_id"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "select_section", businessInput: rawArgs });
  // §12 — the model supplies ONLY the section id: run identity, workspace,
  // binding, and the expected run revision are all server-derived.
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }
  if (typeof rawArgs.section_id !== "string" || rawArgs.section_id.trim() === "") {
    throw inputInvalid("section_id must be a non-empty string");
  }
  const current = getPlanningRunRecord(ctx.store, envelope.runId);
  if (current === null) {
    throw domainError("RUN_NOT_FOUND", `the attached run '${envelope.runId}' no longer exists`);
  }
  const service = createSectionWorkflowService(ctx.store, ctx.clock);
  const result = service.selectSection({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    bindingGeneration: envelope.bindingGeneration,
    expectedRunRevision: current.revision,
    sectionId: rawArgs.section_id,
  });
  return {
    status: "ok",
    idempotent: result.idempotent,
    active_section: { section_id: result.activeSectionId },
    run: { id: result.run.runId, stage: result.run.stage, revision: result.run.revision },
  };
}

// ---------------------------------------------------------------------------
// prepare_proposal (Phase 11 §21–§24/§53/§59/§60) — the production model-
// facing prepare surface; the Formal Approval remains approve_proposal (§61)
// ---------------------------------------------------------------------------

const PROPOSAL_TYPE_VALUES = ["design_checkpoint", "architecture_completion", "section_completion", "amendment"] as const;

export function handlePrepareProposal(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  // Phase 17 fix: `proposal_id` (optional) revises the AWAITING proposal
  // instead of preparing a new one — the sanctioned "freeze a new Proposal
  // revision" recovery after required evidence goes stale (the frozen
  // revise path with the same gates; §83 replay included).
  assertExactBusinessFields(rawArgs, ["proposal_type", "scope", "title", "summary", "changes", "required_evidence", "proposal_id"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "prepare_proposal", businessInput: rawArgs });

  // §59 — Plan Mode is the host-owned planning boundary for design mutation.
  if (envelope.permissionMode !== "plan") {
    throw domainError("PLAN_MODE_REQUIRED", `prepare_proposal requires permission_mode=plan (observed '${envelope.permissionMode}')`);
  }
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }

  if (typeof rawArgs.proposal_type !== "string" || !(PROPOSAL_TYPE_VALUES as readonly string[]).includes(rawArgs.proposal_type)) {
    throw inputInvalid(`proposal_type must be one of: ${PROPOSAL_TYPE_VALUES.join(", ")}`);
  }
  const scopeRaw = rawArgs.scope;
  if (typeof scopeRaw !== "object" || scopeRaw === null) {
    throw inputInvalid("scope must be an object");
  }
  const scopeRecord = scopeRaw as Record<string, unknown>;
  if (scopeRecord.kind !== "architecture" && scopeRecord.kind !== "detail" && scopeRecord.kind !== "section") {
    throw inputInvalid('scope.kind must be "architecture", "detail", or "section"');
  }
  if (scopeRecord.kind === "section" && (typeof scopeRecord.section_id !== "string" || scopeRecord.section_id === "")) {
    throw inputInvalid('scope.section_id is required when scope.kind="section"');
  }
  const scope: ProposalScope =
    scopeRecord.kind === "section"
      ? { kind: "section", sectionId: scopeRecord.section_id as string }
      : { kind: scopeRecord.kind };
  for (const field of ["title", "summary"] as const) {
    if (typeof rawArgs[field] !== "string" || (rawArgs[field] as string).trim() === "") {
      throw inputInvalid(`${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(rawArgs.changes)) {
    throw inputInvalid("changes must be an array");
  }
  const changes = rawArgs.changes as RawProposalChange[];
  for (const change of changes) {
    if (typeof change !== "object" || change === null || typeof (change as { op?: unknown }).op !== "string") {
      throw inputInvalid("every change must be an object with an op field");
    }
  }
  const requiredEvidence: ProposalEvidenceRef[] = [];
  if (rawArgs.required_evidence !== undefined) {
    if (!Array.isArray(rawArgs.required_evidence)) throw inputInvalid("required_evidence must be an array");
    for (const entry of rawArgs.required_evidence) {
      if (typeof entry !== "object" || entry === null) throw inputInvalid("required_evidence entries must be {evidence_id, revision}");
      const record = entry as Record<string, unknown>;
      if (typeof record.evidence_id !== "string" || record.evidence_id === "") {
        throw inputInvalid("required_evidence entries must carry a non-empty evidence_id");
      }
      if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 1) {
        throw inputInvalid("required_evidence revision must be a positive integer");
      }
      requiredEvidence.push({ evidenceId: record.evidence_id, revision: record.revision });
    }
  }

  // §22 — every authority input is server-derived. The expected run revision
  // comes from the Store at call time; the write transaction's WHERE-revision
  // guard turns any concurrent drift into STALE_RUN_REVISION.
  const current = getPlanningRunRecord(ctx.store, envelope.runId);
  if (current === null) {
    throw domainError("RUN_NOT_FOUND", `the attached run '${envelope.runId}' no longer exists`);
  }
  const service = createProposalService(ctx.store, ctx.clock);
  // §60 — the operation id derives from the SIGNED HostContext tool use.
  const reviseProposalId = rawArgs.proposal_id === undefined
    ? undefined
    : trimStrayTrailingBackslash(rawArgs.proposal_id as string);
  const prepared = reviseProposalId === undefined
    ? service.prepareProposal({
        runId: envelope.runId,
        workspaceId: envelope.workspaceId,
        sessionId: envelope.sessionId,
        bindingGeneration: envelope.bindingGeneration,
        expectedRunRevision: current.revision,
        type: rawArgs.proposal_type as ProposalType,
        scope,
        title: rawArgs.title as string,
        summary: rawArgs.summary as string,
        changes,
        requiredEvidence,
        prepareRequestId: `prepare:${envelope.toolUseId}`,
      })
    : service.reviseProposal({
        runId: envelope.runId,
        workspaceId: envelope.workspaceId,
        sessionId: envelope.sessionId,
        bindingGeneration: envelope.bindingGeneration,
        expectedRunRevision: current.revision,
        proposalId: reviseProposalId,
        type: rawArgs.proposal_type as ProposalType,
        scope,
        title: rawArgs.title as string,
        summary: rawArgs.summary as string,
        changes,
        requiredEvidence,
        prepareRequestId: `prepare:${envelope.toolUseId}`,
      });
  const sectionIds = [...new Set(prepared.candidateRefs.filter((ref) => ref.kind === "section").map((ref) => ref.id))].sort();
  return {
    status: "awaiting_approval",
    proposal: {
      proposal_id: prepared.proposal.proposalId,
      revision: prepared.proposal.revision,
      proposal_hash: prepared.proposal.proposalHash,
      type: prepared.proposal.type,
      scope: prepared.proposal.scope,
      title: prepared.proposal.title,
      base_run_revision: prepared.proposal.baseRunRevision,
    },
    candidate: {
      change_count: prepared.proposal.changes.length,
      candidate_ref_count: prepared.candidateRefs.length,
      section_ids: sectionIds,
    },
    next: "call approve_proposal with the exact proposal_id, revision, and proposal_hash (requires human approval)",
  };
}

// ---------------------------------------------------------------------------
// approve_proposal (directive §27–§32) — the Formal Approval bridge
// ---------------------------------------------------------------------------

/**
 * Phase 17 live finding: some model relays append a stray literal trailing
 * backslash to long identifier values copied into JSON arguments. Identity
 * fields can never legitimately end in one, so the stray character is
 * trimmed before use; the exact-hash checks keep every real corruption
 * failing closed.
 */
function trimStrayTrailingBackslash(value: string): string {
  return value.endsWith("\\") ? value.slice(0, -1) : value;
}

export function handleApproveProposal(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  // §27/§29 — exact business schema; model-supplied authority fields rejected.
  assertExactBusinessFields(rawArgs, ["proposal_id", "proposal_revision", "proposal_hash"]);
  // The signed context is verified over the RAW input exactly as the hook
  // emitted it; the stray-backslash trim below happens strictly afterwards.
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "approve_proposal", businessInput: rawArgs });
  // Gateway escaping defect (Phase 17 live finding): some model relays append
  // a literal trailing backslash when the model copies long identifier values
  // into JSON arguments. Identity fields never legitimately end in a
  // backslash, so the stray character is trimmed after the signed-context
  // verification — the exact-hash approval check below still fails closed on
  // any real corruption.
  const args: Record<string, unknown> = {
    ...rawArgs,
    ...(typeof rawArgs.proposal_id === "string" ? { proposal_id: trimStrayTrailingBackslash(rawArgs.proposal_id) } : {}),
    ...(typeof rawArgs.proposal_hash === "string" ? { proposal_hash: trimStrayTrailingBackslash(rawArgs.proposal_hash) } : {}),
  };

  if (typeof args.proposal_id !== "string" || args.proposal_id === "") {
    throw inputInvalid("proposal_id must be a non-empty string");
  }
  if (typeof args.proposal_revision !== "number" || !Number.isInteger(args.proposal_revision) || args.proposal_revision < 1) {
    throw inputInvalid("proposal_revision must be a positive integer");
  }
  if (typeof args.proposal_hash !== "string" || args.proposal_hash === "") {
    throw inputInvalid("proposal_hash must be a non-empty string");
  }

  // Plan Mode is the host-owned planning boundary: a signed context observed
  // outside plan mode can never drive the Formal Approval (§29).
  if (envelope.permissionMode !== "plan") {
    throw domainError("PLAN_MODE_REQUIRED", `approve_proposal requires permission_mode=plan (observed '${envelope.permissionMode}')`);
  }
  // Signed observation (§23) — the engine revalidates both against the Store.
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }
  // §73 — approving ordinary design is shut off once the run leaves Detail.
  {
    const stageRun = getPlanningRunRecord(ctx.store, envelope.runId);
    if (stageRun !== null) assertMainCapabilityForStage(stageRun.stage, "approve_proposal");
  }

  // §31/§32 — the authorization request id derives from the SIGNED
  // HostContext.toolUseId, never from tool input.
  const engine = createPlanCommitEngine(ctx.store, ctx.clock);
  const result = engine.commitAuthorizedProposal({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    bindingGeneration: envelope.bindingGeneration,
    authorization: {
      authorizationRequestId: `mcp-approve:${envelope.toolUseId}`,
      proposalId: args.proposal_id,
      proposalRevision: args.proposal_revision,
      proposalHash: args.proposal_hash,
    },
  });
  return {
    approved: true,
    approval_id: result.approvalId,
    commit_id: result.commitId,
    snapshot_id: result.snapshotId,
    idempotent: result.idempotent,
    new_run_revision: result.runRevision,
    new_stage: result.stage,
  };
}

// ---------------------------------------------------------------------------
// submit_synthesis / submit_validation / request_reopen (Phase 12 §41–§67)
// ---------------------------------------------------------------------------

/** §73/§74/§88 — main-mutation capabilities the later stages shut off. */
const STAGE_BLOCKED_MAIN_TOOLS = ["promote_evidence", "revalidate_evidence"] as const;

function assertMainCapabilityForStage(stage: string, tool: string): void {
  if (tool === "approve_proposal") {
    // §42/§88: ordinary design approval shuts off once the run leaves Detail;
    // at stage final the ONLY approvable Proposal is the server-frozen
    // final_plan one — the engine's type gates enforce that, so the Formal
    // Final Approval (§46) reuses this exact tool.
    if (stage === "synthesis" || stage === "validation") {
      throw domainError("CAPABILITY_NOT_AVAILABLE", `${tool} is not available at stage '${stage}'`);
    }
    return;
  }
  if ((STAGE_BLOCKED_MAIN_TOOLS as readonly string[]).includes(tool) && (stage === "synthesis" || stage === "validation" || stage === "final")) {
    throw domainError("CAPABILITY_NOT_AVAILABLE", `${tool} is not available at stage '${stage}'`);
  }
}

function stringArgument(rawArgs: Record<string, unknown>, field: string): string {
  const value = rawArgs[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw inputInvalid(`${field} must be a non-empty string`);
  }
  return value;
}

export function handleSubmitSynthesis(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, [
    "input_id",
    "input_hash",
    "cross_section_links",
    "implementation_order",
    "limitations",
    "unresolved_findings",
  ]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "submit_synthesis", businessInput: rawArgs });
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }
  const inputId = stringArgument(rawArgs, "input_id");
  const inputHash = stringArgument(rawArgs, "input_hash");
  for (const field of ["cross_section_links", "implementation_order", "limitations", "unresolved_findings"] as const) {
    if (!Array.isArray(rawArgs[field])) {
      throw inputInvalid(`${field} must be an array`);
    }
  }
  const current = getPlanningRunRecord(ctx.store, envelope.runId);
  if (current === null) {
    throw domainError("RUN_NOT_FOUND", `the attached run '${envelope.runId}' no longer exists`);
  }
  const service = createSynthesisService(ctx.store, ctx.clock);
  const result = service.submitSynthesis({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    bindingGeneration: envelope.bindingGeneration,
    permissionMode: envelope.permissionMode,
    inputId,
    inputHash,
    manifest: {
      version: 1,
      inputId,
      inputHash,
      crossSectionLinks: rawArgs.cross_section_links,
      implementationOrder: rawArgs.implementation_order,
      limitations: rawArgs.limitations,
      unresolvedFindings: rawArgs.unresolved_findings,
    },
    // §44 — the operation identity derives from the SIGNED tool use.
    requestId: `synthesis:${envelope.toolUseId}`,
    // §42 — from the signed envelope only; absent agent ⇒ main-session call.
    callerAgent: envelope.version === 2 ? (envelope.agent ?? null) : null,
  });
  return {
    status: "ok",
    idempotent: result.idempotent,
    manifest_id: result.manifestId,
    manifest_hash: result.manifestHash,
    input_id: result.inputId,
    stage: result.stage,
    run_revision: result.runRevision,
    next: result.stage === "validation" ? "invoke the phase-plan validator subagent (it calls submit_validation)" : undefined,
  };
}

export function handleSubmitValidation(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["manifest_id", "manifest_hash", "input_id", "input_hash", "findings"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "submit_validation", businessInput: rawArgs });
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }
  const manifestId = stringArgument(rawArgs, "manifest_id");
  const manifestHash = stringArgument(rawArgs, "manifest_hash");
  const inputId = stringArgument(rawArgs, "input_id");
  const inputHash = stringArgument(rawArgs, "input_hash");
  if (!Array.isArray(rawArgs.findings)) {
    throw inputInvalid("findings must be an array");
  }
  const current = getPlanningRunRecord(ctx.store, envelope.runId);
  if (current === null) {
    throw domainError("RUN_NOT_FOUND", `the attached run '${envelope.runId}' no longer exists`);
  }
  const service = createSynthesisService(ctx.store, ctx.clock);
  const result = service.submitValidation({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    bindingGeneration: envelope.bindingGeneration,
    manifestId,
    manifestHash,
    inputId,
    inputHash,
    findings: rawArgs.findings,
    // §57 — the operation identity derives from the SIGNED validator tool use.
    requestId: `validation:${envelope.toolUseId}`,
    callerAgent: envelope.version === 2 ? (envelope.agent ?? null) : null,
  });
  return {
    status: "ok",
    idempotent: result.idempotent,
    report_id: result.reportId,
    report_hash: result.reportHash,
    manifest_id: result.manifestId,
    is_clean: result.isClean,
    finding_ids: result.findingIds,
    stage: current.stage,
    run_revision: current.revision,
    next: result.isClean
      ? "validation clean — call request_finalization to freeze the Final Plan Candidate (then present it and, on user authorization, approve_proposal)"
      : "call request_reopen to bring the affected sections back into review",
  };
}

export function handleRequestReopen(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["target", "reason", "finding_ids"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "request_reopen", businessInput: rawArgs });
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }
  const target = rawArgs.target;
  if (target !== "detail" && target !== "architecture") {
    throw inputInvalid('target must be "detail" or "architecture"');
  }
  const reason = stringArgument(rawArgs, "reason");
  const findingIds: string[] = [];
  if (rawArgs.finding_ids !== undefined) {
    if (!Array.isArray(rawArgs.finding_ids)) throw inputInvalid("finding_ids must be an array of finding ids");
    for (const entry of rawArgs.finding_ids) {
      if (typeof entry !== "string" || entry === "") throw inputInvalid("finding_ids entries must be non-empty strings");
      findingIds.push(entry);
    }
  }
  const current = getPlanningRunRecord(ctx.store, envelope.runId);
  if (current === null) {
    throw domainError("RUN_NOT_FOUND", `the attached run '${envelope.runId}' no longer exists`);
  }
  const service = createSynthesisService(ctx.store, ctx.clock);
  const result = service.requestReopen({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    bindingGeneration: envelope.bindingGeneration,
    target,
    reason,
    findingIds,
    requestId: `reopen:${envelope.toolUseId}`,
    callerAgent: envelope.version === 2 ? (envelope.agent ?? null) : null,
  });
  return {
    status: "ok",
    target: result.stage,
    stage: result.stage,
    run_revision: result.runRevision,
    review_event: result.reviewEvent,
    sections_needing_review: result.reviewRequired,
  };
}

export function handleRequestFinalization(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  // §27 — ZERO business fields: the deterministic gate cannot be bypassed,
  // configured, or steered (no force/skip_evidence/ignore_conflicts/
  // allow_partial/assume_clean/head/run_id/candidate_id exist to reject).
  assertExactBusinessFields(rawArgs, []);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "request_finalization", businessInput: rawArgs });
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }
  {
    const stageRun = getPlanningRunRecord(ctx.store, envelope.runId);
    if (stageRun !== null) assertMainCapabilityForStage(stageRun.stage, "request_finalization");
  }
  const service = createFinalizationService(ctx.store, ctx.clock);
  const result = service.requestFinalization({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    bindingGeneration: envelope.bindingGeneration,
    // §72 — the operation identity derives from the SIGNED tool use.
    requestId: `finalize:${envelope.toolUseId}`,
    // §26 — from the signed envelope only; absent agent ⇒ main-session call.
    callerAgent: envelope.version === 2 ? (envelope.agent ?? null) : null,
  });
  return {
    status: "ok",
    idempotent: result.idempotent,
    candidate: {
      candidate_id: result.candidateId,
      candidate_seq: result.candidateSeq,
      candidate_hash: result.candidateHash,
    },
    evidence_audit: {
      audit_id: result.auditId,
      audit_hash: result.auditHash,
    },
    final_proposal: {
      proposal_id: result.proposalId,
      revision: result.proposalRevision,
      proposal_hash: result.proposalHash,
    },
    stage: result.stage,
    run_revision: result.runRevision,
    next: result.idempotent
      ? "the final Proposal is already frozen — present it and call approve_proposal after the user authorizes it"
      : "finalization passed — present the Final Plan Candidate (get_context detail=final) and call approve_proposal ONLY after the user authorizes that exact proposal",
  };
}

// ---------------------------------------------------------------------------
// Build read-side (Phase 14 §57–§67) — execution-authority projections
// ---------------------------------------------------------------------------

/** §58 — the compact completed-run view. Never exposes other session ids. */
function executionBuildState(ctx: PhasePlanToolContext, exec: ExecutionHostContextV1): Record<string, unknown> {
  return ctx.store.withRead((tx) => {
    // A1 §16 — the authority is PlanningRun-scoped: resolve the canonical
    // ExecutionRunID to its source planning provenance.
    const planningRunId = getExecutionRunInTx(tx, exec.executionRunId)?.runId ?? exec.executionRunId;
    const authority = createHandoffService(ctx.store, ctx.clock).requireBuildReadAuthorityInTx(tx, {
      sessionId: exec.sessionId,
      workspaceId: exec.workspaceId,
      runId: planningRunId,
      finalPlanId: exec.finalPlanId,
      generation: exec.executionBindingGeneration,
    });
    const handoff = JSON.parse(authority.handoff.canonicalJson) as ExecutionHandoffV1;
    // Phase 15 §19 — the open-issue projection over the delivered contract.
    const openIssues = listOpenExecutionIssuesInTx(tx, exec.executionRunId);
    // E2 — the durable supervision-ownership view of the active ExecutionRun:
    // state + generation + ownership relative to the signed session (the
    // legacy ExecutionBinding above remains session/read metadata only).
    const supervisorBinding = getSupervisorBindingInTx(tx, exec.executionRunId);
    return {
      authority: "execution",
      run: { id: authority.run.runId, lifecycle: authority.run.lifecycle, stage: authority.run.stage },
      finalPlan: {
        id: authority.finalPlanRow.finalPlanId,
        revision: authority.finalPlanRow.revision,
        hash: authority.finalPlanRow.finalPlanHash,
      },
      executionHandoff: {
        id: authority.handoff.handoffId,
        hash: authority.handoff.handoffHash,
        delivered: true,
      },
      executionBinding: { generation: authority.binding.generation, state: authority.binding.state },
      supervisor: (() => {
        if (supervisorBinding === null) {
          return { state: null, generation: null, ownership: "none" as const };
        }
        return {
          state: supervisorBinding.state,
          generation: supervisorBinding.generation,
          ownership:
            supervisorBinding.sessionId === exec.sessionId
              ? ("current-session" as const)
              : ("other-session" as const),
        };
      })(),
      repositoryBaseline: handoff.repositoryBaseline,
      executionIssues: {
        openCount: openIssues.length,
        replanRequired: openIssues.length > 0,
      },
    };
  });
}

/** §59/§61 — the deterministic Execution Contract projection; no epoch v5 exists
 * because FinalPlan and handoff are immutable — the handoff hash is the anchor. */
function executionBuildContext(ctx: PhasePlanToolContext, exec: ExecutionHostContextV1): Record<string, unknown> {
  const state = executionBuildState(ctx, exec);
  // A1 §16 — handoffs are planning-scoped: resolve the canonical
  // ExecutionRunID to its source planning provenance.
  const planningRunId = ctx.store.withRead((tx) => getExecutionRunInTx(tx, exec.executionRunId)?.runId) ?? exec.executionRunId;
  const handoff = ctx.store.withRead((tx) => {
    const row = getExecutionHandoffInTx(tx, planningRunId);
    return row === null ? null : (JSON.parse(row.canonicalJson) as ExecutionHandoffV1);
  });
  if (handoff === null) {
    throw domainError("EXECUTION_CONTEXT_NOT_AVAILABLE", "the execution handoff row is missing");
  }
  const canonical = state as Record<string, unknown>;
  // Phase 15 §19 — the compact open-issue list; full detail stays opt-in via
  // read tools, never a default injection.
  const compactIssues = ctx.store.withRead((tx) => listOpenExecutionIssuesInTx(tx, exec.executionRunId)).map((issue) => {
    const parsed = JSON.parse(issue.canonicalJson) as { kind: string };
    return {
      issue_id: issue.issueId,
      kind: parsed.kind,
      summary: issue.summary,
    };
  });
  return {
    ...canonical,
    handoff: {
      id: canonical.executionHandoff ? (canonical.executionHandoff as Record<string, unknown>).id : undefined,
      hash: canonical.executionHandoff ? (canonical.executionHandoff as Record<string, unknown>).hash : undefined,
      canonical: handoff,
    },
    openExecutionIssues: compactIssues,
    executionContract: renderExecutionContract(handoff, {
      handoffId: ((canonical.executionHandoff as Record<string, unknown>).id) as string,
      handoffHash: ((canonical.executionHandoff as Record<string, unknown>).hash) as string,
    }),
  };
}

/** §62–§66 — exact-ref reads limited to the approved FinalPlan closure. */
function executionReadMemory(
  ctx: PhasePlanToolContext,
  exec: ExecutionHostContextV1,
  ref: { kind: string; id: string; revision: number; detail: MemoryDetailLevel },
): Record<string, unknown> {
  // Authority check and content read are two separate read transactions:
  // the context read model owns its own store.withRead boundary.
  const runId = ctx.store.withRead((tx) => {
    const authority = createHandoffService(ctx.store, ctx.clock).requireBuildReadAuthorityInTx(tx, {
      sessionId: exec.sessionId,
      workspaceId: exec.workspaceId,
      runId: getExecutionRunInTx(tx, exec.executionRunId)?.runId ?? exec.executionRunId,
      finalPlanId: exec.finalPlanId,
      generation: exec.executionBindingGeneration,
    });
    const plan = parseFinalPlanCanonical(authority.finalPlanRow.canonicalJson, authority.run.runId);
    createHandoffService(ctx.store, ctx.clock).assertExecutionMemoryRefInTx(plan, {
      kind: ref.kind,
      id: ref.id,
      revision: ref.revision,
    });
    return authority.run.runId;
  });
  const view = createStoreContextSource(ctx.store).readRevision({
    runId,
    kind: ref.kind as MemoryRef["kind"],
    id: ref.id,
    revision: ref.revision,
  });
    if (view === null) {
      throw domainError(
        "EXECUTION_MEMORY_REF_NOT_AUTHORIZED",
        `no memory revision exists for ${ref.kind} '${ref.id}'@${ref.revision}`,
      );
    }
    const refView = { runId, kind: ref.kind, id: ref.id, revision: ref.revision };
    switch (ref.detail) {
      case "identity":
        return { status: "ok", authority: "execution", ref: refView };
      case "summary":
        return { status: "ok", authority: "execution", ref: refView, compactProjection: view.compactProjection };
      case "contract":
        // §66 — SectionContract access under the execution authority.
        if (ref.kind !== "section") {
          throw domainError("CAPABILITY_NOT_AVAILABLE", `detail="contract" is only available for section artifacts (requested ${ref.kind})`);
        }
        return { status: "ok", authority: "execution", ref: refView, contract: view.contractJson === null ? null : JSON.parse(view.contractJson) };
      default:
        return {
          status: "ok",
          authority: "execution",
          ref: refView,
          content: view.content,
          compactProjection: view.compactProjection,
          ...(view.contractJson === null ? {} : { contract: JSON.parse(view.contractJson) }),
        };
    }
}

// ---------------------------------------------------------------------------
// handoff (Phase 14 §32–§42/§92/§134) — the sole Plan → Build delivery tool
// ---------------------------------------------------------------------------

function handoffResponse(
  handoff: ExecutionHandoffV1,
  identity: { handoffId: string; handoffHash: string },
  finalPlan: { id: string; hash: string },
  idempotent: boolean,
  executionRun: { id: string; lifecycle: string } | null,
): Record<string, unknown> {
  return {
    status: "ok",
    ...(idempotent ? { idempotent: true } : {}),
    handoff_id: identity.handoffId,
    handoff_hash: identity.handoffHash,
    final_plan: { id: finalPlan.id, hash: finalPlan.hash },
    ...(executionRun === null ? {} : { execution_run: { id: executionRun.id, lifecycle: executionRun.lifecycle } }),
    repository_baseline: handoff.repositoryBaseline,
    execution_contract: renderExecutionContract(handoff, identity),
    // §92 — no session id, no binding generation, no plugin-data paths.
    next:
      "the host completes delivery via PostToolUse; after that this PlanningRun is completed, Plan Memory is read-only, "
      + "and Build reads go through get_state / get_context(detail=build) / read_memory under the execution authority",
  };
}

export function handleHandoff(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  // §32 — ZERO business fields; no force/bypass/skip/complete_run exists.
  assertExactBusinessFields(rawArgs, []);
  const token = requireHostContext(rawArgs);
  const signed = parseSignedHostContext(ctx.secret, token);
  if (signed.authority === "execution") {
    // §134 — the exact original delivered invocation replays idempotently.
    const exec = assertExecutionHostContextForTool(ctx.secret, token, { tool: "handoff", businessInput: rawArgs });
    return ctx.store.withRead((tx) => {
      const authority = createHandoffService(ctx.store, ctx.clock).requireBuildReadAuthorityInTx(tx, {
        sessionId: exec.sessionId,
        workspaceId: exec.workspaceId,
        runId: getExecutionRunInTx(tx, exec.executionRunId)?.runId ?? exec.executionRunId,
        finalPlanId: exec.finalPlanId,
        generation: exec.executionBindingGeneration,
      });
      const handoff = JSON.parse(authority.handoff.canonicalJson) as ExecutionHandoffV1;
      const executionRun = getExecutionRunInTx(tx, exec.executionRunId);
      return handoffResponse(
        handoff,
        { handoffId: authority.handoff.handoffId, handoffHash: authority.handoff.handoffHash },
        { id: authority.finalPlanRow.finalPlanId, hash: authority.finalPlanRow.finalPlanHash },
        true,
        executionRun === null ? null : { id: executionRun.executionRunId, lifecycle: executionRun.lifecycle },
      );
    });
  }
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "handoff", businessInput: rawArgs });
  // §33 — main session only; the validator (or any subagent) can never handoff.
  if (envelope.version === 2 && envelope.agent !== undefined) {
    throw domainError("VALIDATOR_MUTATION_FORBIDDEN", "handoff is a main-session capability; subagents cannot initiate the Plan → Build transition");
  }
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }
  const workspace = getWorkspaceById(ctx.store, envelope.workspaceId);
  if (workspace === null) {
    throw domainError("HOST_CONTEXT_WORKSPACE_MISMATCH", `host context workspace '${envelope.workspaceId}' is not in the catalog`);
  }
  // §134 — a new invocation against a delivered handoff names the exact code
  // (the planning binding is detached by then, so check before ownership).
  const delivered = ctx.store.withRead((tx) => {
    const state = getExecutionHandoffStateInTx(tx, envelope.runId as string);
    return state?.status === "delivered";
  });
  if (delivered) {
    throw domainError("HANDOFF_ALREADY_DELIVERED", "the execution handoff for this run was already delivered");
  }
  // §7 — writable planning ownership is re-verified from the Store.
  ctx.store.withWrite((tx) => {
    assertWritableBindingInTx(tx, {
      runId: envelope.runId as string,
      workspaceId: envelope.workspaceId,
      sessionId: envelope.sessionId,
      generation: envelope.bindingGeneration as number,
    });
    return null;
  });
  // §35 — reload authority, derive/reuse the canonical handoff, create/reuse
  // the ExecutionBinding, append DELIVERY_ATTEMPT — one transaction, and the
  // PlanningRun is NOT completed here (§36: PostToolUse is the boundary).
  const service = createHandoffService(ctx.store, ctx.clock);
  const result = service.prepareHandoffDelivery({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    workspaceRoot: workspace.canonicalRoot,
    sessionId: envelope.sessionId,
    toolUseId: envelope.toolUseId,
  });
  return handoffResponse(
    result.handoff,
    { handoffId: result.handoffId, handoffHash: result.handoffHash },
    { id: result.finalPlan.id, hash: result.finalPlan.hash },
    result.reused,
    { id: result.executionRun.executionRunId, lifecycle: result.executionRun.lifecycle },
  );
}

// ---------------------------------------------------------------------------
// report_execution_issue (Phase 15 §12–§15) — the 16th tool: Build's sole
// defect report against the delivered contract
// ---------------------------------------------------------------------------

export function handleReportExecutionIssue(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  // §12 — the model supplies ONLY kind/summary/detail/affected_refs. No
  // run_id/final_plan_id/handoff_id/workspace_id/session_id/generation/
  // repository revision/successor field exists to accept (§12 forbidden list).
  assertExactBusinessFields(rawArgs, ["kind", "summary", "detail", "affected_refs"]);
  const token = requireHostContext(rawArgs);
  // §13 — EXECUTION authority ONLY: a signed Planning HostContext fails the
  // domain-separated verification before any store access.
  const signed = parseSignedHostContext(ctx.secret, token);
  if (signed.authority !== "execution") {
    throw domainError(
      "HOST_CONTEXT_INVALID",
      "report_execution_issue requires the execution authority of a delivered handoff; planning authority is never accepted",
    );
  }
  const exec = assertExecutionHostContextForTool(ctx.secret, token, { tool: "report_execution_issue", businessInput: rawArgs });

  if (typeof rawArgs.kind !== "string" || !isExecutionIssueKind(rawArgs.kind)) {
    throw inputInvalid(`kind must be one of: ${EXECUTION_ISSUE_KINDS.join(", ")}`);
  }
  for (const field of ["summary", "detail"] as const) {
    if (typeof rawArgs[field] !== "string" || (rawArgs[field] as string).trim() === "") {
      throw inputInvalid(`${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(rawArgs.affected_refs) || rawArgs.affected_refs.length === 0) {
    throw inputInvalid("affected_refs must be a non-empty array of exact FinalPlan refs");
  }
  const affectedRefs: ExecutionIssueAffectedRef[] = (rawArgs.affected_refs as unknown[]).map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw inputInvalid("affected_refs entries must be {type, id, revision} objects");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.type !== "string" || !isExecutionIssueRefType(record.type)) {
      throw inputInvalid(`affected_refs type must be one of: ${EXECUTION_ISSUE_REF_TYPES.join(", ")}`);
    }
    if (typeof record.id !== "string" || record.id.trim() === "") {
      throw inputInvalid("affected_refs id must be a non-empty string");
    }
    if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 1) {
      throw inputInvalid("affected_refs revision must be a positive integer");
    }
    return { type: record.type as ExecutionIssueAffectedRef["type"], id: record.id, revision: record.revision };
  });

  const workspace = getWorkspaceById(ctx.store, exec.workspaceId);
  if (workspace === null) {
    throw domainError("HOST_CONTEXT_WORKSPACE_MISMATCH", `host context workspace '${exec.workspaceId}' is not in the catalog`);
  }
  const service = createExecutionIssueService(ctx.store, ctx.clock);
  const result = service.reportIssue({
    executionRunId: exec.executionRunId,
    workspaceId: exec.workspaceId,
    workspaceRoot: workspace.canonicalRoot,
    sessionId: exec.sessionId,
    toolUseId: exec.toolUseId,
    finalPlanId: exec.finalPlanId,
    executionBindingGeneration: exec.executionBindingGeneration,
    kind: rawArgs.kind as ExecutionIssueKind,
    summary: rawArgs.summary as string,
    detail: rawArgs.detail as string,
    affectedRefs,
  });
  return {
    status: "ok",
    idempotent: result.idempotent,
    issue: {
      issue_id: result.issueId,
      issue_hash: result.issueHash,
      kind: result.kind,
      summary: result.summary,
      affected_refs: result.affectedRefs,
      repository_context: result.repositoryContext,
    },
    executionIssues: { openCount: result.openIssues, replanRequired: result.replanRequired },
    // §20/§21/§88 — the semantic mutation boundary is explicit.
    next:
      "ExecutionIssue recorded; the approved FinalPlan is unchanged and repository mutation is now paused "
      + "(EXECUTION_REPLAN_REQUIRED). Tell the user that replanning is required; when they explicitly invoke "
      + "/phase-plan, a successor PlanningRun is created from the immutable baseline.",
  };
}

// ---------------------------------------------------------------------------
// takeover_run / abort_run (Phase 16 §8–§26/§27–§42) — the 17th/18th tools:
// explicit human-authorized control-plane operations (never design facts)
// ---------------------------------------------------------------------------

/** A1 §49 — the typed target hash for a planning_run control request. */
function planningControlRequestHashOf(
  operation: "takeover" | "abort",
  args: { planningRunId: string; workspaceId: string; expectedBindingGeneration: number },
): string {
  return runControlRequestHash({
    operation,
    targetKind: "planning_run",
    planningRunId: args.planningRunId,
    workspaceId: args.workspaceId,
    expectedBindingGeneration: args.expectedBindingGeneration,
  });
}

/**
 * A1 §37/§38 — model-facing execution identity normalization. The canonical
 * field is execution_run_id; the legacy run_id is accepted only while it
 * resolves to exactly one execution world (0 → EXECUTION_RUN_NOT_FOUND,
 * >1 → EXECUTION_RUN_AMBIGUOUS — never "newest"). Both supplied → they must
 * resolve to the same exact run. Returns null when the legacy id names a run
 * with no execution world (the caller decides whether that is legal).
 */
export function resolveExecutionRunIdentity(
  ctx: PhasePlanToolContext,
  rawArgs: Record<string, unknown>,
  options: { requireExisting: boolean },
): { executionRunId?: string; legacyRunId: string } {
  const canonical = typeof rawArgs.execution_run_id === "string" && rawArgs.execution_run_id.trim() !== ""
    ? rawArgs.execution_run_id.trim()
    : undefined;
  const legacy = typeof rawArgs.run_id === "string" && rawArgs.run_id.trim() !== "" ? rawArgs.run_id.trim() : undefined;
  if (canonical === undefined && legacy === undefined) {
    throw inputInvalid("execution_run_id (or legacy run_id) must be a non-empty string");
  }
  if (canonical !== undefined && legacy !== undefined) {
    const exact = ctx.store.withRead((tx) => getExecutionRunInTx(tx, canonical));
    if (exact === null || exact.runId !== legacy) {
      throw domainError(
        "EXECUTION_RUN_AMBIGUOUS",
        "execution_run_id and run_id resolve to different execution worlds (A1 §38)",
      );
    }
    return { executionRunId: canonical, legacyRunId: legacy };
  }
  if (canonical !== undefined) {
    if (options.requireExisting) {
      const exact = ctx.store.withRead((tx) => getExecutionRunInTx(tx, canonical));
      if (exact === null) {
        throw domainError("EXECUTION_RUN_NOT_FOUND", `no ExecutionRun exists for '${canonical}'`);
      }
    }
    return { executionRunId: canonical, legacyRunId: canonical };
  }
  if (legacy === undefined) {
    throw inputInvalid("run_id must be a non-empty string");
  }
  const worlds = ctx.store.withRead((tx) => listExecutionRunsBySourcePlanningRunInTx(tx, legacy));
  if (worlds.length === 0) {
    if (options.requireExisting) {
      throw domainError("EXECUTION_RUN_NOT_FOUND", `no ExecutionRun exists for legacy run_id '${legacy}'`);
    }
    return { legacyRunId: legacy };
  }
  if (worlds.length > 1) {
    throw domainError(
      "EXECUTION_RUN_AMBIGUOUS",
      `legacy run_id '${legacy}' resolves to ${worlds.length} execution worlds; pass the exact execution_run_id (A1 §37)`,
    );
  }
  return { executionRunId: worlds[0]!.executionRunId, legacyRunId: legacy };
}

/** Main-session attestation check shared by both control tools (§46/§47). */
function assertMainSessionControl(envelope: { version: number; agent?: unknown }, tool: string): void {
  if (envelope.version === 2 && envelope.agent !== undefined) {
    throw domainError(
      "VALIDATOR_MUTATION_FORBIDDEN",
      `${tool} is a main-session capability; subagents (including the validator) can never take over or abort a PlanningRun`,
    );
  }
}

export function handleTakeoverRun(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  // §12/A1 §37 — the model supplies the execution identity (canonical
  // execution_run_id, or the legacy run_id while it resolves to exactly one
  // execution world) + expected_binding_generation. No
  // workspace/session/force/owner_is_dead/new_generation field exists.
  assertExactBusinessFields(rawArgs, ["run_id", "execution_run_id", "expected_binding_generation"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "takeover_run", businessInput: rawArgs });
  assertMainSessionControl(envelope, "takeover_run");

  // A1 §38 — one identity path only; the legacy id MAY stay a pure planning
  // run (pre-handoff takeover), so requireExisting is false here.
  const identity = resolveExecutionRunIdentity(ctx, rawArgs, { requireExisting: false });
  if (identity.executionRunId === undefined && typeof identity.legacyRunId !== "string") {
    throw inputInvalid("run_id must be a non-empty string");
  }
  if (
    typeof rawArgs.expected_binding_generation !== "number"
    || !Number.isInteger(rawArgs.expected_binding_generation)
    || rawArgs.expected_binding_generation < 1
  ) {
    throw inputInvalid("expected_binding_generation must be a positive integer");
  }

  const workspace = getWorkspaceById(ctx.store, envelope.workspaceId);
  if (workspace === null) {
    throw domainError("HOST_CONTEXT_WORKSPACE_MISMATCH", `host context workspace '${envelope.workspaceId}' is not in the catalog`);
  }

  const service = createRunControlService(ctx.store, ctx.clock);
  const result = service.takeoverRun({
    runId: identity.legacyRunId,
    ...(identity.executionRunId === undefined ? {} : { executionRunId: identity.executionRunId }),
    workspaceId: envelope.workspaceId,
    callerSessionId: envelope.sessionId,
    expectedBindingGeneration: rawArgs.expected_binding_generation,
    authorization: {
      authorizationRequestId: `mcp-control:${envelope.toolUseId}`,
      operationId: `takeover:${envelope.toolUseId}`,
      requestHash:
        identity.executionRunId === undefined
          ? planningControlRequestHashOf("takeover", {
              planningRunId: identity.legacyRunId,
              workspaceId: envelope.workspaceId,
              expectedBindingGeneration: rawArgs.expected_binding_generation,
            })
          : runControlRequestHash({
              operation: "takeover",
              targetKind: "execution_run",
              executionRunId: identity.executionRunId,
              workspaceId: envelope.workspaceId,
              expectedBindingGeneration: rawArgs.expected_binding_generation,
            }),
    },
  });
  // A1-I closure §6/§8 — a migrated legacy_pre_a1 replay converges on the
  // durable historical outcome, read-only. Session identities stay in the
  // durable record and are never returned to the model (§4/§13).
  if ("legacyHistorical" in result) {
    const snapshot = result.legacyHistorical.planningSnapshot;
    return {
      status: "historical_outcome",
      idempotent: true,
      control_id: result.control.controlId,
      target_kind: "legacy_pre_a1",
      historical: {
        operation: result.control.operation,
        resulting_binding_generation: result.legacyHistorical.resultingBindingGeneration,
        resulting_run_revision: result.legacyHistorical.resultingRunRevision,
        planning_snapshot_available: snapshot !== null,
      },
      ...(snapshot === null ? {} : { run: runView(snapshot.run), binding: bindingView(snapshot.binding) }),
      next:
        "This authorization is migrated pre-A1 history: the exact retry converged on the already-committed durable outcome. "
        + "No new authority, generation, authorization, or lifecycle object was created.",
    };
  }
  // §4/§13 — session identities stay in the durable record, never in the
  // model-visible response. E2: an execution-supervision takeover reports the
  // new supervision generation instead of planning-binding language.
  if (result.supervisor !== undefined && result.supervisor !== null) {
    return {
      status: "taken_over",
      idempotent: result.idempotent,
      control_id: result.control.controlId,
      run: runView(result.run),
      binding: bindingView(result.binding),
      supervisor: {
        execution_run_id: result.supervisor.executionRunId,
        generation: result.supervisor.generation,
        state: result.supervisor.state,
        // E12 §37/§38 — the launch credentials this takeover invalidated.
        revoked_launch_credentials: result.supervisor.revokedLaunchCredentials,
      },
      next:
        "Execution supervision ownership transferred (supervision generation advanced by exactly one; for an unbound run the initial generation 1 was established); the previous owner is fenced immediately. "
        + "Continue supervising this active ExecutionRun under its immutable FinalPlan; planning history is completed and unchanged."
        + (result.supervisor.revokedLaunchCredentials.length > 0
          ? ` Prepared launch credential(s) for attempt(s) [${result.supervisor.revokedLaunchCredentials.join(", ")}] were invalidated; re-credential the SAME attempt with retry_unclaimed_worker_launch if a worker still needs to start.`
          : ""),
    };
  }
  return {
    status: "taken_over",
    idempotent: result.idempotent,
    control_id: result.control.controlId,
    run: runView(result.run),
    binding: bindingView(result.binding),
    next:
      "Ownership transferred (binding generation advanced by exactly one); the previous owner is fenced immediately. "
      + "Continue planning this exact run: the stage, HEAD, awaiting proposal, and active section carried over unchanged.",
  };
}

export function handleAbortRun(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  // §27 — zero-to-one business fields: at most an audit-only reason.
  assertExactBusinessFields(rawArgs, ["reason"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "abort_run", businessInput: rawArgs });
  assertMainSessionControl(envelope, "abort_run");

  if (rawArgs.reason !== undefined && (typeof rawArgs.reason !== "string" || rawArgs.reason.trim() === "")) {
    throw inputInvalid("reason must be a non-empty string when present");
  }

  const workspace = getWorkspaceById(ctx.store, envelope.workspaceId);
  if (workspace === null) {
    throw domainError("HOST_CONTEXT_WORKSPACE_MISMATCH", `host context workspace '${envelope.workspaceId}' is not in the catalog`);
  }

  const service = createRunControlService(ctx.store, ctx.clock);
  const result = service.abortRun({
    workspaceId: envelope.workspaceId,
    callerSessionId: envelope.sessionId,
    bindingGeneration: envelope.bindingGeneration as number,
    reason: typeof rawArgs.reason === "string" ? rawArgs.reason : undefined,
    authorization: {
      authorizationRequestId: `mcp-control:${envelope.toolUseId}`,
      operationId: `abort:${envelope.toolUseId}`,
      requestHash: planningControlRequestHashOf("abort", {
        planningRunId: envelope.runId as string,
        workspaceId: envelope.workspaceId,
        expectedBindingGeneration: envelope.bindingGeneration as number,
      }),
    },
  });
  // A1-I closure §6/§8 — a migrated legacy_pre_a1 replay converges on the
  // durable historical outcome, read-only (session identities never ride the
  // model-visible response, §4/§13).
  if ("legacyHistorical" in result) {
    const snapshot = result.legacyHistorical.planningSnapshot;
    return {
      status: "historical_outcome",
      idempotent: true,
      control_id: result.control.controlId,
      target_kind: "legacy_pre_a1",
      historical: {
        operation: result.control.operation,
        resulting_binding_generation: result.legacyHistorical.resultingBindingGeneration,
        resulting_run_revision: result.legacyHistorical.resultingRunRevision,
        planning_snapshot_available: snapshot !== null,
      },
      ...(snapshot === null ? {} : { run: runView(snapshot.run), binding: bindingView(snapshot.binding) }),
      next:
        "This authorization is migrated pre-A1 history: the exact retry converged on the already-committed durable outcome. "
        + "No new authority, generation, authorization, or lifecycle object was created. "
        + "No Plan Mode exit is requested: the historical operation is already durable and nothing was re-executed.",
    };
  }
  // Amendment A2 §27 — the response commits the Abort and reports the mode
  // exit as REQUESTED only; whether the host applied it is observed later by
  // the abort PostToolUse hook and is never claimed here.
  return {
    status: "aborted",
    idempotent: result.idempotent,
    control_id: result.control.controlId,
    run: runView(result.run),
    binding: bindingView(result.binding),
    mode_exit: "requested",
    next:
      "The PlanningRun is terminal (aborted); the abort is committed and a session-scoped Plan Mode exit was requested. "
      + "If Claude Code is still in Plan Mode, use its normal permission-mode control to return to default/manual — "
      + "this is host-mode normalization only. All planning history is preserved and no Build authority exists. "
      + "A later /phase-plan starts a NEW ordinary PlanningRun — the aborted run is never resumed or reused.",
  };
}

/**
 * phase_plan.reexecute_final_plan (A1-II §9–§17) — the human-authorized
 * same-FinalPlan reexecution. Control-plane exception like abort_execution_run:
 * NO supervisor binding or generation is required (a detached session may
 * request it after an abort/completion); the mandatory host user-confirmation
 * dialog (PreToolUse ask + the requiresUserInteraction meta) is the
 * authorization. The authorization target is the exact FinalPlanRef + the
 * signed workspace — the resulting ExecutionRun does not exist yet and is
 * never a model-chosen fact (§12). Zero-to-one business fields: the exact
 * FinalPlan identity + optional audit reason.
 */
export function handleReexecuteFinalPlan(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["source_planning_run_id", "final_plan_id", "final_plan_revision", "final_plan_hash", "reason"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "reexecute_final_plan", businessInput: rawArgs });
  assertMainSessionControl(envelope, "reexecute_final_plan");

  for (const field of ["source_planning_run_id", "final_plan_id", "final_plan_hash"] as const) {
    const value = rawArgs[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw inputInvalid(`${field} must be a non-empty string`);
    }
  }
  if (
    typeof rawArgs.final_plan_revision !== "number"
    || !Number.isInteger(rawArgs.final_plan_revision)
    || rawArgs.final_plan_revision < 1
  ) {
    throw inputInvalid("final_plan_revision must be a positive integer");
  }
  if (rawArgs.reason !== undefined && (typeof rawArgs.reason !== "string" || rawArgs.reason.trim() === "")) {
    throw inputInvalid("reason must be a non-empty string when present");
  }

  const workspace = getWorkspaceById(ctx.store, envelope.workspaceId);
  if (workspace === null) {
    throw domainError("HOST_CONTEXT_WORKSPACE_MISMATCH", `host context workspace '${envelope.workspaceId}' is not in the catalog`);
  }

  const finalPlanExecution = {
    sourcePlanningRunId: rawArgs.source_planning_run_id as string,
    finalPlanId: rawArgs.final_plan_id as string,
    finalPlanRevision: rawArgs.final_plan_revision as number,
    finalPlanHash: rawArgs.final_plan_hash as string,
  };
  const service = createReexecutionService(ctx.store, ctx.clock);
  const result = service.reexecuteFinalPlan({
    ...finalPlanExecution,
    workspaceId: envelope.workspaceId,
    requesterSessionId: envelope.sessionId,
    toolUseId: envelope.toolUseId,
    ...(typeof rawArgs.reason === "string" ? { reason: rawArgs.reason } : {}),
    authorization: {
      authorizationRequestId: `mcp-control:${envelope.toolUseId}`,
      operationId: `reexecute_final_plan:${envelope.toolUseId}`,
      // §15 — the hash pins operation + exact FinalPlanRef + workspace; the
      // resulting ExecutionRunID is never hashed (it does not exist yet).
      requestHash: runControlRequestHash({
        operation: "reexecute_final_plan",
        targetKind: "final_plan_execution",
        finalPlanExecution,
        workspaceId: envelope.workspaceId,
        expectedBindingGeneration: 1,
      }),
    },
  });

  // §31/§32 — the control flow then acquires E2 supervision canonically:
  // activation (prepared → active + generation-1 SupervisorBinding + genesis
  // structure) rides its OWN transaction, so a crash between the two commits
  // leaves the durable prepared boundary recoverable (§32/§34) and the SAME
  // authorized retry converges on E2 and completes activation (§16 — a retry
  // never creates a second run). A converged non-prepared E2 is reported
  // read-only; it is never re-activated or re-created.
  let activation: Record<string, unknown> | null = null;
  if (result.lifecycle === "prepared") {
    try {
      const activated = service.activateReexecutionRun({
        executionRunId: result.executionRunId,
        workspaceId: envelope.workspaceId,
        sessionId: envelope.sessionId,
      });
      activation = {
        status: activated.status,
        supervisor_generation: activated.supervisor.generation,
      };
    } catch (err) {
      activation = {
        status: "prepared",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const executionRun = ctx.store.withRead((tx) => getExecutionRunInTx(tx, result.executionRunId));

  return {
    status: result.status === "created" ? "reexecution_created" : "reexecution_converged",
    idempotent: result.idempotent,
    control_id: result.control.controlId,
    target_kind: "final_plan_execution",
    execution_run: {
      execution_run_id: result.executionRunId,
      run_id: result.sourcePlanningRun.runId,
      lifecycle: executionRun?.lifecycle ?? result.lifecycle,
      workspace_id: result.workspaceId,
      final_plan: result.finalPlan,
    },
    ...(activation === null ? {} : { activation }),
    next:
      result.status === "created"
        ? activation !== null && activation.status !== "prepared"
          ? "A NEW ExecutionRun was authorized and created for the exact FinalPlan; it is active under this session's supervision with a fresh identity, fresh baselines, and no inherited history. Drive execution through the canonical supervisor surface (issue_execution_directive …). The source PlanningRun stays completed and prior runs stay untouched."
          : "A NEW ExecutionRun was authorized and created for the exact FinalPlan in the durable prepared state (the recoverable creation boundary). Retry this exact authorized request to complete activation, or use the recovery surface: the same run is found — never a second one."
        : "The exact authorized retry converged on the SAME ExecutionRun: no second authorization, no second run, no replayed creation. The run's current lifecycle is reported as-is and was never mutated by this retry.",
  };
}


/**
 * phase_plan.abort_execution_run (E13 §5/§6) — the human-authorized
 * ExecutionRun abort. Control-plane exception: NO supervisor binding or
 * generation is required (a detached/fenced/recovery session may request it);
 * the mandatory host user-confirmation dialog (PreToolUse ask + the
 * requiresUserInteraction meta) is the authorization, exactly like
 * takeover_run. Zero-to-one business fields: the exact run_id + required
 * non-empty reason (durable provenance, §5/§9).
 */
export function handleAbortExecutionRun(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["run_id", "execution_run_id", "reason"]);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "abort_execution_run", businessInput: rawArgs });
  assertMainSessionControl(envelope, "abort_execution_run");

  // A1 §37 — the abort targets the EXACT ExecutionRunID; the legacy run_id is
  // accepted only while it resolves to exactly one execution world.
  const identity = resolveExecutionRunIdentity(ctx, rawArgs, { requireExisting: true });
  if (typeof rawArgs.reason !== "string" || rawArgs.reason.trim() === "") {
    throw inputInvalid("reason must be a non-empty string (E13 §5 — the durable abort provenance)");
  }

  const workspace = getWorkspaceById(ctx.store, envelope.workspaceId);
  if (workspace === null) {
    throw domainError("HOST_CONTEXT_WORKSPACE_MISMATCH", `host context workspace '${envelope.workspaceId}' is not in the catalog`);
  }

  const service = createExecutionAbortService(ctx.store, ctx.clock);
  const result = service.abortExecutionRun({
    executionRunId: identity.executionRunId!,
    workspaceId: envelope.workspaceId,
    requesterSessionId: envelope.sessionId,
    reason: rawArgs.reason,
    authorization: {
      authorizationRequestId: `mcp-control:${envelope.toolUseId}`,
      operationId: `abort-execution:${envelope.toolUseId}`,
      requestHash: runControlRequestHash({
        operation: "abort",
        targetKind: "execution_run",
        executionRunId: identity.executionRunId!,
        workspaceId: envelope.workspaceId,
        expectedBindingGeneration: 1,
      }),
    },
  });
  // E13 §53 — the response reports the terminal state; the workspace may
  // still contain unaccepted changes and NO rollback was performed.
  return {
    status: "aborted",
    idempotent: result.idempotent,
    control_id: result.controlId,
    execution_run: {
      execution_run_id: result.executionRun.executionRunId,
      run_id: result.executionRun.runId,
      lifecycle: result.executionRun.lifecycle,
    },
    closed_window_id: result.closedWindowId,
    revoked_launch_credentials: result.revokedLaunchCredentials,
    next:
      "The ExecutionRun is terminal (aborted): the execution protocol stopped permanently and every execution mutation "
      + "authority is gone. No rollback was performed — the workspace may contain unaccepted changes beyond the accepted "
      + "head, and any later cleanup is a separate explicit decision. Historical state (acceptedHead, Stages, Attempts, "
      + "Reports, Commits, Issues) remains readable; this run can never resume, complete, or replan. The same FinalPlan may "
      + "later start a NEW, separately authorized ExecutionRun.",
  };
}


// ---------------------------------------------------------------------------
// E5 — ExecutionWorker runtime + supervisor execution operations
// (architecture spec; E5 §16/§17/§33/§39/§42)
// ---------------------------------------------------------------------------

function requireWorkerAuthorityContext(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>, tool: string) {
  const token = requireHostContext(rawArgs);
  return assertWorkerHostContextForTool(ctx.secret, token, { tool, businessInput: rawArgs });
}

/**
 * phase_plan.worker_claim (E5 §10) — the fresh ExecutionWorker claims its
 * exact Attempt with the one-time launch token. The worker session identity
 * comes from the signed worker host context (the host's subagent identity),
 * never from a model argument; the token is consumed atomically.
 */
export function handleWorkerClaim(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["attempt_id", "launch_token"]);
  const worker = requireWorkerAuthorityContext(ctx, rawArgs, "worker_claim");
  if (typeof rawArgs.attempt_id !== "string" || rawArgs.attempt_id.trim() === "") {
    throw inputInvalid("attempt_id must be a non-empty string");
  }
  if (typeof rawArgs.launch_token !== "string" || rawArgs.launch_token.trim() === "") {
    throw inputInvalid("launch_token must be a non-empty string");
  }
  const facts = ctx.store.withWrite((tx) =>
    claimWorkerAttemptInTx(
      tx,
      {
        attemptId: rawArgs.attempt_id as string,
        launchToken: rawArgs.launch_token as string,
        workerSessionId: worker.sessionId,
        workerAgentId: worker.agent.agentId,
        workspaceId: worker.workspaceId,
      },
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: "claimed",
    attempt_id: facts.invocation.attemptId,
    worker_role: facts.attempt.workerRole,
    execution_run_id: facts.invocation.executionRunId,
    directive: { id: facts.directive.directiveId, revision: facts.directive.revision, hash: facts.directive.hash },
    next: "Call phase_plan.worker_get_assignment — canonical authority lives in the Store, never in the launch prompt.",
  };
}

/**
 * phase_plan.worker_get_assignment (E5 §12/§13/§14) — the claimed worker's
 * exact context package: the bound Directive (exact revision/hash), ONLY the
 * Directive's resolved approved planRefs, run/stage/window identity, and the
 * accepted base. No plan-memory closure, no supervisor reasoning, no previous
 * Executor context for verifiers.
 */
export function handleWorkerGetAssignment(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const worker = requireWorkerAuthorityContext(ctx, rawArgs, "worker_get_assignment");
  const assignment = loadWorkerAssignment(ctx.store, {
    workerSessionId: worker.sessionId,
    workspaceId: worker.workspaceId,
  });
  return {
    status: "ok",
    worker_role: assignment.workerRole,
    attempt: assignment.attempt,
    directive: assignment.directive,
    plan_context: assignment.planContext,
    execution: assignment.execution,
    next: "Treat the Directive structured fields + body as exact current authority; submit exactly one phase_plan.worker_submit_report before normal exit.",
  };
}

/**
 * phase_plan.worker_submit_report (E5 §17/§35/§39) — worker-only report
 * submission. Every binding (attempt/directive/role) is DERIVED from the
 * claimed invocation; the model supplies only the factual payload. Durable
 * before success: report + attempt transition + candidate advance + invocation
 * finish commit in ONE transaction before this tool returns.
 */
export function handleWorkerSubmitReport(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, [
    "result",
    "candidate_mutated",
    "actions_performed",
    "files_examined",
    "files_changed",
    "commands_run",
    "tests_run",
    "findings",
    "deviations",
    "blockers",
    "deliverables",
  ]);
  const worker = requireWorkerAuthorityContext(ctx, rawArgs, "worker_submit_report");
  if (typeof rawArgs.result !== "string") throw inputInvalid("result must be a string (completed|partial|blocked|failed)");
  if (typeof rawArgs.candidate_mutated !== "boolean") throw inputInvalid("candidate_mutated must be an explicit boolean");
  const result = ctx.store.withWrite((tx) =>
    submitWorkerReportAndFinishInTx(tx, {
      workerSessionId: worker.sessionId,
      workspaceId: worker.workspaceId,
      clock: ctx.clock,
      now: ctx.clock.nowIso(),
      result: rawArgs.result as ExecutionReportResult,
      candidateMutated: rawArgs.candidate_mutated as boolean,
      actionPerformed: rawArgs.actions_performed as SubmitExecutionReportInput["actionPerformed"],
      filesExamined: rawArgs.files_examined as string[] | undefined,
      filesChanged: rawArgs.files_changed as string[] | undefined,
      commandsRun: rawArgs.commands_run as SubmitExecutionReportInput["commandsRun"],
      testsRun: rawArgs.tests_run as SubmitExecutionReportInput["testsRun"],
      findings: rawArgs.findings as SubmitExecutionReportInput["findings"],
      deviations: rawArgs.deviations as SubmitExecutionReportInput["deviations"],
      blockers: rawArgs.blockers as SubmitExecutionReportInput["blockers"],
      deliverables: rawArgs.deliverables as SubmitExecutionReportInput["deliverables"],
    }),
  );
  // §18 — compact completion acknowledgement only: the authoritative facts
  // are the persisted ExecutionReport, never the worker's final prose.
  return {
    status: "reported",
    attempt_id: result.attempt.attemptId,
    report_id: result.report.reportId,
    result: result.report.result,
    candidate_mutated: result.report.candidateMutated,
    candidate_revision: result.window.candidateRevision,
    invocation: result.invocation.state,
    next: "Return a compact acknowledgement to the parent; the ExecutionReport is the authority.",
  };
}

/**
 * phase_plan.get_execution_acceptance_context (E6 §8/§54) — the fenced
 * supervisor's canonical acceptance context. Everything is Store-derived; the
 * tool adds no repository output and no hidden reasoning. After a commit the
 * context reports the post-commit acceptance boundary instead of a candidate.
 */
export function handleGetExecutionAcceptanceContext(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "get_execution_acceptance_context");
  const context = ctx.store.withRead((tx) => loadExecutionAcceptanceContextInTx(tx, envelope.executionRunId));
  return {
    status: "ok",
    execution_run: context.executionRun,
    accepted_head: context.acceptedHead,
    accepted_base: context.acceptedHead === null ? "execution_start" : `execution_commit/${context.acceptedHead.commitId}`,
    active_stage: context.activeStage,
    open_window: context.openWindow,
    boundary: context.boundary,
    stage_completion: context.stageCompletion,
    candidate: context.candidate,
    next:
      context.candidate === null
        ? "No current candidate available for acceptance (post-commit acceptance boundary or no open window)."
        : "Classify every current-candidate report and submit exactly one phase_plan.submit_supervisor_assessment.",
  };
}

/**
 * phase_plan.submit_supervisor_assessment (E6 §19/§20/§21) — the Supervisor
 * expresses semantic judgment only; run/stage/window/head are derived from
 * current authoritative state. Accept runs the Core gate in ONE transaction:
 * any failure rolls back the assessment together with the commit, the window
 * close, and the head advance.
 */
export function handleSubmitSupervisorAssessment(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, [
    "disposition",
    "rationale",
    "report_judgments",
    "covered_obligations",
    "plan_refs",
    "expected_candidate_revision",
  ]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "submit_supervisor_assessment");
  if (
    typeof rawArgs.disposition !== "string"
    || !(SUPERVISOR_ASSESSMENT_DISPOSITIONS as readonly string[]).includes(rawArgs.disposition)
  ) {
    throw inputInvalid(`disposition must be one of: ${SUPERVISOR_ASSESSMENT_DISPOSITIONS.join(", ")}`);
  }
  if (typeof rawArgs.rationale !== "string" || rawArgs.rationale.trim() === "") {
    throw inputInvalid("rationale must be a non-empty string (E6 §45)");
  }
  if (typeof rawArgs.expected_candidate_revision !== "number" || !Number.isInteger(rawArgs.expected_candidate_revision)) {
    throw inputInvalid("expected_candidate_revision must be an integer");
  }
  if (rawArgs.report_judgments !== undefined && !Array.isArray(rawArgs.report_judgments)) {
    throw inputInvalid("report_judgments must be an array");
  }
  if (rawArgs.covered_obligations !== undefined && !Array.isArray(rawArgs.covered_obligations)) {
    throw inputInvalid("covered_obligations must be an array");
  }
  if (rawArgs.plan_refs !== undefined && !Array.isArray(rawArgs.plan_refs)) {
    throw inputInvalid("plan_refs must be an array");
  }
  const result = ctx.store.withWrite((tx) =>
    submitSupervisorAssessmentInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        disposition: rawArgs.disposition as SupervisorAssessmentDisposition,
        rationale: rawArgs.rationale as string,
        reportJudgments: ((rawArgs.report_judgments as Array<Record<string, unknown>> | undefined) ?? []).map((judgment) => ({
          ...judgment,
          ...(judgment.reportId === undefined && judgment.report_id !== undefined ? { reportId: judgment.report_id } : {}),
          ...(judgment.supersededByReportId === undefined && judgment.superseded_by_report_id !== undefined
            ? { supersededByReportId: judgment.superseded_by_report_id }
            : {}),
        })),
        coveredObligations: ((rawArgs.covered_obligations as Array<Record<string, unknown>> | undefined) ?? []).map((obligation) => ({
          ...obligation,
          ...(obligation.directiveId === undefined && obligation.directive_id !== undefined
            ? { directiveId: obligation.directive_id }
            : {}),
          ...(obligation.directiveRevision === undefined && obligation.directive_revision !== undefined
            ? { directiveRevision: obligation.directive_revision }
            : {}),
          ...(obligation.stageId === undefined && obligation.stage_id !== undefined
            ? { stageId: obligation.stage_id }
            : {}),
          ...(obligation.objectiveHash === undefined && obligation.objective_hash !== undefined
            ? { objectiveHash: obligation.objective_hash }
            : {}),
          // E10 §22 — execution_run_completion identity fields (snake boundary).
          ...(obligation.executionRunId === undefined && obligation.execution_run_id !== undefined
            ? { executionRunId: obligation.execution_run_id }
            : {}),
          ...(obligation.finalPlanHash === undefined && obligation.final_plan_hash !== undefined
            ? { finalPlanHash: obligation.final_plan_hash }
            : {}),
          ...(obligation.baseAcceptedHeadCommitId === undefined && obligation.base_accepted_head_commit_id !== undefined
            ? { baseAcceptedHeadCommitId: obligation.base_accepted_head_commit_id }
            : {}),
          ...(obligation.completedStageSetHash === undefined && obligation.completed_stage_set_hash !== undefined
            ? { completedStageSetHash: obligation.completed_stage_set_hash }
            : {}),
        })),
        ...(rawArgs.plan_refs === undefined ? {} : { planRefs: rawArgs.plan_refs as DirectivePlanRef[] }),
        expectedCandidateRevision: rawArgs.expected_candidate_revision as number,
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  if (result.commit === null) {
    // E6 §20 — a non-accept disposition persists the judgment only.
    return {
      status: "recorded",
      assessment_id: result.assessment.assessmentId,
      disposition: result.assessment.disposition,
      candidate_revision: result.assessment.candidateRevision,
      window_id: result.assessment.windowId,
      next: "The assessment is durable history. Accepted state is unchanged; direct the next Directive or report an execution issue.",
    };
  }
  return {
    status: "accepted",
    assessment_id: result.assessment.assessmentId,
    commit: {
      id: result.commit.commitId,
      sequence: result.commit.sequence,
      parent_commit_id: result.commit.parentCommitId,
      scope_kind: result.commit.scopeKind,
      window_id: result.commit.windowId,
      candidate_revision: result.commit.candidateRevision,
      directive_ref_count: result.commit.directiveRefs.length,
      report_ref_count: result.commit.reportRefs.length,
    },
    accepted_head: result.acceptedHeadCommitId,
    window_closed: true,
    stage_completed: result.stageCompleted,
    run_completed: result.runCompleted,
    next: result.runCompleted
      ? `EXECUTION RUN COMPLETE (E10 §37/§42): the ExecutionCompletionGate transitioned the run to completed inside this transaction. Final ExecutionCommit ${result.commit.commitId} is the acceptedHead and the completion provenance; your supervisor binding is detached. The run can never resume.`
      : result.stageCompleted
        ? "ExecutionCommit created and the Stage is COMPLETED (E7 §11): no open window remains. Read phase_plan.get_execution_progression_context and explicitly activate an eligible pending Stage when ready."
        : "ExecutionCommit created: the acceptedHead advanced. No successor window is opened automatically (E6 §33); continue this Stage explicitly with phase_plan.continue_execution_stage or progress via phase_plan.get_execution_progression_context.",
  };
}

/**
 * phase_plan.get_execution_progression_context (E7 §18/§19) — the fenced
 * supervisor's canonical progression projection: canonical Store facts, the
 * dependency-derived eligible/ineligible Stage classification, and the exact
 * progression boundary. Core never chooses the next Stage (E7 §17).
 */
export function handleGetExecutionProgressionContext(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "get_execution_progression_context");
  const context = ctx.store.withRead((tx) => loadExecutionProgressionContextInTx(tx, envelope.executionRunId));
  return {
    status: "ok",
    execution_run: context.executionRun,
    accepted_head: context.acceptedHead,
    active_stage: context.activeStage,
    open_window: context.openWindow,
    last_execution_commit: context.lastExecutionCommit,
    pending_stages: context.pendingStages,
    completed_stages: context.completedStages,
    eligible_stages: context.eligibleStages,
    ineligible_stages: context.ineligibleStages,
    default_suggested_stage: context.defaultSuggestedStageId,
    progression_boundary: context.progressionBoundary,
    next:
      context.progressionBoundary === "active_candidate"
        ? "Normal execution is in progress under the open window."
        : context.progressionBoundary === "post_commit_same_stage"
          ? "Post-commit same-stage boundary: continue this Stage explicitly with phase_plan.continue_execution_stage."
          : context.progressionBoundary === "between_stages"
            ? "Between stages: select an eligible pending Stage and activate it with phase_plan.activate_execution_stage."
            : "All Stages are completed: at the all_stages_completed boundary. When you decide to close the run, read phase_plan.get_execution_final_closure_context and explicitly begin final execution closure (phase_plan.begin_execution_final_closure) — it is never auto-started (E10 §10).",
  };
}

/**
 * phase_plan.continue_execution_stage (E7 §20/§21) — the explicit Supervisor
 * decision to keep implementing the active Stage: opens the successor window
 * (candidateRevision 0, base = exact acceptedHead). Orchestration only — the
 * acceptedHead never moves here (E7 §39).
 */
export function handleContinueExecutionStage(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "continue_execution_stage");
  const result = ctx.store.withWrite((tx) =>
    continueExecutionStageInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: "continued",
    stage: { id: result.stage.id, ordinal: result.stage.ordinal },
    window: {
      id: result.window.id,
      candidate_revision: result.window.candidateRevision,
      base_kind: result.window.baseKind,
      base_commit_id: result.window.baseCommitId,
    },
    accepted_head: result.baseCommitId,
    next: "New verification window open for the same Stage at candidateRevision 0 (base = acceptedHead). Issue Directives through phase_plan.issue_execution_directive.",
  };
}

/**
 * phase_plan.activate_execution_stage (E7 §22) — the Supervisor selects one
 * eligible pending Stage; Core validates the explicit dependencies and
 * atomically transitions pending → active + opens the Stage's first window
 * rooted in the exact acceptedHead. The acceptedHead never moves (E7 §39).
 */
export function handleActivateExecutionStage(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["target_stage_id"]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "activate_execution_stage");
  if (typeof rawArgs.target_stage_id !== "string" || rawArgs.target_stage_id === "") {
    throw inputInvalid("target_stage_id must be a non-empty string");
  }
  const result = ctx.store.withWrite((tx) =>
    activateExecutionStageInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        targetStageId: rawArgs.target_stage_id as string,
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: "activated",
    stage: { id: result.stage.id, ordinal: result.stage.ordinal, objective: result.stage.objective },
    window: {
      id: result.window.id,
      candidate_revision: result.window.candidateRevision,
      base_kind: result.window.baseKind,
      base_commit_id: result.window.baseCommitId,
    },
    accepted_head: result.baseCommitId,
    next: "Stage activated with its first verification window at candidateRevision 0 (base = acceptedHead). Issue Directives through phase_plan.issue_execution_directive.",
  };
}

/**
 * phase_plan.get_verification_policy_context (E8 §23) — the derived
 * verification-pressure projection. Store facts only; the Store stays
 * canonical and nothing is cached.
 */
export function handleGetVerificationPolicyContext(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "get_verification_policy_context");
  const state = ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, envelope.executionRunId));
  if (state === null) {
    return {
      status: "no_open_window",
      next: "No open verification window: verification pressure is derived only inside a window (E8 §10).",
    };
  }
  return {
    status: "ok",
    window_id: state.windowId,
    candidate_revision: state.candidateRevision,
    latest_verified_revision: state.latestVerifiedRevision,
    unverified_mutation_span: state.unverifiedMutationSpan,
    max_unverified_mutations: state.maxUnverifiedMutations,
    verification_required: state.verificationRequired,
    reason: state.reason,
    blocking_report_ref: state.blockingReportRef,
    normal_verification_reports: state.normalVerificationReports,
    legacy_policy_present: state.legacyPolicyPresent,
    next: state.verificationRequired
      ? "Implementation issuance and starts are blocked: issue and complete a fresh NORMAL verification at the exact current candidate (E8 §14–§22). Inspection and verification remain allowed."
      : "Implementation work may continue within the frozen bound (E8 §14).",
  };
}

/**
 * phase_plan.declare_verification_conflict (E8 §30) — the Supervisor's durable
 * factual-conflict declaration. Core validates structure only.
 */
export function handleDeclareVerificationConflict(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["fact", "claims", "rationale"]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "declare_verification_conflict");
  if (typeof rawArgs.fact !== "string" || rawArgs.fact.trim() === "") {
    throw inputInvalid("fact must be a non-empty statement");
  }
  if (!Array.isArray(rawArgs.claims) || rawArgs.claims.length < 2) {
    throw inputInvalid("claims must be an array of at least two claim variants");
  }
  const conflict = ctx.store.withWrite((tx) =>
    declareVerificationConflictInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        fact: rawArgs.fact as string,
        claims: rawArgs.claims as unknown[],
        ...(rawArgs.rationale === undefined ? {} : { rationale: rawArgs.rationale as string }),
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: "declared",
    conflict: {
      id: conflict.conflictId,
      window_id: conflict.windowId,
      candidate_revision: conflict.candidateRevision,
      status: conflict.status,
      claim_variants: conflict.claims.map((claim) => claim.variant),
      fingerprint: conflict.fingerprint,
    },
    next:
      "Conflict declared OPEN. Author exactly ONE dedicated resolution VerificationDirective (kind=verification, "
      + "verification_purpose=conflict_resolution, verification_conflict_id) — Core binds it and no second resolver is possible. "
      + "A fresh worker session, distinct from all source-report sessions, must run it.",
  };
}

/**
 * phase_plan.resolve_verification_conflict (E8 §35) — the Supervisor settles
 * the conflict on the dedicated resolver's exact report.
 */
export function handleResolveVerificationConflict(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["conflict_id", "outcome", "resolution_report_id", "rationale"]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "resolve_verification_conflict");
  if (typeof rawArgs.conflict_id !== "string" || rawArgs.conflict_id === "") throw inputInvalid("conflict_id is required");
  if (rawArgs.outcome !== "resolved" && rawArgs.outcome !== "verification_blocked") {
    throw inputInvalid("outcome must be 'resolved' or 'verification_blocked'");
  }
  if (typeof rawArgs.resolution_report_id !== "string" || rawArgs.resolution_report_id === "") {
    throw inputInvalid("resolution_report_id is required");
  }
  if (typeof rawArgs.rationale !== "string" || rawArgs.rationale.trim() === "") {
    throw inputInvalid("rationale must be a non-empty string (E8 §35)");
  }
  const conflict = ctx.store.withWrite((tx) =>
    resolveVerificationConflictInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        conflictId: rawArgs.conflict_id as string,
        outcome: rawArgs.outcome as "resolved" | "verification_blocked",
        resolutionReportId: rawArgs.resolution_report_id as string,
        rationale: rawArgs.rationale as string,
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: conflict.status,
    conflict_id: conflict.conflictId,
    candidate_revision: conflict.candidateRevision,
    resolution_report_id: conflict.resolutionReportId,
    next:
      conflict.status === "resolved"
        ? "Conflict resolved: it no longer blocks acceptance, but it never substitutes for fresh NORMAL verification (E8 §34)."
        : "verification_blocked: commits are blocked for this candidate, but inspection and rework remain allowed — a mutation creates a new candidate and naturally stales the conflict (E8 §37/§42).",
  };
}

/**
 * phase_plan.request_execution_replan (E9 §6/§24) — the Supervisor's semantic
 * replan judgment; Core validates protocol + authority and executes the ONE
 * atomic terminal transaction. The model supplies intent only.
 */
export function handleRequestExecutionReplan(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["reason", "affected_normative_refs", "relevant_report_refs", "trigger_assessment_id"]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "request_execution_replan");
  if (typeof rawArgs.reason !== "string" || rawArgs.reason.trim() === "") {
    throw inputInvalid("reason must be a non-empty statement");
  }
  if (rawArgs.affected_normative_refs !== undefined && !Array.isArray(rawArgs.affected_normative_refs)) {
    throw inputInvalid("affected_normative_refs must be an array");
  }
  if (rawArgs.relevant_report_refs !== undefined && !Array.isArray(rawArgs.relevant_report_refs)) {
    throw inputInvalid("relevant_report_refs must be an array of report ids");
  }
  const result = ctx.store.withWrite((tx) =>
    requestExecutionReplanInTx(
      tx,
      {
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        reason: rawArgs.reason as string,
        affectedNormativeRefs: (rawArgs.affected_normative_refs as unknown[]) ?? [],
        relevantReportRefs: (rawArgs.relevant_report_refs as string[]) ?? [],
        ...(rawArgs.trigger_assessment_id === undefined ? {} : { triggerAssessmentId: rawArgs.trigger_assessment_id as string }),
        toolUseId: envelope.toolUseId,
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: result.status,
    execution_run_id: result.executionRunId,
    issue_id: result.issueId,
    issue_hash: result.issueHash,
    window_terminal_closed: result.windowClosed,
    supervisor_binding_detached: result.bindingDetached,
    next:
      result.status === "already_replan_required"
        ? "This replan already happened: the run is terminal and the issue is durable. Invoke /phase-plan to create (or resume) the successor PlanningRun."
        : "Execution is TERMINAL (replan_required): no further Directives, Attempts, or commits. Invoke /phase-plan — a NEW PlanningRun is created from the old FinalPlan baseline; ordinary repository mutation stays paused until then (E9 §29).",
  };
}

/**
 * phase_plan.get_execution_final_closure_context (E10 §55) — the run-level
 * final-closure surface: completion obligation identity, verifier requirement,
 * window state, policy/conflicts, and blockers. Store-derived only.
 */
export function handleGetExecutionFinalClosureContext(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "get_execution_final_closure_context");
  const context = ctx.store.withRead((tx) => loadExecutionFinalClosureContextInTx(tx, envelope.executionRunId));
  return {
    status: "ok",
    execution_run: context.executionRun,
    final_plan: context.finalPlan,
    accepted_head: context.acceptedHead,
    stages: context.stages,
    all_stages_completed: context.allStagesCompleted,
    final_closure_window: context.finalClosureWindow,
    completion_obligation: context.completionObligation,
    completion_verification_requirement: context.completionVerificationRequirement,
    verification_policy: context.verificationPolicy,
    current_conflicts: context.currentConflicts,
    completion_blockers: context.completionBlockers,
    next:
      context.finalClosureWindow.state === "open"
        ? "Run the final-closure window protocol: final-closure directives (issue_execution_directive with scope_kind='final_closure'), worker attempts, reports; then submit_supervisor_assessment=accept carrying the exact execution_run_completion obligation."
        : context.completionObligation === null
          ? "Final closure is not available at this boundary — resolve the completion blockers first (get_execution_progression_context)."
          : "At the all_stages_completed boundary: begin_execution_final_closure when you decide to enter final closure (never auto-started, E10 §10).",
  };
}

/**
 * phase_plan.begin_execution_final_closure (E10 §9/§10/§56) — the explicit
 * Supervisor start of the run-level Final Closure Window. Returns the exact
 * window identity + the Core-derived completion obligation + verifier
 * requirement so the Supervisor can compile proper final-closure directives.
 */
export function handleBeginExecutionFinalClosure(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "begin_execution_final_closure");
  const result = ctx.store.withWrite((tx) =>
    beginExecutionFinalClosureInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: "final_closure_open",
    window: {
      id: result.window.id,
      scope_kind: result.window.scopeKind,
      stage_id: result.window.stageId,
      candidate_revision: result.window.candidateRevision,
      base_kind: result.window.baseKind,
      base_commit_id: result.window.baseCommitId,
    },
    base_accepted_head_commit_id: result.baseAcceptedHeadCommitId,
    candidate_revision: result.candidateRevision,
    completion_obligation: result.completionObligation,
    completion_verification_requirement: result.completionVerificationRequirement,
    next:
      "Issue final-closure directives (issue_execution_directive with scope_kind='final_closure') for integration/inspection/verification/rework; the FINAL accept assessment must carry the exact execution_run_completion obligation and a fresh verifier whose directive carries verify_execution_completion. Opening this window never completes the run.",
  };
}

/**
 * phase_plan.get_attempt_recovery_context (E11 §46) — the read-only recovery
 * surface. Store-derived projection; never authority (E11 §47).
 */
export function handleGetAttemptRecoveryContext(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "get_attempt_recovery_context");
  const context = ctx.store.withRead((tx) => loadAttemptRecoveryContextInTx(tx, envelope.executionRunId));
  return {
    status: "ok",
    execution_run: context.executionRun,
    accepted_head: context.acceptedHead,
    open_window: context.openWindow,
    attempts: context.attempts,
    unresolved_indeterminate_attempt_ids: context.unresolvedIndeterminateAttemptIds,
    execution_fenced: context.executionFenced,
    capability_resolution_available: context.capabilityResolutionAvailable,
    next: context.executionFenced
      ? "Ordinary execution is fenced (E11 §13): issue_attempt_reconciliation (or resolve_indeterminate_attempt with no_effect_by_capability where available), or request_execution_replan."
      : "No unresolved indeterminate work in the current window.",
  };
}

/**
 * phase_plan.retry_unclaimed_worker_launch (E11 §40/§41) — the same-Attempt
 * launch-credential retry. Rotates the one-time token on the SAME prepared
 * unclaimed binding; the old token is invalidated.
 */
export function handleRetryUnclaimedWorkerLaunch(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["attempt_id"]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "retry_unclaimed_worker_launch");
  if (typeof rawArgs.attempt_id !== "string" || rawArgs.attempt_id === "") throw inputInvalid("attempt_id is required");
  const result = ctx.store.withWrite((tx) =>
    retryUnclaimedLaunchInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        attemptId: rawArgs.attempt_id as string,
      },
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: "relaunched",
    attempt_id: result.attemptId,
    directive: result.directive,
    worker_role: result.workerRole,
    launch_token: result.launchToken,
    worker_agent_type: result.workerAgentType,
    next: "Launch the native phase-plan execution-worker subagent with ONLY attempt_id + the NEW launch_token. The previous token no longer works.",
  };
}

/**
 * phase_plan.issue_attempt_reconciliation (E11 §11/§12) — binding + exact
 * inspection Directive in ONE transaction; the requiredAction hash-covers the
 * target (E11 §10 preferred option 1 — no protocol v4).
 */
export function handleIssueAttemptReconciliation(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["attempt_id", "objective", "body", "capability_envelope", "report_contract", "_hostContext"]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "issue_attempt_reconciliation");
  if (typeof rawArgs.attempt_id !== "string" || rawArgs.attempt_id === "") throw inputInvalid("attempt_id is required");
  if (typeof rawArgs.objective !== "string" || rawArgs.objective === "") throw inputInvalid("objective is required");
  if (typeof rawArgs.body !== "string") throw inputInvalid("body must be a string");
  const result = ctx.store.withWrite((tx) =>
    issueAttemptReconciliationInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        attemptId: rawArgs.attempt_id as string,
        objective: rawArgs.objective as string,
        body: rawArgs.body as string,
        capabilityEnvelope: rawArgs.capability_envelope as ExecutionDirective["capabilityEnvelope"],
        reportContract: rawArgs.report_contract as ExecutionDirective["reportContract"],
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: "reconciliation_bound",
    attempt_id: result.binding.attemptId,
    directive: {
      id: result.directive.directiveId,
      revision: result.directive.revision,
      hash: result.directive.hash,
      kind: result.directive.kind,
      scope_kind: result.directive.scopeKind,
      stage_id: result.directive.stageId,
      window_id: result.directive.windowId,
      base_candidate_revision: result.directive.baseCandidateRevision,
    },
    side_effect_capable: result.sideEffectCapable,
    next: result.sideEffectCapable
      ? "Start the inspection attempt with start_worker_attempt (this exact revision + hash). The interrupted Directive had side-effect-capable authority: only a completed non-mutating inspection Report may resolve the Attempt."
      : "The interrupted Directive was provably non-mutating: resolve_indeterminate_attempt with no_effect_by_capability is available without an inspection.",
  };
}

/**
 * phase_plan.resolve_indeterminate_attempt (E11 §24–§29) — the final immutable
 * reconciliation.
 */
export function handleResolveIndeterminateAttempt(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["attempt_id", "resolution", "inspection_report_id", "rationale", "expected_candidate_revision", "_hostContext"]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "resolve_indeterminate_attempt");
  if (typeof rawArgs.attempt_id !== "string" || rawArgs.attempt_id === "") throw inputInvalid("attempt_id is required");
  const resolution = rawArgs.resolution;
  if (resolution !== "no_effect" && resolution !== "no_effect_by_capability" && resolution !== "candidate_changed") {
    throw inputInvalid("resolution must be no_effect | no_effect_by_capability | candidate_changed");
  }
  if (typeof rawArgs.rationale !== "string" || rawArgs.rationale.trim() === "") throw inputInvalid("rationale must be a non-empty string");
  if (typeof rawArgs.expected_candidate_revision !== "number") throw inputInvalid("expected_candidate_revision must be a number");
  const result = ctx.store.withWrite((tx) =>
    resolveIndeterminateAttemptInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        attemptId: rawArgs.attempt_id as string,
        resolution,
        ...(typeof rawArgs.inspection_report_id === "string" && rawArgs.inspection_report_id !== ""
          ? { inspectionReportId: rawArgs.inspection_report_id as string }
          : {}),
        rationale: rawArgs.rationale as string,
        expectedCandidateRevision: rawArgs.expected_candidate_revision as number,
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: result.status,
    reconciliation: {
      id: result.reconciliation.reconciliationId,
      attempt_id: result.reconciliation.attemptId,
      resolution: result.reconciliation.resolution,
      candidate_revision_before: result.reconciliation.candidateRevisionBefore,
      candidate_revision_after: result.reconciliation.candidateRevisionAfter,
    },
    window: { id: result.window.id, candidate_revision: result.window.candidateRevision },
    next:
      result.status === "already_resolved"
        ? "The Attempt was already reconciled with this exact resolution; the durable fact is returned unchanged."
        : result.reconciliation.resolution === "candidate_changed"
          ? "Candidate recovered: all verification at the previous revision is stale. A fresh normal verification (and, for final closure, a fresh final verifier) is required before acceptance."
          : "No durable effect: normal execution may resume (E11 §25).",
  };
}

function requireExecutionSupervisorContext(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>, tool: string): ExecutionHostContextV1 {

  const token = requireHostContext(rawArgs);
  const signed = parseSignedHostContext(ctx.secret, token);
  if (signed.authority !== "execution") {
    throw domainError("WORKER_AUTHORITY_REQUIRED", tool + " requires an execution-domain supervisor context signed by the PreToolUse hook");
  }
  return assertExecutionHostContextForTool(ctx.secret, token, { tool, businessInput: rawArgs });
}

/**
 * phase_plan.issue_execution_directive (E5 §42) — the fenced supervisor's
 * domain-intent issuance. The FinalPlan/stage/window/base bindings are
 * revalidated by the E4 core; the model supplies only directive intent.
 */
export function handleIssueExecutionDirective(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, [
    "kind",
    "stage_id",
    "scope_kind",
    "window_id",
    "objective",
    "body",
    "directive_id",
    "revision",
    "final_plan_ref",
    "base_candidate_revision",
    "plan_refs",
    "expected_execution_scope",
    "capability_envelope",
    "invariants",
    "required_actions",
    "forbidden_actions",
    "validation_requirements",
    "deliverables",
    "stop_conditions",
    "report_contract",
    "verification_policy",
  ]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "issue_execution_directive");
  if (typeof rawArgs.kind !== "string") throw inputInvalid("kind must be a string");
  // E10 §5/§16 — exactly one scope form: stage_id (stage scope) or
  // scope_kind='final_closure' with no stage_id. The authority triangle is
  // revalidated by the E10 core.
  if (rawArgs.stage_id !== undefined && (typeof rawArgs.stage_id !== "string" || rawArgs.stage_id === "")) {
    throw inputInvalid("stage_id must be a non-empty string when present");
  }
  if (
    rawArgs.scope_kind !== undefined
    && (rawArgs.scope_kind !== "final_closure" || rawArgs.stage_id !== undefined)
  ) {
    throw inputInvalid("scope_kind must be 'final_closure' and must be omitted when stage_id is present");
  }
  if (rawArgs.stage_id === undefined && rawArgs.scope_kind === undefined) {
    throw inputInvalid("directive scope is required: stage_id (stage scope) or scope_kind='final_closure' (E10 §5)");
  }
  if (typeof rawArgs.window_id !== "string" || rawArgs.window_id === "") throw inputInvalid("window_id is required");
  if (typeof rawArgs.objective !== "string" || rawArgs.objective === "") throw inputInvalid("objective is required");
  if (typeof rawArgs.body !== "string") throw inputInvalid("body must be a string");
  if (typeof rawArgs.capability_envelope !== "object" || rawArgs.capability_envelope === null) {
    throw inputInvalid("capability_envelope is required and must be the complete 8-field object");
  }
  if (typeof rawArgs.report_contract !== "object" || rawArgs.report_contract === null) {
    throw inputInvalid("report_contract is required and must be the complete contract object");
  }
  const directive = ctx.store.withWrite((tx) =>
    issueExecutionDirectiveInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        kind: rawArgs.kind as ExecutionDirectiveKind,
        ...(rawArgs.stage_id === undefined ? {} : { stageId: rawArgs.stage_id as string }),
        ...(rawArgs.scope_kind === undefined ? {} : { scopeKind: rawArgs.scope_kind as "final_closure" }),
        windowId: rawArgs.window_id as string,
        objective: rawArgs.objective as string,
        body: rawArgs.body as string,
        ...(rawArgs.directive_id === undefined ? {} : { directiveId: rawArgs.directive_id as string }),
        ...(rawArgs.revision === undefined ? {} : { revision: rawArgs.revision as number }),
        ...(rawArgs.final_plan_ref === undefined ? {} : { finalPlanRef: rawArgs.final_plan_ref as IssueExecutionDirectiveInput["finalPlanRef"] }),
        ...(rawArgs.base_candidate_revision === undefined ? {} : { baseCandidateRevision: rawArgs.base_candidate_revision as number }),
        ...(rawArgs.plan_refs === undefined ? {} : { planRefs: rawArgs.plan_refs as DirectivePlanRef[] }),
        ...(rawArgs.expected_execution_scope === undefined ? {} : { expectedExecutionScope: rawArgs.expected_execution_scope as IssueExecutionDirectiveInput["expectedExecutionScope"] }),
        capabilityEnvelope: rawArgs.capability_envelope as IssueExecutionDirectiveInput["capabilityEnvelope"],
        ...(rawArgs.invariants === undefined ? {} : { invariants: rawArgs.invariants as IssueExecutionDirectiveInput["invariants"] }),
        ...(rawArgs.required_actions === undefined ? {} : { requiredActions: rawArgs.required_actions as IssueExecutionDirectiveInput["requiredActions"] }),
        ...(rawArgs.forbidden_actions === undefined ? {} : { forbiddenActions: rawArgs.forbidden_actions as IssueExecutionDirectiveInput["forbiddenActions"] }),
        ...(rawArgs.validation_requirements === undefined ? {} : { validationRequirements: rawArgs.validation_requirements as IssueExecutionDirectiveInput["validationRequirements"] }),
        ...(rawArgs.deliverables === undefined ? {} : { deliverables: rawArgs.deliverables as IssueExecutionDirectiveInput["deliverables"] }),
        ...(rawArgs.stop_conditions === undefined ? {} : { stopConditions: rawArgs.stop_conditions as IssueExecutionDirectiveInput["stopConditions"] }),
        reportContract: rawArgs.report_contract as IssueExecutionDirectiveInput["reportContract"],
        ...(rawArgs.verification_policy === undefined
          ? {}
          : {
              verificationPolicy: normalizeSnakeRecord(rawArgs.verification_policy as Record<string, unknown>, [
                ["implementation_requirement", "implementationRequirement"],
                ["verification_purpose", "verificationPurpose"],
                ["verification_conflict_id", "verificationConflictId"],
              ]) as unknown as IssueExecutionDirectiveInput["verificationPolicy"],
            }),
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: "issued",
    directive: {
      id: directive.directiveId,
      revision: directive.revision,
      hash: directive.hash,
      kind: directive.kind,
      scope_kind: directive.scopeKind,
      stage_id: directive.stageId,
      window_id: directive.windowId,
      base_candidate_revision: directive.baseCandidateRevision,
    },
    next: "Start a worker attempt with phase_plan.start_worker_attempt using this exact revision + hash.",
  };
}

/**
 * phase_plan.start_worker_attempt (E5 §9/§20/§42) — the fenced supervisor
 * starts the exact Attempt and prepares the one-time worker launch package.
 * The plaintext launch token is returned EXACTLY ONCE here; only its hash is
 * durable. The Supervisor then launches the native phase-plan execution-worker
 * subagent with the claim bootstrap (attempt_id + launch token) — never the
 * Directive itself (E5 §43).
 */
export function handleStartWorkerAttempt(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["directive_id", "directive_revision", "directive_hash", "worker_role"]);
  const envelope = requireExecutionSupervisorContext(ctx, rawArgs, "start_worker_attempt");
  if (typeof rawArgs.directive_id !== "string" || rawArgs.directive_id === "") throw inputInvalid("directive_id is required");
  if (typeof rawArgs.directive_revision !== "number" || !Number.isInteger(rawArgs.directive_revision)) {
    throw inputInvalid("directive_revision must be an integer");
  }
  if (typeof rawArgs.directive_hash !== "string" || rawArgs.directive_hash === "") throw inputInvalid("directive_hash is required");
  if (rawArgs.worker_role !== "executor" && rawArgs.worker_role !== "verifier") {
    throw inputInvalid('worker_role must be "executor" or "verifier"');
  }
  const { attempt, launch } = ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: envelope.executionRunId,
        sessionId: envelope.sessionId,
        workspaceId: envelope.workspaceId,
        generation: envelope.executionBindingGeneration,
        directiveId: rawArgs.directive_id as string,
        directiveRevision: rawArgs.directive_revision as number,
        directiveHash: rawArgs.directive_hash as string,
        workerRole: rawArgs.worker_role as StartExecutionAttemptInput["workerRole"],
      },
      ctx.clock,
      ctx.clock.nowIso(),
    ),
  );
  return {
    status: "launched",
    attempt_id: attempt.attemptId,
    worker_role: attempt.workerRole,
    directive: launch.directive,
    worker_agent_type: launch.workerAgentType,
    launch_token: launch.launchToken,
    next: "Launch the phase-plan execution-worker subagent with ONLY attempt_id, this one-time launch_token, and the instruction to claim via phase_plan.worker_claim. Never paste the Directive into the launch prompt.",
  };
}
// ---------------------------------------------------------------------------

export function executePhasePlanTool(ctx: PhasePlanToolContext, name: string, rawArgs: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "start_or_resume":
      return handleStartOrResume(ctx, rawArgs);
    case "get_state":
      return handleGetState(ctx, rawArgs);
    case "get_context":
      return handleGetContext(ctx, rawArgs);
    case "read_memory":
      return handleReadMemory(ctx, rawArgs);
    case "list_observations":
      return handleListObservations(ctx, rawArgs);
    case "promote_evidence":
      return handlePromoteEvidence(ctx, rawArgs);
    case "revalidate_evidence":
      return handleRevalidateEvidence(ctx, rawArgs);
    case "select_section":
      return handleSelectSection(ctx, rawArgs);
    case "prepare_proposal":
      return handlePrepareProposal(ctx, rawArgs);
    case "approve_proposal":
      return handleApproveProposal(ctx, rawArgs);
    case "submit_synthesis":
      return handleSubmitSynthesis(ctx, rawArgs);
    case "submit_validation":
      return handleSubmitValidation(ctx, rawArgs);
    case "request_reopen":
      return handleRequestReopen(ctx, rawArgs);
    case "request_finalization":
      return handleRequestFinalization(ctx, rawArgs);
    case "handoff":
      return handleHandoff(ctx, rawArgs);
    case "report_execution_issue":
      return handleReportExecutionIssue(ctx, rawArgs);
    case "takeover_run":
      return handleTakeoverRun(ctx, rawArgs);
    case "abort_run":
      return handleAbortRun(ctx, rawArgs);
    case "abort_execution_run":
      return handleAbortExecutionRun(ctx, rawArgs);
    case "reexecute_final_plan":
      return handleReexecuteFinalPlan(ctx, rawArgs);
    case "worker_claim":
      return handleWorkerClaim(ctx, rawArgs);
    case "worker_get_assignment":
      return handleWorkerGetAssignment(ctx, rawArgs);
    case "worker_submit_report":
      return handleWorkerSubmitReport(ctx, rawArgs);
    case "issue_execution_directive":
      return handleIssueExecutionDirective(ctx, rawArgs);
    case "start_worker_attempt":
      return handleStartWorkerAttempt(ctx, rawArgs);
    case "get_execution_acceptance_context":
      return handleGetExecutionAcceptanceContext(ctx, rawArgs);
    case "submit_supervisor_assessment":
      return handleSubmitSupervisorAssessment(ctx, rawArgs);
    case "get_execution_progression_context":
      return handleGetExecutionProgressionContext(ctx, rawArgs);
    case "continue_execution_stage":
      return handleContinueExecutionStage(ctx, rawArgs);
    case "activate_execution_stage":
      return handleActivateExecutionStage(ctx, rawArgs);
    case "get_verification_policy_context":
      return handleGetVerificationPolicyContext(ctx, rawArgs);
    case "declare_verification_conflict":
      return handleDeclareVerificationConflict(ctx, rawArgs);
    case "resolve_verification_conflict":
      return handleResolveVerificationConflict(ctx, rawArgs);
    case "get_attempt_recovery_context":
      return handleGetAttemptRecoveryContext(ctx, rawArgs);
    case "retry_unclaimed_worker_launch":
      return handleRetryUnclaimedWorkerLaunch(ctx, rawArgs);
    case "issue_attempt_reconciliation":
      return handleIssueAttemptReconciliation(ctx, rawArgs);
    case "resolve_indeterminate_attempt":
      return handleResolveIndeterminateAttempt(ctx, rawArgs);
    case "get_execution_final_closure_context":
      return handleGetExecutionFinalClosureContext(ctx, rawArgs);
    case "begin_execution_final_closure":
      return handleBeginExecutionFinalClosure(ctx, rawArgs);
    case "request_execution_replan":
      return handleRequestExecutionReplan(ctx, rawArgs);
    default:
      throw new RuntimeError("MCP_INPUT_INVALID", `unknown tool '${name}'`);
  }
}
