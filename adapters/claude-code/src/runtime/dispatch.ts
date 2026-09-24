/**
 * Unified runtime CLI dispatcher (frozen plan §5, §2.2).
 *
 * One bundled artifact, role subcommands:
 *   node phase-plan-runtime.mjs doctor [--json]
 *   node phase-plan-runtime.mjs mcp
 *   node phase-plan-runtime.mjs hook <event>   (dispatch reserved; Phase 1 stub)
 *
 * Unknown commands/flags fail loudly with a stable exit code and a clear
 * message — never a silent fallback, never a stack trace unless debug mode.
 */

import { RuntimeError } from "./errors.js";
import { EXIT_CODES, type ExitCode } from "./exit-codes.js";
import { isNodeVersionSupported } from "./node-version.js";
import { createLogger, resolveLogLevel, type Logger } from "./logger.js";
import { runDoctor } from "../doctor/doctor.js";
import { doctorExitCode, renderHumanReport, renderJsonReport } from "../doctor/report.js";
import { startMcpServer } from "../mcp/bootstrap.js";

/** Hook events the frozen architecture relies on (dispatch reserved). */
export const KNOWN_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolBatch",
  "PostCompact",
  "FileChanged",
] as const;

export type RuntimeCommand =
  | { kind: "doctor"; json: boolean }
  | { kind: "mcp" }
  | { kind: "hook"; event: string }
  | { kind: "help" };

export type ParseResult =
  | { ok: true; command: RuntimeCommand }
  | { ok: false; error: RuntimeError };

export function usage(): string {
  return [
    "Usage:",
    "  node phase-plan-runtime.mjs doctor [--json]   Run runtime/host preflight checks",
    "  node phase-plan-runtime.mjs mcp               Start the stdio MCP server",
    "  node phase-plan-runtime.mjs hook <event>      Reserved hook dispatch (Phase 1)",
    "",
    "Environment:",
    "  PHASE_PLAN_LOG_LEVEL    debug|info|warn|error|silent (stderr diagnostics)",
    "  PHASE_PLAN_CLAUDE_BIN   explicit claude CLI path for doctor detection",
    "  PHASE_PLAN_DEBUG=1      include stack traces in error output",
  ].join("\n");
}

export function parseRuntimeCommand(argv: readonly string[]): ParseResult {
  const args = [...argv];
  if (args.length === 0) {
    return {
      ok: false,
      error: new RuntimeError("INVALID_RUNTIME_COMMAND", "missing command", {
        cause: "expected one of: doctor, mcp, hook <event>, help",
      }),
    };
  }

  const helpIndex = args.indexOf("--help") >= 0 ? args.indexOf("--help") : args.indexOf("-h");
  const positional: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") continue;
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1)) {
      flags.push(arg);
    } else {
      positional.push(arg);
    }
  }
  if (helpIndex >= 0) {
    if (positional.length === 0) {
      return { ok: true, command: { kind: "help" } };
    }
    // `doctor --help` etc. still shows usage — helpful, not an error.
    return { ok: true, command: { kind: "help" } };
  }

  const command = positional.shift();
  if (command === undefined) {
    return {
      ok: false,
      error: new RuntimeError("INVALID_RUNTIME_COMMAND", "missing command", {
        cause: "expected one of: doctor, mcp, hook <event>, help",
      }),
    };
  }

  switch (command) {
    case "doctor": {
      if (positional.length > 0) {
        return {
          ok: false,
          error: new RuntimeError("INVALID_RUNTIME_COMMAND", `unexpected extra argument(s): ${positional.join(" ")}`),
        };
      }
      const jsonFlags = flags.filter((f) => f === "--json");
      const unknown = flags.filter((f) => f !== "--json");
      if (unknown.length > 0) {
        return {
          ok: false,
          error: new RuntimeError("INVALID_RUNTIME_COMMAND", `unknown flag(s) for doctor: ${unknown.join(" ")}`),
        };
      }
      return { ok: true, command: { kind: "doctor", json: jsonFlags.length > 0 } };
    }
    case "mcp": {
      if (positional.length > 0) {
        return {
          ok: false,
          error: new RuntimeError("INVALID_RUNTIME_COMMAND", `unexpected extra argument(s): ${positional.join(" ")}`),
        };
      }
      if (flags.length > 0) {
        return {
          ok: false,
          error: new RuntimeError("INVALID_RUNTIME_COMMAND", `unknown flag(s) for mcp: ${flags.join(" ")}`),
        };
      }
      return { ok: true, command: { kind: "mcp" } };
    }
    case "hook": {
      if (flags.length > 0) {
        return {
          ok: false,
          error: new RuntimeError("INVALID_RUNTIME_COMMAND", `unknown flag(s) for hook: ${flags.join(" ")}`),
        };
      }
      const event = positional.shift();
      if (event === undefined) {
        return {
          ok: false,
          error: new RuntimeError("INVALID_RUNTIME_COMMAND", "hook requires an event name", {
            cause: `known events: ${KNOWN_HOOK_EVENTS.join(", ")}`,
          }),
        };
      }
      if (positional.length > 0) {
        return {
          ok: false,
          error: new RuntimeError("INVALID_RUNTIME_COMMAND", `unexpected extra argument(s): ${positional.join(" ")}`),
        };
      }
      return { ok: true, command: { kind: "hook", event } };
    }
    case "help":
      return { ok: true, command: { kind: "help" } };
    default:
      return {
        ok: false,
        error: new RuntimeError("INVALID_RUNTIME_COMMAND", `unknown command: ${command}`, {
          cause: "expected one of: doctor, mcp, hook <event>, help",
        }),
      };
  }
}

export interface DispatchDeps {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  out?(text: string): void;
  err?(text: string): void;
  doctor?: typeof runDoctor;
  startMcp?: typeof startMcpServer;
  nodeVersion?(): string;
}

export interface CommandResult {
  exitCode: ExitCode;
  /** Whether the command requests long-running process lifetime (mcp). */
  longRunning: boolean;
}

/**
 * Execute a parsed command. Returns the process exit code; for `mcp` the
 * caller awaits until the server stops before applying it.
 */
export async function executeCommand(
  command: RuntimeCommand,
  deps: DispatchDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((text: string) => process.stdout.write(text));

  switch (command.kind) {
    case "help":
      out(usage() + "\n");
      return { exitCode: EXIT_CODES.success, longRunning: false };

    case "doctor": {
      const report = await (deps.doctor ?? runDoctor)({
        env,
        detectNodeVersion: deps.nodeVersion ? () => deps.nodeVersion!() : undefined,
      });
      out(command.json ? renderJsonReport(report) : renderHumanReport(report));
      return { exitCode: doctorExitCode(report), longRunning: false };
    }

    case "mcp": {
      // Fail-closed runtime prerequisite: the MCP process is long-lived
      // product runtime and must not start on unsupported Node (frozen plan
      // E3/E11). Doctor deliberately does NOT apply this guard — it must run
      // on any Node to diagnose the problem.
      const detected = deps.nodeVersion?.() ?? process.versions.node;
      if (!isNodeVersionSupported(detected)) {
        throw new RuntimeError(
          "UNSUPPORTED_NODE_VERSION",
          `Phase Plan requires Node >= 24.15.0; running ${detected}`,
          { cause: "mcp runtime refused to start (fail-closed)" },
        );
      }
      const logger = deps.logger ?? createLogger(resolveLogLevel(env.PHASE_PLAN_LOG_LEVEL));
      const { waitStopped } = await (deps.startMcp ?? startMcpServer)({ logger });
      await waitStopped;
      return { exitCode: EXIT_CODES.success, longRunning: true };
    }

    case "hook": {
      if ((KNOWN_HOOK_EVENTS as readonly string[]).includes(command.event)) {
        throw new RuntimeError(
          "HOOK_NOT_IMPLEMENTED",
          `hook '${command.event}' is recognized but not implemented in Phase 1`,
          { cause: "hook dispatch is reserved; lifecycle hooks ship in a later phase" },
        );
      }
      throw new RuntimeError(
        "INVALID_RUNTIME_COMMAND",
        `unknown hook event: ${command.event}`,
        { cause: `known events: ${KNOWN_HOOK_EVENTS.join(", ")}` },
      );
    }
  }
}
