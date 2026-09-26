/**
 * Synthesis / Semantic Validation application service (Phase 12 §13–§27/§35–§67/§78/§84).
 *
 * Authority model (§1–§3): SynthesisInput / SynthesisManifest /
 * SemanticValidationReport are durable, immutable, auditable RECORDS — never
 * Plan Memory mutations. None of them move HEAD or create PlanCommits; only
 * request_reopen moves the run (stage + revision + review states), and only a
 * real Proposal → Approval → PlanCommit ever changes committed design.
 *
 * The DETAIL_COMPLETE hook (§18) is the sole SynthesisInput creation point:
 * the LAST legal Section completion that advances Detail → Synthesis builds
 * the frozen input in the SAME transaction, anchored to the resulting HEAD.
 * Any construction failure (including §24's critical-Evidence gate) rolls
 * back the entire completion.
 */

import {
  canonicalizeSynthesisInput,
  derivedIsClean,
  manifestSupportRefs,
  semanticValidationReportHash,
  synthesisInputHash,
  synthesisManifestHash,
  validateSynthesisManifest,
  validateValidationFindings,
  type SynthesisBundleRef,
  type SynthesisInputEvidence,
  type SynthesisInputV1,
  type SynthesisManifestV1,
  type ValidationFinding,
} from "../core/synthesis.js";
import type { MemoryRef } from "../core/memory-refs.js";
import { nextStage } from "../core/state-machine.js";
import { RuntimeError } from "../runtime/errors.js";
import { evidenceNeedsValidationError } from "./evidence-gate.js";
import { evaluateCriticalEvidenceGateInTx } from "./evidence-freshness-service.js";
import {
  listDownstreamSectionClosure,
  sectionDependenciesInTx,
  transitionSectionWorkflowInTx,
} from "./section-workflow-service.js";
import { canonicalJson } from "../core/canonical-json.js";
import { runStateError } from "../store/planning-runs.js";
import { getHeadPairInTx } from "../store/plan-commits.js";
import { getSnapshotRefsInTx } from "../store/plan-memory.js";
import { assertWritableBindingInTx } from "../store/session-bindings.js";
import {
  getProposalRevisionInTx,
  findAwaitingProposalStateInTx,
  transitionProposalStateInTx,
} from "../store/proposals.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import {
  getLatestSynthesisInputInTx,
  getSynthesisManifestByInputInTx,
  getSynthesisManifestByRequestInTx,
  getSynthesisManifestInTx,
  getValidationReportByManifestInTx,
  getValidationReportByRequestInTx,
  insertSynthesisInputInTx,
  insertSynthesisManifestInTx,
  insertValidationReportInTx,
  listEvidenceUpstreamInTx,
  listRunCommitProposalsInTx,
  listSynthesisInputEvidenceInTx,
  listSynthesisInputRefsInTx,
  listValidationFindingsInTx,
  nextSynthesisInputSeqInTx,
  type SynthesisInputEvidenceRow,
} from "../store/synthesis.js";
import {
  listSectionWorkflowStatesInTx,
} from "../store/section-workflow.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";

/** The only agent type whose signed calls may reach submit_validation (§5/§53). */
export const VALIDATOR_AGENT_TYPE = "phase-plan:validator";

type SynthesisErrorCode =
  | "SYNTHESIS_INPUT_REQUIRED"
  | "SYNTHESIS_INPUT_NOT_READY"
  | "SYNTHESIS_STALE"
  | "SYNTHESIS_REF_INVALID"
  | "SYNTHESIS_MANIFEST_INVALID"
  | "SYNTHESIS_ALREADY_SUBMITTED"
  | "VALIDATOR_CALLER_REQUIRED"
  | "VALIDATOR_MUTATION_FORBIDDEN"
  | "VALIDATION_REPORT_INVALID"
  | "VALIDATION_STALE"
  | "VALIDATION_ALREADY_SUBMITTED"
  | "REOPEN_REQUEST_INVALID"
  | "FINAL_PLAN_ALREADY_APPROVED";

function synthesisError(code: SynthesisErrorCode, message: string, detail?: Record<string, unknown>): RuntimeError {
  return new RuntimeError(code, message, { detail });
}

/** Manifest validation with the typed error mapping (SYNTHESIS_MANIFEST_INVALID). */
function validateSynthesisManifestOrThrow(raw: unknown, runId: string): SynthesisManifestV1 {
  try {
    return validateSynthesisManifest(raw);
  } catch (err) {
    throw synthesisError("SYNTHESIS_MANIFEST_INVALID", err instanceof Error ? err.message : "manifest is structurally invalid", {
      runId,
    });
  }
}

export interface CallerAgent {
  agentId?: string;
  agentType?: string;
}

/** Map a bundle-facing ref to its Plan Memory identity (§38 vocabulary). */
function bundleRefToMemoryRef(ref: SynthesisBundleRef): { kind: string; id: string; revision: number } | null {
  switch (ref.kind) {
    case "architecture":
    case "section":
    case "decision":
    case "constraint":
    case "conflict":
      return { kind: ref.kind, id: ref.id, revision: ref.revision };
    case "question":
      return { kind: "open_question", id: ref.id, revision: ref.revision };
    case "section_contract":
      // The contract is embedded in that exact section revision.
      return { kind: "section", id: ref.id, revision: ref.revision };
    case "evidence":
      return null;
  }
}

function loadRunInTx(tx: StoreTx, runId: string): PlanningRun {
  const row = tx
    .prepare(
      "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
      + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
    )
    .get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw runStateError("RUN_NOT_FOUND", `no PlanningRun exists for '${runId}'`, { runId });
  }
  return parsePlanningRunRow(row);
}

function bumpRunStageInTx(
  tx: StoreTx,
  input: { runId: string; expectedRevision: number; nextStage: PlanningRun["stage"] },
  now: string,
): void {
  const result = tx
    .prepare("UPDATE planning_runs SET stage = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND revision = ?")
    .run(input.nextStage, now, input.runId, input.expectedRevision) as { changes?: number };
  if ((result.changes ?? 0) !== 1) {
    throw runStateError("STALE_RUN_REVISION", "run revision changed during the synthesis transition", {
      runId: input.runId,
      expected: input.expectedRevision,
    });
  }
}

// ---------------------------------------------------------------------------
// §21 — deterministic relevant-Evidence reachability
// ---------------------------------------------------------------------------

/**
 * The union of Evidence required by the committed provenance of the CURRENT
 * design (§21): for each exact artifact revision in the base snapshot, the
 * introducing Proposal's requiredEvidence; plus each completed Section's
 * completion Proposal requiredEvidence; plus the recursive exact upstream
 * closure of every collected Evidence revision. No claims are scanned and no
 * run-wide "latest evidence" inference is allowed (§22).
 *
 * Exported for the Phase 13 finalization audit, which must re-verify that
 * this deterministic reachability still equals the frozen input scope (§7).
 */
export function listRelevantEvidenceInTx(
  tx: StoreTx,
  runId: string,
  baseRefs: MemoryRef[],
): Array<{ evidenceId: string; revision: number }> {
  const refKeys = new Set(baseRefs.map((ref) => `${ref.kind}\u0000${ref.id}\u0000${ref.revision}`));
  const contributing = new Set<string>();
  const addProposal = (proposalId: string | null, proposalRevision: number | null) => {
    if (proposalId === null || proposalRevision === null) return;
    contributing.add(`${proposalId}\u0000${proposalRevision}`);
  };

  for (const commit of listRunCommitProposalsInTx(tx, runId)) {
    const revision = getProposalRevisionInTx(tx, { runId, proposalId: commit.proposalId, revision: commit.proposalRevision });
    if (revision === null) continue;
    let contributes = false;
    for (const change of revision.changes) {
      const kind = changeOpKindOf(change);
      const result = changeResultOf(change);
      if (kind === null || result === undefined) continue;
      if (refKeys.has(`${kind}\u0000${change.artifactId}\u0000${result.revision}`)) {
        contributes = true;
        break;
      }
    }
    if (contributes) addProposal(commit.proposalId, commit.proposalRevision);
  }
  // §21 rule 2 — completion Proposals contribute explicitly (superset of the
  // change-scan result; COMPLETE_SECTION changes already match, but the
  // workflow state is the completion authority).
  const completionStates = tx
    .prepare(
      "SELECT completed_proposal_id AS proposalId, completed_proposal_revision AS proposalRevision "
      + "FROM section_workflow_states WHERE run_id = ? AND completed_proposal_id IS NOT NULL",
    )
    .all(runId) as Array<{ proposalId: string; proposalRevision: number }>;
  for (const state of completionStates) addProposal(state.proposalId, state.proposalRevision);

  // §21 rule 3 — union of the contributing proposals' requiredEvidence, then
  // the recursive exact upstream closure.
  const collected = new Map<string, { evidenceId: string; revision: number }>();
  for (const key of [...contributing].sort()) {
    const [proposalId, proposalRevisionRaw] = key.split("\u0000");
    const proposalRevision = Number(proposalRevisionRaw);
    const refs = tx
      .prepare(
        "SELECT evidence_id AS evidenceId, evidence_revision AS revision FROM proposal_evidence_refs "
        + "WHERE run_id = ? AND proposal_id = ? AND proposal_revision = ?",
      )
      .all(runId, proposalId, proposalRevision) as Array<{ evidenceId: string; revision: number }>;
    for (const ref of refs) {
      collected.set(`${ref.evidenceId}\u0000${ref.revision}`, { ...ref });
    }
  }
  const queue = [...collected.values()];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const upstream of listEvidenceUpstreamInTx(tx, runId, current.evidenceId, current.revision)) {
      const key = `${upstream.evidenceId}\u0000${upstream.revision}`;
      if (!collected.has(key)) {
        collected.set(key, { ...upstream });
        queue.push(upstream);
      }
    }
  }
  return [...collected.values()].sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : a.revision - b.revision));
}

type ChangeWithKind = { op: string; artifactId: string; result?: { revision: number } };

function changeOpKindOf(change: unknown): string | null {
  const record = change as ChangeWithKind;
  switch (record.op) {
    case "ADD_CONSTRAINT":
    case "SUPERSEDE_CONSTRAINT":
      return "constraint";
    case "ADD_DECISION":
    case "SUPERSEDE_DECISION":
      return "decision";
    case "SET_ARCHITECTURE_REVISION":
      return "architecture";
    case "SET_SECTION_REVISION":
    case "COMPLETE_SECTION":
    case "REOPEN_SECTION":
      return "section";
    case "ADD_OPEN_QUESTION":
    case "RESOLVE_OPEN_QUESTION":
      return "open_question";
    case "ADD_CONFLICT":
    case "RESOLVE_CONFLICT":
      return "conflict";
    default:
      return null;
  }
}

function changeResultOf(change: unknown): { revision: number } | undefined {
  return (change as ChangeWithKind).result;
}

// ---------------------------------------------------------------------------
// §13–§27 — SynthesisInput creation (the DETAIL_COMPLETE hook)
// ---------------------------------------------------------------------------

/**
 * Build and freeze the SynthesisInput for a run that JUST completed its last
 * Section (§18): the caller has already applied the resulting snapshot and
 * HEAD and bumped the run exactly once. Runs INSIDE the commit transaction —
 * any failure (including §24's gate) rolls the whole completion back, so a
 * run can never sit at stage synthesis without an input.
 */
export function createSynthesisInputAtDetailCompletionInTx(
  tx: StoreTx,
  input: {
    runId: string;
    workspaceId: string;
    /** The resulting HEAD snapshot this input is anchored to. */
    snapshotId: string;
    /** The resulting HEAD commit (null only for snapshot-only heads, which never complete Detail). */
    commitId: string | null;
    baseRunRevision: number;
  },
  clock: StoreClock,
): { inputId: string; inputHash: string; relevantEvidence: number } {
  const baseRefs = getSnapshotRefsInTx(tx, input.snapshotId) ?? [];
  if (baseRefs.length === 0) {
    throw synthesisError("SYNTHESIS_INPUT_NOT_READY", "the resulting snapshot carries no committed design", {
      runId: input.runId,
      snapshotId: input.snapshotId,
    });
  }
  const readContent = (ref: MemoryRef): { content: unknown; contractJson: string | null } | null => {
    const row = tx
      .prepare(
        "SELECT content_json AS contentJson, contract_json AS contractJson FROM memory_revisions "
        + "WHERE run_id = ? AND kind = ? AND artifact_id = ? AND revision = ?",
      )
      .get(input.runId, ref.kind, ref.id, ref.revision) as { contentJson: string; contractJson: string | null } | undefined;
    if (row === undefined) return null;
    return { content: JSON.parse(row.contentJson), contractJson: row.contractJson };
  };

  const toInputRef = (ref: MemoryRef): SynthesisInputV1["sections"][number] | null => {
    const read = readContent(ref);
    if (read === null) return null;
    return { kind: ref.kind, id: ref.id, revision: ref.revision, content: read.content };
  };

  const architecture: SynthesisInputV1["architecture"] = [];
  const sections: SynthesisInputV1["sections"] = [];
  const sectionContracts: SynthesisInputV1["sectionContracts"] = [];
  const decisions: SynthesisInputV1["decisions"] = [];
  const constraints: SynthesisInputV1["constraints"] = [];
  const resolvedQuestions: SynthesisInputV1["resolvedQuestions"] = [];
  const resolvedConflicts: SynthesisInputV1["resolvedConflicts"] = [];

  for (const ref of baseRefs) {
    if (ref.kind === "architecture") {
      const entry = toInputRef(ref);
      if (entry !== null) architecture.push(entry);
      continue;
    }
    if (ref.kind === "section") {
      const entry = toInputRef(ref);
      if (entry === null) continue;
      sections.push(entry);
      const read = readContent(ref);
      if (read !== null && read.contractJson !== null) {
        sectionContracts.push({ sectionId: ref.id, revision: ref.revision, contract: JSON.parse(read.contractJson) });
      }
      continue;
    }
    if (ref.kind === "decision" || ref.kind === "constraint") {
      const entry = toInputRef(ref);
      if (entry !== null) {
        if (ref.kind === "decision") decisions.push(entry);
        else constraints.push(entry);
      }
      continue;
    }
    // §16 — only RESOLVED questions/conflicts enter the frozen world.
    if (ref.kind === "open_question" || ref.kind === "conflict") {
      const entry = toInputRef(ref);
      if (entry === null) continue;
      const status = (entry.content as { status?: string }).status;
      if (status !== "resolved") continue;
      if (ref.kind === "open_question") resolvedQuestions.push(entry);
      else resolvedConflicts.push(entry);
    }
  }

  // §20–§23 — deterministic relevant-Evidence reachability, frozen with the
  // exact freshness state each revision had at this instant.
  const relevantRefs = listRelevantEvidenceInTx(tx, input.runId, baseRefs);
  const relevantEvidence: SynthesisInputEvidence[] = [];
  for (const ref of relevantRefs) {
    const revision = tx
      .prepare(
        "SELECT claim AS claim, confidence AS confidence, criticality AS criticality, "
        + "validation_strategy AS validationStrategy FROM evidence_revisions "
        + "WHERE run_id = ? AND evidence_id = ? AND revision = ?",
      )
      .get(input.runId, ref.evidenceId, ref.revision) as
      | { claim: string; confidence: string; criticality: string; validationStrategy: string }
      | undefined;
    const state = tx
      .prepare(
        "SELECT state AS state, last_event_seq AS lastEventSeq FROM evidence_current_states "
        + "WHERE run_id = ? AND evidence_id = ? AND evidence_revision = ?",
      )
      .get(input.runId, ref.evidenceId, ref.revision) as { state: string; lastEventSeq: number } | undefined;
    if (revision === undefined || state === undefined) {
      throw synthesisError(
        "SYNTHESIS_INPUT_NOT_READY",
        `relevant evidence '${ref.evidenceId}'@${ref.revision} has no revision/state row`,
        { runId: input.runId, evidenceId: ref.evidenceId, revision: ref.revision },
      );
    }
    relevantEvidence.push({
      evidenceId: ref.evidenceId,
      revision: ref.revision,
      confidence: revision.confidence as SynthesisInputEvidence["confidence"],
      criticality: revision.criticality as SynthesisInputEvidence["criticality"],
      validationStrategy: revision.validationStrategy as SynthesisInputEvidence["validationStrategy"],
      state: state.state as SynthesisInputEvidence["state"],
      lastValidationEventSeq: state.lastEventSeq,
      claim: revision.claim,
    });
  }

  const canonical: SynthesisInputV1 = canonicalizeSynthesisInput({
    version: 1,
    runId: input.runId,
    baseRunRevision: input.baseRunRevision,
    baseHeadSnapshot: input.snapshotId,
    baseHeadCommit: input.commitId,
    architecture,
    sections,
    sectionContracts,
    decisions,
    constraints,
    resolvedQuestions,
    resolvedConflicts,
    relevantEvidence,
  });
  const inputHash = synthesisInputHash(canonical);

  // §24 — every design-reachable CRITICAL evidence must be fresh, with
  // gate-time deterministic revalidation. Supporting/informational state is
  // recorded but never blocks synthesis entry. A failure throws → the whole
  // section-completion transaction rolls back.
  const criticalRefs = relevantEvidence
    .filter((entry) => entry.criticality === "critical")
    .map((entry) => ({ evidenceId: entry.evidenceId, revision: entry.revision }));
  const gate = evaluateCriticalEvidenceGateInTx(tx, {
    runId: input.runId,
    workspaceId: input.workspaceId,
    requiredRefs: criticalRefs,
    recheck: true,
    clock,
  });
  if (!gate.ok) {
    throw evidenceNeedsValidationError(gate.failures);
  }

  const inputId = `synin_${clock.newId()}`;
  insertSynthesisInputInTx(tx, {
    runId: input.runId,
    inputSeq: nextSynthesisInputSeqInTx(tx, input.runId),
    inputId,
    baseRunRevision: input.baseRunRevision,
    baseHeadSnapshotId: input.snapshotId,
    baseHeadCommitId: input.commitId,
    canonicalJson: canonicalJson(canonical),
    inputHash,
    createdAt: clock.nowIso(),
    refs: [
      ...architecture,
      ...sections,
      ...decisions,
      ...constraints,
      ...resolvedQuestions,
      ...resolvedConflicts,
    ].map((entry) => ({ kind: entry.kind, artifactId: entry.id, revision: entry.revision })),
    evidence: relevantEvidence.map(
      (entry): SynthesisInputEvidenceRow => ({
        evidenceId: entry.evidenceId,
        evidenceRevision: entry.revision,
        confidence: entry.confidence,
        criticality: entry.criticality,
        validationStrategy: entry.validationStrategy,
        frozenState: entry.state,
        frozenLastEventSeq: entry.lastValidationEventSeq,
      }),
    ),
  });
  return { inputId, inputHash, relevantEvidence: relevantEvidence.length };
}

// ---------------------------------------------------------------------------
// submit_synthesis / submit_validation / request_reopen
// ---------------------------------------------------------------------------

export interface SubmitSynthesisInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  permissionMode: string;
  inputId: string;
  inputHash: string;
  /** Raw manifest as received; validated here (SYNTHESIS_MANIFEST_INVALID). */
  manifest: unknown;
  requestId: string;
  callerAgent: CallerAgent | null;
}

export interface SubmitSynthesisResult {
  manifestId: string;
  manifestHash: string;
  inputId: string;
  inputHash: string;
  stage: PlanningRun["stage"];
  runRevision: number;
  idempotent: boolean;
}

export interface SubmitValidationInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  manifestId: string;
  manifestHash: string;
  inputId: string;
  inputHash: string;
  /** Raw findings array as received; validated here (VALIDATION_REPORT_INVALID). */
  findings: unknown;
  requestId: string;
  callerAgent: CallerAgent | null;
}

export interface SubmitValidationResult {
  reportId: string;
  reportHash: string;
  manifestId: string;
  isClean: boolean;
  findingIds: string[];
  idempotent: boolean;
}

export interface RequestReopenInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  target: "detail" | "architecture";
  reason: string;
  findingIds?: string[];
  requestId: string;
  callerAgent: CallerAgent | null;
}

export interface RequestReopenResult {
  stage: PlanningRun["stage"];
  runRevision: number;
  reviewRequired: string[];
  reviewEvent: string;
}

export function createSynthesisService(store: PlanStore, clock: StoreClock) {
  return {
    /**
     * §41–§45/§78/§84/§86/§89 — submit the derived SynthesisManifest for the
     * run's current frozen input. One transaction: authority fences → exact
     * input reload → HEAD match → at-most-one manifest → critical-Evidence
     * gate → structural ref membership → immutable insert + the single
     * synthesis→validation run bump. Never touches Plan Memory.
     */
    submitSynthesis(input: SubmitSynthesisInput): SubmitSynthesisResult {
      return store.withWrite((tx) => {
        // §44 — same-invocation retry replays the recorded result (the stage
        // has already moved to validation, so this precedes the stage gate).
        const replay = getSynthesisManifestByRequestInTx(tx, input.runId, input.requestId);
        if (replay !== null) {
          const replayManifest = validateSynthesisManifestOrThrow(input.manifest, input.runId);
          const replayHash = synthesisManifestHash({
            ...replayManifest,
            inputId: replay.inputId,
            inputHash: replay.inputHash,
          });
          if (replay.manifestHash !== replayHash) {
            throw new RuntimeError("IDEMPOTENCY_CONFLICT", "the same synthesis operation was submitted with different content", {
              detail: { runId: input.runId, requestId: input.requestId },
            });
          }
          const run = loadRunInTx(tx, input.runId);
          return {
            manifestId: replay.manifestId,
            manifestHash: replay.manifestHash,
            inputId: replay.inputId,
            inputHash: replay.inputHash,
            stage: run.stage,
            runRevision: run.revision,
            idempotent: true,
          };
        }

        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });
        if (run.lifecycle !== "active") {
          throw runStateError("RUN_TERMINAL", `PlanningRun '${run.runId}' is ${run.lifecycle} and can no longer mutate`, {
            runId: run.runId,
            lifecycle: run.lifecycle,
          });
        }
        // §3/§42 — the validator subagent can never submit synthesis.
        if (input.callerAgent?.agentType !== undefined && input.callerAgent.agentType !== "") {
          throw synthesisError(
            "VALIDATOR_MUTATION_FORBIDDEN",
            `submit_synthesis is a main planning capability; caller is attested as '${input.callerAgent.agentType}'`,
            { agentType: input.callerAgent.agentType },
          );
        }
        if (input.permissionMode !== "plan") {
          throw new RuntimeError("PLAN_MODE_REQUIRED", "submit_synthesis requires permission_mode=plan", {
            detail: { permissionMode: input.permissionMode },
          });
        }
        // §19/§26 — the exact frozen input, then HEAD match.
        const latest = getLatestSynthesisInputInTx(tx, input.runId);
        if (latest === null) {
          throw synthesisError(
            "SYNTHESIS_INPUT_REQUIRED",
            "this run has no frozen SynthesisInput (legacy synthesis runs must request_reopen and re-complete their sections)",
            { runId: input.runId },
          );
        }
        // §45/§86 — at most one accepted manifest per input. This check sits
        // BEFORE the stage gate so a racing loser sees the already-submitted
        // identity of the input, not the stage the winner moved it to.
        if (getSynthesisManifestByInputInTx(tx, input.runId, latest.inputId) !== null) {
          throw synthesisError("SYNTHESIS_ALREADY_SUBMITTED", "this frozen input already has an accepted manifest", {
            inputId: latest.inputId,
          });
        }
        if (run.stage !== "synthesis") {
          throw new RuntimeError(
            "CAPABILITY_NOT_AVAILABLE",
            `submit_synthesis is available only at stage synthesis (run is at '${run.stage}')`,
            { detail: { stage: run.stage } },
          );
        }
        if (input.inputId !== latest.inputId) {
          throw synthesisError("SYNTHESIS_STALE", `submitted input '${input.inputId}' is not the current input '${latest.inputId}'`, {
            expected: latest.inputId,
            detected: input.inputId,
          });
        }
        if (input.inputHash !== latest.inputHash) {
          throw synthesisError("SYNTHESIS_REF_INVALID", "submitted input hash does not match the frozen input", {
            expected: latest.inputHash,
            detected: input.inputHash,
          });
        }
        const head = getHeadPairInTx(tx, input.runId);
        if (
          head === null ||
          head.headSnapshotId !== latest.baseHeadSnapshotId ||
          (head.headCommitId ?? null) !== latest.baseHeadCommitId
        ) {
          throw synthesisError("SYNTHESIS_STALE", "current HEAD no longer matches the frozen input's base", {
            baseSnapshot: latest.baseHeadSnapshotId,
            baseCommit: latest.baseHeadCommitId,
            headSnapshot: head?.headSnapshotId ?? null,
          });
        }
        // §78 — critical evidence gate-time revalidation. Failures persist the
        // real freshness facts (the gate appends SOURCE_CHANGED events) but no
        // manifest; the stage stays synthesis.
        const relevant = listSynthesisInputEvidenceInTx(tx, input.runId, latest.inputId);
        const gate = evaluateCriticalEvidenceGateInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          requiredRefs: relevant
            .filter((entry) => entry.criticality === "critical")
            .map((entry) => ({ evidenceId: entry.evidenceId, revision: entry.evidenceRevision })),
          recheck: true,
          clock,
        });
        if (!gate.ok) {
          throw evidenceNeedsValidationError(gate.failures);
        }

        // Structural validation + §38/§40 — every ref must belong to the input.
        // The model's echoed input identity inside the manifest payload is
        // overridden with the authoritative frozen values before hashing.
        const manifest = validateSynthesisManifestOrThrow(input.manifest, input.runId);
        const authoritative = { ...manifest, inputId: latest.inputId, inputHash: latest.inputHash };
        const inputRefs = new Set(
          listSynthesisInputRefsInTx(tx, input.runId, latest.inputId).map((ref) => `${ref.kind}\u0000${ref.artifactId}\u0000${ref.revision}`),
        );
        const evidenceRefs = new Set(relevant.map((entry) => `${entry.evidenceId}\u0000${entry.evidenceRevision}`));
        for (const ref of manifestSupportRefs(authoritative)) {
          if (ref.kind === "evidence") {
            if (!evidenceRefs.has(`${ref.id}\u0000${ref.revision}`)) {
              throw synthesisError("SYNTHESIS_REF_INVALID", `manifest cites evidence '${ref.id}'@${ref.revision} outside the frozen input`, {
                ref,
              });
            }
            continue;
          }
          const memoryRef = bundleRefToMemoryRef(ref);
          if (memoryRef === null || !inputRefs.has(`${memoryRef.kind}\u0000${memoryRef.id}\u0000${memoryRef.revision}`)) {
            throw synthesisError("SYNTHESIS_REF_INVALID", `manifest cites '${ref.id}' (${ref.kind}) outside the frozen input`, { ref });
          }
        }

        const manifestId = `synm_${clock.newId()}`;
        const manifestHash = synthesisManifestHash(authoritative);
        const now = clock.nowIso();
        // §84 — synthesis → validation is the ONE run bump this operation owns.
        bumpRunStageInTx(tx, { runId: input.runId, expectedRevision: run.revision, nextStage: "validation" }, now);
        insertSynthesisManifestInTx(
          tx,
          {
            runId: input.runId,
            manifestId,
            inputId: latest.inputId,
            inputHash: latest.inputHash,
            canonicalJson: canonicalJson(authoritative),
            manifestHash,
            requestId: input.requestId,
            createdAt: now,
          },
          manifestSupportRefs(authoritative).map((ref) => ({
            kind: ref.kind,
            artifactId: ref.id,
            revision: ref.revision,
          })),
        );
        return {
          manifestId,
          manifestHash,
          inputId: latest.inputId,
          inputHash: latest.inputHash,
          stage: "validation",
          runRevision: run.revision + 1,
          idempotent: false,
        };
      });
    },

    /**
     * §52–§58/§79/§87/§88 — persist the isolated validator's report. Requires
     * the signed validator attestation; never moves stage, run revision, or
     * HEAD; at most one accepted report per manifest.
     */
    submitValidation(input: SubmitValidationInput): SubmitValidationResult {
      return store.withWrite((tx) => {
        // §57 — same-invocation retry replays.
        const replay = getValidationReportByRequestInTx(tx, input.runId, input.requestId);
        if (replay !== null) {
          const findings = validateValidationFindings(input.findings);
          const recomputed = semanticValidationReportHash({
            version: 1,
            inputId: replay.inputId,
            inputHash: replay.inputHash,
            manifestId: replay.manifestId,
            manifestHash: replay.manifestHash,
            findings,
          });
          if (replay.reportHash !== recomputed) {
            throw new RuntimeError("IDEMPOTENCY_CONFLICT", "the same validation operation was submitted with different content", {
              detail: { runId: input.runId, requestId: input.requestId },
            });
          }
          return {
            reportId: replay.reportId,
            reportHash: replay.reportHash,
            manifestId: replay.manifestId,
            isClean: replay.isClean,
            findingIds: listValidationFindingsInTx(tx, input.runId, replay.reportId).map((f) => f.findingId),
            idempotent: true,
          };
        }

        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });
        if (run.lifecycle !== "active") {
          throw runStateError("RUN_TERMINAL", `PlanningRun '${run.runId}' is ${run.lifecycle} and can no longer mutate`, {
            runId: run.runId,
            lifecycle: run.lifecycle,
          });
        }
        // §5/§53 — the caller must be the ATTESTED validator, even with a
        // perfect manifest/report schema (§98).
        if (input.callerAgent?.agentType !== VALIDATOR_AGENT_TYPE) {
          throw synthesisError(
            "VALIDATOR_CALLER_REQUIRED",
            `submit_validation is validator-only; caller is${input.callerAgent?.agentType ? ` attested as '${input.callerAgent.agentType}'` : " not an attested subagent"}`,
            { agentType: input.callerAgent?.agentType ?? null },
          );
        }
        if (run.stage !== "validation") {
          throw synthesisError("VALIDATION_STALE", `submit_validation requires stage validation (run is at '${run.stage}')`, {
            stage: run.stage,
          });
        }
        const latest = getLatestSynthesisInputInTx(tx, input.runId);
        if (latest === null || input.inputId !== latest.inputId || input.inputHash !== latest.inputHash) {
          throw synthesisError("VALIDATION_STALE", "the frozen input changed while validation was running", {
            expected: latest?.inputId ?? null,
            detected: input.inputId,
          });
        }
        const manifest = getSynthesisManifestInTx(tx, input.runId, input.manifestId);
        if (manifest === null || manifest.inputId !== latest.inputId || manifest.manifestHash !== input.manifestHash) {
          throw synthesisError("VALIDATION_STALE", "the submitted manifest is not the run's current manifest", {
            manifestId: input.manifestId,
          });
        }
        // §79/§88 — HEAD must still match the frozen base.
        const head = getHeadPairInTx(tx, input.runId);
        if (
          head === null ||
          head.headSnapshotId !== latest.baseHeadSnapshotId ||
          (head.headCommitId ?? null) !== latest.baseHeadCommitId
        ) {
          throw synthesisError("VALIDATION_STALE", "current HEAD no longer matches the frozen input's base", {
            baseSnapshot: latest.baseHeadSnapshotId,
          });
        }
        // §58/§87 — one accepted report per manifest.
        if (getValidationReportByManifestInTx(tx, input.runId, input.manifestId) !== null) {
          throw synthesisError("VALIDATION_ALREADY_SUBMITTED", "this manifest already has an accepted validation report", {
            manifestId: input.manifestId,
          });
        }

        let findings: ValidationFinding[];
        try {
          findings = validateValidationFindings(input.findings);
        } catch (err) {
          throw synthesisError(
            "VALIDATION_REPORT_INVALID",
            err instanceof Error ? err.message : "validation findings are invalid",
            { runId: input.runId },
          );
        }
        // §37/§49 — every finding ref must belong to the frozen bundle.
        const inputRefs = new Set(
          listSynthesisInputRefsInTx(tx, input.runId, latest.inputId).map((ref) => `${ref.kind}\u0000${ref.artifactId}\u0000${ref.revision}`),
        );
        const evidenceRefs = new Set(
          listSynthesisInputEvidenceInTx(tx, input.runId, latest.inputId).map((entry) => `${entry.evidenceId}\u0000${entry.evidenceRevision}`),
        );
        const assertBundleRefs = (refs: SynthesisBundleRef[], context: string): void => {
          for (const ref of refs) {
            if (ref.kind === "evidence") {
              if (!evidenceRefs.has(`${ref.id}\u0000${ref.revision}`)) {
                throw synthesisError("VALIDATION_REPORT_INVALID", `${context} cites evidence '${ref.id}'@${ref.revision} outside the frozen bundle`, {
                  ref,
                });
              }
              continue;
            }
            const memoryRef = bundleRefToMemoryRef(ref);
            if (memoryRef === null || !inputRefs.has(`${memoryRef.kind}\u0000${memoryRef.id}\u0000${memoryRef.revision}`)) {
              throw synthesisError("VALIDATION_REPORT_INVALID", `${context} cites '${ref.id}' (${ref.kind}) outside the frozen bundle`, { ref });
            }
          }
        };
        for (const finding of findings) {
          assertBundleRefs(finding.subjectRefs, `finding '${finding.kind}' subject refs`);
          assertBundleRefs(finding.supportingRefs, `finding '${finding.kind}' supporting refs`);
        }

        const isClean = derivedIsClean(findings);
        const reportId = `valrep_${clock.newId()}`;
        const reportHash = semanticValidationReportHash({
          version: 1,
          inputId: latest.inputId,
          inputHash: latest.inputHash,
          manifestId: input.manifestId,
          manifestHash: input.manifestHash,
          findings,
        });
        // §56 — the report NEVER changes stage, run revision, or HEAD.
        insertValidationReportInTx(
          tx,
          {
            runId: input.runId,
            reportId,
            manifestId: input.manifestId,
            inputId: latest.inputId,
            inputHash: latest.inputHash,
            manifestHash: input.manifestHash,
            isClean,
            canonicalJson: canonicalJson({
              version: 1,
              inputId: latest.inputId,
              inputHash: latest.inputHash,
              manifestId: input.manifestId,
              manifestHash: input.manifestHash,
              findings,
            }),
            reportHash,
            validatorAgentJson: canonicalJson({
              agentId: input.callerAgent.agentId ?? null,
              agentType: input.callerAgent.agentType,
            }),
            requestId: input.requestId,
            createdAt: clock.nowIso(),
          },
          findings.map((finding) => ({
            findingId: `vf_${clock.newId()}`,
            kind: finding.kind,
            summary: finding.summary,
            detail: finding.detail,
            subjectRefsJson: canonicalJson(finding.subjectRefs),
            supportingRefsJson: canonicalJson(finding.supportingRefs),
          })),
        );
        const stored = listValidationFindingsInTx(tx, input.runId, reportId).map((f) => f.findingId);
        return { reportId, reportHash, manifestId: input.manifestId, isClean, findingIds: stored, idempotent: false };
      });
    },

    /**
     * §59–§67 — reopen the run from synthesis/validation/final back into the
     * normal design workflow. Main-agent-only, no formal approval, moves the
     * stage and run revision exactly once and derives the Section review
     * policy; never mutates Plan Memory and never touches the historical
     * input/manifest/report/candidate records. From final (Phase 13 §65) the
     * reopen is legal ONLY before FinalPlan approval (§67) and atomically
     * supersedes the awaiting final Proposal (§66).
     */
    requestReopen(input: RequestReopenInput): RequestReopenResult {
      return store.withWrite((tx) => {
        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });
        if (run.lifecycle !== "active") {
          throw runStateError("RUN_TERMINAL", `PlanningRun '${run.runId}' is ${run.lifecycle} and can no longer mutate`, {
            runId: run.runId,
            lifecycle: run.lifecycle,
          });
        }
        // §61 — the validator only ever submits findings.
        if (input.callerAgent?.agentType !== undefined && input.callerAgent.agentType !== "") {
          throw synthesisError(
            "VALIDATOR_MUTATION_FORBIDDEN",
            `request_reopen is a main planning capability; caller is attested as '${input.callerAgent.agentType}'`,
            { agentType: input.callerAgent.agentType },
          );
        }
        // §60/§65 — synthesis/validation/final are the reopen origins.
        if (run.stage !== "synthesis" && run.stage !== "validation" && run.stage !== "final") {
          throw synthesisError("REOPEN_REQUEST_INVALID", `request_reopen operates only from synthesis/validation/final (run is at '${run.stage}')`, {
            stage: run.stage,
          });
        }
        // §67 — once the FinalPlan is approved, Phase 14 owns the boundary.
        if (run.stage === "final" && getFinalPlanInTx(tx, input.runId) !== null) {
          throw synthesisError(
            "FINAL_PLAN_ALREADY_APPROVED",
            "the FinalPlan is approved; the run can no longer be reopened",
            { runId: input.runId },
          );
        }
        if (input.target !== "detail" && input.target !== "architecture") {
          throw synthesisError("REOPEN_REQUEST_INVALID", `reopen target must be detail or architecture (got '${String(input.target)}')`, {
            target: input.target,
          });
        }
        if (typeof input.reason !== "string" || input.reason.trim() === "") {
          throw synthesisError("REOPEN_REQUEST_INVALID", "reopen requires a non-empty reason");
        }
        // §60 — finding_ids are a validation-stage input: synthesis has no
        // independent finding authority to resolve them against.
        const findingIds = input.findingIds ?? [];
        if (findingIds.length > 0 && run.stage !== "validation") {
          throw synthesisError("REOPEN_REQUEST_INVALID", "finding_ids require the validation stage", { stage: run.stage });
        }

        const event = input.target === "detail" ? "REOPEN_DETAIL" : "REOPEN_ARCHITECTURE";
        const targetStage = nextStage(run.stage, event);

        // §63/§64 — Section review derivation (completed → needs_review).
        const completed = listSectionWorkflowStatesInTx(tx, input.runId)
          .filter((state) => state.status === "completed")
          .map((state) => state.sectionId)
          .sort();
        let affected: string[] = [];
        let reviewEvent: "SYNTHESIS_REVIEW_REQUIRED" | "VALIDATION_REVIEW_REQUIRED" | "ARCHITECTURE_REVIEW_REQUIRED";
        if (input.target === "architecture") {
          // §64 — the architecture foundation reopens; no completion can be
          // assumed valid anymore.
          reviewEvent = "ARCHITECTURE_REVIEW_REQUIRED";
          affected = [...completed];
        } else if (run.stage === "synthesis") {
          // §63 — fail-closed v0.1: no independent finding authority exists
          // before validation, so every completed Section re-enters review.
          reviewEvent = "SYNTHESIS_REVIEW_REQUIRED";
          affected = [...completed];
        } else {
          reviewEvent = "VALIDATION_REVIEW_REQUIRED";
          if (findingIds.length > 0) {
            // Resolve the exact Section refs named by the findings; no Section
            // refs at all → conservatively mark ALL completed Sections.
            const namedSections = resolveFindingSectionsInTx(tx, input.runId, findingIds);
            if (namedSections === null) {
              throw synthesisError("REOPEN_REQUEST_INVALID", "one or more finding_ids do not exist in this run's reports", {
                findingIds,
              });
            }
            if (namedSections.length === 0) {
              affected = [...completed];
            } else {
              // §63 — the named Sections themselves plus their DAG downstream,
              // intersected with what is actually completed.
              const head = getHeadPairInTx(tx, input.runId);
              const headRefs: MemoryRef[] = head === null ? [] : (getSnapshotRefsInTx(tx, head.headSnapshotId) ?? []);
              const downstream = listDownstreamSectionClosure(
                headRefs,
                (sectionId) => {
                  const ref = headRefs.find((candidate) => candidate.kind === "section" && candidate.id === sectionId);
                  return ref === undefined ? [] : sectionDependenciesInTx(tx, input.runId, sectionId, ref.revision);
                },
                namedSections,
              );
              affected = [...new Set([...namedSections, ...downstream])].filter((sectionId) => completed.includes(sectionId)).sort();
            }
          } else {
            // §63 — validation findings exist but none were specified (or the
            // report carries none): conservative full review.
            affected = [...completed];
          }
        }
        // §66 — reopening final while the Final Proposal is still awaiting
        // atomically supersedes it; the Candidate/Audit history is preserved
        // (immutable records, never deleted). A later cycle freezes a NEW
        // candidate (§68).
        if (run.stage === "final") {
          const awaiting = findAwaitingProposalStateInTx(tx, input.runId);
          if (awaiting !== null) {
            const superseded = transitionProposalStateInTx(
              tx,
              { runId: input.runId, proposalId: awaiting.proposalId, revision: awaiting.revision, to: "superseded" },
              clock.nowIso(),
            );
            if (!superseded) {
              throw synthesisError("REOPEN_REQUEST_INVALID", "the awaiting final proposal could not be superseded", {
                proposalId: awaiting.proposalId,
              });
            }
          }
        }

        for (const sectionId of affected) {
          transitionSectionWorkflowInTx(
            tx,
            {
              runId: input.runId,
              sectionId,
              eventType: reviewEvent,
              reasonCode: `reopen_to_${input.target}`,
              detail: { requestId: input.requestId, reason: input.reason, findingIds },
            },
            clock,
          );
        }

        const now = clock.nowIso();
        // §62/§84 — stage moves, revision +1 EXACTLY once, HEAD untouched.
        bumpRunStageInTx(tx, { runId: input.runId, expectedRevision: run.revision, nextStage: targetStage }, now);
        return { stage: targetStage, runRevision: run.revision + 1, reviewRequired: affected, reviewEvent };
      });
    },
  };
}

/**
 * §63 — resolve validation finding ids to the Section identities their
 * subject/supporting refs name. Returns null when an id is unknown; returns
 * [] when the findings exist but name no Section (the caller then applies the
 * conservative all-sections policy).
 */
function resolveFindingSectionsInTx(tx: StoreTx, runId: string, findingIds: string[]): string[] | null {
  const sections = new Set<string>();
  for (const findingId of findingIds) {
    const row = tx
      .prepare(
        "SELECT subject_refs_json AS subjectJson, supporting_refs_json AS supportingJson "
        + "FROM semantic_validation_findings WHERE run_id = ? AND finding_id = ?",
      )
      .get(runId, findingId) as { subjectJson: string; supportingJson: string } | undefined;
    if (row === undefined) return null;
    for (const ref of [...JSON.parse(row.subjectJson), ...JSON.parse(row.supportingJson)] as SynthesisBundleRef[]) {
      if (ref.kind === "section" || ref.kind === "section_contract") sections.add(ref.id);
    }
  }
  return [...sections].sort();
}
