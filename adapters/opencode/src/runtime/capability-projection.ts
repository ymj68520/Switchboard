/**
 * Capability → OpenCode tool projection — v0.2.0 Phase 7A (directive §31-§34/§77).
 *
 * Honest mapping only: the projection states, per capability, whether the
 * installed OpenCode runtime can MECHANICALLY enforce it (per-call `tools`
 * override + per-agent `permission` rules) or whether it is SEMANTIC ONLY
 * (a subset of an allowed tool — never presented as enforced). No custom
 * sandbox is invented (§34), and no path-level enforcement is added.
 *
 * Verified against @opencode-ai/plugin 1.18.32 / SDK 1.18.32 (§10 audit):
 * - session.prompt accepts a per-call `tools: {[name]: boolean}` override.
 * - AgentConfig.permission covers edit / bash (pattern-scoped) / webfetch.
 * - git runs through the bash tool; network runs through webfetch OR bash.
 */
import { UltraPlanError } from "../core/errors.js";
import type { ExecutionCapabilityEnvelope } from "../core/execution-directive.js";

export type CapabilityEnforceability = "mechanical" | "semantic_only";

export interface CapabilityProjectionEntry {
  capability: keyof ExecutionCapabilityEnvelope;
  enforceability: CapabilityEnforceability;
  /** The concrete OpenCode mechanism (or why none exists). */
  mechanism: string;
}

/**
 * OpenCode repository/runtime tool names (1.18 baseline). The deny map is
 * built from these PLUS any additional host tool names the caller supplies
 * (the client can enumerate its own surface); deny-by-default keeps unknown
 * tools off the invocation.
 */
export const OPENCODE_RUNTIME_TOOLS = {
  repositoryRead: ["read", "grep", "glob", "list"],
  repositoryWrite: ["edit", "write", "patch"],
  commandExecution: ["bash"],
  networkAccess: ["webfetch"],
  /** Subagent delegation is NEVER exposed to a supervised Worker. */
  delegation: ["task"],
  housekeeping: ["todowrite", "todoread"],
} as const;

/** All baseline tool names known to this projection. */
export function baselineHostToolNames(): string[] {
  return [...new Set(Object.values(OPENCODE_RUNTIME_TOOLS).flat())];
}

/**
 * Per-capability enforceability of the installed runtime (§32). `gitCommit`
 * and `gitPush` are bash subcommands: bash-permission PATTERNS (e.g.
 * "git push*": "deny") add mechanical friction, but the bash tool remains
 * enabled whenever commandExecution is granted — honest answer:
 * semantic_only in that case, mechanical (transitively) when bash is denied.
 */
export function capabilityEnforceability(effective: ExecutionCapabilityEnvelope): CapabilityProjectionEntry[] {
  return [
    { capability: "repositoryRead", enforceability: "mechanical", mechanism: "per-call tools override disables read/grep/glob/list for the invocation" },
    { capability: "repositoryWrite", enforceability: "mechanical", mechanism: "per-call tools override disables edit/write/patch; agent permission.edit=deny adds the second layer" },
    { capability: "commandExecution", enforceability: "mechanical", mechanism: "per-call tools override disables bash; agent permission.bash=deny adds the second layer" },
    {
      capability: "networkAccess",
      enforceability: effective.commandExecution ? "semantic_only" : "mechanical",
      mechanism: effective.commandExecution
        ? "webfetch can be disabled mechanically, but an allowed bash tool can reach the network (curl/git) — semantic subset, not a sandbox"
        : "per-call tools override disables webfetch; bash is disabled so no network path remains",
    },
    { capability: "dependencyMutation", enforceability: "semantic_only", mechanism: "install/upgrade commands are a semantic subset of bash/write — OpenCode has no package-manager boundary (no custom sandbox is invented)" },
    {
      capability: "gitCommit",
      enforceability: effective.commandExecution ? "semantic_only" : "mechanical",
      mechanism: effective.commandExecution
        ? "git commit runs through the allowed bash tool; permission.bash patterns add friction only — semantic subset"
        : "no bash tool → no git path (transitively enforced)",
    },
    {
      capability: "gitPush",
      enforceability: effective.commandExecution ? "semantic_only" : "mechanical",
      mechanism: effective.commandExecution
        ? "git push runs through the allowed bash tool; permission.bash patterns add friction only — semantic subset"
        : "no bash tool → no git path (transitively enforced)",
    },
    {
      capability: "externalServiceMutation",
      enforceability: effective.commandExecution || effective.networkAccess ? "semantic_only" : "mechanical",
      mechanism: "external services are reachable via bash/webfetch when either is allowed — semantic subset",
    },
  ];
}

/**
 * §31/§33 — the per-call `tools` override for ONE Worker invocation:
 * every baseline host tool is explicitly projected from the effective
 * envelope (plus explicit deny for delegation/housekeeping), and any extra
 * host tool name the caller enumerates is DENIED BY DEFAULT. Ultra Plan
 * control-plane tools are never in the map (§76) — the explicit ultraplan
 * entries keep them off even where a host registers them globally.
 */
export function projectWorkerToolMap(
  effective: ExecutionCapabilityEnvelope,
  extraHostToolNames: readonly string[] = [],
  registeredUltraPlanToolNames: readonly string[] = [],
): { tools: Record<string, boolean>; projection: CapabilityProjectionEntry[] } {
  const tools: Record<string, boolean> = {};
  const enable = (names: readonly string[], allowed: boolean) => {
    for (const name of names) tools[name] = allowed;
  };
  enable(OPENCODE_RUNTIME_TOOLS.repositoryRead, effective.repositoryRead);
  enable(OPENCODE_RUNTIME_TOOLS.repositoryWrite, effective.repositoryWrite);
  enable(OPENCODE_RUNTIME_TOOLS.commandExecution, effective.commandExecution);
  enable(OPENCODE_RUNTIME_TOOLS.networkAccess, effective.networkAccess);
  enable(OPENCODE_RUNTIME_TOOLS.delegation, false);
  enable(OPENCODE_RUNTIME_TOOLS.housekeeping, false);
  for (const name of registeredUltraPlanToolNames) tools[name] = false;
  for (const name of extraHostToolNames) {
    if (!(name in tools)) tools[name] = false;
  }
  return { tools, projection: capabilityEnforceability(effective) };
}

/**
 * §21 — the Supervisor invocation's tool map: EVERY host tool is mechanically
 * denied (the per-call override is host-enforced, not prompt-enforced). The
 * Supervisor's execution operations are NOT host tools — they travel through
 * the adapter's strict JSON final-response contract, so there is nothing to
 * enable here. Returns the explicit all-deny map over the given host names.
 */
export function projectSupervisorToolMap(hostToolNames: readonly string[]): Record<string, boolean> {
  const tools: Record<string, boolean> = {};
  for (const name of new Set([...baselineHostToolNames(), ...hostToolNames])) {
    tools[name] = false;
  }
  return tools;
}

/**
 * §33 — derive the trusted host permission ceiling from REAL OpenCode config
 * state (never invented): a deny/ask rule on edit/bash/webfetch lowers the
 * ceiling; anything unresolved stays at the config's expressed permission.
 * The ceiling can only be LOWERED here — a Directive can never elevate the
 * host (Core intersects envelope ≤ ceiling ≤ host anyway).
 */
export function deriveHostPermissionCeiling(config: {
  permission?: Record<string, unknown> | string;
  agent?: Record<string, { permission?: Record<string, unknown>; tools?: Record<string, boolean> } | undefined>;
}): ExecutionCapabilityEnvelope {
  const env: { -readonly [K in keyof ExecutionCapabilityEnvelope]: boolean } = {
    repositoryRead: true,
    repositoryWrite: true,
    commandExecution: true,
    networkAccess: true,
    dependencyMutation: true,
    gitCommit: true,
    gitPush: true,
    externalServiceMutation: true,
  };
  const denyLike = (value: unknown): boolean => value === "deny";
  const globalPermission: Record<string, unknown> =
    typeof config.permission === "object" && config.permission !== null ? config.permission : {};
  if (denyLike(globalPermission["edit"])) env.repositoryWrite = false;
  if (denyLike(globalPermission["webfetch"])) env.networkAccess = false;
  // bash: only the WHOLE-TOOL "deny" removes the command family. A
  // pattern-scoped object rule (e.g. "git push*": "deny") is mechanical
  // friction on specific commands — the tool itself stays enabled, so the
  // ceiling keeps the family available (honest, never overclaiming).
  if (globalPermission["bash"] === "deny") {
    env.commandExecution = false;
    env.dependencyMutation = false;
    env.gitCommit = false;
    env.gitPush = false;
    env.externalServiceMutation = false;
  }
  // An explicitly disabled tool in ANY agent override removes it from the
  // ceiling conservatively (the host will not grant what a ruleset denies).
  for (const agent of Object.values(config.agent ?? {})) {
    if (!agent) continue;
    if (agent.tools) {
      if (agent.tools["bash"] === false) {
        env.commandExecution = false;
        env.dependencyMutation = false;
        env.gitCommit = false;
        env.gitPush = false;
        env.externalServiceMutation = false;
      }
      if (agent.tools["edit"] === false || agent.tools["write"] === false || agent.tools["patch"] === false) env.repositoryWrite = false;
      if (agent.tools["webfetch"] === false) env.networkAccess = false;
      if (agent.tools["read"] === false && agent.tools["grep"] === false && agent.tools["glob"] === false) env.repositoryRead = false;
    }
    const permission = agent.permission ?? {};
    if (denyLike(permission["edit"])) env.repositoryWrite = false;
    if (denyLike(permission["webfetch"])) env.networkAccess = false;
    if (permission["bash"] === "deny") {
      env.commandExecution = false;
      env.dependencyMutation = false;
      env.gitCommit = false;
      env.gitPush = false;
      env.externalServiceMutation = false;
    }
  }
  return env;
}

export function assertEnvelopeWithinHostCeiling(envelope: ExecutionCapabilityEnvelope, ceiling: ExecutionCapabilityEnvelope): void {
  for (const key of Object.keys(envelope) as (keyof ExecutionCapabilityEnvelope)[]) {
    if (envelope[key] && !ceiling[key]) {
      throw new UltraPlanError("invalid_scope", `Capability ${key} is granted beyond the host permission ceiling; the host ceiling cannot be elevated by a Directive (§33)`, {
        capability: key,
      });
    }
  }
}
