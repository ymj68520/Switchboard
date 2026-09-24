/**
 * Capability exposure — the authoritative state → allowed-operations matrix
 * (frozen architecture §14 L5, §35 invariants; formalized in Phase 2A).
 *
 * This module is the SINGLE source of truth for what the planning model may do
 * in a given run state. Tools validate through it (controller.assertToolAuth);
 * they must not carry their own stage rules. The matrix is mirrored in
 * docs/opencode/spec/opencode-ultra-plan-agent-protocol.md and pinned by
 * test/capabilities.test.ts — changing code without updating the protocol
 * document (or vice versa) fails the suite.
 */
import { UltraPlanError } from "./errors.js";
import type { PlanningRun, PlanningStage } from "./types.js";
import { isActiveRun } from "./state-machine.js";

/**
 * Semantic capabilities. Every model-visible tool maps to exactly one; reads
 * are capabilities too so exposure stays explicit.
 */
/**
 * Semantic capabilities. Every model-visible tool maps to exactly one; reads
 * are capabilities too so exposure stays explicit. Since Phase 2A.1
 * (Correction A), question "resolution" is only ever a CANDIDATE the model
 * proposes — the authoritative open → resolved transition belongs to an
 * approved PlanCommit.
 */
export const ULTRA_PLAN_CAPABILITIES = [
  "start_or_resume",
  "read_status",
  "read_memory",
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "promote_evidence",
  "prepare_proposal",
  "request_user_approval",
  "request_reopen",
  "request_completion",
  "request_synthesis",
] as const;

export type UltraPlanCapability = (typeof ULTRA_PLAN_CAPABILITIES)[number];

/**
 * Stage-scoped capabilities for an ACTIVE run. Derivation from the frozen
 * workflow:
 *
 * - discovery: inspect, ask questions, ground evidence. No design exists to
 *   conflict about, so no conflicts/proposals yet.
 * - architecture: + conflicts and architecture proposals/checkpoints.
 * - detail: + section proposals, completion requests, reopen requests.
 * - synthesis: read-only over approved memory + raise blockers + reopen +
 *   request the finalization gate. No new evidence/design mutation.
 * - final: read-only; final approval is USER authority, handoff is Harness
 *   authority.
 */
const STAGE_CAPABILITIES: Readonly<Record<PlanningStage, readonly UltraPlanCapability[]>> = {
  discovery: ["record_question", "propose_question_resolution", "promote_evidence"],
  architecture: [
    "record_question",
    "propose_question_resolution",
    "raise_conflict",
    "promote_evidence",
    "prepare_proposal",
    "request_user_approval",
  ],
  detail: [
    "record_question",
    "propose_question_resolution",
    "raise_conflict",
    "promote_evidence",
    "prepare_proposal",
    "request_user_approval",
    "request_completion",
    "request_reopen",
  ],
  synthesis: [
    "record_question",
    "propose_question_resolution",
    "raise_conflict",
    "request_reopen",
    "request_synthesis",
  ],
  final: [],
};

/**
 * Lifecycle always-granted capabilities. start_or_resume is how a session with
 * a completed/aborted run begins a NEW run; reads stay available for post-run
 * inspection (spec §34 gives execution read-only Plan Memory access).
 */
const LIFECYCLE_BASE: readonly UltraPlanCapability[] = [
  "start_or_resume",
  "read_status",
  "read_memory",
];

/**
 * handoff_pending is recoverable-handoff territory: planning mutation is
 * closed; recovery/handoff operations are Harness-authoritative (not
 * model-visible tools).
 */
const HANDOFF_CAPABILITIES: readonly UltraPlanCapability[] = ["read_status", "read_memory"];

/**
 * The authoritative capability decision function.
 *
 * - No run: start a new one; report the absence (renderNoRunStatus). Anything
 *   that reads or mutates actual memory needs a run.
 * - active: base reads + the stage matrix.
 * - handoff_pending / completed / aborted: reads only, no planning mutation.
 */
export function getCapabilities(run: PlanningRun | undefined): ReadonlySet<UltraPlanCapability> {
  if (!run) return new Set<UltraPlanCapability>(["start_or_resume", "read_status"]);
  if (run.lifecycle === "handoff_pending") return new Set<UltraPlanCapability>(HANDOFF_CAPABILITIES);
  if (!isActiveRun(run)) return new Set<UltraPlanCapability>(LIFECYCLE_BASE);

  return new Set<UltraPlanCapability>([
    ...LIFECYCLE_BASE,
    ...STAGE_CAPABILITIES[run.stage],
  ]);
}

/**
 * Capability check + run narrowing for operations that need a run. Throws
 * `no_active_run` when run is undefined, then delegates to assertCapability.
 */
export function requireRun(
  run: PlanningRun | undefined,
  capability: UltraPlanCapability,
): PlanningRun {
  if (!run) {
    throw new UltraPlanError(
      "no_active_run",
      `Capability "${capability}" requires an active PlanningRun; invoke /ultra-plan first`,
      { capability },
    );
  }
  assertCapability(run, capability);
  return run;
}

/**
 * Deterministic enforcement point for tool invocations. `no_active_run` when
 * the capability needs a run and none exists; `capability_not_available` when
 * the run exists but the current stage/lifecycle does not grant the
 * capability.
 */
export function assertCapability(
  run: PlanningRun | undefined,
  capability: UltraPlanCapability,
): void {
  if (getCapabilities(run).has(capability)) return;
  if (!run) {
    throw new UltraPlanError(
      "no_active_run",
      `Capability "${capability}" requires an active PlanningRun; invoke /ultra-plan first`,
      { capability },
    );
  }
  throw new UltraPlanError(
    "capability_not_available",
    `Capability "${capability}" is not available in lifecycle=${run.lifecycle}, stage=${run.stage}`,
    { capability, stage: run.stage, lifecycle: run.lifecycle },
  );
}
