/**
 * Phase Plan runtime entry point. Bundled to dist/phase-plan-runtime.mjs and
 * executed as `node phase-plan-runtime.mjs <command>`. Keep this file thin:
 * argv → parsed command → executeCommand, with one central error boundary.
 */

import { pathToFileURL } from "node:url";

import { RuntimeError, isRuntimeError, toRuntimeError } from "./runtime/errors.js";
import { exitCodeForError } from "./runtime/exit-codes.js";
import { executeCommand, parseRuntimeCommand, usage, type DispatchDeps } from "./runtime/dispatch.js";

export interface MainResult {
  exitCode: number;
}

/**
 * Run one runtime command. Diagnostics go to stderr; command output goes to
 * stdout; stack traces are printed only in debug mode (PHASE_PLAN_DEBUG=1).
 */
export async function main(argv: readonly string[] = process.argv.slice(2), deps: DispatchDeps = {}): Promise<MainResult> {
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const debug = deps.env?.PHASE_PLAN_DEBUG === "1" || process.env.PHASE_PLAN_DEBUG === "1";
  try {
    const parsed = parseRuntimeCommand(argv);
    if (!parsed.ok) {
      throw parsed.error;
    }
    const { exitCode } = await executeCommand(parsed.command, deps);
    return { exitCode };
  } catch (thrown) {
    const error = toRuntimeError(thrown);
    const causeSuffix = error.causeText !== undefined ? `\n  cause: ${error.causeText}` : "";
    err(`error [${error.code}]: ${error.message}${causeSuffix}\n`);
    if (debug) {
      err(`${thrown instanceof Error ? (thrown.stack ?? "") : String(thrown)}\n`);
    } else if (error.code === "INVALID_RUNTIME_COMMAND" || error.code === "HOOK_NOT_IMPLEMENTED") {
      err(`Run with --help for usage.\n`);
    }
    return { exitCode: exitCodeForError(error.code) };
  }
}

/** True when this module is the process entry script (i.e. the bundled CLI). */
export function isDirectExecution(moduleUrl: string = import.meta.url, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  try {
    // moduleUrl (import.meta.url) is already an href; only argv1 needs the
    // path → URL conversion. Converting it twice yields a mangled double URL.
    const entry = pathToFileURL(argv1).href;
    const normalize = (href: string): string => (process.platform === "win32" ? href.toLowerCase() : href);
    return normalize(entry) === normalize(moduleUrl);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().then((result) => {
    process.exitCode = result.exitCode;
  }).catch((error: unknown) => {
    // Defensive: main() catches its own errors; reaching here is a bug.
    const envelope = isRuntimeError(error)
      ? error.toEnvelope()
      : toRuntimeError(error).toEnvelope();
    process.stderr.write(`error [${envelope.code}]: ${envelope.message}\n`);
    process.exitCode = exitCodeForError(
      error instanceof RuntimeError ? error.code : "INTERNAL_ERROR",
    );
  });
}

export { usage };
