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
