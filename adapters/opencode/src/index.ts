/**
 * Ultra Plan for OpenCode — plugin entry point.
 *
 * Registers, using verified @opencode-ai/plugin 1.18 APIs only:
 * - the /ultra-plan command (config hook → `config.command`),
 * - the planning agent (config hook → `config.agent`),
 * - the full Ultra Plan tool surface (plugin `tool` hook),
 * - repository-tool observation recording (`tool.execute.after` hook) feeding
 *   the observation ledger that evidence promotion requires,
 * - the L0 Planning Protocol injected into planning-model system context via
 *   `experimental.chat.system.transform`, gated on an active run.
 */
import type { Hooks, Plugin } from "@opencode-ai/plugin";

import { renderPlanningProtocol } from "./context/protocol.js";
import { getProjectInstance } from "./runtime/instance.js";
import { ObservationIDs, nextSequence } from "./core/ids.js";
import type { Observation, ObservationLedger, SourceLocator } from "./repository/observations.js";
import { getUltraPlanInstance } from "./runtime/instance.js";
import { createUltraPlanTools } from "./tools/registry.js";

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
 * can wire the hooks without an OpenCode server connection.
 */
export function createUltraPlanHooks(project?: { projectID: string }): Hooks {
  const instance = project ? getProjectInstance(project.projectID) : getUltraPlanInstance();
  const { runtime, controller, ledger, store } = instance;
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
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const run = await store.findActiveRunBySession(input.sessionID);
      if (run) output.system.push(renderPlanningProtocol({ run }));
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
  createUltraPlanHooks({ projectID: input.project.id });

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
  SynthesisRequestResult,
} from "./core/controller.js";
export { buildMemoryRef } from "./core/controller.js";
export { UltraPlanError, isUltraPlanError } from "./core/errors.js";
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
  QuestionResolution,
  ApprovedDecision,
  ApprovedSectionRevision,
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
export { renderPlanningProtocol } from "./context/protocol.js";
export * from "./context/trace.js";
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