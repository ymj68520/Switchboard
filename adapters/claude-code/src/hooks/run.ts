/**
 * Hook runtime: one process, one event (Phase 7 directive §34/§35).
 *
 *   node phase-plan-runtime.mjs hook <Event>
 *
 * Reads the full stdin JSON, parses it with the typed parsers, runs the
 * handler, and writes EXACTLY ONE JSON object to stdout (or nothing). All
 * diagnostics go to stderr. Exit policy per event:
 *
 *   SessionStart/End    any failure → exit 0, nothing on stdout (advisory;
 *                                    never breaks the session lifecycle §38)
 *   UserPromptSubmit    failure     → block decision, exit 0 (fail closed §40)
 *   UserPromptExpansion failure     → exit 2 (blocks the expansion)
 *   PreToolUse          failure     → exit 2 (blocks the tool call)
 *   PermissionRequest   failure     → deny decision, exit 0 (exit 2 is not
 *                                     honored for this event)
 *
 * A hook that fails at THIS layer can never create authority: every mutating
 * MCP handler independently verifies the signed HostContext and fails closed
 * (HOST_CONTEXT_REQUIRED) when no hook injected one.
 */

import { RuntimeError, toRuntimeError } from "../runtime/errors.js";
import { createLogger, type Logger } from "../runtime/logger.js";
import { initializePlanStore, type PlanStore, type PlanStoreOptions } from "../store/sqlite-store.js";
import { systemStoreClock } from "../store/clock.js";
import { loadHostSecret } from "../host/secret.js";
import { HookInputError } from "./parse.js";
import {
  parsePermissionRequestInput,
  parsePreToolUseInput,
  parseSessionEndInput,
  parseSessionStartInput,
  parseUserPromptExpansionInput,
  parseUserPromptSubmitInput,
} from "./parse.js";
import { blockPrompt, denyPermissionRequest, renderHookOutput } from "./output.js";
import {
  handlePermissionRequest,
  handlePreToolUse,
  handleSessionEnd,
  handleSessionStart,
  handleUserPromptExpansion,
  handleUserPromptSubmit,
  type HookHandlerDeps,
} from "./handlers.js";

export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PreToolUse",
  "PermissionRequest",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

export interface HookRunResult {
  exitCode: number;
  /** What was written to stdout ("" when nothing). Exposed for tests. */
  stdout: string;
}

function writeOut(text: string): void {
  if (text !== "") process.stdout.write(text);
}

function diag(logger: Logger, message: string): void {
  logger.error(message);
}

function parseStdin(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HookInputError([{ field: "(stdin)", problem: "is not valid JSON" }]);
  }
}

/**
 * Run one hook invocation. `raw` is the full stdin payload; nothing here
 * touches process streams directly (the CLI entry wires them), which keeps
 * the whole path testable in-process.
 */
export async function runHook(options: {
  event: string;
  raw: string;
  pluginDataRoot: string;
  logger?: Logger;
  /** Test seam: store open override. */
  openStore?: (options: PlanStoreOptions) => Promise<PlanStore>;
}): Promise<HookRunResult> {
  const logger = options.logger ?? createLogger("warn");
  if (!isHookEvent(options.event)) {
    throw new RuntimeError("INVALID_RUNTIME_COMMAND", `unknown hook event: ${options.event}`, {
      cause: `hook events: ${HOOK_EVENTS.join(", ")}`,
    });
  }
  const event: HookEvent = options.event;

  try {
    const parsed = parseStdin(options.raw);

    // Cross-check argv event against the payload (fail closed on mismatch).
    const eventName = (parsed as Record<string, unknown> | null)?.hook_event_name;
    if (typeof eventName === "string" && eventName !== event) {
      throw new HookInputError([
        { field: "hook_event_name", problem: `'${eventName}' does not match invoked event '${event}'` },
      ]);
    }

    const store = await (options.openStore ?? initializePlanStore)({ pluginDataRoot: options.pluginDataRoot });
    try {
      const secret = loadHostSecret(options.pluginDataRoot);
      const deps: HookHandlerDeps = { store, secret: secret.key, clock: systemStoreClock() };

      let stdout = "";
      switch (event) {
        case "SessionStart": {
          stdout = renderHookOutput(await handleSessionStart(deps, parseSessionStartInput(parsed)));
          break;
        }
        case "SessionEnd": {
          stdout = renderHookOutput(handleSessionEnd(deps, parseSessionEndInput(parsed)));
          break;
        }
        case "UserPromptSubmit": {
          stdout = renderHookOutput(handleUserPromptSubmit(deps, parseUserPromptSubmitInput(parsed)));
          break;
        }
        case "UserPromptExpansion": {
          stdout = renderHookOutput(handleUserPromptExpansion(deps, parseUserPromptExpansionInput(parsed)));
          break;
        }
        case "PreToolUse": {
          stdout = renderHookOutput(await handlePreToolUse(deps, parsePreToolUseInput(parsed)));
          break;
        }
        case "PermissionRequest": {
          stdout = renderHookOutput(handlePermissionRequest(deps, parsePermissionRequestInput(parsed)));
          break;
        }
      }
      writeOut(stdout);
      return { exitCode: 0, stdout };
    } finally {
      store.close();
    }
  } catch (err) {
    const error = toRuntimeError(err);
    diag(logger, `hook ${event} failed: [${error.code}] ${error.message}${error.causeText ? ` — ${error.causeText}` : ""}`);
    return failClosed(event);
  }
}

/** Event-specific fail-closed behavior for any hook failure. */
function failClosed(event: HookEvent): HookRunResult {
  switch (event) {
    case "SessionStart":
    case "SessionEnd":
      // Advisory: degrade silently, never break the session lifecycle.
      return { exitCode: 0, stdout: "" };
    case "UserPromptSubmit": {
      const stdout = renderHookOutput(
        blockPrompt("Phase Plan could not evaluate this prompt (hook input rejected); it is blocked fail-closed."),
      );
      writeOut(stdout);
      return { exitCode: 0, stdout };
    }
    case "PermissionRequest": {
      const stdout = renderHookOutput(denyPermissionRequest("HOST_CONTEXT_INVALID: hook input rejected"));
      writeOut(stdout);
      return { exitCode: 0, stdout };
    }
    default:
      // PreToolUse / UserPromptExpansion: exit 2 blocks the tool call/expansion.
      return { exitCode: 2, stdout: "" };
  }
}
