/**
 * Pure builder for the native Codex TUI launch argv (Phase 5 directive
 * §8-11, §36-37). Frozen launch intent (verified against codex-cli 0.156.1):
 *
 *   codex --remote ws://127.0.0.1:<P>
 *         --model <executionModel>
 *         -c model_reasoning_effort="<effort>"
 *         -c plan_mode_reasoning_effort="<effort>"
 *         [passthrough user args...]
 *
 * - argv array only — NO shell quoting/concatenation anywhere (§37);
 * - the `-c` value uses the exact TOML override form the CLI parser
 *   accepts: `-c key="value"` with minimal TOML string escaping;
 * - both native effort keys are initialized to the SAME configured value
 *   (directive §7) — a unified startup default, not per-phase routing;
 * - `--model` pins the TUI startup model to executionModel (§8) so the
 *   normal fresh session starts correct WITHOUT waiting for a controller
 *   correction (the controller's first reconciliation is retained anyway);
 * - reserved-argument conflicts in the passthrough FAIL FAST (§11): no
 *   double authority, no last-arg-wins.
 */

import type { LoopbackEndpoint } from "../runtime/types.js";

/** Passthrough flags/keys the launcher has sole authority over (§10-11). */
export const RESERVED_TUI_FLAGS = ["--remote"] as const;
export const RESERVED_MODEL_FLAGS = ["-m", "--model"] as const;
/** `-c`/`--config` keys reserved by the managed session. */
export const RESERVED_CONFIG_KEYS = [
  "model",
  "model_reasoning_effort",
  "plan_mode_reasoning_effort",
] as const;

/** Raised when user passthrough args would create a double authority (§11). */
export class ReservedArgumentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservedArgumentConflictError";
  }
}

export interface BuildCodexTuiArgsInput {
  readonly endpoint: LoopbackEndpoint;
  readonly executionModel: string;
  readonly reasoningEffort: string;
  readonly passthroughArgs: readonly string[];
}

/**
 * Build the exact TUI argv. Throws ReservedArgumentConflictError when the
 * passthrough args claim a reserved flag/key — the launcher's startup
 * semantics must stay deterministic (directive §11: fail fast, never
 * silently override).
 */
export function buildCodexTuiArgs(input: BuildCodexTuiArgsInput): string[] {
  assertNoReservedArgs(input.passthroughArgs);

  const effortValue = tomlOverrideValue(input.reasoningEffort);
  return [
    "--remote",
    input.endpoint.wsUrl,
    "--model",
    input.executionModel,
    "-c",
    `model_reasoning_effort=${effortValue}`,
    "-c",
    `plan_mode_reasoning_effort=${effortValue}`,
    ...input.passthroughArgs,
  ];
}

/**
 * Detect reserved flags in user passthrough args, including attached forms
 * (`--remote=ws://…`, `-mX`, `-cmodel=…`) and both `-c key=value` /
 * `--config key=value` shapes. Key comparison is exact (before the first
 * `=`); near-miss keys like `model_reasoning_effort_v2` pass through.
 */
export function assertNoReservedArgs(passthroughArgs: readonly string[]): void {
  for (let index = 0; index < passthroughArgs.length; index += 1) {
    const arg = passthroughArgs[index];
    if (arg === undefined) {
      break;
    }
    const conflict = describeReservedConflict(arg, passthroughArgs[index + 1]);
    if (conflict !== null) {
      throw new ReservedArgumentConflictError(
        `passthrough argument ${JSON.stringify(arg)} conflicts with a ` +
          `launcher-managed startup argument (${conflict}); the managed ` +
          "launcher owns --remote, --model/-m, and the model / " +
          "model_reasoning_effort / plan_mode_reasoning_effort config keys",
      );
    }
  }
}

function describeReservedConflict(
  arg: string,
  nextArg: string | undefined,
): string | null {
  // Exact / attached long flags.
  if (RESERVED_TUI_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
    return "remote endpoint is assigned by the launcher";
  }
  if (RESERVED_MODEL_FLAGS.some((flag) => arg === flag || (arg.startsWith(flag) && arg.length > flag.length && isAttachedValue(arg, flag)))) {
    return "startup model is assigned by the launcher";
  }
  // Short flag attached value: -mX / -ckey=value
  if (arg.startsWith("-c") && arg.length > 2) {
    const payload = arg.slice(2);
    return describeConfigKeyConflict(
      payload.includes("=") ? payload.slice(0, payload.indexOf("=")) : payload,
    );
  }
  // Separate-value forms: -c key=value, --config key=value, -c key value?
  // Codex's `-c` always takes a key=value payload; a bare next arg is the
  // payload when the flag is exact.
  if (arg === "-c" || arg === "--config") {
    const payload = nextArg ?? "";
    return describeConfigKeyConflict(payload.includes("=") ? payload.slice(0, payload.indexOf("=")) : payload);
  }
  if (arg.startsWith("--config=")) {
    return describeConfigKeyConflict(arg.slice("--config=".length));
  }
  return null;
}

/** `-mX` attached form: flag char followed by a non-flag value. */
function isAttachedValue(arg: string, flag: string): boolean {
  const rest = arg.slice(flag.length);
  return !rest.startsWith("-");
}

function describeConfigKeyConflict(key: string): string | null {
  if ((RESERVED_CONFIG_KEYS as readonly string[]).includes(key)) {
    return `config key "${key}" is assigned by the launcher`;
  }
  return null;
}

/**
 * Minimal TOML string value for `-c key=<value>`: always a double-quoted
 * TOML string (codex parses the value portion as TOML, falling back to the
 * raw literal), with backslash and quote escaped. Keeps unusual model IDs /
 * effort strings unambiguous — still no shell quoting involved (the argv
 * item is passed verbatim to the codex process).
 */
function tomlOverrideValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
