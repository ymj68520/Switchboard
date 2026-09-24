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
 * Append-only observation ledger, scoped per OpenCode session. Deliberately
 * tiny: observations are ephemeral working data, not committed state.
 * (Phase 2A refinement: the ledger is session-keyed because evidence
 * provenance must tie observations to the planning session that produced
 * them. The Phase 1 shape was an unwired type shell.)
 */
export interface ObservationLedger {
  append(sessionID: string, observation: Observation): Promise<void>;
  /** Observations made in the given session, in append order. */
  list(sessionID: string): Promise<Observation[]>;
}

/** In-memory ledger; durable persistence is a later-phase concern. */
export class InMemoryObservationLedger implements ObservationLedger {
  private readonly bySession = new Map<string, Observation[]>();

  async append(sessionID: string, observation: Observation): Promise<void> {
    const list = this.bySession.get(sessionID) ?? [];
    list.push(observation);
    this.bySession.set(sessionID, list);
  }

  async list(sessionID: string): Promise<Observation[]> {
    return [...(this.bySession.get(sessionID) ?? [])];
  }
}
