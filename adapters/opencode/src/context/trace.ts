/**
 * Context Trace — spec §19.
 *
 * Type-only module in Phase 1: the Context Assembler and its runtime trace
 * collection are later-phase work (see Phase 1 non-goals). The frozen shape is
 * established now so retrieval decisions remain observable from day one.
 */
import type { ContextTraceID, CommitID } from "../core/ids.js";
import type { MemoryRef, WorkRef } from "../core/refs.js";
import type { PlanningStage } from "../core/types.js";

export type DetailLevel = "identity" | "summary" | "relevant" | "full";

export type RetrievalReason =
  | "global_constraint"
  | "active_scope"
  | "direct_dependency"
  | "transitive_dependency"
  | "explicit_reference"
  | "blocking_conflict"
  | "open_question"
  | "current_proposal";

export interface ContextTrace {
  id: ContextTraceID;

  headCommit: CommitID;
  stage: PlanningStage;
  activeWork?: WorkRef;

  included: {
    ref: MemoryRef;
    projection: DetailLevel;
    reason: RetrievalReason;
    estimatedTokens: number;
  }[];

  excluded: {
    ref: MemoryRef;
    reason: string;
  }[];

  totalTokens: number;
}
