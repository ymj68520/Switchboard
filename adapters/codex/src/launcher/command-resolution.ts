/**
 * One shared Codex command resolution for BOTH managed children (Phase 5
 * directive §38-39): the app-server and the TUI must come from the SAME
 * resolved Codex installation — never two different `codex` binaries found
 * by independent PATH lookups (that would allow an app-server/Codex-A vs
 * TUI/Codex-B version drift).
 *
 * Windows reality (Phase 1 discovery): `codex` on PATH is an npm shim
 * (codex → codex.cmd → node → codex.exe). Node cannot spawn a .cmd without
 * a shell, and the frozen design forbids shell-string commands — so on
 * win32 the resolved program is `cmd.exe` with the fixed argv prefix
 * ["/d", "/s", "/c", "codex"], exactly the strategy validated since
 * Phase 1. POSIX resolves to a plain "codex" exec.
 */

export interface ResolvedCodexCommand {
  /** Program to spawn (argv[0] of the child process). */
  readonly program: string;
  /** Fixed prefix args before the Codex subcommand/flags. */
  readonly prefixArgs: readonly string[];
}

/** Human-readable identity of the resolved Codex entry (diagnostics only). */
export function describeResolvedCodexCommand(resolved: ResolvedCodexCommand): string {
  return [resolved.program, ...resolved.prefixArgs].join(" ");
}

export function resolveCodexCommand(): ResolvedCodexCommand {
  if (process.platform === "win32") {
    return {
      program: process.env.ComSpec ?? "cmd.exe",
      prefixArgs: ["/d", "/s", "/c", "codex"],
    };
  }
  return { program: "codex", prefixArgs: [] };
}
