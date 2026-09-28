/**
 * Run-control authorization persistence (Phase 16 directive §4–§6).
 *
 * One immutable row per explicitly human-authorized control operation.
 * `operation_id` (`takeover:<toolUseId>` / `abort:<toolUseId>`) is the
 * idempotency identity (§25): the SAME authorized invocation retrying after
 * a crash must find its row and never double-apply (§53). `request_hash`
 * pins the exact authorized request; the same operation id with a different
 * hash is IDEMPOTENCY_CONFLICT, never a silent reinterpretation (§25).
 *
 * Session identities ride in previous/new binding identity JSON for internal
 * audit only — they are never returned to the model (§4/§13).
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../core/canonical-json.js";

export type RunControlOperation = "takeover" | "abort";

export const RUN_CONTROL_OPERATIONS: readonly RunControlOperation[] = ["takeover", "abort"];

export function isRunControlOperation(value: string): value is RunControlOperation {
  return (RUN_CONTROL_OPERATIONS as readonly string[]).includes(value);
}

export interface BindingIdentity {
  sessionId: string;
  generation: number;
}

export interface RunControlAuthorizationRecord {
  controlId: string;
  runId: string;
  operation: RunControlOperation;
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
  runId: string;
  operation: string;
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
  "control_id AS controlId, run_id AS runId, operation, "
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
    runId: row.runId,
    operation: row.operation as RunControlOperation,
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
  runId: string;
  operation: RunControlOperation;
  authorizationRequestId: string;
  operationId: string;
  requestHash: string;
  workspaceId: string;
  expectedBindingGeneration: number;
  resultingBindingGeneration: number | null;
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
  tx.prepare(
    "INSERT INTO run_control_authorizations ("
    + "control_id, run_id, operation, authorization_request_id, operation_id, request_hash, workspace_id, "
    + "expected_binding_generation, resulting_binding_generation, previous_binding_identity, new_binding_identity, "
    + "resulting_run_revision, reason, created_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.controlId,
    input.runId,
    input.operation,
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
    runId: input.runId,
    operation: input.operation,
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
 * The durable hash that pins the exact authorized request (§6): canonical
 * over the operation identity + fencing inputs. Session identity is NOT
 * hashed — the signed HostContext already binds the caller.
 */
export function runControlRequestHash(input: {
  operation: RunControlOperation;
  runId: string;
  workspaceId: string;
  expectedBindingGeneration: number;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        operation: input.operation,
        run_id: input.runId,
        workspace_id: input.workspaceId,
        expected_binding_generation: input.expectedBindingGeneration,
      }),
      "utf8",
    )
    .digest("hex");
}
