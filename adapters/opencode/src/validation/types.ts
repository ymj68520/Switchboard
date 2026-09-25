/**
 * Phase 2G — read-only semantic validation (frozen architecture §31/§9 of the
 * agent protocol; Phase 2G brief §5-§26).
 *
 * AUTHORITY CLASS: everything here is a DERIVED artifact, same family as the
 * Phase 2F synthesis artifacts. A ValidationReport is durable, immutable,
 * content-hashed, and exact-ref-bound — but it is NOT committed Plan Memory:
 * persisting one creates no Proposal, no Approval, no PlanCommit, moves HEAD
 * nowhere, and changes no stage (brief §54/§60).
 *
 * VALIDATOR AUTHORITY (brief §5): the semantic validator is a DETECTOR ONLY.
 * It may classify `unsupported_new_fact | contradiction | missing_design |
 * missing_dependency | incorrect_derivation | coverage_gap | clean`. It may
 * NOT create proposals/approvals/commits, write any design artifact, resolve
 * questions/conflicts, reopen sections, set stages, or move HEAD — these
 * restrictions are STRUCTURAL: the validator output shape below cannot express
 * any of them, and the only path back to design is the user-approved
 * `reopen_section` PlanCommit (§37-§44).
 *
 * VALIDATION INTERPRETATION (brief §3): the frozen `PlanningStage` union has no
 * `validation` stage and none is introduced — semantic validation lives as
 * durable derived state (`stage = synthesis` + ValidationReport). A clean
 * report records ONLY that the semantic-validation component passed; it is NOT
 * finalization and does not grant Final authority (brief §4/§55).
 */
import type {
  PlanID,
  SectionID,
  SynthesisInputID,
  SynthesisManifestID,
  ValidationFindingID,
  ValidationReportID,
} from "../core/ids.js";
import type { SnapshotRef, Timestamp } from "../core/refs.js";
import type { SynthesisSourceRef } from "../synthesis/types.js";

/** The complete non-clean detector vocabulary (brief §20). `clean` is a report RESULT, never a finding category (§19). */
export const SEMANTIC_FINDING_CATEGORIES = [
  "unsupported_new_fact",
  "contradiction",
  "missing_design",
  "missing_dependency",
  "incorrect_derivation",
  "coverage_gap",
] as const;
export type SemanticFindingCategory = (typeof SEMANTIC_FINDING_CATEGORIES)[number];
export type ValidationResult = "clean" | "findings";

/**
 * Closed locator for a specific SynthesisManifest item (brief §21). Indices are
 * 1-BASED (matching the Harness-derived step `order` convention); arbitrary
 * executable paths and JSONPath are never accepted as authority.
 */
export type ManifestItemRef =
  | { kind: "cross_section_link"; index: number }
  | { kind: "implementation_step"; order: number }
  | { kind: "limitation"; index: number }
  | { kind: "synthesis_finding"; index: number };

/**
 * The affected scope of a finding (brief §20/§22): the exact Architecture
 * revision and/or >= 1 exact SectionRevisionRef. Refs resolve against the
 * CURRENT frozen SynthesisInput only.
 */
export interface SemanticFindingScope {
  architecture?: { id: "ARCH"; revision: number };
  sections?: { id: SectionID; revision: number }[];
}

/**
 * The strict WIRE shape a validator returns for one finding (brief §17/§20):
 * NO finding id (the Harness assigns it), closed field set, closed ref forms.
 */
export interface ValidatorFindingDraft {
  category: SemanticFindingCategory;
  statement: string;
  scope: SemanticFindingScope;
  manifestItem?: ManifestItemRef;
  sources?: SynthesisSourceRef[];
}

/**
 * The parsed, strictly-typed validator output (brief §17): exactly one JSON
 * document, `clean` with an empty findings array or `findings` with at least
 * one finding (§19 — never `[{category: "clean"}]`).
 */
export interface ValidationReportDraft {
  result: ValidationResult;
  findings: ValidatorFindingDraft[];
}

/** A persisted finding: the draft plus the Harness-assigned id (brief §20). */
export interface SemanticValidationFinding extends ValidatorFindingDraft {
  id: ValidationFindingID;
  sources: SynthesisSourceRef[];
}

/**
 * The validation identity (brief §11/§25): one EXACT pair (SynthesisInput,
 * SynthesisManifest revision) under ONE validator protocol. The same exact
 * identity can only ever produce ONE successful report — the anti-laundering
 * rule — so this triple is the report's content-level identity.
 */
export interface ValidationIdentity {
  inputHash: string;
  manifestHash: string;
  validatorProtocol: string;
}

/** Canonical key for admission indexes and identity comparison. */
export function validationIdentityKey(identity: ValidationIdentity): string {
  return `${identity.inputHash}|${identity.manifestHash}|${identity.validatorProtocol}`;
}

/**
 * The immutable semantic-validation report (brief §18). Adapted from the
 * conceptual shape to the real domain: `input`/`manifest` are exact refs with
 * their canonical hashes, `baseSnapshot` mirrors the input's anchor, and the
 * hash covers the full authority payload EXCLUDING id/createdAt/hash (brief
 * §24; the existing derived-hash convention).
 */
export interface ValidationReport {
  id: ValidationReportID;
  planID: PlanID;
  input: { id: SynthesisInputID };
  inputHash: string;
  manifest: { id: SynthesisManifestID; revision: number };
  manifestHash: string;
  baseSnapshot: SnapshotRef;
  /** Frozen protocol version, e.g. "semantic-validation:v1" (brief §16). */
  validatorProtocol: string;
  /** Model identity where the runtime records one; omitted = server default. */
  validatorModel?: string;
  result: ValidationResult;
  findings: SemanticValidationFinding[];
  createdAt: Timestamp;
  hash: string;
}

/**
 * Single-flight admission for a validation execution (brief §30/§31/§32): the
 * durable lock is NEVER held across model inference — instead a narrow,
 * expiring, owner-stamped admission is registered under the lock, the validator
 * runs unlocked, and the report persists under the lock with full identity
 * revalidation. A admission left behind by a dead process is RECLAIMABLE
 * (different owner pid, or expiry) — never a wedge, never a clean result.
 */
export interface SemanticValidationAdmission {
  identityKey: string;
  inputID: SynthesisInputID;
  manifestID: SynthesisManifestID;
  manifestRevision: number;
  ownerPid: number;
  admittedAt: Timestamp;
  expiresAt: Timestamp;
}

/** The frozen capsule the validator reasons over (brief §14): deterministic rendered text. */
export type ValidationCapsule = string;

/** Raw validator response BEFORE parsing — an opaque string the Harness parses strictly. */
export interface RawValidatorOutput {
  text: string;
  /** Model identity, when the runtime adapter knows it. */
  model?: string;
}

/**
 * The Core's validator boundary (brief §7): the core never depends on OpenCode
 * SDK response objects — the runtime adapter owns the actual model invocation
 * and adapts it to this narrow shape. NO model-facing tool ever implements
 * this: the planning model cannot declare itself valid (brief §6).
 */
export interface SemanticValidator {
  /** Human/model identity of the validator, when known (recorded in reports). */
  readonly model?: string;
  /** One-shot isolated validation inference over the frozen capsule. */
  validate(capsule: ValidationCapsule): Promise<RawValidatorOutput>;
}
