/**
 * ExecutionDirective — v0.2.0 Phase 4 (worker transaction protocol).
 *
 * A Directive is a BOUNDED EXECUTION AUTHORIZATION issued by the Supervisor
 * under an active ExecutionRun — never a mere prompt. Authority order is
 * frozen: FinalPlan > ExecutionDirective > Worker local implementation
 * choice. A Directive can never modify the FinalPlan, supersede an approved
 * Decision, or create new normative authority; its `planRefs` are the ONLY
 * channel through which a Worker later receives normative context (SPEC
 * v0.2.0 §22 — there is deliberately no readAllPlanMemory default).
 *
 * IMMUTABILITY (directive §16/§18): an issued Directive revision is never
 * modified — there is no update/edit/patch operation. Clarification or
 * rework creates the SAME logical id at a NEW revision (DIR-017@1 →
 * DIR-017@2) with a NEW canonical hash; the old revision stays durable
 * forever. Content idempotency: re-issuing byte-identical canonical content
 * under the same logical id returns the existing revision.
 *
 * CANONICAL HASH (directive §17): sha256 over the stable serialization of
 * every authority/semantics-bearing field — logical id, revision, run/
 * stage/window refs, FinalPlan ref, base accepted state, candidate
 * revision, kind, planRefs, scope, capabilities, candidateEffect,
 * requirements/prohibitions, report contract, and body. createdAt is pure
 * persistence metadata and is excluded (the repository's handoff/proposal
 * hash convention).
 *
 * BASE BINDINGS (directive §7/§8): `baseAcceptedState` is COPIED from the
 * bound VerificationWindow (execution_start until ExecutionCommit exists —
 * never a fabricated commit), and `baseCandidateRevision` equals the
 * window's candidateRevision at issuance; later candidate advances never
 * rewrite the Directive — it becomes a historical artifact whose
 * executability is decided by the Attempt-start gate.
 */
import { createHash } from "node:crypto";

import { UltraPlanError } from "./errors.js";
import type {
  ExecutionDirectiveID,
  ExecutionRunID,
  ExecutionStageID,
  FinalPlanID,
  StageCompletionObligationID,
  VerificationWindowID,
} from "./ids.js";
import type { Timestamp } from "./refs.js";
import { stableStringify } from "./invariants.js";
import type { AcceptedStateRef } from "./verification-window.js";
import type { ExecutionPlanRef } from "./execution-stage.js";
import type { FinalPlan } from "./types.js";
import { validateExecutionPlanRefs } from "./execution-stage.js";

// -- ExecutionCapabilityEnvelope (directive §13/§14) --------------------------

/**
 * The closed concept-capability vocabulary. Capability is NOT decided by
 * worker role — a verifier is not hardcoded read-only and an executor is not
 * hardcoded write-enabled; the issuing Directive's envelope decides what the
 * invocation is authorized for, within trusted ceilings.
 */
export const EXECUTION_CAPABILITIES = [
  "repositoryRead",
  "repositoryWrite",
  "commandExecution",
  "networkAccess",
  "dependencyMutation",
  "gitCommit",
  "gitPush",
  "externalServiceMutation",
] as const;
export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];

/** Full fixed-key envelope: every capability explicitly granted or denied. */
export type ExecutionCapabilityEnvelope = Readonly<Record<ExecutionCapability, boolean>>;

/**
 * The TRUSTED capability ceiling (host/user + execution policy). It enters
 * issuance/worker-context construction as harness-supplied state — never as
 * model business payload. The Supervisor may NARROW within it, never
 * elevate above it (SPEC v0.2.0 §23.2).
 */
export type ExecutionCapabilityCeiling = ExecutionCapabilityEnvelope;

export function capabilityEnvelope(granted: readonly ExecutionCapability[]): ExecutionCapabilityEnvelope {
  const envelope = {} as Record<ExecutionCapability, boolean>;
  for (const capability of EXECUTION_CAPABILITIES) {
    envelope[capability] = granted.includes(capability);
  }
  return envelope;
}

export function intersectCapabilities(
  a: ExecutionCapabilityEnvelope,
  b: ExecutionCapabilityEnvelope,
): ExecutionCapabilityEnvelope {
  const result = {} as Record<ExecutionCapability, boolean>;
  for (const capability of EXECUTION_CAPABILITIES) {
    result[capability] = a[capability] && b[capability];
  }
  return result;
}

export function envelopeAllows(envelope: ExecutionCapabilityEnvelope, capability: ExecutionCapability): boolean {
  return envelope[capability] === true;
}

/**
 * THE capability ceiling check: every capability the Directive grants must
 * also be granted by the trusted ceiling. Superset → `capability_not_available`.
 */
export function assertEnvelopeWithinCeiling(
  envelope: ExecutionCapabilityEnvelope,
  ceiling: ExecutionCapabilityCeiling,
): void {
  const exceeded = EXECUTION_CAPABILITIES.filter((capability) => envelope[capability] && !ceiling[capability]);
  if (exceeded.length > 0) {
    throw new UltraPlanError(
      "capability_not_available",
      `Directive capabilities exceed the trusted ceiling: ${exceeded.join(", ")}`,
      { exceeded },
    );
  }
}

export function assertCapabilityEnvelope(value: unknown): asserts value is ExecutionCapabilityEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new UltraPlanError("invalid_scope", "Capability envelope must be an object");
  }
  for (const capability of EXECUTION_CAPABILITIES) {
    if (typeof (value as Record<string, unknown>)[capability] !== "boolean") {
      throw new UltraPlanError("invalid_scope", `Capability envelope is missing boolean "${capability}"`);
    }
  }
}

// -- Directive kinds / candidate effect (directive §15/§20) -------------------

export const EXECUTION_DIRECTIVE_KINDS = ["implementation", "inspection", "verification"] as const;
export type ExecutionDirectiveKind = (typeof EXECUTION_DIRECTIVE_KINDS)[number];

/** The crash-semantics property: can this Attempt mutate candidate workspace state? */
export const DIRECTIVE_CANDIDATE_EFFECTS = ["non_mutating", "may_mutate"] as const;
export type DirectiveCandidateEffect = (typeof DIRECTIVE_CANDIDATE_EFFECTS)[number];

/**
 * Phase 6A §26 — what this verification Directive is FOR. LEGACY directives
 * (pre-6A, field absent) are interpreted as `acceptance` — the only purpose
 * that can satisfy the fresh-acceptance-verifier rule and Stage obligation
 * coverage. `conflict_resolution` directives adjudicate one disputed fact and
 * can do neither (§38).
 */
export const VERIFICATION_PURPOSES = ["acceptance", "conflict_resolution"] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

export function assertVerificationPurpose(value: string): asserts value is VerificationPurpose {
  if (!(VERIFICATION_PURPOSES as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not a verification purpose`, {
      value,
      known: VERIFICATION_PURPOSES,
    });
  }
}

/** Legacy-missing purpose = acceptance (§26 backward compatibility). */
export function verificationPurposeOf(
  directive: Pick<ExecutionDirective, "verificationPurpose">,
): VerificationPurpose {
  return directive.verificationPurpose ?? "acceptance";
}

/**
 * Phase 6A §45 — capability constraints of a reconciliation inspection:
 * read-only over the candidate. `repositoryRead` is REQUIRED; the five
 * mutation capabilities are FORBIDDEN; `commandExecution`/`networkAccess`
 * stay Supervisor/host policy choices within the trusted ceiling.
 */
export const RECONCILIATION_FORBIDDEN_CAPABILITIES = [
  "repositoryWrite",
  "dependencyMutation",
  "gitCommit",
  "gitPush",
  "externalServiceMutation",
] as const;

export function assertReconciliationCapabilityConstraints(
  envelope: ExecutionCapabilityEnvelope,
): void {
  if (envelope.repositoryRead !== true) {
    throw new UltraPlanError("invalid_scope", "A reconciliation inspection Directive requires repositoryRead", {});
  }
  const violations = RECONCILIATION_FORBIDDEN_CAPABILITIES.filter((capability) => envelope[capability]);
  if (violations.length > 0) {
    throw new UltraPlanError(
      "invalid_scope",
      `A reconciliation inspection Directive must be non-mutating; forbidden capabilities granted: ${violations.join(", ")}`,
      { violations },
    );
  }
}

// -- Structured envelope ------------------------------------------------------

/** Phase 5 — which Stage completion obligations this verification intends to close. Absent/[] = generic candidate-integrity verification; only EXPLICIT coverage can ever close a named obligation. */
export interface VerificationCoverage {
  obligationRefs: StageCompletionObligationID[];
}

/** Expected execution scope — REPOSITORY HINTS ONLY (directive §11). Never a path allowlist, write sandbox, or authority boundary; semantic-preserving correction is always allowed. */
export interface ExpectedExecutionScope {
  files?: string[];
  symbols?: string[];
  tests?: string[];
  callPaths?: string[];
  notes?: string[];
}

export interface ExecutionDirective {
  id: ExecutionDirectiveID;
  revision: number;
  /** Canonical content hash (see module header) — excludes createdAt only. */
  hash: string;

  executionRunID: ExecutionRunID;
  /** Exact approved FinalPlan binding — id + revision + content hash. */
  finalPlan: { id: FinalPlanID; revision: number };
  finalPlanHash: string;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;

  kind: ExecutionDirectiveKind;

  /** COPIED from the bound window at issuance — never self-computed. */
  baseAcceptedState: AcceptedStateRef;
  /** The window's candidateRevision at issuance. */
  baseCandidateRevision: number;

  objective: string;
  /** Exact obligation provenance — the Worker's ONLY normative context channel. */
  planRefs: ExecutionPlanRef[];

  expectedExecutionScope: ExpectedExecutionScope;
  capabilityEnvelope: ExecutionCapabilityEnvelope;
  /** May this Attempt mutate candidate state? Explicit — never derived from kind. */
  candidateEffect: DirectiveCandidateEffect;

  invariants: string[];
  requiredActions: string[];
  forbiddenActions: string[];
  validationRequirements: string[];
  deliverables: string[];
  stopConditions: string[];
  /** Phase 5 — mandatory for verification-kind directives' obligation-closing power; participates in the canonical hash (immutable with the revision). */
  verificationCoverage?: VerificationCoverage;
  /**
   * Phase 6A §26 — acceptance (default for legacy directives missing the
   * field) vs conflict_resolution. Semantic content: participates in the
   * canonical hash. A conflict_resolution directive additionally carries
   * `conflictID` and is bound to THE one resolver slot (§29).
   */
  verificationPurpose?: VerificationPurpose;
  /** Phase 6A §27 — the open VerificationConflict this resolver adjudicates (required iff purpose=conflict_resolution). */
  conflictID?: import("./ids.js").VerificationConflictID;
  /**
   * Phase 6A §43 — inspection-kind only: the indeterminate Attempts this
   * reconciliation inspection covers. When the canonical unresolved set is
   * non-empty this MUST be exactly that set; semantic content (hash-bound
   * per §44). Absent = ordinary (non-reconciliation) work.
   */
  reconciliationTargets?: import("./ids.js").ExecutionAttemptID[];
  /** The report contract the Worker must answer (natural language, structured by the unified Report schema). */
  reportContract: string;

  /** Detailed natural-language execution instructions — coexists with the structured envelope. */
  body: string;

  createdAt: Timestamp;
}

/** Hash payload: everything EXCEPT createdAt (and the hash itself). */
export type ExecutionDirectiveHashPayload = Omit<ExecutionDirective, "createdAt" | "hash">;

export function executionDirectiveHashPayload(directive: ExecutionDirective): ExecutionDirectiveHashPayload {
  const { createdAt: _createdAt, hash: _hash, ...payload } = directive;
  void _createdAt;
  void _hash;
  return payload;
}

export function computeExecutionDirectiveHash(payload: ExecutionDirectiveHashPayload): string {
  const digest = createHash("sha256");
  digest.update(stableStringify(payload));
  return digest.digest("hex");
}

/** Recompute from a stored record (issuance gate + durable load validation). */
export function computeExecutionDirectiveHashFromRecord(record: ExecutionDirective): string {
  return computeExecutionDirectiveHash(executionDirectiveHashPayload(record));
}

export function assertExecutionDirectiveKind(value: string): asserts value is ExecutionDirectiveKind {
  if (!(EXECUTION_DIRECTIVE_KINDS as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not an execution directive kind`, {
      value,
      known: EXECUTION_DIRECTIVE_KINDS,
    });
  }
}

/**
 * Directive cross-binding integrity (directive §6): refs resolve to the
 * exact FinalPlan, the stage belongs to the same run, the window belongs to
 * that stage. Plan-ref exactness is validated against the FinalPlan record.
 */
export function validateDirectiveBindings(input: {
  directive: Pick<ExecutionDirective, "executionRunID" | "finalPlan" | "finalPlanHash" | "stageID" | "windowID" | "planRefs" | "baseAcceptedState">;
  run: { id: ExecutionRunID; finalPlan: { id: FinalPlanID; revision: number }; finalPlanHash: string };
  stage: { id: ExecutionStageID; executionRunID: ExecutionRunID };
  window: { id: VerificationWindowID; executionRunID: ExecutionRunID; stageID: ExecutionStageID; baseAcceptedState: AcceptedStateRef };
  finalPlanRecord: FinalPlan;
}): void {
  const { directive, run, stage, window, finalPlanRecord } = input;
  if (directive.executionRunID !== run.id) {
    throw new UltraPlanError("directive_not_current", `Directive binds run ${directive.executionRunID}, not ${run.id}`, {});
  }
  if (directive.finalPlan.id !== run.finalPlan.id || directive.finalPlan.revision !== run.finalPlan.revision || directive.finalPlanHash !== run.finalPlanHash) {
    throw new UltraPlanError("directive_not_current", "Directive FinalPlan binding disagrees with the run's exact binding", {});
  }
  if (directive.stageID !== stage.id || stage.executionRunID !== run.id) {
    throw new UltraPlanError("directive_not_current", `Directive stage ${directive.stageID} is not the run's bound Stage`, {});
  }
  if (directive.windowID !== window.id || window.executionRunID !== run.id || window.stageID !== stage.id) {
    throw new UltraPlanError("directive_not_current", `Directive window ${directive.windowID} does not belong to the run's active Stage`, {});
  }
  if (stableStringify(directive.baseAcceptedState) !== stableStringify(window.baseAcceptedState)) {
    throw new UltraPlanError("directive_not_current", "Directive baseAcceptedState does not match the window's accepted-state anchor", {});
  }
  validateExecutionPlanRefs(directive.planRefs, finalPlanRecord);
}
