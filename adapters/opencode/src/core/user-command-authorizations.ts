/**
 * User execution-command authorizations — v0.2.0 Phase 7B (§30-§37/§41).
 *
 * The typed, HOST-parsed companion to the /ultra-plan start admission. The
 * OpenCode `command.execute.before` hook sees the RAW user-typed arguments —
 * the model cannot invoke that hook and cannot mint an authorization. The
 * planning model's tool call merely forwards its own (untrusted) args; the
 * controller consumes a matching HOST-MINTED authorization before any
 * takeover/abort/replan action runs, so "the human explicitly requested it"
 * is enforced mechanically, never by prompt discipline:
 *
 *   /ultra-plan                        → plan (goal optional)  [start admission]
 *   /ultra-plan new <goal>             → fresh planning run, no replan binding
 *   /ultra-plan resume [EXEC-###]      → resume supervised execution
 *   /ultra-plan resume EXEC-### --takeover → explicit cross-session takeover
 *   /ultra-plan abort EXEC-###         → explicit human abort of ONE exact run
 *   /ultra-plan replan [EXEC-###]      → start replanning from the ExecutionIssue
 *
 * Authorizations are session-scoped, one-shot, and short-lived, exactly like
 * StartAdmission (core/admissions.ts).
 */
import { UltraPlanError } from "./errors.js";
import type { Timestamp } from "./refs.js";

export const USER_COMMAND_TTL_MS = 10 * 60 * 1000;

export type UserExecutionCommand =
  | { kind: "plan"; goal?: string }
  | { kind: "new"; goal?: string }
  | { kind: "resume"; executionRunID?: string }
  | { kind: "takeover"; executionRunID?: string }
  | { kind: "abort"; executionRunID: string }
  | { kind: "replan"; executionRunID?: string };

const EXECUTION_RUN_ID_PATTERN = /^EXEC-\d+$/;

/** Deterministic host-side parse of the RAW /ultra-plan arguments (§33/§35). */
export function parseUserExecutionCommand(rawArguments: string): UserExecutionCommand {
  const trimmed = rawArguments.trim();
  if (trimmed === "") return { kind: "plan" };
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0]!.toLowerCase();
  const rest = tokens.slice(1);
  const runRef = rest.find((token) => EXECUTION_RUN_ID_PATTERN.test(token.toUpperCase()));
  const executionRunID = runRef ? (runRef.toUpperCase() as string) : undefined;
  const goal = rest.filter((token) => token !== "--takeover").join(" ").trim();
  switch (head) {
    case "new":
      return { kind: "new", ...(goal ? { goal } : {}) };
    case "resume":
      return rest.includes("--takeover")
        ? { kind: "takeover", ...(executionRunID ? { executionRunID } : {}) }
        : { kind: "resume", ...(executionRunID ? { executionRunID } : {}) };
    case "takeover":
      return { kind: "takeover", ...(executionRunID ? { executionRunID } : {}) };
    case "abort":
      // §36 — an abort must identify the EXACT ExecutionRun; a bare "abort"
      // is not a valid user abort and degrades to an ordinary plan entry
      // rather than guessing a target.
      return executionRunID ? { kind: "abort", executionRunID } : { kind: "plan", goal: trimmed };
    case "replan":
      return { kind: "replan", ...(executionRunID ? { executionRunID } : {}) };
    default:
      // Anything else is the historical goal text of a fresh planning run.
      return { kind: "plan", goal: trimmed };
  }
}

export interface UserExecutionAuthorization {
  sessionID: string;
  command: UserExecutionCommand;
  issuedAt: Timestamp;
  expiresAt: Timestamp;
  consumedAt: Timestamp | null;
}

export interface UserExecutionCommandLedger {
  /** Harness-only: record a one-shot authorization parsed from raw user args. */
  issue(sessionID: string, command: UserExecutionCommand, now?: Timestamp): UserExecutionAuthorization;
  /**
   * Consume the matching authorization. Throws `start_not_authorized` when no
   * unconsumed, unexpired, kind-and-target-matching authorization exists —
   * which is exactly the "the model tried this on its own" case.
   */
  consume(sessionID: string, command: UserExecutionCommand, now?: Timestamp): UserExecutionAuthorization;
}

export class InMemoryUserExecutionCommandLedger implements UserExecutionCommandLedger {
  private readonly bySession = new Map<string, UserExecutionAuthorization[]>();
  private readonly now: () => Timestamp;
  private readonly ttlMs: number;

  constructor(now: () => Timestamp = () => new Date().toISOString(), ttlMs: number = USER_COMMAND_TTL_MS) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  issue(sessionID: string, command: UserExecutionCommand, now?: Timestamp): UserExecutionAuthorization {
    const at = now ?? this.now();
    const authorization: UserExecutionAuthorization = {
      sessionID,
      command,
      issuedAt: at,
      expiresAt: new Date(Date.parse(at) + this.ttlMs).toISOString(),
      consumedAt: null,
    };
    const list = this.bySession.get(sessionID) ?? [];
    list.push(authorization);
    this.bySession.set(sessionID, list);
    return authorization;
  }

  consume(sessionID: string, command: UserExecutionCommand, now?: Timestamp): UserExecutionAuthorization {
    const at = now ?? this.now();
    const list = this.bySession.get(sessionID) ?? [];
    const index = list.findIndex((candidate) => {
      if (candidate.consumedAt !== null || candidate.expiresAt <= at) return false;
      if (candidate.command.kind !== command.kind) return false;
      // An authorization naming an exact run is only consumed by the same
      // target; an open authorization matches any target of the same kind.
      const authorizedRunID = "executionRunID" in candidate.command ? candidate.command.executionRunID : undefined;
      const requestedRunID = "executionRunID" in command ? command.executionRunID : undefined;
      return authorizedRunID === undefined || requestedRunID === undefined || authorizedRunID === requestedRunID;
    });
    if (index < 0) {
      throw new UltraPlanError(
        "start_not_authorized",
        `No user-issued /ultra-plan authorization for "${command.kind}" in this session; execution control actions must be typed by the user in the command itself`,
        { kind: command.kind },
      );
    }
    const [authorization] = list.splice(index, 1);
    if (list.length === 0) this.bySession.delete(sessionID);
    return { ...authorization!, consumedAt: at };
  }
}
