/**
 * ExecutionHandoff application service (Phase 14 §1/§22/§35/§37/§42–§43/§63/§90–§91).
 *
 * Authority model (§1/§47/§48): Final Approval + Final PlanCommit already
 * authorize the Plan → Build transition; this layer NEVER re-runs the
 * FinalizationGate, the Evidence audit, or the semantic validator, never
 * mutates Evidence/Section/Plan Memory state, and never asks for a second
 * approval. The handoff is a deterministic projection of the approved
 * FinalPlan plus the frozen repository baseline.
 *
 * Two transactions carry the whole lifecycle:
 *
 *   prepareHandoffDelivery (§35/§42/§90)  eligibility re-check → derive or
 *     reuse the immutable handoff → create/reuse the ExecutionBinding →
 *     DELIVERY_ATTEMPT bound to the exact tool_use_id — the PlanningRun stays
 *     active; the MCP return alone is NOT delivery (§36)
 *
 *   finalizeDelivery (§37/§93) — the trusted PostToolUse acknowledgement:
 *     exact attempt lookup + handoff id/hash verification, then ONE
 *     transaction: DELIVERED + state → delivered + PlanningRun active→
 *     completed + revision +1 exactly once + planning SessionBinding detach.
 *     Idempotent replays and competing attempts converge on one delivery (§39).
 *
 * Build read authority (§91) requires ALL of: completed run, approved
 * FinalPlan, delivered handoff, attached exact-session ExecutionBinding with
 * the exact generation.
 */

import { canonicalJson } from "../core/canonical-json.js";
import {
  executionHandoffHash,
  type ExecutionHandoffV1,
  type RepositoryBaseline,
} from "../core/execution-handoff.js";
import type { FinalPlanV1 } from "../core/finalization.js";
import {
  parseMemoryRevisionContent,
  type ConstraintContent,
  type MemoryRevisionContent,
} from "../core/memory-artifacts.js";
import type { MemoryArtifactKind } from "../core/memory-refs.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";
import { RuntimeError } from "../runtime/errors.js";
import { observeGitHeadSync } from "../evidence/fingerprint-check.js";
import { detachBindingInTx } from "../store/session-bindings.js";
import {
  findDeliveryAttemptInTx,
  getExecutionBindingInTx,
  getExecutionHandoffInTx,
  getExecutionHandoffStateInTx,
  insertAttachedExecutionBindingInTx,
  insertExecutionHandoffEventInTx,
  insertExecutionHandoffInTx,
  insertExecutionHandoffStateInTx,
  reattachExecutionBindingInTx,
  updateExecutionHandoffStateInTx,
  type ExecutionBindingRow,
  type ExecutionHandoffRow,
  type ExecutionHandoffStateRow,
} from "../store/execution.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import { runStateError } from "../store/planning-runs.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";

function handoffError(
  code:
    | "HANDOFF_NOT_AUTHORIZED"
    | "HANDOFF_ALREADY_DELIVERED"
    | "HANDOFF_DELIVERY_INVALID"
    | "EXECUTION_BINDING_REQUIRED"
    | "STALE_EXECUTION_BINDING"
    | "EXECUTION_CONTEXT_NOT_AVAILABLE"
    | "EXECUTION_MEMORY_REF_NOT_AUTHORIZED"
    | "CAPABILITY_NOT_AVAILABLE",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail });
}

/** The FinalPlan canonical persisted by the Final PlanCommit (Phase 13 §54). */
export function parseFinalPlanCanonical(raw: unknown, runId: string): FinalPlanV1 {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw handoffError("HANDOFF_NOT_AUTHORIZED", `FinalPlan canonical payload in run '${runId}' is unparsable`);
    }
  }
  if (typeof raw !== "object" || raw === null) {
    throw handoffError("HANDOFF_NOT_AUTHORIZED", `FinalPlan canonical payload in run '${runId}' is not an object`);
  }
  const plan = raw as FinalPlanV1;
  if (plan.version !== 1 || !Array.isArray(plan.sections) || !Array.isArray(plan.decisions) || !Array.isArray(plan.constraints)) {
    throw handoffError("HANDOFF_NOT_AUTHORIZED", `FinalPlan canonical payload in run '${runId}' has an unsupported shape`);
  }
  return plan;
}

function loadRunInTx(tx: StoreTx, runId: string): PlanningRun {
  const row = tx
    .prepare(
      "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
      + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
    )
    .get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw runStateError("RUN_NOT_FOUND", `no PlanningRun exists for '${runId}'`, { runId });
  }
  return parsePlanningRunRow(row);
}

/** In-tx exact memory revision content load (constraint severity filter, §26). */
function loadMemoryRevisionContentInTx(
  tx: StoreTx,
  ref: { runId: string; kind: MemoryArtifactKind; id: string; revision: number },
): MemoryRevisionContent {
  const row = tx
    .prepare(
      "SELECT content_json AS contentJson FROM memory_revisions "
      + "WHERE run_id = ? AND kind = ? AND artifact_id = ? AND revision = ?",
    )
    .get(ref.runId, ref.kind, ref.id, ref.revision) as { contentJson: string } | undefined;
  if (row === undefined) {
    throw handoffError(
      "HANDOFF_NOT_AUTHORIZED",
      `FinalPlan references missing memory revision ${ref.kind} '${ref.id}@${ref.revision}'`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.contentJson);
  } catch {
    throw handoffError("HANDOFF_NOT_AUTHORIZED", `memory revision '${ref.id}@${ref.revision}' has unparsable content`);
  }
  return parseMemoryRevisionContent(ref.kind, parsed, ref.runId, ref.id, ref.revision);
}

// ---------------------------------------------------------------------------
// §22–§31 — deterministic handoff derivation
// ---------------------------------------------------------------------------

/**
 * Derive ExecutionHandoffV1 entirely from the approved FinalPlan, the run
 * goal, and the frozen repository baseline. The model supplies nothing; no
 * gate rerun happens (§47); Evidence is not touched (§48).
 */
export function deriveExecutionHandoffInTx(
  tx: StoreTx,
  input: { runId: string; run: PlanningRun; finalPlan: FinalPlanV1; finalPlanId: string; finalPlanRevision: number; finalPlanHash: string; baseline: RepositoryBaseline },
): { handoff: ExecutionHandoffV1; handoffHash: string } {
  if (input.finalPlan.architecture === null) {
    throw handoffError("HANDOFF_NOT_AUTHORIZED", "the approved FinalPlan carries no architecture at HEAD", {
      finalPlanId: input.finalPlanId,
    });
  }
  // §26 — exact FinalPlan constraint refs, filtered to severity=hard; soft
  // constraints stay readable through Build read_memory but never bind Build.
  const hardConstraints = input.finalPlan.constraints
    .filter((ref) => {
      const content = loadMemoryRevisionContentInTx(tx, {
        runId: input.runId,
        kind: "constraint",
        id: ref.id,
        revision: ref.revision,
      });
      return (content as ConstraintContent).severity === "hard";
    })
    .map((ref) => ({ id: ref.id, revision: ref.revision }));
  const handoff: ExecutionHandoffV1 = {
    version: 1,
    finalPlan: { id: input.finalPlanId, revision: input.finalPlanRevision, hash: input.finalPlanHash },
    repositoryBaseline: input.baseline,
    goal: input.run.goal,
    hardConstraints,
    architectureRef: { id: input.finalPlan.architecture.id, revision: input.finalPlan.architecture.revision },
    // §28 — conservative mapping: no formal decision criticality classifier
    // exists, so every exact FinalPlan decision ref is critical.
    implementationSteps: input.finalPlan.implementationOrder,
    requiredContracts: input.finalPlan.sections.map((section) => ({
      sectionId: section.sectionId,
      revision: section.revision,
    })),
    criticalDecisions: input.finalPlan.decisions.map((decision) => ({
      id: decision.id,
      revision: decision.revision,
    })),
    knownLimitations: input.finalPlan.limitations,
    // §30 — empty because no canonical validation-requirement source exists
    // in the approved planning schema; the handoff model never invents one.
    validationRequirements: [],
  };
  return { handoff, handoffHash: executionHandoffHash(handoff) };
}

/** §24/§25 — repository baseline frozen at handoff creation; never re-derived. */
export function deriveRepositoryBaseline(kind: string, workspaceRoot: string): RepositoryBaseline {
  if (kind !== "git_worktree") {
    return { kind: "directory", revision: null };
  }
  const head = observeGitHeadSync(workspaceRoot);
  if (head === null) {
    throw handoffError(
      "HANDOFF_NOT_AUTHORIZED",
      "the git repository baseline is unavailable; the execution handoff cannot be derived",
    );
  }
  return { kind: "git", revision: head };
}

// ---------------------------------------------------------------------------
// §43 — the derived handoffPending condition
// ---------------------------------------------------------------------------

/** The uniform §43 condition, evaluated against an open transaction. */
export function isHandoffPendingInTx(tx: StoreTx, run: PlanningRun | null): boolean {
  if (run === null || run.lifecycle !== "active" || run.stage !== "final") {
    return false;
  }
  const finalPlan = getFinalPlanInTx(tx, run.runId);
  if (finalPlan === null) {
    return false;
  }
  const handoff = getExecutionHandoffInTx(tx, run.runId);
  if (handoff === null) {
    return true; // no handoff row yet (§43)
  }
  const state = getExecutionHandoffStateInTx(tx, run.runId);
  return state?.status !== "delivered"; // prepared handoff is still pending
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface PrepareHandoffInput {
  runId: string;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  toolUseId: string;
}

export interface PrepareHandoffResult {
  handoff: ExecutionHandoffV1;
  handoffId: string;
  handoffHash: string;
  finalPlan: { id: string; revision: number; hash: string };
  reused: boolean;
  binding: { state: "attached" | "detached"; generation: number };
}

export interface FinalizeDeliveryInput {
  runId: string;
  sessionId: string;
  toolUseId: string;
  responseHandoffId: string;
  responseHandoffHash: string;
}

export interface FinalizeDeliveryResult {
  alreadyDelivered: boolean;
  runRevision: number;
}

export interface BuildReadAuthority {
  run: PlanningRun;
  finalPlanRow: { finalPlanId: string; finalPlanHash: string; canonicalJson: string; revision: number };
  handoff: ExecutionHandoffRow;
  state: ExecutionHandoffStateRow;
  binding: ExecutionBindingRow;
}

export function createHandoffService(store: PlanStore, clock: StoreClock) {
  function requireEligibleRunInTx(tx: StoreTx, input: { runId: string; workspaceId: string }): PlanningRun {
    const run = loadRunInTx(tx, input.runId);
    if (run.workspaceId !== input.workspaceId) {
      throw handoffError("HANDOFF_NOT_AUTHORIZED", `PlanningRun '${run.runId}' belongs to a different workspace`, {
        expected: run.workspaceId,
        detected: input.workspaceId,
      });
    }
    if (run.lifecycle === "completed") {
      throw handoffError("HANDOFF_ALREADY_DELIVERED", `PlanningRun '${run.runId}' is already completed`, {
        runId: run.runId,
      });
    }
    if (run.lifecycle !== "active" || run.stage !== "final") {
      // §34 — first invocation requires active + final; everything else,
      // including an aborted run, is simply not authorized.
      throw handoffError(
        "HANDOFF_NOT_AUTHORIZED",
        `handoff requires an active PlanningRun at stage 'final' (run is ${run.lifecycle}/${run.stage})`,
        { runId: run.runId, lifecycle: run.lifecycle, stage: run.stage },
      );
    }
    return run;
  }

  /** §90 — create-or-reuse the current-session ExecutionBinding. */
  function ensureExecutionBindingInTx(
    tx: StoreTx,
    input: { runId: string; workspaceId: string; finalPlanId: string; sessionId: string },
    now: string,
  ): ExecutionBindingRow {
    const existing = getExecutionBindingInTx(tx, input.runId);
    if (existing === null) {
      return insertAttachedExecutionBindingInTx(tx, input, now);
    }
    if (existing.sessionId !== input.sessionId) {
      // §82 — no takeover; only the exact session may hold the binding.
      throw handoffError(
        "EXECUTION_BINDING_REQUIRED",
        `the execution binding for FinalPlan '${input.finalPlanId}' belongs to another session`,
        { boundSession: existing.sessionId, state: existing.state },
      );
    }
    if (existing.state === "detached") {
      return reattachExecutionBindingInTx(tx, input, now);
    }
    return existing;
  }

  return {
    /**
     * §35/§42/§90 — the handoff MCP handler core: reload authority, derive or
     * reuse the canonical handoff, create/reuse the ExecutionBinding, append
     * DELIVERY_ATTEMPT — all in ONE transaction. Never completes the run (§36).
     */
    prepareHandoffDelivery(input: PrepareHandoffInput): PrepareHandoffResult {
      return store.withWrite((tx) => {
        const run = requireEligibleRunInTx(tx, input);
        const finalPlanRow = getFinalPlanInTx(tx, input.runId);
        if (finalPlanRow === null) {
          throw handoffError("HANDOFF_NOT_AUTHORIZED", `no approved FinalPlan exists for run '${input.runId}'`);
        }
        const now = clock.nowIso();
        const existing = getExecutionHandoffInTx(tx, input.runId);
        let reused = true;
        let handoffId: string;
        let handoffHash: string;
        let handoff: ExecutionHandoffV1;
        if (existing !== null) {
          handoffId = existing.handoffId;
          handoffHash = existing.handoffHash;
          const state = getExecutionHandoffStateInTx(tx, input.runId);
          if (state?.status === "delivered") {
            throw handoffError("HANDOFF_ALREADY_DELIVERED", `execution handoff '${handoffId}' is already delivered`, {
              handoffId,
            });
          }
          // §42 — a prepared handoff is NEVER re-derived for a new invocation;
          // integrity is verified against the stored hash.
          const parsed: unknown = JSON.parse(existing.canonicalJson);
          if (typeof parsed !== "object" || parsed === null || executionHandoffHash(parsed as ExecutionHandoffV1) !== handoffHash) {
            throw handoffError("HANDOFF_NOT_AUTHORIZED", `stored execution handoff '${handoffId}' does not match its canonical payload`);
          }
          handoff = parsed as ExecutionHandoffV1;
        } else {
          // First invocation — derive deterministically (§22/§35).
          reused = false;
          const plan = parseFinalPlanCanonical(finalPlanRow.canonicalJson, input.runId);
          const workspaceRow = tx
            .prepare("SELECT kind, canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
            .get(input.workspaceId) as { kind: string; canonicalRoot: string } | undefined;
          if (workspaceRow === undefined) {
            throw handoffError("HANDOFF_NOT_AUTHORIZED", `workspace '${input.workspaceId}' is not registered`);
          }
          const baseline = deriveRepositoryBaseline(workspaceRow.kind, workspaceRow.canonicalRoot);
          const derived = deriveExecutionHandoffInTx(tx, {
            runId: input.runId,
            run,
            finalPlan: plan,
            finalPlanId: finalPlanRow.finalPlanId,
            finalPlanRevision: finalPlanRow.revision,
            finalPlanHash: finalPlanRow.finalPlanHash,
            baseline,
          });
          handoff = derived.handoff;
          handoffHash = derived.handoffHash;
          handoffId = `xhandoff_${clock.newId()}`;
          insertExecutionHandoffInTx(tx, {
            runId: input.runId,
            handoffId,
            finalPlanId: finalPlanRow.finalPlanId,
            finalPlanHash: finalPlanRow.finalPlanHash,
            canonicalJson: canonicalJson(handoff),
            handoffHash,
          }, now);
          const preparedSeq = insertExecutionHandoffEventInTx(tx, {
            runId: input.runId,
            handoffId,
            eventType: "PREPARED",
            sessionId: input.sessionId,
          }, now);
          insertExecutionHandoffStateInTx(tx, {
            runId: input.runId,
            handoffId,
            status: "prepared",
            lastEventSeq: preparedSeq,
          }, now);
        }
        const binding = ensureExecutionBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          finalPlanId: finalPlanRow.finalPlanId,
          sessionId: input.sessionId,
        }, now);
        // §42 — the same invocation identity does not duplicate attempts; a
        // genuinely new invocation appends a fresh DELIVERY_ATTEMPT.
        const priorAttempt = findDeliveryAttemptInTx(tx, {
          runId: input.runId,
          sessionId: input.sessionId,
          toolUseId: input.toolUseId,
        });
        if (priorAttempt === null) {
          const attemptSeq = insertExecutionHandoffEventInTx(tx, {
            runId: input.runId,
            handoffId,
            eventType: "DELIVERY_ATTEMPT",
            sessionId: input.sessionId,
            toolUseId: input.toolUseId,
          }, now);
          updateExecutionHandoffStateInTx(tx, {
            runId: input.runId,
            handoffId,
            status: "prepared",
            lastEventSeq: attemptSeq,
            currentAttemptToolUseId: input.toolUseId,
          }, now);
        }
        return {
          handoff,
          handoffId,
          handoffHash,
          finalPlan: {
            id: finalPlanRow.finalPlanId,
            revision: finalPlanRow.revision,
            hash: finalPlanRow.finalPlanHash,
          },
          reused,
          binding: { state: binding.state, generation: binding.generation },
        };
      });
    },

    /**
     * §37/§93 — the PostToolUse delivery finalizer core. Verifies the exact
     * delivery attempt and the stored handoff identity, then completes the
     * transition in ONE transaction. Idempotent: replays of the delivered
     * state change nothing (§39/§116).
     */
    finalizeDelivery(input: FinalizeDeliveryInput): FinalizeDeliveryResult {
      return store.withWrite((tx) => {
        const handoffRow = getExecutionHandoffInTx(tx, input.runId);
        if (handoffRow === null) {
          throw handoffError("HANDOFF_DELIVERY_INVALID", `no execution handoff exists for run '${input.runId}'`);
        }
        const state = getExecutionHandoffStateInTx(tx, input.runId);
        const run = loadRunInTx(tx, input.runId);
        if (state?.status === "delivered") {
          // §39 — identical delivery replay: no extra event, no revision bump.
          if (input.responseHandoffId !== handoffRow.handoffId) {
            throw handoffError("HANDOFF_DELIVERY_INVALID", "delivery response names a different handoff");
          }
          return { alreadyDelivered: true, runRevision: run.revision };
        }
        // §93 — never trust the response alone: exact attempt + stored hashes.
        if (input.responseHandoffId !== handoffRow.handoffId || input.responseHandoffHash !== handoffRow.handoffHash) {
          throw handoffError("HANDOFF_DELIVERY_INVALID", "delivery response does not match the stored execution handoff");
        }
        const attempt = findDeliveryAttemptInTx(tx, {
          runId: input.runId,
          sessionId: input.sessionId,
          toolUseId: input.toolUseId,
        });
        if (attempt === null) {
          throw handoffError(
            "HANDOFF_DELIVERY_INVALID",
            `no delivery attempt '${input.toolUseId}' exists for run '${input.runId}' in session '${input.sessionId}'`,
          );
        }
        if (run.lifecycle !== "active") {
          throw handoffError("HANDOFF_DELIVERY_INVALID", `PlanningRun '${input.runId}' is ${run.lifecycle}; delivery cannot complete`);
        }
        const now = clock.nowIso();
        const deliveredSeq = insertExecutionHandoffEventInTx(tx, {
          runId: input.runId,
          handoffId: handoffRow.handoffId,
          eventType: "DELIVERED",
          sessionId: input.sessionId,
          toolUseId: input.toolUseId,
        }, now);
        updateExecutionHandoffStateInTx(tx, {
          runId: input.runId,
          handoffId: handoffRow.handoffId,
          status: "delivered",
          lastEventSeq: deliveredSeq,
          currentAttemptToolUseId: input.toolUseId,
          deliveredAt: now,
        }, now);
        // §49/§50 — active → completed, revision +1 exactly once, stage stays final.
        tx.prepare(
          "UPDATE planning_runs SET lifecycle = 'completed', revision = revision + 1, updated_at = ? "
          + "WHERE run_id = ? AND revision = ? AND lifecycle = 'active'",
        ).run(now, input.runId, run.revision);
        const completed = loadRunInTx(tx, input.runId);
        if (completed.lifecycle !== "completed" || completed.revision !== run.revision + 1) {
          throw handoffError("HANDOFF_DELIVERY_INVALID", `PlanningRun '${input.runId}' completion raced a concurrent mutation`);
        }
        // §52 — the planning SessionBinding detaches exactly once so every
        // old Planning HostContext token fences as STALE_SESSION_BINDING.
        try {
          detachBindingInTx(tx, { runId: input.runId, sessionId: input.sessionId }, now);
        } catch (err) {
          if (
            !(err instanceof RuntimeError)
            || (err.code !== "BINDING_DETACHED" && err.code !== "BINDING_NOT_FOUND" && err.code !== "STALE_SESSION_BINDING")
          ) {
            throw err;
          }
          // Recovery paths may have detached already; detached planning
          // authority at delivery time is the correct end state.
        }
        return { alreadyDelivered: false, runRevision: completed.revision };
      });
    },

    /**
     * §91 — the complete Build read-authority check, in-tx. Any failure is
     * EXECUTION_CONTEXT_NOT_AVAILABLE except a generation mismatch, which is
     * STALE_EXECUTION_BINDING (§56).
     */
    requireBuildReadAuthorityInTx(
      tx: StoreTx,
      input: { sessionId: string; workspaceId: string; runId: string; finalPlanId: string; generation: number },
    ): BuildReadAuthority {
      const run = loadRunInTx(tx, input.runId);
      if (run.workspaceId !== input.workspaceId || run.lifecycle !== "completed") {
        throw handoffError("EXECUTION_CONTEXT_NOT_AVAILABLE", `run '${input.runId}' is not a completed run of this workspace`);
      }
      const binding = getExecutionBindingInTx(tx, input.runId);
      if (
        binding === null
        || binding.state !== "attached"
        || binding.sessionId !== input.sessionId
        || binding.workspaceId !== input.workspaceId
      ) {
        throw handoffError("EXECUTION_CONTEXT_NOT_AVAILABLE", "no attached ExecutionBinding exists for this session");
      }
      if (binding.generation !== input.generation) {
        throw handoffError(
          "STALE_EXECUTION_BINDING",
          `stale execution binding generation ${input.generation}; current is ${binding.generation}`,
          { expected: input.generation, detected: binding.generation },
        );
      }
      const handoff = getExecutionHandoffInTx(tx, input.runId);
      const state = getExecutionHandoffStateInTx(tx, input.runId);
      if (handoff === null || state === null || state.status !== "delivered") {
        throw handoffError("EXECUTION_CONTEXT_NOT_AVAILABLE", "the execution handoff has not been delivered");
      }
      const finalPlanRow = getFinalPlanInTx(tx, input.runId);
      if (finalPlanRow === null || finalPlanRow.finalPlanId !== input.finalPlanId || binding.finalPlanId !== input.finalPlanId) {
        throw handoffError("EXECUTION_CONTEXT_NOT_AVAILABLE", "the approved FinalPlan does not match the execution binding");
      }
      return { run, finalPlanRow, handoff, state, binding };
    },

    /**
     * §63–§65 — the exact FinalPlan-closure membership test for Build
     * read_memory. Historical revisions fail closed even though they exist
     * in the same run's history (§64).
     */
    assertExecutionMemoryRefInTx(
      plan: FinalPlanV1,
      ref: { kind: string; id: string; revision: number },
    ): void {
      if (ref.kind === "section") {
        if (plan.sections.some((s) => s.sectionId === ref.id && s.revision === ref.revision)) return;
        throw handoffError(
          "EXECUTION_MEMORY_REF_NOT_AUTHORIZED",
          `${ref.kind} '${ref.id}@${ref.revision}' is not part of the approved FinalPlan`,
        );
      }
      if (ref.kind === "decision" || ref.kind === "constraint") {
        const refs = ref.kind === "decision" ? plan.decisions : plan.constraints;
        if (refs.some((r) => r.id === ref.id && r.revision === ref.revision)) return;
        throw handoffError(
          "EXECUTION_MEMORY_REF_NOT_AUTHORIZED",
          `${ref.kind} '${ref.id}@${ref.revision}' is not part of the approved FinalPlan`,
        );
      }
      if (ref.kind === "architecture") {
        if (plan.architecture !== null && plan.architecture.id === ref.id && plan.architecture.revision === ref.revision) return;
        throw handoffError(
          "EXECUTION_MEMORY_REF_NOT_AUTHORIZED",
          `architecture '${ref.id}@${ref.revision}' is not the FinalPlan architecture`,
        );
      }
      // §65 — questions/conflicts are not Build execution memory.
      throw handoffError(
        "CAPABILITY_NOT_AVAILABLE",
        `${ref.kind} artifacts are not readable under the execution authority`,
      );
    },

    /** §43 — session-free derived condition for hooks and projections. */
    isHandoffPending(runId: string): boolean {
      return store.withRead((tx) => {
        const run = loadRunInTx(tx, runId);
        return isHandoffPendingInTx(tx, run);
      });
    },
  };
}

export type HandoffService = ReturnType<typeof createHandoffService>;
