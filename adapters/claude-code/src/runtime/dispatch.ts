/**
 * Unified runtime CLI dispatcher (frozen plan §5, §2.2).
 *
 * One bundled artifact, role subcommands:
 *   node phase-plan-runtime.mjs doctor [--json]
 *   node phase-plan-runtime.mjs mcp
 *   node phase-plan-runtime.mjs hook <event>
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
import { preflightPluginData } from "../claude/environment.js";
import { initializePlanStore, type PlanStore, type PlanStoreOptions } from "../store/sqlite-store.js";
import { resolveStorePaths } from "../store/paths.js";
import { loadHostSecret } from "../host/secret.js";
import { CAPABILITY_PROOF_VERSION, writeCapabilityProofs, type CapabilityProofs } from "../host/capability-proofs.js";
import { probeClaudeVersion, type SpawnRunner } from "../claude/version.js";
import { systemStoreClock } from "../store/clock.js";
import { HOOK_EVENTS, isHookEvent, runHook } from "../hooks/run.js";

/** Hook events the frozen architecture reserves for later phases. */
export const RESERVED_HOOK_EVENTS = [
  "PostToolBatch",
  "PostCompact",
  "FileChanged",
] as const;

export type RuntimeCommand =
  | { kind: "doctor"; json: boolean }
  | { kind: "mcp" }
  | { kind: "hook"; event: string }
  | { kind: "record-proof"; hooksVerified: boolean; planModeVerified: boolean; claudeVersion?: string }
  | { kind: "help" };

export type ParseResult =
  | { ok: true; command: RuntimeCommand }
  | { ok: false; error: RuntimeError };

export function usage(): string {
  return [
    "Usage:",
    "  node phase-plan-runtime.mjs doctor [--json]   Run runtime/host preflight checks",
    "  node phase-plan-runtime.mjs mcp               Start the stdio MCP server",
    `  node phase-plan-runtime.mjs hook <event>      Hook dispatch (${HOOK_EVENTS.join(", ")})`,
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
            cause: `known events: ${HOOK_EVENTS.join(", ")}`,
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
    case "record-capability-proof": {
      const hooksVerified = flags.includes("--hooks-verified");
      const planModeVerified = flags.includes("--plan-mode-verified");
      const versionFlags = flags.filter((f) => f.startsWith("--claude-version="));
      const unknownFlags = flags.filter(
        (f) => f !== "--hooks-verified" && f !== "--plan-mode-verified" && !f.startsWith("--claude-version="),
      );
      if (unknownFlags.length > 0 || positional.length > 0) {
        return {
          ok: false,
          error: new RuntimeError(
            "INVALID_RUNTIME_COMMAND",
            `unexpected argument(s) for record-capability-proof: ${[...unknownFlags, ...positional].join(" ")}`,
            { cause: "usage: record-capability-proof [--hooks-verified] [--plan-mode-verified] [--claude-version=<v>]" },
          ),
        };
      }
      if (versionFlags.length > 1) {
        return {
          ok: false,
          error: new RuntimeError("INVALID_RUNTIME_COMMAND", "--claude-version given more than once"),
        };
      }
      const claudeVersion = versionFlags[0]?.slice("--claude-version=".length);
      return {
        ok: true,
        command: {
          kind: "record-proof",
          hooksVerified,
          planModeVerified,
          ...(claudeVersion === undefined ? {} : { claudeVersion }),
        },
      };
    }
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
  /** Test seam for the MCP bootstrap store initialization. */
  initializeStore?(options: PlanStoreOptions): Promise<PlanStore>;
  /** Test seam for the plugin-data filesystem preflight. */
  preflightPluginData?: typeof preflightPluginData;
  /** Test seam: full stdin payload for hook invocations. */
  readStdin?(): Promise<string>;
  /** Test seam: hook runner override. */
  runHook?: typeof runHook;
  /** Test seams for the capability-proof version probe. */
  probeClaude?: typeof probeClaudeVersion;
  claudeSpawnRunner?: SpawnRunner;
}

/** Default store bootstrap for the MCP runtime (initialize → ready). */
async function defaultInitializeStore(options: PlanStoreOptions): Promise<PlanStore> {
  return initializePlanStore(options);
}

/** Read the full hook stdin payload. */
function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

const defaultPreflightPluginData = preflightPluginData;

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

      // Fail-closed storage prerequisite: no canonical data location means
      // no server (frozen plan §32 — never fall back to cwd/temp paths).
      const pluginData = env.CLAUDE_PLUGIN_DATA?.trim();
      if (pluginData === undefined || pluginData === "") {
        throw new RuntimeError(
          "PLUGIN_DATA_UNAVAILABLE",
          "CLAUDE_PLUGIN_DATA is not set; the Phase Plan MCP server requires a canonical plugin data location",
          { cause: "mcp runtime refused to start without plugin storage (fail-closed)" },
        );
      }
      const preflight = await (deps.preflightPluginData ?? defaultPreflightPluginData)(pluginData);
      if (preflight.status !== "ok") {
        throw new RuntimeError(preflight.errorCode, preflight.message);
      }

      // Store before server: initialize/migrate to the current schema, and
      // only then serve (frozen plan §31). Store errors (too new, corrupt,
      // migration/backup failure) fail closed above and never yield a
      // seemingly-healthy Phase Plan server.
      const store = await (deps.initializeStore ?? defaultInitializeStore)({
        pluginDataRoot: preflight.resolvedRoot,
      });
      const logger = deps.logger ?? createLogger(resolveLogLevel(env.PHASE_PLAN_LOG_LEVEL));
      logger.info(`plan store ready at ${resolveStorePaths(preflight.resolvedRoot).databasePath}`);
      try {
        // The signing secret is a boot prerequisite: no secret → no verified
        // HostContext → no authority (fail closed before serving).
        const secret = loadHostSecret(preflight.resolvedRoot);
        const { waitStopped } = await (deps.startMcp ?? startMcpServer)({ logger, store, secret: secret.key });
        await waitStopped;
      } finally {
        // Deterministic close of the store connection once serving stops.
        store.close();
      }
      return { exitCode: EXIT_CODES.success, longRunning: true };
    }

    case "hook": {
      if (!isHookEvent(command.event)) {
        if ((RESERVED_HOOK_EVENTS as readonly string[]).includes(command.event)) {
          throw new RuntimeError(
            "HOOK_NOT_IMPLEMENTED",
            `hook '${command.event}' is recognized but reserved for a later phase`,
            { cause: `implemented events: ${HOOK_EVENTS.join(", ")}` },
          );
        }
        throw new RuntimeError(
          "INVALID_RUNTIME_COMMAND",
          `unknown hook event: ${command.event}`,
          { cause: `implemented events: ${HOOK_EVENTS.join(", ")}` },
        );
      }
      const pluginData = env.CLAUDE_PLUGIN_DATA?.trim();
      if (pluginData === undefined || pluginData === "") {
        throw new RuntimeError(
          "PLUGIN_DATA_UNAVAILABLE",
          "CLAUDE_PLUGIN_DATA is not set; Phase Plan hooks require a canonical plugin data location",
          { cause: "hook runtime refused to run without plugin storage (fail-closed)" },
        );
      }
      const raw = await (deps.readStdin ?? readAllStdin)();
      const result = await (deps.runHook ?? runHook)({
        event: command.event,
        raw,
        pluginDataRoot: pluginData,
      });
      return { exitCode: result.exitCode as ExitCode, longRunning: false };
    }

    case "record-proof": {
      // Real-host probe recording (Phase 7 §45): the operator runs the
      // documented probe against a real Claude Code session, then records
      // what it verified. This command records facts — it never verifies
      // anything itself and never runs an interactive probe.
      const pluginData = env.CLAUDE_PLUGIN_DATA?.trim();
      if (pluginData === undefined || pluginData === "") {
        throw new RuntimeError(
          "PLUGIN_DATA_UNAVAILABLE",
          "CLAUDE_PLUGIN_DATA is not set; capability proofs require a canonical plugin data location",
          { cause: "fail-closed" },
        );
      }
      const versionResult = await (deps.probeClaude ?? probeClaudeVersion)(deps.claudeSpawnRunner);
      const detectedVersion = versionResult.status === "ok" ? versionResult.version : undefined;
      if (command.claudeVersion === undefined && detectedVersion === undefined) {
        throw new RuntimeError("CLAUDE_VERSION_UNREADABLE", "cannot determine the Claude Code version for the proof", {
          cause: versionResult.status === "unreadable" ? versionResult.reason : "claude CLI not found",
        });
      }
      const proofs: CapabilityProofs = {
        claudeVersion: command.claudeVersion ?? detectedVersion!,
        proofVersion: CAPABILITY_PROOF_VERSION,
        hookLifecycleVerified: command.hooksVerified,
        planModeIntegrationVerified: command.planModeVerified,
        verifiedAt: systemStoreClock().nowIso(),
      };
      writeCapabilityProofs(pluginData, proofs);
      out(`${JSON.stringify(proofs)}\n`);
      return { exitCode: EXIT_CODES.success, longRunning: false };
    }
  }
}
