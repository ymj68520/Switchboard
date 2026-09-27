/**
 * Ultra Plan for OpenCode — plugin entry point.
 *
 * Registers, using verified @opencode-ai/plugin 1.18 APIs only:
 * - the /ultra-plan command (config hook → `config.command`),
 * - the planning agent (config hook → `config.agent`),
 * - the full Ultra Plan tool surface (plugin `tool` hook),
 * - repository-tool observation recording (`tool.execute.after` hook) feeding
 *   the observation ledger that evidence promotion requires,
 * - the CONTEXT ASSEMBLER output injected into planning-model system context
 *   via `experimental.chat.system.transform` (R2): the deterministic L0-L5
 *   block assembled from ONE snapshot-consistent read of the store — the ONLY
 *   production context path (no duplicate legacy fragment).
 *
 * Adapter-level context budget configuration (R2 brief §46): deterministic,
 * provider-neutral environment settings read once at hook creation —
 *   ULTRA_PLAN_CONTEXT_BUDGET_TOKENS  (estimated-token ceiling; default 12000)
 *   ULTRA_PLAN_CONTEXT_OVERFLOW       ("render" (default) | "fail")
 * Core never hardcodes a provider-specific context window.
 */
import type { Hooks, Plugin } from "@opencode-ai/plugin";

import {
  assemblePlanningContext,
  renderTraceLog,
  recordLatestTrace,
  DEFAULT_CONTEXT_BUDGET,
} from "./context/assembler.js";
import { setValidationProtocolForContext } from "./context/state.js";
import { SEMANTIC_VALIDATION_PROTOCOL } from "./validation/protocol.js";
import { getProjectInstance } from "./runtime/instance.js";
import { ObservationIDs, nextSequence } from "./core/ids.js";
import type { Observation, ObservationLedger, SourceLocator } from "./repository/observations.js";
import { getUltraPlanInstance } from "./runtime/instance.js";
import { createUltraPlanTools } from "./tools/registry.js";

// The synthesis-context report lookup binds the frozen validator protocol.
setValidationProtocolForContext(SEMANTIC_VALIDATION_PROTOCOL);

/**
 * The deterministic adapter-level context budget (R2 brief §46). Invalid or
 * non-positive values fall back to the documented default — never an error
 * surface at plugin load.
 */
export function resolveContextBudgetConfig(options: { contextBudgetTokens?: number; contextOverflow?: "render" | "fail" } = {}): {
  budgetTokens: number;
  overflow: "render" | "fail";
} {
  const fromEnv = process.env.ULTRA_PLAN_CONTEXT_BUDGET_TOKENS;
  const parsed = fromEnv !== undefined ? Number.parseInt(fromEnv, 10) : Number.NaN;
  const budgetTokens =
    options.contextBudgetTokens ??
    (Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_BUDGET.budgetTokens);
  const overflow =
    options.contextOverflow ??
    (process.env.ULTRA_PLAN_CONTEXT_OVERFLOW === "fail" ? ("fail" as const) : DEFAULT_CONTEXT_BUDGET.overflow);
  return { budgetTokens, overflow };
}

/**
 * Best-effort source locator from repository-tool arguments. Observation
 * richness grows with the observation ledger work; even tool-name-level
 * provenance is enough to enforce that evidence references a real observation.
 */
function locatorFromArgs(args: unknown): SourceLocator | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const file = record.filePath ?? record.path ?? record.file;
  if (typeof file === "string") return { kind: "file", path: file };
  if (typeof record.command === "string") return { kind: "command", command: record.command };
  if (typeof record.pattern === "string") return { kind: "command", command: record.pattern };
  return undefined;
}

/** Tools that ARE the harness must not observe themselves as repository activity. */
function isHarnessTool(toolName: string): boolean {
  return toolName === "ultraplan_start" || toolName.startsWith("ultraplan_") || toolName === "plan_memory";
}

async function recordObservation(
  ledger: ObservationLedger,
  sessionID: string,
  toolName: string,
  args: unknown,
): Promise<void> {
  const existing = await ledger.list(sessionID);
  const observation: Observation = {
    id: ObservationIDs.from(nextSequence(existing.map((o) => o.id), ObservationIDs.prefix)),
    tool: toolName,
    ...(locatorFromArgs(args) ? { source: locatorFromArgs(args) } : {}),
    observedAt: new Date().toISOString(),
  };
  await ledger.append(sessionID, observation);
}

/**
 * Build the Ultra Plan plugin hooks. Input-free factory so embedders and tests
 * can wire the hooks without an OpenCode server connection. When the host's
 * SDK client is provided, the isolated OpenCode semantic validator (Phase 2G)
 * is bound to the controller.
 */
export function createUltraPlanHooks(project?: {
  projectID: string;
  client?: import("@opencode-ai/plugin").PluginInput["client"];
  contextBudgetTokens?: number;
  contextOverflow?: "render" | "fail";
}): Hooks {
  const instance = project
    ? getProjectInstance(project.projectID, { ...(project.client ? { client: project.client } : {}) })
    : getUltraPlanInstance();
  const { runtime, controller, ledger, store } = instance;
  const contextBudget = resolveContextBudgetConfig({
    ...(project?.contextBudgetTokens !== undefined ? { contextBudgetTokens: project.contextBudgetTokens } : {}),
    ...(project?.contextOverflow !== undefined ? { contextOverflow: project.contextOverflow } : {}),
  });
  return {
    config: async (config) => {
      runtime.applyToConfig(config);
    },
    tool: createUltraPlanTools(controller),
    /**
     * Explicit plan-entry admission (Phase 2A.1 Correction B): the ONLY path
     * that mints a start admission is the user invoking /ultra-plan. The
     * model cannot invoke command hooks and cannot pass arguments here.
     */
    "command.execute.before": async (input) => {
      if (input.command === runtime.spec.commandName) {
        controller.issueStartAdmission(input.sessionID);
      }
    },
    "tool.execute.after": async (input) => {
      if (isHarnessTool(input.tool)) return;
      await recordObservation(ledger, input.sessionID, input.tool, input.args);
    },
    /**
     * Phase 2J §36/§78: the deterministic runtime-handoff trigger. When the
     * session goes idle with a handoff_pending run, the Harness recovery
     * path performs the runtime Build handoff — no planning-model turn or
     * decision is involved. All other events (and any failure) are no-ops:
     * the durable delivery record carries the state.
     */
    event: async (input) => {
      if (input.event.type !== "session.idle") return;
      const sessionID = input.event.properties.sessionID;
      if (!sessionID) return;
      // Guarded: acts only on a handoff_pending run; never throws.
      await controller.maybeRecoverHandoff(sessionID);
    },
    /**
     * R2 §58: the SINGLE production context path. Every planning inference
     * receives ONE deterministic Ultra Plan context block assembled from ONE
     * snapshot-consistent store read — no duplicate legacy L0 fragment.
     *
     * - Active runs: the full L0-L5 assembly (protocol, run state, committed
     *   memory, active scope, working context, operations) with budget
     *   management and a ContextTrace.
     * - handoff_pending: the minimal non-authoritative handoff-status context
     *   (L0 boundary + L1 + read-only L5) — Build does not receive planning
     *   assembly (brief §66/§67).
     * - completed/aborted runs: NO injection — planning context stops (§65).
     *
     * Each assembly emits the structured `ultraplan.context.trace` diagnostic
     * (brief §73): refs, projection levels, retrieval reasons, budget usage —
     * never full prompt content. The live smoke parses this log.
     */
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const run = await store.findActiveRunBySession(input.sessionID);
      if (!run) return;
      const state = await store.capturePlanningContextState(run.id);
      if (!state) return;
      const assembled = assemblePlanningContext(state, {
        budgetTokens: contextBudget.budgetTokens,
        overflow: contextBudget.overflow,
        // handoff_pending: minimal non-authoritative status context — never a
        // planning L2-L4 assembly (§66/§67).
        ...(run.lifecycle === "handoff_pending" ? { mode: "handoff-status" as const } : {}),
      });
      output.system.push(assembled.rendered);
      recordLatestTrace(assembled.trace);
      // §89: trace logging is observability — a logging failure must never
      // change context correctness, so it is best-effort by construction.
      try {
        console.log(renderTraceLog(assembled.trace));
        for (const warning of assembled.warnings) {
          console.log(
            JSON.stringify({
              channel: "ultraplan.context.warning",
              planID: assembled.trace.planID,
              overBudget: assembled.trace.overBudget,
              budget: assembled.trace.budget,
              totalTokens: assembled.trace.totalTokens,
              message: warning,
            }),
          );
        }
      } catch {
        /* the injected context block is unaffected */
      }
    },
    dispose: async () => {
      instance.dispose();
    },
  };
}

/**
 * Production entry. The trusted OpenCode project identity selects the durable
 * per-project store; a store that cannot be opened fails the plugin loudly
 * (no silent in-memory fallback — that would destroy recovery guarantees).
 */
export const UltraPlanPlugin: Plugin = async (input) =>
  createUltraPlanHooks({ projectID: input.project.id, client: input.client });

export default UltraPlanPlugin;

// ---------------------------------------------------------------------------
// Public surface for embedders and tests
// ---------------------------------------------------------------------------
export { UltraPlanController } from "./core/controller.js";
export type {
  StartOrResumeResult,
  FlatMemoryRef,
  MemoryQuery,
  MemoryReadResult,
  RecordQuestionInput,
  ProposeQuestionResolutionInput,
  RaiseConflictInput,
  ProposalScopeInput,
  PreparedChange,
  PreparedChangeKind,
  PrepareProposalInput,
  ProposedDecisionInput,
  PromoteEvidenceInput,
  PreparedProposal,
  RequestCompletionInput,
  SectionCheckpointInput,
  SectionFocusInput,
  SynthesisRequestResult,
} from "./core/controller.js";
export { buildMemoryRef } from "./core/controller.js";
export { UltraPlanError, isUltraPlanError } from "./core/errors.js";
export type {
  BeginSynthesisResult,
  SubmitSynthesisManifestResult,
  SynthesisManifestDraftInput,
  SynthesisSourceRefInput,
  RunSemanticValidationResult,
  RequestReopenInput,
  RequestFinalizationResult,
  PrepareFinalPlanResult,
} from "./core/controller.js";
export * from "./synthesis/types.js";
export * from "./validation/types.js";
export { SEMANTIC_VALIDATION_PROTOCOL, SEMANTIC_VALIDATION_SYSTEM_PROMPT } from "./validation/protocol.js";
export { computeValidationReportHash, computeValidationReportHashFromRecord } from "./validation/hash.js";
export { parseValidatorOutput } from "./validation/parse.js";
export { validateValidatorOutput } from "./validation/validate.js";
export { buildValidationCapsule } from "./validation/capsule.js";
export { OpenCodeSemanticValidator } from "./validation/opencode-validator.js";
export {
  computeSynthesisInputHash,
  computeSynthesisManifestHash,
  computeSynthesisManifestHashFromRecord,
} from "./synthesis/hash.js";
export { assertSynthesisEntryReady, buildSynthesisAuthorityPayload } from "./synthesis/entry.js";
export { validateManifestDraft, sourceRefResolves } from "./synthesis/validate.js";
export { renderSynthesisCapsule } from "./synthesis/capsule.js";
export * from "./finalization/types.js";
export {
  computeEvidenceStateHash,
  computeEvidenceAuditHash,
  computeEvidenceAuditHashFromRecord,
  computeFinalPlanCandidateHash,
  computeFinalPlanCandidateHashFromRecord,
  evidenceSourceIdentity,
} from "./finalization/hash.js";
export {
  buildEvidenceAudit,
  collectReachableEvidence,
  computeCurrentEvidenceStateHash,
  computeEvidenceAuditCounts,
  evaluateEvidenceEntryRules,
  assertEvidenceAuditInternallyConsistent,
} from "./finalization/audit.js";
export { evaluateFinalizationGate } from "./finalization/gate.js";
export type { FinalizationGateDeps, ResolvedGateSection } from "./finalization/gate.js";
export {
  assembleFinalPlanCandidate,
  renderFinalPlanCandidatePreview,
} from "./finalization/candidate.js";
export {
  buildFinalPlanFromCandidate,
  computeFinalPlanHashFromContent,
  renderFinalPlanBody,
  finalizationIdentityMatchesCandidate,
} from "./finalization/plan.js";
export type { FinalPlanContent } from "./finalization/plan.js";
export { resolveSynthesisFinalization, resolveCurrentFinalProposal } from "./core/controller.js";
export type { HandoffRecoveryResult } from "./core/controller.js";
export * from "./handoff/types.js";
export { computeExecutionHandoffHash, computeExecutionHandoffHashFromRecord } from "./handoff/hash.js";
export {
  assembleExecutionHandoff,
  renderExecutionHandoffPrompt,
  HANDOFF_VALIDATION_REQUIREMENTS,
} from "./handoff/assemble.js";
export { OpenCodeExecutionAdapter } from "./runtime/opencode-execution-adapter.js";
export type {
  ExecutionRuntimeAdapter,
  ExecutionHandoffDispatchInput,
  HostDeliveryReceipt,
} from "./runtime/types.js";
export * from "./core/ids.js";
export * from "./core/refs.js";
export * from "./core/types.js";
export * from "./core/state-machine.js";
export * from "./core/invariants.js";
export * from "./core/capabilities.js";
export * from "./core/admissions.js";
export * from "./transaction/types.js";
export { computeProposalHash, proposalApprovalPayload, computePayloadHash } from "./transaction/hash.js";
export type { ProposalApprovalPayload } from "./transaction/hash.js";
export {
  applyApprovalDecision,
  type ApprovalRequest,
  type UserApprovalDecision,
  type ApprovalDecisionOutcome,
  type BegunApproval,
} from "./transaction/approval.js";
export type {
  Approval,
  PlanCommit,
  CommittedChange,
  ProposalChange,
  ProposalChangeKind,
  QuestionResolution,
  ApprovedDecision,
  ApprovedSectionRevision,
  ApprovedArchitecture,
  ApprovedConstraint,
  ApprovedSectionRoot,
  ArchitectureDraft,
  ConstraintDraft,
  SectionDecompositionDraft,
  SectionRevisionDraft,
} from "./transaction/types.js";
export type { CommitResult } from "./core/controller.js";
export { InMemoryPlanStore } from "./memory/store.js";
export type { TransactionFailure } from "./memory/store.js";
export type { PlanStore, CommitTransactionInput } from "./memory/store.js";
export { DurablePlanStore } from "./memory/durable-store.js";
export type { DurableStoreOptions, DurableCrashPoint } from "./memory/durable-store.js";
export { STORE_SCHEMA_VERSION } from "./memory/document.js";
export type { StoreDocument } from "./memory/document.js";
export { projectStorePath, getProjectInstance } from "./runtime/instance.js";
export * from "./memory/events.js";
export * from "./memory/snapshots.js";
export { renderStatus, renderNoRunStatus } from "./memory/renderer.js";
export type { StatusDetails } from "./memory/renderer.js";
export { renderProposalForApproval } from "./memory/approval-view.js";
export type { SectionRootSnapshot } from "./memory/snapshots.js";
export type { SectionDecompositionInput } from "./core/controller.js";
export { renderPlanningProtocol } from "./context/protocol.js";
export * from "./context/trace.js";
export * from "./context/state.js";
export * from "./context/projections.js";
export * from "./context/budget.js";
export * from "./context/assembler.js";
export * from "./repository/evidence.js";
export * from "./repository/observations.js";
export * from "./runtime/types.js";
export {
  OpenCodeRuntimeAdapter,
  DEFAULT_PLANNING_RUNTIME_SPEC,
  ULTRA_PLAN_COMMAND_TEMPLATE,
  ULTRA_PLAN_TOOL_NAMES,
} from "./runtime/opencode-plugin.js";
export { getUltraPlanInstance, resetUltraPlanInstance } from "./runtime/instance.js";
export type { UltraPlanInstance } from "./runtime/instance.js";
export { ULTRA_PLAN_START_TOOL, createUltraPlanStartTool } from "./tools/ultra-plan.js";
export { createUltraPlanTools } from "./tools/registry.js";
export {
  TOOL_CONTRACTS,
  FORBIDDEN_TOOL_NAMES,
  type ToolContract,
  type ToolAuthority,
} from "./tools/contracts.js";