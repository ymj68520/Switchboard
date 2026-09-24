/**
 * OpenCode runtime adapter boundary — Phase 1 brief §7.
 *
 * The core domain talks to OpenCode only through this interface. It must never
 * depend on arbitrary SDK objects directly. Capabilities are declared
 * explicitly (including what OpenCode v1.18 CANNOT do) so unsupported spec
 * features surface as data instead of silent no-ops.
 *
 * Verified against @opencode-ai/plugin 1.18.32 type definitions (see the
 * Phase 1 report for the full API findings).
 */
import type { Config as OpenCodeConfig } from "@opencode-ai/plugin";
import type { PlanID } from "../core/ids.js";

export interface RuntimeCapabilities {
  /** Register /ultra-plan via the `config` hook (`config.command` map). */
  registerCommand: boolean;
  /** Define the planning agent via the `config` hook (`config.agent` map). */
  registerAgent: boolean;
  /** Expose Ultra Plan tools via the plugin `tool` hook. */
  registerTools: boolean;
  /**
   * Imperatively switch the session's model at runtime. OpenCode v1.18 has no
   * such API — model selection binds per command/agent (config) or per
   * `client.session.prompt` call. The planning model is therefore applied via
   * the /ultra-plan command binding instead.
   */
  dynamicModelSwitch: boolean;
  /** Imperatively switch the session's agent at runtime (same situation). */
  dynamicAgentSwitch: boolean;
  /** Inject/transform planning context (`experimental.chat.system.transform`). */
  injectSystemContext: boolean;
  /** Observe repository-tool activity (`tool.execute.before/after` hooks). */
  observeRepositoryTools: boolean;
  /** Observe command invocations (`command.execute.before` hook). */
  observeCommandInvocation: boolean;
}

/** Names/addresses of the OpenCode-native mechanisms Ultra Plan uses. */
export interface PlanningRuntimeSpec {
  /** Command name registered under `config.command` (without the slash). */
  commandName: string;
  /** Planning agent name registered under `config.agent`. */
  agentName: string;
  /**
   * Planning model as "provider/model". Switchboard's tier→model policy
   * supplies this in a later phase; when absent the user's default model
   * applies.
   */
  planningModel?: string;
}

export interface RuntimeActivationInput {
  planID: PlanID;
  sessionID: string;
}

export interface RuntimeActivationResult {
  planID: PlanID;
  sessionID: string;
  /** Human-readable description of the mechanisms actually applied. */
  mechanism: readonly string[];
  /** Capabilities the spec wants but this runtime cannot do imperatively. */
  unsupported: readonly string[];
}

export interface UltraPlanRuntime {
  readonly capabilities: RuntimeCapabilities;
  readonly spec: PlanningRuntimeSpec;
  /** Apply the planning runtime registration to an OpenCode config object. */
  applyToConfig(config: OpenCodeConfig): void;
  /**
   * Put the session into the planning runtime configuration. Called by the
   * controller on /ultra-plan create AND resume (re-asserting is idempotent).
   */
  activatePlanningRuntime(input: RuntimeActivationInput): Promise<RuntimeActivationResult>;
}
