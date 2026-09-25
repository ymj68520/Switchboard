/**
 * Structured Phase Plan context model (Phase 8 directive §2/§16).
 *
 * Context is a PROJECTION of authoritative Store state — never authority
 * itself (directive §1): injection failures may degrade reasoning quality but
 * can never authorize a mutation. The six logical layers are represented
 * structurally, not as six markdown sections:
 *
 *   L0 Planning Protocol      → `protocol` (static protocol identity)
 *   L1 Run State              → `run` + `head`
 *   L2 Global Committed Memory → `globalMemory` (architecture, hard
 *                                constraints) at the HEAD Snapshot
 *   L3 Active Scope Memory    → `globalMemory.sections` identities +
 *                                `activeScope` (deliberately null until the
 *                                Section workflow phase establishes active-
 *                                scope authority — directive §8)
 *   L4 Working Context        → `working.awaitingProposal`
 *   L5 Available Operations   → `operations`
 *
 * This module is pure: it must never import hooks, the MCP SDK, node:sqlite,
 * the filesystem, or process.env (directive §3).
 */

import type { MemoryRevisionContent } from "../core/memory-artifacts.js";
import type { MemoryRef } from "../core/memory-refs.js";
import type { ProposalScope, ProposalType } from "../core/proposal.js";

export const CONTEXT_MODEL_VERSION = 1 as const;

/** L0 — static identity of the planning protocol layer. */
export interface ContextProtocol {
  readonly name: "phase-plan";
  readonly entry: "/phase-plan";
  readonly contextModelVersion: typeof CONTEXT_MODEL_VERSION;
}

/** L1 — run state (frozen plan §5/§6 fields relevant to context). */
export interface ContextRunState {
  runId: string;
  lifecycle: string;
  stage: string;
  revision: number;
  goal: string;
}

/** L1 — the run's HEAD Commit/Snapshot pair (either side may be absent). */
export interface ContextHead {
  commitId: string | null;
  snapshotId: string | null;
}

/** L2 — one hard constraint at its current exact HEAD revision. */
export interface ContextHardConstraint {
  ref: MemoryRef;
  source: "user" | "repository" | "environment" | "runtime";
  statement: string;
}

/** L2 — the approved architecture via its frozen stable compact projection. */
export interface ContextArchitecture {
  ref: MemoryRef;
  compactProjection: string;
}

/** L3 — committed section identity (title only; detail via read_memory). */
export interface ContextSectionIdentity {
  ref: MemoryRef;
  title: string;
}

/** Blocking = open + blocking=true (committed HEAD authority, §13). */
export interface ContextBlockingQuestion {
  ref: MemoryRef;
  question: string;
}

/** Blocking = open + severity hard (engine §58 semantics). */
export interface ContextBlockingConflict {
  ref: MemoryRef;
  type: string;
  severity: "hard";
  description: string;
}

/** L2/L3 — committed memory visible at the HEAD Snapshot, deterministic order. */
export interface ContextGlobalMemory {
  hardConstraints: ContextHardConstraint[];
  architecture: ContextArchitecture | null;
  sections: ContextSectionIdentity[];
  blockingQuestions: ContextBlockingQuestion[];
  blockingConflicts: ContextBlockingConflict[];
}

/** L4 — the awaiting proposal, always SEPARATE from committed memory (§14). */
export interface ContextAwaitingProposal {
  proposalId: string;
  revision: number;
  hash: string;
  type: ProposalType;
  scope: ProposalScope;
  title: string;
  summary: string;
}

export interface ContextWorking {
  awaitingProposal: ContextAwaitingProposal | null;
}

/** L5 — operations logically available under the current state (§27). */
export type ContextOperation =
  | "get_state"
  | "get_context"
  | "read_memory"
  | "start_or_resume"
  | "approve_proposal";

/** Internal provenance of one assembly (directive §44) — tests/debug aid. */
export interface ContextSourceTrace {
  runRevision: number;
  headCommitId: string | null;
  headSnapshotId: string | null;
  snapshotRefCount: number;
  awaitingProposalRevision: number | null;
}

export interface PhasePlanContext {
  version: typeof CONTEXT_MODEL_VERSION;
  epoch: string;
  protocol: ContextProtocol;
  run: ContextRunState;
  head: ContextHead;
  globalMemory: ContextGlobalMemory;
  /** §8: no authoritative active scope exists yet — never guessed (§10). */
  activeScope: null;
  working: ContextWorking;
  operations: ContextOperation[];
  sourceTrace: ContextSourceTrace;
}

// ---------------------------------------------------------------------------
// Authoritative read-model port (directive §3: the Application layer provides
// the store-backed implementation; the Context layer only assembles/projects)
// ---------------------------------------------------------------------------

/** One committed memory revision exactly as persisted (parsed + projections). */
export interface CommittedRevisionView {
  ref: MemoryRef;
  content: MemoryRevisionContent;
  compactProjection: string;
  contractJson: string | null;
}

/**
 * The read-model port the assembler consumes. Implementations MUST source
 * every value from the Plan Store's Phase 5/6 read APIs — never from
 * conversation text, compact summaries, or model input (§26/§31).
 */
export interface ContextSource {
  getRun(runId: string): ContextRunState | null;
  getHeadPair(runId: string): ContextHead;
  listHeadSnapshotRefs(runId: string): MemoryRef[];
  readRevision(ref: MemoryRef): CommittedRevisionView | null;
  getAwaitingProposal(runId: string): ContextAwaitingProposal | null;
}
