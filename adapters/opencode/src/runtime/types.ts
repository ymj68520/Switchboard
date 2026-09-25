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
  /**
   * Phase 2J §30: the host-native Build/execution agent used for the runtime
   * handoff turn. Defaults to the host's built-in Build agent ("build") —
   * never a second custom orchestration agent. An EMPTY string means
   * "configured but unresolvable" and leaves the handoff pending (§58).
   */
  executionAgent?: string;
  /**
   * Phase 2J §29: the execution model as "provider/model". Deterministic
   * role policy from adapter configuration — when absent the HOST DEFAULT
   * model applies (a host-supplied safe default, §57); the planning model is
   * deliberately NOT reused.
   */
  executionModel?: string;
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

// ---------------------------------------------------------------------------
// Phase 2J — the narrow ExecutionHandoff runtime boundary (§74/§75)
// ---------------------------------------------------------------------------

/**
 * Receipt built ONLY from host-observable identifiers (§22/§112): the target
 * session, the delivered user message id, and the execution agent/model the
 * host recorded on that message. No credentials or provider internals.
 */
export interface HostDeliveryReceipt {
  sessionID: string;
  messageID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
}

export interface ExecutionHandoffDispatchInput {
  /** Trusted runtime identity — exactly PlanningRun.sessionID (§27/§28). */
  sessionID: string;
  /** Resolved execution agent (undefined = host default). */
  agent: string | undefined;
  /** Resolved execution model (undefined = host default). */
  model: { providerID: string; modelID: string } | undefined;
  /** The deterministic handoff payload (includes the stable marker, §25). */
  prompt: string;
  /** §21 stable correlation key; also searchable in host history. */
  deliveryKey: string;
}

/**
 * The handoff side-effect boundary. CORE NEVER SEES SDK RESPONSE SHAPES
 * (§75): it sees dispatch/accept, receipt, and confirmation. Implementations
 * must NOT hold any PlanStore lock across these calls (§40) — the coordinator
 * invokes them between locked store operations.
 */
export interface ExecutionRuntimeAdapter {
  /**
   * Deliver the handoff turn into the EXISTING session. Semantics: the host
   * must accept the turn for execution WITHOUT the coordinator waiting for
   * the whole Build turn to complete (§105 — delivered ≠ Build finished).
   * Throws `HandoffDispatchRejected` BEFORE acceptance = definite failure
   * (retryable); any other failure = possibly-accepted ambiguity (the caller
   * keeps `dispatching` and recovers through findHandoffDelivery).
   */
  dispatchHandoff(input: ExecutionHandoffDispatchInput): Promise<{ accepted: true }>;
  /**
   * Query the host for the exact delivered handoff message in this session
   * (§43 recovery step 1; §24 option B). `undefined` = the host definitively
   * does not show the handoff (safe to re-dispatch). Implementations may
   * return `undefined` with `capability: false` semantics by being absent —
   * an adapter without query support forces fail-closed ambiguity instead.
   */
  findHandoffDelivery?(input: { sessionID: string; deliveryKey: string }): Promise<HostDeliveryReceipt | undefined>;
}

/**
 * A DEFINITE host rejection before acceptance (§61): the delivery remains
 * retryable. Every other dispatch failure is treated as possibly-accepted
 * ambiguity (§62) — never classified retry-safe by the core.
 */
export class HandoffDispatchRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffDispatchRejected";
  }
}
