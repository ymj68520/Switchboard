/**
 * Repository Observations — spec §22.
 *
 * Observations are cheap, temporary records of OpenCode repository-tool
 * activity (file reads, greps, test runs). They never become Evidence
 * automatically; promotion into Evidence is an explicit planning-model action
 * (Phase 2+). The ledger interface exists so later phases can persist
 * observations without changing the core domain.
 */
import type { ObservationID } from "../core/ids.js";
import type { Timestamp } from "../core/refs.js";

export type SourceLocator =
  | { kind: "file"; path: string; range?: { startLine: number; endLine: number } }
  | { kind: "symbol"; path?: string; symbol: string }
  | { kind: "command"; command: string };

export interface Observation {
  id: ObservationID;
  /** The OpenCode tool that produced the observation (e.g. "read", "bash"). */
  tool: string;
  source?: SourceLocator;
  observedAt: Timestamp;
  contentFingerprint?: string;
}

/**
 * Append-only observation ledger. Deliberately tiny: observations are
 * ephemeral working data, not committed state.
 */
export interface ObservationLedger {
  append(observation: Observation): Promise<void>;
  list(): Promise<Observation[]>;
}
