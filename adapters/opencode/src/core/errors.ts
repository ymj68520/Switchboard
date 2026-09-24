/**
 * Typed error surface for Ultra Plan. All domain violations carry a machine
 * readable `code` so callers (tools, plugin hooks) can react deterministically
 * instead of parsing error text.
 */

export type UltraPlanErrorCode =
  | "unknown_planning_stage"
  | "unknown_planning_lifecycle"
  | "invalid_stage_transition"
  | "invalid_lifecycle_transition"
  | "multiple_active_runs"
  | "duplicate_plan_id"
  | "run_not_found"
  | "duplicate_revision"
  | "non_monotonic_revision"
  | "section_dependency_cycle"
  | "unknown_section"
  | "dependency_incomplete"
  | "commit_gated_run_field"
  | "phase_boundary";

export class UltraPlanError extends Error {
  readonly code: UltraPlanErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: UltraPlanErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "UltraPlanError";
    this.code = code;
    this.detail = detail;
  }
}

export function isUltraPlanError(value: unknown): value is UltraPlanError {
  return value instanceof UltraPlanError;
}
