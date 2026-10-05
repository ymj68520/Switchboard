/**
 * ExecutionDirective persistence (v0.2.0 E4 §11/§43).
 *
 * A Directive revision is a HISTORICAL IMMUTABLE ARTIFACT (E4 §8/§11): the
 * table's PRIMARY KEY (directive_id, revision) makes each revision exactly one
 * row, the no-update/no-delete triggers make it permanent, and the composite
 * FinalPlan FK + Stage/Window FKs pin the authority bindings at the DDL level.
 * To revise, INSERT a new revision — there is deliberately NO update path and
 * no generic updateDirective(...) anywhere.
 *
 * The only production caller of the insert primitive is the application
 * execution-directive service (issuance inside the supervisor-authority fence).
 * Model code never writes directive rows directly (E4 §40).
 */

import { parseExecutionDirectiveRow, type ExecutionDirective } from "../core/execution-directive.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "./transaction.js";

const DIRECTIVE_COLUMNS =
  "directive_id AS directiveId, revision, directive_hash AS hash, execution_run_id AS executionRunId, run_id AS runId, "
  + "protocol_version AS protocolVersion, "
  + "verification_requirement AS verificationRequirement, verification_purpose AS verificationPurpose, "
  + "verification_conflict_id AS verificationConflictId, "
  + "final_plan_id AS id, final_plan_revision AS fpRevision, final_plan_hash AS fpHash, "
  + "scope_kind AS scopeKind, stage_id AS stageId, window_id AS windowId, kind, "
  + "base_candidate_revision AS baseCandidateRevision, "
  + "accepted_base_kind AS acceptedBaseKind, accepted_base_json AS acceptedBaseJson, "
  + "objective, plan_refs_json AS planRefsJson, expected_scope_json AS expectedScopeJson, "
  + "capability_envelope_json AS capabilityEnvelopeJson, "
  + "invariants_json AS invariantsJson, required_actions_json AS requiredActionsJson, "
  + "forbidden_actions_json AS forbiddenActionsJson, "
  + "validation_requirements_json AS validationRequirementsJson, "
  + "deliverables_json AS deliverablesJson, stop_conditions_json AS stopConditionsJson, "
  + "report_contract_json AS reportContractJson, body, issued_at AS issuedAt";

function directiveError(
  code:
    | "DIRECTIVE_NOT_CURRENT"
    | "DIRECTIVE_REVISION_CONFLICT",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

function parseJsonField(raw: Record<string, unknown>, field: string): unknown {
  try {
    return JSON.parse(String(raw[field]));
  } catch {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_directives row is corrupt", {
      detail: { fields: [field] },
    });
  }
}

/** Reassemble the canonical row shape parseExecutionDirectiveRow expects. */
export function mapDirectiveRow(raw: Record<string, unknown>): ExecutionDirective {
  const row: Record<string, unknown> = { ...raw };
  row.finalPlanRef = { id: raw.id, revision: raw.fpRevision, hash: raw.fpHash };
  const baseline = parseJsonField(raw, "acceptedBaseJson") as Record<string, unknown> | null;
  row.acceptedBase =
    raw.acceptedBaseKind === "execution_start"
      ? { kind: "execution_start", baseline }
      : { kind: "execution_commit", executionCommitId: baseline?.executionCommitId };
  row.planRefs = parseJsonField(raw, "planRefsJson");
  row.expectedExecutionScope = parseJsonField(raw, "expectedScopeJson");
  row.capabilityEnvelope = parseJsonField(raw, "capabilityEnvelopeJson");
  row.invariants = parseJsonField(raw, "invariantsJson");
  row.requiredActions = parseJsonField(raw, "requiredActionsJson");
  row.forbiddenActions = parseJsonField(raw, "forbiddenActionsJson");
  row.validationRequirements = parseJsonField(raw, "validationRequirementsJson");
  row.deliverables = parseJsonField(raw, "deliverablesJson");
  row.stopConditions = parseJsonField(raw, "stopConditionsJson");
  row.reportContract = parseJsonField(raw, "reportContractJson");
  return parseExecutionDirectiveRow(row);
}

export function getExecutionDirectiveInTx(tx: StoreTx, directiveId: string, revision: number): ExecutionDirective | null {
  const raw = tx
    .prepare(`SELECT ${DIRECTIVE_COLUMNS} FROM execution_directives WHERE directive_id = ? AND revision = ?`)
    .get(directiveId, revision) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapDirectiveRow(raw);
}

/** All revisions of one logical Directive, oldest first (history preserved). */
export function listDirectiveRevisionsInTx(tx: StoreTx, directiveId: string): ExecutionDirective[] {
  return (tx
    .prepare(`SELECT ${DIRECTIVE_COLUMNS} FROM execution_directives WHERE directive_id = ? ORDER BY revision`)
    .all(directiveId) as Record<string, unknown>[]).map(mapDirectiveRow);
}

/** Every Directive ever issued under one run, deterministic order (newest first). */
export function listRunDirectivesInTx(tx: StoreTx, executionRunId: string): ExecutionDirective[] {
  return (tx
    .prepare(
      `SELECT ${DIRECTIVE_COLUMNS} FROM execution_directives WHERE execution_run_id = ? `
      + "ORDER BY issued_at DESC, directive_id DESC, revision DESC",
    )
    .all(executionRunId) as Record<string, unknown>[]).map(mapDirectiveRow);
}

/**
 * E6 §27 — ALL immutable Directive revisions of one VerificationWindow, in
 * deterministic protocol order (oldest first). Complete Window provenance is
 * derived from this list, never from a Supervisor's enumeration.
 */
export function listWindowDirectivesInTx(tx: StoreTx, windowId: string): ExecutionDirective[] {
  return (tx
    .prepare(
      `SELECT ${DIRECTIVE_COLUMNS} FROM execution_directives WHERE window_id = ? `
      + "ORDER BY issued_at, directive_id, revision",
    )
    .all(windowId) as Record<string, unknown>[]).map(mapDirectiveRow);
}

/**
 * Persist one immutable Directive revision (E4 §11). Revision numbering is
 * Core-owned: revision 1 for a new logical Directive, exactly latest+1 for a
 * revision of an existing one (no gaps, no repeats — the chosen monotonic rule,
 * documented for E4-T4). The PRIMARY KEY rejects duplicates; the FKs reject
 * bindings to missing parents.
 */
export function insertExecutionDirectiveInTx(tx: StoreTx, directive: ExecutionDirective): void {
  const prior = listDirectiveRevisionsInTx(tx, directive.directiveId);
  const expectedRevision = prior.length === 0 ? 1 : (prior[prior.length - 1]?.revision ?? 0) + 1;
  if (directive.revision !== expectedRevision) {
    throw directiveError(
      "DIRECTIVE_REVISION_CONFLICT",
      `directive '${directive.directiveId}' expects revision ${expectedRevision}; got ${directive.revision}`,
      { directiveId: directive.directiveId, expected: expectedRevision, detected: directive.revision },
    );
  }
  if (prior.length > 0) {
    const first = prior[0]!;
    // E4 §9 — a revision keeps the same logical authority context: run,
    // FinalPlan, Stage, Window, and kind are invariant; baseCandidateRevision
    // may legitimately move. A different Window is a NEW Directive id.
    // A1 §27 — Directive lineage belongs to exactly ONE ExecutionRun: the
    // canonical scope AND the source-planning provenance are both invariant.
    const stable =
      first.executionRunId === directive.executionRunId
      && first.runId === directive.runId
      && first.finalPlanRef.id === directive.finalPlanRef.id
      && first.finalPlanRef.revision === directive.finalPlanRef.revision
      && first.finalPlanRef.hash === directive.finalPlanRef.hash
      && first.scopeKind === directive.scopeKind
      && first.stageId === directive.stageId
      && first.windowId === directive.windowId
      && first.kind === directive.kind;
    if (!stable) {
      throw directiveError(
        "DIRECTIVE_REVISION_CONFLICT",
        `directive '${directive.directiveId}' revisions must keep the same run/FinalPlan/scope/kind authority context (E10 §19 — a logical Directive can never switch stage ↔ final_closure)`,
        { directiveId: directive.directiveId },
      );
    }
  }
  const baselineJson =
    directive.acceptedBase.kind === "execution_start"
      ? JSON.stringify(directive.acceptedBase.baseline)
      : JSON.stringify({ executionCommitId: directive.acceptedBase.executionCommitId });
  tx.prepare(
    `INSERT INTO execution_directives (
       directive_id, revision, directive_hash, execution_run_id, run_id,
       protocol_version, verification_requirement, verification_purpose, verification_conflict_id,
       final_plan_id, final_plan_revision, final_plan_hash,
       scope_kind, stage_id, window_id, kind, base_candidate_revision,
       accepted_base_kind, accepted_base_json, objective,
       plan_refs_json, expected_scope_json, capability_envelope_json,
       invariants_json, required_actions_json, forbidden_actions_json,
       validation_requirements_json, deliverables_json, stop_conditions_json,
       report_contract_json, body, issued_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    directive.directiveId,
    directive.revision,
    directive.hash,
    directive.executionRunId,
    directive.runId,
    directive.protocolVersion,
    directive.verificationPolicy?.implementationRequirement ?? null,
    directive.verificationPolicy?.verificationPurpose ?? null,
    directive.verificationPolicy?.verificationConflictId ?? null,
    directive.finalPlanRef.id,
    directive.finalPlanRef.revision,
    directive.finalPlanRef.hash,
    directive.scopeKind,
    directive.stageId,
    directive.windowId,
    directive.kind,
    directive.baseCandidateRevision,
    directive.acceptedBase.kind,
    baselineJson,
    directive.objective,
    JSON.stringify(directive.planRefs),
    JSON.stringify(directive.expectedExecutionScope),
    JSON.stringify(directive.capabilityEnvelope),
    JSON.stringify(directive.invariants),
    JSON.stringify(directive.requiredActions),
    JSON.stringify(directive.forbiddenActions),
    JSON.stringify(directive.validationRequirements),
    JSON.stringify(directive.deliverables),
    JSON.stringify(directive.stopConditions),
    JSON.stringify(directive.reportContract),
    directive.body,
    directive.issuedAt,
  );
}

/** Append one protocol event inside the caller's transaction (sequence Core-owned). */
export function insertProtocolEventInTx(
  tx: StoreTx,
  input: {
    executionRunId: string;
    eventType: "DIRECTIVE_ISSUED" | "ATTEMPT_STARTED" | "ATTEMPT_REPORTED" | "ATTEMPT_INDETERMINATE";
    directiveId?: string;
    directiveRevision?: number;
    attemptId?: string;
  },
  now: string,
): void {
  const head = tx
    .prepare("SELECT MAX(event_seq) AS seq FROM execution_protocol_events WHERE execution_run_id = ?")
    .get(input.executionRunId) as { seq: number | null };
  tx.prepare(
    `INSERT INTO execution_protocol_events (execution_run_id, event_seq, event_type, directive_id, directive_revision, attempt_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.executionRunId,
    (head.seq ?? 0) + 1,
    input.eventType,
    input.directiveId ?? null,
    input.directiveRevision ?? null,
    input.attemptId ?? null,
    now,
  );
}

export interface ProtocolEventRow {
  eventType: string;
  directiveId: string | null;
  directiveRevision: number | null;
  attemptId: string | null;
  createdAt: string;
}

export function listProtocolEventsInTx(tx: StoreTx, executionRunId: string): ProtocolEventRow[] {
  return tx
    .prepare(
      "SELECT event_type AS eventType, directive_id AS directiveId, directive_revision AS directiveRevision, "
      + "attempt_id AS attemptId, created_at AS createdAt FROM execution_protocol_events "
      + "WHERE execution_run_id = ? ORDER BY event_seq",
    )
    .all(executionRunId) as ProtocolEventRow[];
}
