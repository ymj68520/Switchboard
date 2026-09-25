/**
 * Recovery Capsule assembly with its bounded-size policy (Phase 8 directive
 * §17–§19).
 *
 * The capsule is a BOUNDED projection of the structured context — never a
 * full Plan Memory dump (§18). Budget policy (§19):
 *
 *   P0 (required — never dropped): run identity/stage/goal, HEAD pair,
 *       context epoch, hard constraints, blocking questions/conflicts,
 *       awaiting proposal, active-scope line, available operations.
 *   P1 (best effort — explicit omission): approved architecture projection,
 *       committed section identities.
 *
 * If the P0 set alone exceeds the budget the assembler fails closed with
 * CONTEXT_BUDGET_EXCEEDED rather than emitting a misleading capsule. P1
 * segments are dropped only with an explicit omission marker — a hard
 * constraint or blocking condition is never silently truncated (E16), and no
 * individual line is ever cut mid-content.
 */

import { RuntimeError } from "../runtime/errors.js";
import type { PhasePlanContext } from "./types.js";
import {
  activeScopeSegment,
  architectureSegment,
  awaitingProposalSegment,
  blockingSegment,
  hardConstraintsSegment,
  headSegment,
  operationsSegment,
  renderRecoveryCapsule,
  runSegment,
  sectionsSegment,
  type CapsuleSegment,
} from "./render.js";

/**
 * Documented budget choice (directive §18): comfortably fits a full
 * discovery-stage run plus an average architecture projection in well under
 * one model turn, while staying far below any context window. Purely a
 * rendering budget — it gates nothing else.
 */
export const RECOVERY_CAPSULE_MAX_CHARS = 12_000;

const SEPARATOR = "\n\n";
const OMISSION_MARKER_PREFIX = "Budget note: omitted due to capsule budget: ";

export interface RecoveryCapsule {
  text: string;
  /** True when at least one P1 segment was explicitly omitted. */
  truncated: boolean;
  epoch: string;
}

/** Segment display order (§17 sketch); budget priority rides on `required`. */
function capsuleSegments(context: PhasePlanContext): CapsuleSegment[] {
  return [
    runSegment(context),
    headSegment(context),
    hardConstraintsSegment(context),
    architectureSegment(context),
    activeScopeSegment(),
    blockingSegment(context),
    awaitingProposalSegment(context),
    sectionsSegment(context),
    operationsSegment(context),
  ];
}

function omissionMarker(omitted: readonly string[]): string {
  return `${OMISSION_MARKER_PREFIX}${omitted.join(", ")} — call get_context/read_memory for exact detail.`;
}

export function buildRecoveryCapsule(
  context: PhasePlanContext,
  options: { maxChars?: number } = {},
): RecoveryCapsule {
  const maxChars = options.maxChars ?? RECOVERY_CAPSULE_MAX_CHARS;
  const segments = capsuleSegments(context);
  const required = segments.filter((segment) => segment.required);
  const optional = segments.filter((segment) => !segment.required);

  const requiredText = renderRecoveryCapsule(required);
  if (requiredText.length > maxChars) {
    // §19 — fail closed instead of emitting a capsule that silently lost a
    // hard constraint or blocking condition.
    throw new RuntimeError(
      "CONTEXT_BUDGET_EXCEEDED",
      `recovery capsule required segments need ${requiredText.length} chars, exceeding the ${maxChars}-char budget`,
      { detail: { maxChars, requiredLength: requiredText.length } },
    );
  }

  // Greedy inclusion over the optional set; total length is independent of
  // display position, so accumulating it here is exact.
  const includedNames = new Set(required.map((segment) => segment.name));
  const omitted: string[] = [];
  let length = requiredText.length;
  for (const segment of optional) {
    const candidate = length + SEPARATOR.length + segment.text.length;
    if (candidate <= maxChars) {
      includedNames.add(segment.name);
      length = candidate;
    } else {
      omitted.push(segment.name);
    }
  }

  // Rendering keeps the canonical §17 display order regardless of budget.
  const included = segments.filter((segment) => includedNames.has(segment.name));
  let text = renderRecoveryCapsule(included);
  let truncated = false;
  if (omitted.length > 0) {
    const marker = omissionMarker(omitted);
    if (text.length + SEPARATOR.length + marker.length > maxChars) {
      throw new RuntimeError(
        "CONTEXT_BUDGET_EXCEEDED",
        "recovery capsule budget cannot fit the explicit omission marker",
        { detail: { maxChars } },
      );
    }
    text = `${text}${SEPARATOR}${marker}`;
    truncated = true;
  }

  return { text, truncated, epoch: context.epoch };
}
