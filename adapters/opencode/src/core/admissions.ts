/**
 * Explicit plan-entry admission — Phase 2A.1 Correction B.
 *
 * The user must explicitly enter Ultra Plan via the /ultra-plan command. The
 * planning model can never create or resume a PlanningRun on its own, even
 * though `ultraplan_start` is visible in its tool surface.
 *
 * Mechanism: the plugin's `command.execute.before` hook (a real OpenCode hook;
 * the model cannot invoke it) issues a StartAdmission for the session when —
 * and only when — the /ultra-plan command fires. `ultraplan_start` consumes
 * one matching admission through the controller. Admissions are:
 *
 * - session-scoped (invalid for another session);
 * - command-specific;
 * - one-shot (consumed on first successful use);
 * - short-lived (TTL, see START_ADMISSION_TTL_MS);
 * - Harness-created only (no tool, no tool argument can mint one).
 */
import { UltraPlanError } from "./errors.js";
import type { Timestamp } from "./refs.js";

/**
 * Admissions expire after 10 minutes. The command template directs the model
 * to call `ultraplan_start` immediately, so this only guards against stale
 * admissions being replayed much later in a session. One-shot consumption is
 * the primary non-replayability property; the TTL is defense in depth.
 */
export const START_ADMISSION_TTL_MS = 10 * 60 * 1000;

export interface StartAdmission {
  sessionID: string;
  command: string;
  issuedAt: Timestamp;
  expiresAt: Timestamp;
  /** Set when consumed; a consumed admission can never be used again. */
  consumedAt: Timestamp | null;
}

export interface StartAdmissionLedger {
  /** Harness-only: record a one-shot admission for a session. */
  issue(sessionID: string, command: string, now?: Timestamp): StartAdmission;
  /**
   * Consume the oldest valid admission for this session+command. Throws
   * `start_not_authorized` when no unconsumed, unexpired admission exists.
   */
  consume(sessionID: string, command: string, now?: Timestamp): StartAdmission;
  /** Outstanding (unconsumed, unexpired) admissions for a session. */
  list(sessionID: string): StartAdmission[];
}

export class InMemoryStartAdmissionLedger implements StartAdmissionLedger {
  private readonly bySession = new Map<string, StartAdmission[]>();
  private readonly now: () => Timestamp;
  private readonly ttlMs: number;

  constructor(
    now: () => Timestamp = () => new Date().toISOString(),
    ttlMs: number = START_ADMISSION_TTL_MS,
  ) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  issue(sessionID: string, command: string): StartAdmission {
    const issuedAt = this.now();
    const admission: StartAdmission = {
      sessionID,
      command,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + this.ttlMs).toISOString(),
      consumedAt: null,
    };
    const list = this.bySession.get(sessionID) ?? [];
    list.push(admission);
    this.bySession.set(sessionID, list);
    return admission;
  }

  consume(sessionID: string, command: string): StartAdmission {
    const list = this.bySession.get(sessionID) ?? [];
    const nowMs = Date.parse(this.now());
    const index = list.findIndex(
      (admission) =>
        admission.command === command &&
        admission.consumedAt === null &&
        Date.parse(admission.expiresAt) > nowMs,
    );
    const admission = index >= 0 ? list[index] : undefined;
    if (!admission) {
      throw new UltraPlanError(
        "start_not_authorized",
        `No valid /${command} admission for session ${sessionID}; planning entry requires an explicit /ultra-plan command issued by the user`,
        { sessionID, command },
      );
    }
    admission.consumedAt = this.now();
    return admission;
  }

  list(sessionID: string): StartAdmission[] {
    return [...(this.bySession.get(sessionID) ?? [])];
  }
}
