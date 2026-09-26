/**
 * Shared counter-based test clock: ids are globally unique per process
 * (evidence ids are UNIQUE across the whole store; validation event ids are
 * UNIQUE per run), unlike fixedClock's replayable id lists.
 */

import type { StoreClock } from "../src/store/migration-runner.js";

let counter = 0;

export function counterClock(): StoreClock {
  return {
    nowIso: () => new Date(0).toISOString(),
    newId: () => `u${(counter += 1)}`,
  };
}
