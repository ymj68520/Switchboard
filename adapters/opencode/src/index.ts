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
import { resolveSynthesisFinalization, resolveCurrentFinalProposal } from "./core/controller.js";
import { getProjectInstance } from "./runtime/instance.js";
import { ObservationIDs, nextSequence } from "./core/ids.js";
import type { Observation, ObservationLedger, SourceLocator } from "./repository/observations.js";
import { getUltraPlanInstance } from "./runtime/instance.js";
import { SEMANTIC_VALIDATION_PROTOCOL } from "./validation/protocol.js";
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
 * can wire the hooks without an OpenCode server connection. When the host's
 * SDK client is provided, the isolated OpenCode semantic validator (Phase 2G)
 * is bound to the controller.
 */
export function createUltraPlanHooks(project?: {
  projectID: string;
  client?: import("@opencode-ai/plugin").PluginInput["client"];
}): Hooks {
  const instance = project
    ? getProjectInstance(project.projectID, { ...(project.client ? { client: project.client } : {}) })
    : getUltraPlanInstance();
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
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const run = await store.findActiveRunBySession(input.sessionID);
      if (run) {
        // Phase 2D/2E1/2E2: identify the active Section (id/title/objective/
        // dependencies/revision state/validation) plus each direct
        // dependency's contract availability and approval status, and the
        // first deterministic completion blocker — for the L0 protocol.
        let activeSection: import("./context/protocol.js").PlanningProtocolInput["activeSection"];
        if (run.activeWork?.type === "section") {
          const section = await store.getSection(run.id, run.activeWork.id);
          if (section) {
            const dependencyContracts: { id: string; revision?: number; approved?: boolean }[] = [];
            let completionBlocked: string | undefined;
            for (const depID of section.dependencies) {
              const dep = await store.getSection(run.id, depID);
              dependencyContracts.push({
                id: depID,
                ...(dep?.approvedRevision !== undefined ? { revision: dep.approvedRevision } : {}),
                ...(dep ? { approved: dep.status === "approved" } : {}),
              });
              if (dep?.status !== "approved" && completionBlocked === undefined) {
                completionBlocked = `dependency ${depID} not approved`;
              }
            }
            if (completionBlocked === undefined && section.validation !== "valid") {
              completionBlocked = `validation ${section.validation}`;
            }
            activeSection = {
              id: section.id,
              title: section.title,
              objective: section.objective,
              dependencies: section.dependencies,
              ...(section.currentRevision !== undefined ? { currentRevision: section.currentRevision } : {}),
              validation: section.validation,
              dependencyContracts,
              ...(section.currentRevision !== undefined && completionBlocked !== undefined
                ? { completionBlocked }
                : {}),
            };
          }
        }
        // Phase 2F §46 + Phase 2G + Phase 2H: the minimal synthesis projection
        // for the L0 protocol — current input identity/base/hash, manifest
        // ref/hash, staleness, the CURRENT validation result, the
        // deterministic finalization state, and the open blocker count.
        let synthesis: import("./context/protocol.js").PlanningProtocolInput["synthesis"];
        if (run.stage === "synthesis") {
          const [latestInput, manifests] = await Promise.all([
            store.getLatestSynthesisInput(run.id),
            store.listSynthesisManifests(run.id),
          ]);
          const latestManifest = latestInput
            ? manifests
                .filter((manifest) => manifest.input.id === latestInput.id)
                .reduce<import("./synthesis/types.js").SynthesisManifest | undefined>(
                  (latest, manifest) => (latest === undefined || manifest.revision > latest.revision ? manifest : latest),
                  undefined,
                )
            : undefined;
          const report =
            latestInput && latestManifest
              ? ((await store.findValidationReportByIdentity(run.id, {
                  inputHash: latestInput.hash,
                  manifestHash: latestManifest.hash,
                  validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
                })) ?? undefined)
              : undefined;
          const finalization = await resolveSynthesisFinalization(store, run, latestInput ?? undefined, latestManifest, report ?? undefined);
          // Phase 2I §86: the current final_plan Proposal selects the
          // final-boundary L0 guidance.
          const finalProposal = await resolveCurrentFinalProposal(store, run, {
            candidateCurrent: finalization.candidate?.current === true,
          });
          synthesis = {
            ...(latestInput
              ? {
                  inputID: latestInput.id,
                  baseSnapshot: latestInput.baseSnapshot.id,
                  inputHash: latestInput.hash,
                  stale: run.headSnapshot !== latestInput.baseSnapshot.id,
                }
              : {}),
            ...(latestManifest
              ? { manifestRef: `${latestManifest.id}@${latestManifest.revision}`, manifestHash: latestManifest.hash }
              : {}),
            ...(report ? { validationResult: report.result } : {}),
            finalization: {
              state: finalization.state,
              ...(finalization.candidate ? { candidate: finalization.candidate } : {}),
            },
            ...(finalProposal
              ? {
                  finalProposal: {
                    ref: finalProposal.proposal.id,
                    status: finalProposal.proposal.status as "ready" | "awaiting_approval",
                  },
                }
              : {}),
            blockerCount:
              run.openQuestions.filter((q) => q.blocking && q.status === "open").length +
              run.conflicts.filter((c) => c.severity === "blocking" && c.status === "open").length,
          };
        }
        output.system.push(
          renderPlanningProtocol({ run, ...(activeSection ? { activeSection } : {}), ...(synthesis ? { synthesis } : {}) }),
        );
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