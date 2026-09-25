/**
 * Deterministic projections from committed memory revisions into the
 * structured context layers (Phase 8 directive §9–§15).
 *
 * Every projection is a pure function over exact CommittedRevisionViews from
 * the HEAD Snapshot. Ordering is explicit (artifact id within each kind —
 * §15); SQLite natural ordering is never relied on. Filtering rules:
 *
 *   constraints → severity=hard AND status=active at the snapshot's chosen
 *                 revisions (§12) — never from historical revisions,
 *                 conversation, or uncommitted proposal changes;
 *   questions   → open + blocking=true (§13);
 *   conflicts   → open + severity=hard (the engine's "blocking" semantics,
 *                 plan-commit-engine §58);
 *   architecture→ the at-most-one architecture revision, carried via its
 *                 FROZEN persisted compact projection — never re-summarized
 *                 (§9);
 *   sections    → identity (ref + title) only; activeSection is never
 *                 guessed (§10) and dependencyContracts stay empty while no
 *                 active-scope authority exists (§11).
 */

import type {
  ConflictContent,
  ConstraintContent,
  OpenQuestionContent,
  SectionContent,
} from "../core/memory-artifacts.js";
import { sortMemoryRefs } from "../core/memory-refs.js";
import type {
  CommittedRevisionView,
  ContextArchitecture,
  ContextBlockingConflict,
  ContextBlockingQuestion,
  ContextGlobalMemory,
  ContextHardConstraint,
  ContextSectionIdentity,
} from "./types.js";

/** Committed memory projection of the HEAD Snapshot (L2/L3). */
export function projectGlobalMemory(views: readonly CommittedRevisionView[]): ContextGlobalMemory {
  const architecture = projectArchitecture(views);
  const sections = projectSections(views);
  return {
    hardConstraints: projectHardConstraints(views),
    architecture,
    sections,
    blockingQuestions: projectBlockingQuestions(views),
    blockingConflicts: projectBlockingConflicts(views),
  };
}

function sortedById(views: readonly CommittedRevisionView[], kind: string): CommittedRevisionView[] {
  return sortMemoryRefs(
    views.filter((view) => view.ref.kind === kind).map((view) => view.ref),
  ).map((ref) => views.find((view) => view.ref.kind === ref.kind && view.ref.id === ref.id)!)
    .filter((view) => view !== undefined);
}

export function projectHardConstraints(views: readonly CommittedRevisionView[]): ContextHardConstraint[] {
  return sortedById(views, "constraint")
    .map((view) => ({ view, content: view.content as ConstraintContent }))
    .filter((entry) => entry.content.severity === "hard" && entry.content.status === "active")
    .map((entry) => ({
      ref: entry.view.ref,
      source: entry.content.source,
      statement: entry.content.statement,
    }));
}

export function projectArchitecture(views: readonly CommittedRevisionView[]): ContextArchitecture | null {
  const ref = views.find((view) => view.ref.kind === "architecture");
  // A run has at most one architecture identity, and a snapshot at most one
  // revision of it — the first hit is the only hit.
  return ref === undefined ? null : { ref: ref.ref, compactProjection: ref.compactProjection };
}

export function projectSections(views: readonly CommittedRevisionView[]): ContextSectionIdentity[] {
  return sortedById(views, "section").map((view) => ({
    ref: view.ref,
    title: (view.content as SectionContent).title,
  }));
}

export function projectBlockingQuestions(views: readonly CommittedRevisionView[]): ContextBlockingQuestion[] {
  return sortedById(views, "open_question")
    .map((view) => ({ view, content: view.content as OpenQuestionContent }))
    .filter((entry) => entry.content.status === "open" && entry.content.blocking === true)
    .map((entry) => ({ ref: entry.view.ref, question: entry.content.question }));
}

export function projectBlockingConflicts(views: readonly CommittedRevisionView[]): ContextBlockingConflict[] {
  return sortedById(views, "conflict")
    .map((view) => ({ view, content: view.content as ConflictContent }))
    .filter((entry) => entry.content.status === "open" && entry.content.severity === "hard")
    .map((entry) => ({
      ref: entry.view.ref,
      type: entry.content.type,
      severity: "hard" as const,
      description: entry.content.description,
    }));
}
