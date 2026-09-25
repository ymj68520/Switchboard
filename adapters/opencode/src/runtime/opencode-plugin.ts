/**
 * OpenCode plugin runtime adapter — binds the UltraPlanRuntime boundary to the
 * actual @opencode-ai/plugin 1.18 APIs (config hook for command/agent/model
 * registration). Everything expressed here uses verified plugin API surface
 * only; see the Phase 1 report for findings and gaps.
 */
import type { Config as OpenCodeConfig } from "@opencode-ai/plugin";
import type {
  PlanningRuntimeSpec,
  RuntimeActivationInput,
  RuntimeActivationResult,
  RuntimeCapabilities,
  UltraPlanRuntime,
} from "./types.js";

export const DEFAULT_PLANNING_RUNTIME_SPEC: PlanningRuntimeSpec = {
  commandName: "ultra-plan",
  agentName: "ultraplan",
  // Phase 2J §30: the HOST-NATIVE Build agent is the default execution
  // runtime context — no second custom Build orchestration agent exists.
  // The execution model is left UNSET deliberately (§29/§57): the session's
  // host default model is the documented safe default; a tier-policy model
  // can be configured via `executionModel` ("provider/model").
  executionAgent: "build",
};

/**
 * The /ultra-plan command template. OpenCode command templates are prompts;
 * the deterministic work happens in the `ultraplan_start` tool the template
 * directs the model to invoke. `$ARGUMENTS` is OpenCode's argument
 * placeholder.
 */
export const ULTRA_PLAN_COMMAND_TEMPLATE = [
  "Start or resume the Ultra Plan planning run for this session.",
  "",
  "Call the `ultraplan_start` tool now (goal: $ARGUMENTS; omit the goal when no arguments were given).",
  "Then output the Ultra Plan status block returned by the tool verbatim, without paraphrasing it.",
].join("\n");

/** Tool names Ultra Plan registers (used for narrow agent-side exposure). */
export const ULTRA_PLAN_TOOL_NAMES = [
  "ultraplan_start",
  "ultraplan_status",
  "plan_memory",
  "ultraplan_record_question",
  "ultraplan_propose_question_resolution",
  "ultraplan_raise_conflict",
  "ultraplan_promote_evidence",
  "ultraplan_request_architecture",
  "ultraplan_prepare_proposal",
  "ultraplan_prepare_section_decomposition",
  "ultraplan_prepare_section_checkpoint",
  "ultraplan_request_section_focus",
  "ultraplan_request_user_approval",
  "ultraplan_request_completion",
  "ultraplan_request_reopen",
  "ultraplan_request_synthesis",
  "ultraplan_begin_synthesis",
  "ultraplan_submit_synthesis_manifest",
  "ultraplan_run_semantic_validation",
  "ultraplan_request_finalization",
  "ultraplan_prepare_final_plan",
] as const;

export class OpenCodeRuntimeAdapter implements UltraPlanRuntime {
  readonly capabilities: RuntimeCapabilities = {
    registerCommand: true,
    registerAgent: true,
    registerTools: true,
    // v1.18 binds model/agent per command/agent/prompt, not per session.
    // The /ultra-plan command binding achieves the planning-runtime switch;
    // the imperative capability is recorded as absent rather than faked.
    dynamicModelSwitch: false,
    dynamicAgentSwitch: false,
    injectSystemContext: true,
    observeRepositoryTools: true,
    observeCommandInvocation: true,
  };

  constructor(
    readonly spec: PlanningRuntimeSpec = DEFAULT_PLANNING_RUNTIME_SPEC,
    private readonly commandTemplate: string = ULTRA_PLAN_COMMAND_TEMPLATE,
  ) {}

  applyToConfig(config: OpenCodeConfig): void {
    config.command = {
      ...config.command,
      [this.spec.commandName]: {
        template: this.commandTemplate,
        description: "Start or resume an Ultra Plan planning run",
        agent: this.spec.agentName,
        ...(this.spec.planningModel ? { model: this.spec.planningModel } : {}),
      },
    };
    config.agent = {
      ...config.agent,
      [this.spec.agentName]: {
        mode: "primary",
        description: "Ultra Plan planning agent (frontier reasoning tier)",
        // Defense-in-depth exposure (Phase 2A.1 §5): explicitly enable the
        // Ultra Plan tool surface on the planning agent. OpenCode's per-agent
        // tool maps are overrides, not allowlists, so this narrows but cannot
        // fully hide the tools from other agents — which is exactly why the
        // controller still requires explicit command admission for planning
        // entry. Exposure is never the authorization mechanism.
        tools: Object.fromEntries(ULTRA_PLAN_TOOL_NAMES.map((name) => [name, true])),
        ...(this.spec.planningModel ? { model: this.spec.planningModel } : {}),
      },
    };
  }

  async activatePlanningRuntime(input: RuntimeActivationInput): Promise<RuntimeActivationResult> {
    const modelSuffix = this.spec.planningModel ? ` and model ${this.spec.planningModel}` : "";
    const mechanism = [
      `command "${this.spec.commandName}" bound to planning agent "${this.spec.agentName}"${modelSuffix} (applied via the config hook)`,
    ];
    const unsupported: string[] = [];
    if (!this.capabilities.dynamicModelSwitch) {
      unsupported.push(
        "dynamicModelSwitch: OpenCode v1.18 binds models per command/agent/prompt; the planning model is applied through the /ultra-plan command binding",
      );
    }
    if (!this.capabilities.dynamicAgentSwitch) {
      unsupported.push(
        "dynamicAgentSwitch: OpenCode v1.18 binds agents per command/agent/prompt; the planning agent is applied through the /ultra-plan command binding",
      );
    }
    return { ...input, mechanism, unsupported };
  }
}
