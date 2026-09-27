/**
 * Context Trace — frozen architecture §19, completed by R2 (brief §51-§55).
 *
 * The Phase 1 module froze the §19 shape without instantiating it. R2 implements
 * the concept and extends it with the fields the budget manager and the
 * layer model require (brief §51/§55). The frozen required fields are kept:
 * id / headCommit / stage / activeWork / included[] / excluded[] / totalTokens.
 * Two documented adaptations to the real type system (both R2 brief "adapt to
 * the real type system" clauses):
 *
 * 1. `included[].ref` is OPTIONAL. The frozen shape assumed every traced
 *    fragment represents one MemoryRef, but L0/L1/L5 and the derived synthesis
 *    capsule are structural fragments without a MemoryRef; `fragmentId` (a
 *    stable deterministic string, e.g. "L2:constraint:CON-001") is always
 *    present instead.
 * 2. `RetrievalReason` gains the always-included structural fragments
 *    (protocol / run_state / goal / capabilities / architecture_compact) and
 *    the five documented Evidence-specific reasons of R2 brief §54.
 *
 * A trace is OBSERVABILITY ONLY (§53): it is never persisted through
 * PlanCommit, never moves HEAD, and is never planning authority.
 */
import type { ContextTraceID, CommitID, PlanID } from "../core/ids.js";
import type { MemoryRef, WorkRef } from "../core/refs.js";
import type { PlanningStage } from "../core/types.js";

export type DetailLevel = "identity" | "summary" | "relevant" | "full";

/**
 * Detail ordering: `full` renders the most content, `identity` the least.
 * Budget degradation steps down this chain one level at a time and never
 * below a fragment's `minimumDetail` (brief §48/§49) — compression is ALWAYS a
 * switch to another deterministic projection level, never substring truncation
 * (brief §50).
 */
export const DETAIL_LEVEL_ORDER: readonly DetailLevel[] = ["full", "relevant", "summary", "identity"];

export type RetrievalReason =
  // The frozen §19 vocabulary:
  | "global_constraint"
  | "active_scope"
  | "direct_dependency"
  | "transitive_dependency"
  | "explicit_reference"
  | "blocking_conflict"
  | "open_question"
  | "current_proposal"
  // R2: the always-included structural fragments (documented addition).
  | "protocol"
  | "run_state"
  | "goal"
  | "capabilities"
  | "architecture_compact"
  // R2 §54: documented Evidence-specific retrieval reasons.
  | "blocking_evidence"
  | "active_decision_evidence"
  | "active_section_evidence"
  | "architecture_evidence"
  | "dependency_evidence";

/** The six context layers of frozen architecture §14 (R2 brief §7). */
export const CONTEXT_LAYERS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type ContextLayer = (typeof CONTEXT_LAYERS)[number];

/** The P0-P3 budget priorities of frozen architecture §16 (R2 brief §44). */
export const CONTEXT_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type ContextPriority = (typeof CONTEXT_PRIORITIES)[number];

/**
 * How the budget manager disposed of one fragment (brief §55):
 * - kept: rendered at the desired detail level;
 * - downgraded: rendered, but at a lower deterministic projection level than
 *   desired (the trace records both);
 * - dropped: excluded from the rendered context entirely (budget reason in
 *   `excluded[]`).
 */
export type BudgetDecision = "kept" | "downgraded" | "dropped";

export interface ContextTraceIncludedEntry {
  /** Stable fragment id; always present (see adaptation note 1). */
  fragmentId: string;
  /** Exact memory ref when the fragment represents one. */
  ref?: MemoryRef;
  layer: ContextLayer;
  priority: ContextPriority;
  projection: DetailLevel;
  desiredDetail: DetailLevel;
  reason: RetrievalReason;
  /** ALL retrieval reasons when deduplication merged several paths (primary first). */
  reasons: RetrievalReason[];
  estimatedTokens: number;
  budgetDecision: BudgetDecision;
}

export interface ContextTraceExcludedEntry {
  fragmentId: string;
  ref?: MemoryRef;
  layer?: ContextLayer;
  /** Stable machine reason, e.g. "budget_dropped_p3", "resolved_conflict_not_current". */
  reason: string;
}

/**
 * One deterministic projection of a fragment at a specific detail level
 * (brief §7/§8). A fragment carries one variant per level from desiredDetail
 * down to minimumDetail — budget degradation switches between variants and
 * never truncates text (brief §50).
 */
export interface ContextProjectionVariant {
  level: DetailLevel;
  text: string;
}

/**
 * The internal deterministic fragment model (R2 brief §7). Fragments are NOT
 * committed Plan Memory and are never exposed as such — they are the assembler's
 * working representation of one model-visible piece of context.
 */
export interface ContextFragment {
  /** Stable deterministic id, e.g. "L2:constraint:CON-001". */
  id: string;
  layer: ContextLayer;
  priority: ContextPriority;
  /** Primary (strongest) retrieval reason. */
  reason: RetrievalReason;
  /** ALL retrieval reasons when deduplication merged several paths (primary first). */
  reasons: RetrievalReason[];
  /** Exact memory ref when the fragment represents one. */
  ref?: MemoryRef;
  /** Canonical ordering key — the deterministic tie-break within (layer, priority). */
  orderKey: string;
  desiredDetail: DetailLevel;
  minimumDetail: DetailLevel;
  droppable: boolean;
  variants: ContextProjectionVariant[];
}

export interface ContextTrace {
  id: ContextTraceID;

  planID: PlanID;
  headCommit?: CommitID;
  stage: PlanningStage;
  activeWork?: WorkRef;

  included: ContextTraceIncludedEntry[];
  excluded: ContextTraceExcludedEntry[];

  /** The configured Ultra Plan context budget (estimated tokens). */
  budget: number;
  /**
   * True when the REQUIRED minimum context exceeded the budget. P0 content is
   * still rendered in full (never silently dropped — brief §17); the flag plus
   * the structured `ultraplan.context.overflow` warning record the violation.
   */
  overBudget: boolean;

  totalTokens: number;
}
