/**
 * VerificationWindow — v0.2.0 Phase 3 (supervised-execution structural layer).
 *
 * A VerificationWindow is the span of CANDIDATE execution work after the
 * current accepted execution state that has not yet been formally accepted
 * (SPEC v0.2.0 §14). It is NOT a Verifier session, NOT a Worker attempt,
 * NOT a Git branch, NOT a filesystem transaction — and it can NEVER advance
 * accepted execution truth by itself: only the future ExecutionCommit may
 * close a Window (directive §30 — no close/accept API exists in Phase 3;
 * `closed` exists in the schema purely for future hydration).
 *
 * CANDIDATE REVISION (directive §26-§29): `candidateRevision` is the
 * monotonic revision of candidate implementation state INSIDE the window —
 * starting at 0 (a legal state: window opened, no candidate-mutating work
 * completed yet). It is deliberately DISTINCT from the record's own
 * concurrency `revision`. It advances only by exactly +1 through an
 * expected-revision CAS; there is no setter, no decrement, no reset.
 *
 * BASE ACCEPTED STATE (directive §20): with no ExecutionCommit in existence
 * there is deliberately NO fake EC-000 — the first window anchors to the
 * run's `executionStartBaseline` via the tagged `execution_start` ref. The
 * `execution_commit` variant is reserved vocabulary for the future.
 */
import { UltraPlanError } from "./errors.js";
import type { ExecutionCommitID, ExecutionRunID, ExecutionStageID, VerificationWindowID } from "./ids.js";
import type { Timestamp } from "./refs.js";

/** Phase 3 window states ONLY (directive §21) — no verifying/failed/rework/blocked/accepted. */
export const VERIFICATION_WINDOW_STATES = ["open", "closed"] as const;
export type VerificationWindowState = (typeof VERIFICATION_WINDOW_STATES)[number];

/**
 * The accepted execution state a window's candidate span starts from.
 * `execution_start` = the run's executionStartBaseline; Phase 5: after the
 * first ExecutionCommit, later windows anchor to `execution_commit` (the
 * linear chain tip at window-open time). There is still no fake EC-000.
 */
export type AcceptedStateRef =
  | { kind: "execution_start"; executionRunID: ExecutionRunID }
  | { kind: "execution_commit"; executionCommitID: ExecutionCommitID };

export function assertAcceptedStateRef(value: unknown, executionRunID: ExecutionRunID): asserts value is AcceptedStateRef {
  if (typeof value !== "object" || value === null) {
    throw new UltraPlanError("window_not_found", "VerificationWindow is missing its baseAcceptedState anchor", { executionRunID });
  }
  const ref = value as Record<string, unknown>;
  if (ref["kind"] !== "execution_start" && ref["kind"] !== "execution_commit") {
    throw new UltraPlanError("window_not_found", `VerificationWindow baseAcceptedState kind ${String(ref["kind"])} is invalid`, { executionRunID });
  }
  if (ref["kind"] === "execution_start" && ref["executionRunID"] !== executionRunID) {
    throw new UltraPlanError("window_not_found", "VerificationWindow baseAcceptedState anchors a different ExecutionRun", { executionRunID });
  }
}

/** The durable candidate-span record. */
export interface VerificationWindow {
  id: VerificationWindowID;
  executionRunID: ExecutionRunID;
  /** The (single) active Stage this candidate span belongs to. */
  stageID: ExecutionStageID;

  state: VerificationWindowState;

  /** Monotonic candidate implementation revision; starts at 0; +1 only via CAS. */
  candidateRevision: number;

  /** The accepted state this candidate span starts from (never a fake commit). */
  baseAcceptedState: AcceptedStateRef;

  /** Record concurrency revision (CAS) — deliberately DISTINCT from candidateRevision. */
  revision: number;

  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** RESERVED: set only by the future ExecutionCommit transaction. */
  closedAt?: Timestamp;
}

export function assertVerificationWindowState(value: string): asserts value is VerificationWindowState {
  if (!(VERIFICATION_WINDOW_STATES as readonly string[]).includes(value)) {
    throw new UltraPlanError("window_not_found", `"${value}" is not a verification window state`, {
      value,
      known: VERIFICATION_WINDOW_STATES,
    });
  }
}

/**
 * THE candidate-revision staleness check (directive §29). Every future
 * Directive/Report/Assessment that references candidate state must pass
 * through this check — a reference to revision N goes stale the moment the
 * window advances to N+1.
 */
export function assertCurrentCandidateRevision(
  window: Pick<VerificationWindow, "id" | "candidateRevision">,
  expectedRevision: number,
): void {
  if (window.candidateRevision !== expectedRevision) {
    throw new UltraPlanError(
      "stale_candidate_revision",
      `VerificationWindow ${window.id} is at candidateRevision ${window.candidateRevision}; the presented revision ${expectedRevision} is stale`,
      { windowID: window.id, currentCandidateRevision: window.candidateRevision, presentedCandidateRevision: expectedRevision },
    );
  }
}
