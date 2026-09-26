/**
 * phase-model launcher CLI (Phase 5 directive §1, §10, §13-14, §21).
 *
 *   phase-model [phase-model flags] [codex passthrough args...]
 *
 * Phase-model flags (fixed surface, directive §13):
 *   --planning-model <id>       override planning model
 *   --execution-model <id>      override execution model
 *   --reasoning-effort <level>  override startup reasoning effort
 *   --config <path>             explicit config file (default:
 *                               ./.codex-phase-model.json)
 *   -h | --help
 *
 * Everything else is PASSTHROUGH to the Codex TUI (directive §10) — the
 * launcher does not implement a Codex CLI parser; it only rejects the
 * handful of reserved arguments it must own itself (directive §11: fail
 * fast, never double authority).
 *
 * Exit codes (directive §21 — deliberately tiny):
 *   0        TUI exited 0
 *   TUI code propagated for any other TUI exit; 130 when the session ended
 *   via SIGINT with no TUI exit code
 *   1        bootstrap failure / app-server crash
 *   2        phase-model configuration error
 */

import {
  CLI_CONFIG_FILE,
  CLI_EXECUTION_MODEL,
  CLI_PLANNING_MODEL,
  CLI_REASONING_EFFORT,
  CodexPhaseModelConfigError,
  loadCodexPhaseModelConfig,
  type PartialPhaseModelConfig,
} from "../config/phase-model-config.js";
import {
  ReservedArgumentConflictError,
  assertNoReservedArgs,
} from "./tui-args.js";
import { ManagedCodexSession } from "./managed-session.js";

export interface LauncherArgParse {
  readonly configFilePath?: string;
  readonly cliOverrides: PartialPhaseModelConfig;
  readonly passthroughArgs: string[];
}

export class LauncherUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherUsageError";
  }
}

const VALUE_FLAGS: ReadonlyMap<string, keyof PartialPhaseModelConfig | "config"> = new Map([
  [CLI_PLANNING_MODEL, "planningModel"],
  [CLI_EXECUTION_MODEL, "executionModel"],
  [CLI_REASONING_EFFORT, "reasoningEffort"],
  [CLI_CONFIG_FILE, "config"],
]);

export const LAUNCHER_USAGE = `usage: phase-model [phase-model flags] [codex args...]

phase-model flags:
  --planning-model <model-id>    model applied in Codex Plan mode
  --execution-model <model-id>   model applied in Default mode and at startup
  --reasoning-effort <level>     unified startup effort (default: xhigh)
  --config <path>                config file (default: ./.codex-phase-model.json)
  -h, --help

Config file (JSON): {"planningModel": "...", "executionModel": "...",
"reasoningEffort": "xhigh"} — snake_case keys are also accepted.
Precedence: defaults < config file < environment < these flags.
All other arguments are passed through to the Codex TUI. Reserved startup
arguments (--remote, --model/-m, -c model / model_reasoning_effort /
plan_mode_reasoning_effort) are rejected — the launcher owns them for the
session it starts.`;

/**
 * Split launcher argv into phase-model flags and codex passthrough args.
 * Attached forms (`--planning-model=X`) are supported; unknown flags are
 * NEVER rejected — they are passthrough (directive §10).
 */
export function parseLauncherArgs(argv: readonly string[]): LauncherArgParse {
  const cliOverrides: PartialPhaseModelConfig = {};
  let configFilePath: string | undefined;
  const passthroughArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "-h" || arg === "--help") {
      throw new LauncherUsageError(LAUNCHER_USAGE);
    }
    const attachedSplit = arg.indexOf("=");
    const attachedName = attachedSplit > 0 ? arg.slice(0, attachedSplit) : null;
    const target = VALUE_FLAGS.get(arg) ?? (attachedName !== null ? VALUE_FLAGS.get(attachedName) : undefined);
    if (target === undefined) {
      passthroughArgs.push(arg);
      continue;
    }
    let value: string;
    if (attachedName !== null) {
      value = arg.slice(attachedSplit + 1);
    } else {
      index += 1;
      const next = argv[index];
      if (next === undefined) {
        throw new LauncherUsageError(`missing value for ${arg}`);
      }
      value = next;
    }
    if (target === "config") {
      configFilePath = value;
    } else {
      cliOverrides[target] = value;
    }
  }

  return { configFilePath, cliOverrides, passthroughArgs };
}

export interface RunLauncherOptions {
  /** Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Config-file lookup base. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Test seam for config file reads. */
  readonly readFile?: (path: string) => string;
  /** Test seam for warning/diagnostic output. */
  readonly warn?: (message: string) => void;
  /** Test seam replacing the session itself. */
  readonly sessionFactory?: (options: {
    phaseModel: ReturnType<typeof loadCodexPhaseModelConfig>;
    passthroughArgs: string[];
  }) => Promise<{
    kind: "tui-exit";
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  } | { kind: "bootstrap-failure"; message: string } | { kind: "app-server-crash"; message: string }>;
}

/** Run one managed session; resolves with the process exit code. */
export async function runLauncher(argv: readonly string[], options: RunLauncherOptions = {}): Promise<number> {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  // Runtime guard (same convention as the Claude adapter): the controller
  // transport needs Node's built-in WebSocket client, unflagged since
  // Node 22.4.0 — engines.node documents the same floor.
  if (typeof globalThis.WebSocket !== "function") {
    warn(
      "error: phase-model requires Node.js >= 22.4.0 — the built-in WebSocket " +
        "client is unavailable in this runtime",
    );
    return 1;
  }

  let parsed: LauncherArgParse;
  try {
    parsed = parseLauncherArgs(argv);
    // §11: reserved conflicts fail fast BEFORE anything is spawned.
    assertNoReservedArgs(parsed.passthroughArgs);
  } catch (error) {
    if (error instanceof LauncherUsageError) {
      warn(error.message);
      return 0;
    }
    if (error instanceof ReservedArgumentConflictError) {
      warn(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }

  let phaseModel;
  try {
    phaseModel = loadCodexPhaseModelConfig({
      configFilePath: parsed.configFilePath,
      cliOverrides: parsed.cliOverrides,
      env: options.env,
      cwd: options.cwd,
      readFile: options.readFile,
    });
  } catch (error) {
    if (error instanceof CodexPhaseModelConfigError) {
      warn(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const outcome = options.sessionFactory
    ? await options.sessionFactory({
        phaseModel,
        passthroughArgs: parsed.passthroughArgs,
      })
    : await new ManagedCodexSession({
        phaseModel,
        passthroughArgs: parsed.passthroughArgs,
        warn,
      }).run();

  switch (outcome.kind) {
    case "tui-exit":
      if (outcome.exitCode !== null) {
        return outcome.exitCode;
      }
      return outcome.signal !== null ? 130 : 1;
    case "bootstrap-failure":
      warn(`error: ${outcome.message}`);
      return 1;
    case "app-server-crash":
      warn(`error: ${outcome.message}`);
      return 1;
  }
}
