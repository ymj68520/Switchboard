/**
 * Phase 13 MCP tool surface (Phase 12 §95 + Phase 13 §87).
 *
 * Exactly fourteen tools — the Phase 12 set plus request_finalization:
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
import { assertExecutionHostContextForTool, parseSignedHostContext, type ExecutionHostContextV1 } from "../host/execution-context.js";
import { assertWritableBindingInTx } from "../store/session-bindings.js";
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
      + "This tool is NOT the human approval — call approve_proposal afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_type: { type: "string", enum: ["design_checkpoint", "architecture_completion", "section_completion", "amendment"] },
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
    return {
      status: "selection_required",
      code: "RUN_SELECTION_REQUIRED",
      runs: otherSessionRuns.map(selectableRunView),
      takeover_required: true,
      message:
        "This workspace has active planning runs owned by other sessions. Phase Plan never attaches to them automatically; "
        + "takeover is a separate human-authorized operation (TAKEOVER_REQUIRED), or pass action=start_new with a goal to begin a new run.",
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
  assertExactBusinessFields(rawArgs, ["proposal_type", "scope", "title", "summary", "changes", "required_evidence"]);
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
  const prepared = service.prepareProposal({
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

export function handleApproveProposal(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  // §27/§29 — exact business schema; model-supplied authority fields rejected.
  assertExactBusinessFields(rawArgs, ["proposal_id", "proposal_revision", "proposal_hash"]);
  const args = rawArgs;
  const token = requireHostContext(args);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "approve_proposal", businessInput: args });

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
    const authority = createHandoffService(ctx.store, ctx.clock).requireBuildReadAuthorityInTx(tx, {
      sessionId: exec.sessionId,
      workspaceId: exec.workspaceId,
      runId: exec.runId,
      finalPlanId: exec.finalPlanId,
      generation: exec.executionBindingGeneration,
    });
    const handoff = JSON.parse(authority.handoff.canonicalJson) as ExecutionHandoffV1;
    // Phase 15 §19 — the open-issue projection over the delivered contract.
    const openIssues = listOpenExecutionIssuesInTx(tx, exec.runId);
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
  const handoff = ctx.store.withRead((tx) => {
    const row = getExecutionHandoffInTx(tx, exec.runId);
    return row === null ? null : (JSON.parse(row.canonicalJson) as ExecutionHandoffV1);
  });
  if (handoff === null) {
    throw domainError("EXECUTION_CONTEXT_NOT_AVAILABLE", "the execution handoff row is missing");
  }
  const canonical = state as Record<string, unknown>;
  // Phase 15 §19 — the compact open-issue list; full detail stays opt-in via
  // read tools, never a default injection.
  const compactIssues = ctx.store.withRead((tx) => listOpenExecutionIssuesInTx(tx, exec.runId)).map((issue) => {
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
      runId: exec.runId,
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
): Record<string, unknown> {
  return {
    status: "ok",
    ...(idempotent ? { idempotent: true } : {}),
    handoff_id: identity.handoffId,
    handoff_hash: identity.handoffHash,
    final_plan: { id: finalPlan.id, hash: finalPlan.hash },
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
        runId: exec.runId,
        finalPlanId: exec.finalPlanId,
        generation: exec.executionBindingGeneration,
      });
      const handoff = JSON.parse(authority.handoff.canonicalJson) as ExecutionHandoffV1;
      return handoffResponse(
        handoff,
        { handoffId: authority.handoff.handoffId, handoffHash: authority.handoff.handoffHash },
        { id: authority.finalPlanRow.finalPlanId, hash: authority.finalPlanRow.finalPlanHash },
        true,
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
    runId: exec.runId,
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
    default:
      throw new RuntimeError("MCP_INPUT_INVALID", `unknown tool '${name}'`);
  }
}
