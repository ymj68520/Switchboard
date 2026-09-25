/**
 * Tool → Observation class mapping (Phase 9 §7/§8).
 *
 * Exact host tool names only (probed facts, Claude Code 2.1.282 Windows):
 * Read / Grep / Glob / PowerShell. Unknown, mutation-capable, or Phase-Plan
 * tools are NEVER captured and never guessed into a class — the hook matcher
 * pre-filters, and this classifier is the authoritative second gate.
 */

import type { ObservationClass } from "./types.js";

export function observationClassForTool(toolName: string): ObservationClass | null {
  switch (toolName) {
    case "Read":
      return "source";
    case "Grep":
    case "Glob":
      return "locator";
    case "Bash":
    case "PowerShell":
      return "execution";
    default:
      return null;
  }
}
