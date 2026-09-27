/**
 * Budget Manager — frozen architecture §16 + R2 brief §44/§46/§47/§48/§49/§50.
 *
 * Deterministic, provider-neutral, never model-driven. The budget applies ONLY
 * to the Ultra Plan assembled model-visible context (brief §45) — never to the
 * OpenCode conversation, tool schemas, host system prompts, or model responses.
 *
 * Token estimation (brief §47): the audited OpenCode 1.18.x runtime exposes NO
 * reliable tokenizer API for arbitrary candidate system context (the plugin
 * surface has no such export), so a deterministic documented estimator is used
 * through this boundary:
 *
 *   estimateTokens(text) = ceil(asciiUnits / 4) + nonAsciiUnits
 *
 * where every code point ≤ U+007F counts 1 asciiUnit and every code point
 * above U+007F counts 1 nonAsciiUnit (i.e. ≈1 token). Properties: pure, stable
 * across processes, UTF-8 safe, provider-neutral, and CONSERVATIVE for
 * budgeting (CJK text realistically costs ~1-2 tokens per code point; the
 * estimator charges 1 per code point plus the ASCII share). These are budget
 * ESTIMATES, never provider billing-token counts. No model-specific tokenizer
 * subsystem was added (brief §47's explicit non-goal).
 *
 * Degradation (brief §48): a single fixed-order action loop — P3 downgrade
 * steps, then droppable-P3 drops, then P2, then only-explicitly-droppable P1.
 * P0 is never dropped and never degrades below its minimum projection; the
 * required L2 Architecture compact is a P2 fragment whose minimum is
 * non-droppable (brief §16 resolution). Tie-breaking is the canonical
 * fragment order (brief §81) — repeated runs make identical choices.
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../core/invariants.js";
import type {
  BudgetDecision,
  ContextFragment,
  ContextLayer,
  ContextPriority,
  DetailLevel,
} from "./trace.js";
import { DETAIL_LEVEL_ORDER } from "./trace.js";

/** Conservative default Ultra Plan context budget (estimated tokens). */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 12_000;

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

/**
 * Deterministic trace identity (brief §52): a hash over the assembly inputs
 * and decisions — never an allocator, never a clock. Context assembly stays
 * read-only.
 */
export function computeTraceId(payload: unknown): string {
  const hash = createHash("sha256");
  hash.update(stableStringify(payload));
  return `TRACE-${hash.digest("hex").slice(0, 12)}`;
}

/** The canonical ordering key space: layer order, then priority, then the fragment's own key. */
const LAYER_ORDER: Record<ContextLayer, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 };
const PRIORITY_ORDER: Record<ContextPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Deterministic canonical ordering of fragments (brief §11/§81). */
export function compareFragments(a: ContextFragment, b: ContextFragment): number {
  const layerDelta = LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer];
  if (layerDelta !== 0) return layerDelta;
  const priorityDelta = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (priorityDelta !== 0) return priorityDelta;
  if (a.orderKey !== b.orderKey) return a.orderKey < b.orderKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function stepDown(level: DetailLevel, minimum: DetailLevel): DetailLevel | undefined {
  const order = DETAIL_LEVEL_ORDER; // full → relevant → summary → identity
  const current = order.indexOf(level);
  const floor = order.indexOf(minimum);
  if (current < 0 || floor < 0 || current >= order.length - 1 || current >= floor) return undefined;
  return order[current + 1];
}

export interface BudgetedFragment {
  fragment: ContextFragment;
  /** The projection level the budget decided to render. */
  level: DetailLevel;
  budgetDecision: BudgetDecision;
  estimatedTokens: number;
  text: string;
}

export interface BudgetResult {
  included: BudgetedFragment[];
  excluded: { fragment: ContextFragment; reason: string }[];
  overBudget: boolean;
  totalTokens: number;
}

function renderAt(fragment: ContextFragment, level: DetailLevel): string {
  const variant = fragment.variants.find((candidate) => candidate.level === level);
  // Every fragment carries variants for every level from desired down to
  // minimum (the assembler builds them), so a miss is an invariant violation.
  if (!variant) {
    throw new Error(`context fragment ${fragment.id} has no ${level} projection variant`);
  }
  return variant.text;
}

function variantTokens(fragment: ContextFragment, level: DetailLevel): number {
  return estimateTokens(renderAt(fragment, level));
}

/**
 * Apply the deterministic budget degradation to the fragment set. `budget` is
 * the estimated-token ceiling. Returns the included fragments (with their
 * final levels) and the excluded ones with stable machine reasons.
 */
export function applyBudget(fragments: readonly ContextFragment[], budget: number): BudgetResult {
  // Working state: every fragment at its desired level.
  const state = new Map<string, { fragment: ContextFragment; level: DetailLevel }>();
  for (const fragment of [...fragments].sort(compareFragments)) {
    state.set(fragment.id, { fragment, level: fragment.desiredDetail });
  }

  const totalAt = (): number =>
    [...state.values()].reduce((sum, entry) => sum + variantTokens(entry.fragment, entry.level), 0);

  const canonicalOrder = (): { fragment: ContextFragment; level: DetailLevel }[] =>
    [...state.values()].sort((a, b) => compareFragments(a.fragment, b.fragment));

  // Fixed-order action loop (brief §48's sequence, one action per iteration,
  // stable tie-break by canonical order).
  for (;;) {
    if (totalAt() <= budget) break;
    let acted = false;
    for (const priority of ["P3", "P2", "P1"] as const) {
      // (a) downgrade one step: first fragment of this priority above minimum.
      for (const entry of canonicalOrder()) {
        if (entry.fragment.priority !== priority) continue;
        const next = stepDown(entry.level, entry.fragment.minimumDetail);
        if (next !== undefined) {
          state.set(entry.fragment.id, { fragment: entry.fragment, level: next });
          acted = true;
          break;
        }
      }
      if (acted) break;
      // (b) drop droppable: first explicitly droppable fragment of this priority.
      for (const entry of canonicalOrder()) {
        if (entry.fragment.priority !== priority) continue;
        if (entry.fragment.droppable) {
          state.delete(entry.fragment.id);
          acted = true;
          break;
        }
      }
      if (acted) break;
    }
    if (!acted) break;
  }

  const overBudget = totalAt() > budget;
  if (overBudget) {
    // Required minimum context exceeds the budget (brief §17): P0 is never
    // dropped, but remaining DROPPABLE fragments give way so the required
    // minimum renders complete — P3 first, then P2, then P1.
    for (const priority of ["P3", "P2", "P1"] as const) {
      for (const entry of [...canonicalOrder()]) {
        if (entry.fragment.priority === priority && entry.fragment.droppable) {
          state.delete(entry.fragment.id);
        }
      }
    }
  }

  const included: BudgetedFragment[] = [];
  const excluded: { fragment: ContextFragment; reason: string }[] = [];
  const before = new Map(fragments.map((fragment) => [fragment.id, fragment] as const));
  for (const entry of canonicalOrder()) {
    const order = DETAIL_LEVEL_ORDER;
    included.push({
      fragment: entry.fragment,
      level: entry.level,
      budgetDecision:
        order.indexOf(entry.level) === order.indexOf(entry.fragment.desiredDetail) ? "kept" : "downgraded",
      estimatedTokens: variantTokens(entry.fragment, entry.level),
      text: renderAt(entry.fragment, entry.level),
    });
  }
  for (const fragment of before.keys()) {
    if (!state.has(fragment)) {
      excluded.push({
        fragment: before.get(fragment)!,
        reason: `budget_dropped_${before.get(fragment)!.priority.toLowerCase()}`,
      });
    }
  }
  return { included, excluded, overBudget, totalTokens: totalAt() };
}
