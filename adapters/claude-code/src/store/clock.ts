import { randomUUID } from "node:crypto";

import type { StoreClock } from "./migration-runner.js";

/**
 * Production clock: wall-time ISO timestamps + random UUID ids. Hook and MCP
 * processes share this; tests inject deterministic clocks instead.
 */
export function systemStoreClock(): StoreClock {
  return {
    nowIso: () => new Date().toISOString(),
    newId: () => randomUUID(),
  };
}
