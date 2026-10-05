/**
 * Run-control authorization persistence (Phase 16 directive §4–§6; A1-I
 * typed targets per the frozen A1 amendment §49 and its Closure revisions).
 *
 * One immutable append-only row per explicitly human-authorized control
 * operation. `operation_id` (`takeover:<toolUseId>` / `abort:<toolUseId>` /
 * `reexecute_final_plan:<operationId>`) is the idempotency identity (§25):
 * the SAME authorized invocation retrying after a crash must find its row and
 * never double-apply (§53). `request_hash` pins the exact authorized request;
 * the same operation id with a different hash is IDEMPOTENCY_CONFLICT, never
 * a silent reinterpretation (§25).
 *
 * A1 §49 — every row carries an explicit typed target; no row is ambiguously
 * interpretable as both planning and execution authority:
 *
 *   planning_run         planning control of an existing PlanningRun
 *   execution_run        control of an existing ExecutionRun (exact ID)
 *   final_plan_execution reexecution of an exact FinalPlan in a workspace
 *                        (A1-II writer; schema support only in A1-I — the
 *                        row is persisted ATOMICALLY with its resulting run,
 *                        resulting_execution_run_id already set at commit;
 *                        the append-only table never takes an UPDATE)
 *
 * `legacy_pre_a1` exists ONLY as a migration classification (A1 §42): it can
 * never be inserted and never authorizes new mutation (A1 §43). The legacy
 * `run_id` column is nullable source-PlanningRun provenance; it is never the
 * target authority. The operation vocabulary carries `reexecute_final_plan`
 * from v26 so A1-II needs no further schema migration (A1-I adds NO
 * production writer — A1 §33).
 *
 * Session identities ride in previous/new binding identity JSON for internal
 * audit only — they are never returned to the model (§4/§13).
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../core/canonical-json.js";

export type RunControlOperation = "takeover" | "abort" | "reexecute_final_plan";

export const RUN_CONTROL_OPERATIONS: readonly RunControlOperation[] = [
  "takeover",
  "abort",
  "reexecute_final_plan",
];

export function isRunControlOperation(value: string): value is RunControlOperation {
  return (RUN_CONTROL_OPERATIONS as readonly string[]).includes(value);
}

/** A1 §49 — the insertable typed target kinds (legacy_pre_a1 is migration-only). */
export type RunControlTargetKind = "planning_run" | "execution_run" | "final_plan_execution";

/** A1 §7 — the exact legal target_kind × operation pairs for NEW rows. */
const LEGAL_TARGET_PAIRS: Record<RunControlTargetKind, readonly RunControlOperation[]> = {
  planning_run: ["takeover", "abort"],
  execution_run: ["takeover", "abort"],
  final_plan_execution: ["reexecute_final_plan"],
};

export interface BindingIdentity {
  sessionId: string;
  generation: number;
}

/** A1 §5 — the exact FinalPlan identity a reexecution authorization binds. */
export interface FinalPlanExecutionTarget {
  sourcePlanningRunId: string;
  finalPlanId: string;
  finalPlanRevision: number;
  finalPlanHash: string;
}

export interface RunControlAuthorizationRecord {
  controlId: string;
  targetKind: string;
  /** Legacy source-PlanningRun provenance (nullable; never target authority). */
  legacyRunId: string | null;
  operation: RunControlOperation;
  planningRunId: string | null;
  executionRunId: string | null;
  finalPlanExecution: (FinalPlanExecutionTarget & { resultingExecutionRunId: string | null }) | null;
  authorizationRequestId: string;
  operationId: string;
  requestHash: string;
  workspaceId: string;
  expectedBindingGeneration: number;
  resultingBindingGeneration: number | null;
  previousBindingIdentity: BindingIdentity | null;
  newBindingIdentity: BindingIdentity | null;
  resultingRunRevision: number | null;
  reason: string | null;
  createdAt: string;
}

interface RunControlRow {
  controlId: string;
  targetKind: string;
  legacyRunId: string | null;
  operation: string;
  planningRunId: string | null;
  executionRunId: string | null;
  sourcePlanningRunId: string | null;
  finalPlanId: string | null;
  finalPlanRevision: number | null;
  finalPlanHash: string | null;
  resultingExecutionRunId: string | null;
  authorizationRequestId: string;
  operationId: string;
  requestHash: string;
  workspaceId: string;
  expectedBindingGeneration: number;
  resultingBindingGeneration: number | null;
  previousBindingIdentity: string | null;
  newBindingIdentity: string | null;
  resultingRunRevision: number | null;
  reason: string | null;
  createdAt: string;
}

const CONTROL_COLUMNS =
  "control_id AS controlId, target_kind AS targetKind, run_id AS legacyRunId, operation, "
  + "planning_run_id AS planningRunId, execution_run_id AS executionRunId, "
  + "source_planning_run_id AS sourcePlanningRunId, final_plan_id AS finalPlanId, "
  + "final_plan_revision AS finalPlanRevision, final_plan_hash AS finalPlanHash, "
  + "resulting_execution_run_id AS resultingExecutionRunId, "
  + "authorization_request_id AS authorizationRequestId, operation_id AS operationId, request_hash AS requestHash, "
  + "workspace_id AS workspaceId, expected_binding_generation AS expectedBindingGeneration, "
  + "resulting_binding_generation AS resultingBindingGeneration, "
  + "previous_binding_identity AS previousBindingIdentity, new_binding_identity AS newBindingIdentity, "
  + "resulting_run_revision AS resultingRunRevision, reason, created_at AS createdAt";

function parseBindingIdentity(raw: string | null): BindingIdentity | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("run_control_authorizations binding identity is corrupt");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || typeof record.generation !== "number") {
    throw new Error("run_control_authorizations binding identity is corrupt");
  }
  return { sessionId: record.sessionId, generation: record.generation };
}

function parseControlRow(row: RunControlRow): RunControlAuthorizationRecord {
  return {
    controlId: row.controlId,
    targetKind: row.targetKind,
    legacyRunId: row.legacyRunId,
    operation: row.operation as RunControlOperation,
    planningRunId: row.planningRunId,
    executionRunId: row.executionRunId,
    finalPlanExecution:
      row.targetKind === "final_plan_execution"
        ? {
            sourcePlanningRunId: row.sourcePlanningRunId ?? "",
            finalPlanId: row.finalPlanId ?? "",
            finalPlanRevision: row.finalPlanRevision ?? 0,
            finalPlanHash: row.finalPlanHash ?? "",
            resultingExecutionRunId: row.resultingExecutionRunId,
          }
        : null,
    authorizationRequestId: row.authorizationRequestId,
    operationId: row.operationId,
    requestHash: row.requestHash,
    workspaceId: row.workspaceId,
    expectedBindingGeneration: row.expectedBindingGeneration,
    resultingBindingGeneration: row.resultingBindingGeneration,
    previousBindingIdentity: parseBindingIdentity(row.previousBindingIdentity),
    newBindingIdentity: parseBindingIdentity(row.newBindingIdentity),
    resultingRunRevision: row.resultingRunRevision,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

export interface InsertControlAuthorizationInput {
  controlId: string;
  operation: RunControlOperation;
  /** A1 §49 — the explicit typed target. */
  targetKind: RunControlTargetKind;
  /** planning_run target: the controlled PlanningRun. */
  planningRunId?: string;
  /** execution_run target: the exact controlled ExecutionRun. */
  executionRunId?: string;
  /** final_plan_execution target: the exact FinalPlan + workspace binding. */
  finalPlanExecution?: FinalPlanExecutionTarget;
  /**
   * final_plan_execution only: the resulting ExecutionRunID, persisted
   * ATOMICALLY with the new run (A1 §9 — never written back later).
   */
  resultingExecutionRunId?: string;
  /** Optional clearly-defined legacy source-planning provenance. */
  legacySourcePlanningRunId?: string;
  authorizationRequestId: string;
  operationId: string;
  requestHash: string;
  workspaceId: string;
  expectedBindingGeneration: number;
  resultingBindingGeneration?: number | null;
  previousBindingIdentity?: BindingIdentity;
  newBindingIdentity?: BindingIdentity;
  resultingRunRevision?: number;
  reason?: string;
}

/** Caller owns the enclosing write transaction; the row is immutable after. */
export function insertControlAuthorizationInTx(
  tx: { prepare(sql: string): { run(...params: unknown[]): unknown } },
  input: InsertControlAuthorizationInput,
  now: string,
): RunControlAuthorizationRecord {
  // A1 §7 — target_kind + operation form an explicit legal pair; identifier
  // presence alone never determines the target, and `legacy_pre_a1` is never
  // insertable (A1 §31).
  const legalOperations = LEGAL_TARGET_PAIRS[input.targetKind] ?? [];
  if (!legalOperations.includes(input.operation)) {
    throw new Error(`illegal run-control target pair: ${input.targetKind} × ${input.operation}`);
  }
  const legacyRunId =
    input.legacySourcePlanningRunId
      ?? (input.targetKind === "planning_run" ? input.planningRunId : undefined)
      ?? null;
  tx.prepare(
    "INSERT INTO run_control_authorizations ("
    + "control_id, run_id, operation, target_kind, planning_run_id, execution_run_id, "
    + "source_planning_run_id, final_plan_id, final_plan_revision, final_plan_hash, "
    + "resulting_execution_run_id, "
    + "authorization_request_id, operation_id, request_hash, workspace_id, "
    + "expected_binding_generation, resulting_binding_generation, previous_binding_identity, new_binding_identity, "
    + "resulting_run_revision, reason, created_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.controlId,
    legacyRunId,
    input.operation,
    input.targetKind,
    input.planningRunId ?? null,
    input.executionRunId ?? null,
    input.finalPlanExecution?.sourcePlanningRunId ?? null,
    input.finalPlanExecution?.finalPlanId ?? null,
    input.finalPlanExecution?.finalPlanRevision ?? null,
    input.finalPlanExecution?.finalPlanHash ?? null,
    input.resultingExecutionRunId ?? null,
    input.authorizationRequestId,
    input.operationId,
    input.requestHash,
    input.workspaceId,
    input.expectedBindingGeneration,
    input.resultingBindingGeneration ?? null,
    input.previousBindingIdentity === undefined ? null : canonicalJson(input.previousBindingIdentity),
    input.newBindingIdentity === undefined ? null : canonicalJson(input.newBindingIdentity),
    input.resultingRunRevision ?? null,
    input.reason ?? null,
    now,
  );
  return {
    controlId: input.controlId,
    targetKind: input.targetKind,
    legacyRunId,
    operation: input.operation,
    planningRunId: input.planningRunId ?? null,
    executionRunId: input.executionRunId ?? null,
    finalPlanExecution: input.finalPlanExecution
      ? { ...input.finalPlanExecution, resultingExecutionRunId: input.resultingExecutionRunId ?? null }
      : null,
    authorizationRequestId: input.authorizationRequestId,
    operationId: input.operationId,
    requestHash: input.requestHash,
    workspaceId: input.workspaceId,
    expectedBindingGeneration: input.expectedBindingGeneration,
    resultingBindingGeneration: input.resultingBindingGeneration ?? null,
    previousBindingIdentity: input.previousBindingIdentity ?? null,
    newBindingIdentity: input.newBindingIdentity ?? null,
    resultingRunRevision: input.resultingRunRevision ?? null,
    reason: input.reason ?? null,
    createdAt: now,
  };
}

/** Idempotency lookup — the ONLY sanctioned retry-arbitration path (§25/§53). */
export function findControlAuthorizationByOperationInTx(
  tx: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  operationId: string,
): RunControlAuthorizationRecord | null {
  const row = tx
    .prepare(`SELECT ${CONTROL_COLUMNS} FROM run_control_authorizations WHERE operation_id = ?`)
    .get(operationId) as RunControlRow | undefined;
  return row === undefined ? null : parseControlRow(row);
}

/**
 * The durable hash that pins the exact authorized request (§6; A1 §8 — the
 * typed target is part of the idempotency identity): canonical over the
 * operation, the explicit typed target, and the fencing inputs. Session
 * identity is NOT hashed — the signed HostContext already binds the caller.
 */
export function runControlRequestHash(input: {
  operation: RunControlOperation;
  targetKind: RunControlTargetKind;
  planningRunId?: string;
  executionRunId?: string;
  finalPlanExecution?: FinalPlanExecutionTarget;
  workspaceId: string;
  expectedBindingGeneration: number;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        operation: input.operation,
        target_kind: input.targetKind,
        planning_run_id: input.planningRunId ?? null,
        execution_run_id: input.executionRunId ?? null,
        final_plan_execution: input.finalPlanExecution ?? null,
        workspace_id: input.workspaceId,
        expected_binding_generation: input.expectedBindingGeneration,
      }),
      "utf8",
    )
    .digest("hex");
}
