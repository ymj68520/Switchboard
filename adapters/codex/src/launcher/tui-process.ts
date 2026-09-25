/**
 * Codex TUI child abstraction (Phase 5 directive §18-19, §29).
 *
 * The TUI is owned EXCLUSIVELY by the managed session (composition root):
 * the controller and the runtime must never know it exists (§4 no
 * cross-layer kill). It directly owns the user's terminal — stdin/stdout/
 * stderr are inherited, never piped (piping would corrupt the interactive
 * TUI, directive §18) — and the launcher only spawns / waits / supervises
 * it (§19: no output parsing, no input proxying, no conversation capture).
 *
 * Termination reuses the Phase 1 process-tree cleanup mechanics verbatim
 * (§29: win32 shim→child tree via taskkill /T /F, POSIX process-group
 * signals) by sharing NodeAppServerProcess with stdio: "inherit" — there is
 * deliberately NO second Windows taskkill implementation.
 */

import { NodeAppServerProcess, type SpawnRequest } from "../runtime/app-server-process.js";
import type { ChildExitStatus } from "../runtime/types.js";

/**
 * What the launcher needs from the TUI child: pid, exit, termination.
 * Deliberately NARROWER than AppServerProcess — no stdout/stderr stream
 * access exists on this type, so the launcher structurally cannot parse
 * TUI output or capture conversation content (directive §19).
 */
export interface CodexTuiProcess {
  readonly pid: number | undefined;
  readonly exits: Promise<ChildExitStatus>;
  requestTerminate(): void;
  forceKill(): void;
  killImmediate(): void;
}

export type CodexTuiProcessFactory = (request: SpawnRequest) => CodexTuiProcess;

/** Default TUI factory: the shared Node process seam with stdio inherited. */
export const nodeCodexTuiProcessFactory: CodexTuiProcessFactory = (request) =>
  new NodeAppServerProcess({ ...request, stdio: "inherit" });
