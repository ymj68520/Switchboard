/**
 * Shared fixtures for the v0.2.0 E12 conversation/session recovery matrix.
 *
 * A conversation/session operation (/clear, fork, rewind, compaction, takeover)
 * is NEVER an execution-state operation: these helpers fingerprint canonical
 * execution state so every suite can prove the operation left the Store
 * untouched, and drive ownership changes through the real run-control
 * authorization shape (the durable record of the mandatory host dialog).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { HookHandlerDeps } from "../src/hooks/handlers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { executionToken } from "./phase14-helpers.js";
import { createRunControlService } from "../src/application/run-control-service.js";
import type { RunControlResult } from "../src/application/run-control-service.js";
import { createExecutionAbortService } from "../src/application/execution-abort-service.js";
import { runControlRequestHash } from "../src/store/run-control.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getSupervisorBindingInTx, listSupervisorBindingEventsInTx } from "../src/store/supervisor-bindings.js";
import { getExecutionStructureInTx } from "../src/application/execution-structure-service.js";
import { listRunAttemptsInTx } from "../src/store/execution-attempts.js";
import { listRunDirectivesInTx } from "../src/store/execution-directives.js";
import { getAcceptedHeadCommitIdInTx } from "../src/store/execution-commits.js";
import type { AcceptanceWorld } from "./acceptance-helpers.js";

/** Hook-handler deps bound to an execution world's real store/clock/secret. */
export function depsOf(world: AcceptanceWorld): HookHandlerDeps {
  return { store: world.ctx.store, secret: world.ctx.secret, clock: world.ctx.clock };
}

export function sessionStartInput(
  world: AcceptanceWorld,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionId: world.f.sessionId,
    cwd: world.f.workspaceRoot,
    permissionMode: "default",
    hookEventName: "SessionStart",
    source: "startup",
    ...overrides,
  };
}

/** The delivered additionalContext of a JSON SessionStart/PreToolUse output. */
export function contextOf(output: unknown): string {
  const payload = (output as { payload?: Record<string, unknown> }).payload ?? {};
  const specific = payload.hookSpecificOutput as { additionalContext?: string } | undefined;
  return specific?.additionalContext ?? "";
}

/**
 * The canonical execution-state fingerprint (E12 §5/§29/§I29): everything a
 * conversation operation must never rewrite. Deep-enough JSON of lifecycle,
 * ownership, structure, protocol, accepted progress, attempts.
 */
export function executionFingerprintOf(world: AcceptanceWorld): string {
  const store = world.ctx.store;
  return JSON.stringify(
    store.withRead((tx) => {
      const run = getExecutionRunInTx(tx, world.executionRunId);
      const binding = getSupervisorBindingInTx(tx, world.executionRunId);
      const structure = getExecutionStructureInTx(tx, world.executionRunId);
      return {
        lifecycle: run?.lifecycle ?? null,
        runRevision: run?.revision ?? null,
        binding: binding === null ? null : { state: binding.state, generation: binding.generation, sessionId: binding.sessionId },
        stages: structure.stages.map((stage) => ({ id: stage.id, status: stage.status })),
        activeStage: structure.activeStage?.id ?? null,
        openWindow: structure.openWindow === null ? null : { id: structure.openWindow.id, candidateRevision: structure.openWindow.candidateRevision },
        directives: listRunDirectivesInTx(tx, world.executionRunId).map((d) => ({ id: d.directiveId, revision: d.revision, hash: d.hash })),
        attempts: listRunAttemptsInTx(tx, world.executionRunId).map((a) => ({ id: a.attemptId, state: a.state, revision: a.directiveRevision })),
        acceptedHead: getAcceptedHeadCommitIdInTx(tx, world.executionRunId),
      };
    }),
  );
}

/** Supervisor-binding event count (E12-T25 — compaction adds no events). */
export function supervisorEventCountOf(world: AcceptanceWorld): number {
  return world.ctx.store.withRead((tx) => listSupervisorBindingEventsInTx(tx, world.executionRunId).length);
}

/**
 * Explicit execution takeover through the REAL run-control service, in the
 * exact shape the MCP handler produces AFTER the mandatory host dialog: the
 * `mcp-control:<toolUseId>` authorization request id IS the trusted user
 * authorization record (E12 §26 — the dialog cannot be impersonated by the
 * model; the service trusts only its durable record).
 */
export function explicitExecutionTakeover(
  world: AcceptanceWorld,
  input: { newSessionId: string; expectedGeneration: number; executionRunId?: string; workspaceId?: string; toolUseId?: string },
) {
  const service = createRunControlService(world.ctx.store, world.ctx.clock);
  return service.takeoverRun({
    // A1 §49 — the canonical ExecutionRunID selects the execution-supervision
    // branch; runId stays the source-PlanningRun provenance identity.
    runId: world.f.runId,
    executionRunId: input.executionRunId ?? world.executionRunId,
    workspaceId: input.workspaceId ?? world.f.workspaceId,
    callerSessionId: input.newSessionId,
    expectedBindingGeneration: input.expectedGeneration,
    authorization: {
      authorizationRequestId: `mcp-control:${input.toolUseId ?? `TU-TAKEOVER-${input.newSessionId}`}`,
      operationId: `takeover:${input.toolUseId ?? `TU-TAKEOVER-${input.newSessionId}`}`,
      requestHash: `hash:${input.executionRunId ?? world.executionRunId}:${input.expectedGeneration}`,
    },
    // The supervision branch always returns a full result; the migrated
    // legacy_pre_a1 replay shape is unreachable from the execution branch.
  }) as RunControlResult;
}

/**
 * Explicit human-authorized ExecutionRun abort through the REAL E13 abort
 * service, in the exact shape the MCP handler produces AFTER the mandatory
 * host dialog (E13 §4). The request hash is the REAL runControlRequestHash so
 * a replay retry converges idempotently exactly as production would.
 */
export function explicitExecutionAbort(
  world: AcceptanceWorld,
  input: { executionRunId?: string; requesterSessionId?: string; reason?: string; toolUseId?: string; workspaceId?: string },
) {
  const executionRunId = input.executionRunId ?? world.executionRunId;
  const workspaceId = input.workspaceId ?? world.f.workspaceId;
  const toolUseId = input.toolUseId ?? `TU-ABORT-${executionRunId}`;
  const service = createExecutionAbortService(world.ctx.store, world.ctx.clock);
  return service.abortExecutionRun({
    executionRunId,
    workspaceId,
    requesterSessionId: input.requesterSessionId ?? world.f.sessionId,
    reason: input.reason ?? "user requested stop",
    authorization: {
      authorizationRequestId: `mcp-control:${toolUseId}`,
      operationId: `abort-execution:${toolUseId}`,
      requestHash: runControlRequestHash({
        operation: "abort",
        targetKind: "execution_run",
        executionRunId,
        workspaceId,
        expectedBindingGeneration: 1,
      }),
    },
  });
}

/**
 * Clone the world's run into a SECOND ACTIVE execution run of the SAME
 * workspace (E12 §29 ambiguity fixture). The clone reuses the frozen rows'
 * shapes — a completed PlanningRun, its FinalPlan, and an active ExecutionRun —
 * and deliberately carries NO SupervisorBinding (the migrated-v14 unbound
 * shape, E2 §16). This is the only way to reach the ambiguous/unbound states,
 * whose production causes (legacy migration, crashed activation) predate the
 * E12 code under test.
 */
export function cloneActiveRunInTx(
  world: AcceptanceWorld,
  newRunId: string,
  options: { lifecycle?: "active" | "replan_required"; samePlanningRun?: boolean } = {},
): string {
  // A1 §28 — a workspace holds at most ONE non-terminal execution world
  // (idx_execution_runs_workspace_singleton). A second candidate world is
  // therefore cloned TERMINAL (replan_required) and, when it must count as a
  // second execution world OF THE SAME planning run (the legacy
  // run_id-resolution ambiguity surface), it shares the source planning id.
  const lifecycle = options.lifecycle ?? "active";
  const samePlanningRun = options.samePlanningRun ?? false;
  const planningKey = samePlanningRun ? world.f.runId : newRunId;
  return world.ctx.store.withWrite((tx) => {
    // The MINIMAL FK-legal closure for a second active ExecutionRun of the
    // same workspace. Every row is copied from the source run re-keyed to the
    // new run id, except the two globally-unique snapshot/commit references,
    // which are nulled in the copied proposal_revisions row (nullable by DDL;
    // final_plan_candidates carries them as plain text with no FK). The clone
    // deliberately carries NO SupervisorBinding — the migrated-v14 unbound
    // shape (E2 §16) whose production cause predates the E12 code under test.
    const copyRow = (table: string, keyCols: Array<[string, string]>, overrides: Record<string, unknown>) => {
      const columns = (tx.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      const where = keyCols.map(([column]) => `${column} = ?`).join(" AND ");
      const row = tx.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...keyCols.map(([, value]) => value)) as
        | Record<string, unknown>
        | undefined;
      if (row === undefined) throw new Error(`clone source row missing: ${table} ${where}`);
      const merged = { ...row, ...overrides };
      tx.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => merged[column]));
    };
    // A1 — planning-side rows are keyed by the source PlanningRunID; the
    // source ExecutionRun is keyed by its canonical ExecutionRunID.
    if (!samePlanningRun) {
      copyRow("planning_runs", [["run_id", world.f.runId]], { run_id: newRunId });
      copyRow("session_bindings", [["run_id", world.f.runId]], { run_id: newRunId });
      // prepare_request_id backs a partial UNIQUE index (nullable) — the clone
      // carries no prepare request of its own.
      copyRow("proposals", [["run_id", world.f.runId]], { run_id: newRunId, prepare_request_id: null });
      copyRow("proposal_revisions", [["run_id", world.f.runId]], {
        run_id: newRunId,
        base_head_snapshot_id: null,
        base_head_commit_id: null,
      });
      copyRow("final_plan_candidates", [["run_id", world.f.runId]], { run_id: newRunId });
      copyRow("final_plans", [["run_id", world.f.runId]], { run_id: newRunId });
    }
    copyRow("execution_runs", [["execution_run_id", world.executionRunId]], {
      run_id: planningKey,
      execution_run_id: `${newRunId}-EXEC`,
      lifecycle,
      completion_commit_id: null,
    });
    return planningKey;
  });
}

/** A fresh plain directory — a second, unrelated WorkspaceIdentity. */
export function makeForeignWorkspace(prefix = "phase-plan-e12-foreign-"): { root: string; close(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  return { root, close: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}

/** A run's lifecycle through the real store. */
export function lifecycleOf(world: AcceptanceWorld, runId = world.executionRunId): string | null {
  return world.ctx.store.withRead((tx) => getExecutionRunInTx(tx, runId)?.lifecycle ?? null);
}

/**
 * Minimal mutating-supervisor business args for issue_execution_directive:
 * every required field is present (presence-only validation) so the handler
 * reaches the EXECUTION supervisor authority check as the FIRST real gate —
 * the shared stale-owner probe for the E12 authority-fence matrix.
 */
export function directiveProbeBusiness(world: AcceptanceWorld): Record<string, unknown> {
  const open = world.ctx.store.withRead(
    (tx) =>
      tx.prepare("SELECT candidate_revision AS r FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(world.executionRunId) as
        | { r: number }
        | undefined,
  );
  const envelope = {
    repositoryRead: true,
    repositoryWrite: false,
    commandExecution: false,
    networkAccess: false,
    dependencyMutation: false,
    gitCommit: false,
    gitPush: false,
    externalServiceMutation: false,
  };
  const contract = {
    requireActionsPerformed: false,
    requireFilesExamined: false,
    requireFilesChanged: false,
    requireCommandsRun: false,
    requireTestsRun: false,
    requireFindings: false,
    requireDeviations: false,
    requireBlockers: false,
    requireDeliverables: false,
  };
  return {
    kind: "inspection",
    stage_id: world.activeStageId,
    window_id: world.openWindowId,
    objective: "probe",
    body: "probe",
    directive_id: "DIR-PROBE",
    revision: 1,
    final_plan_ref: { id: world.f.finalPlanId, revision: 1, hash: world.f.finalPlanHash },
    base_candidate_revision: open?.r ?? 0,
    plan_refs: [],
    expected_execution_scope: { stageId: world.activeStageId },
    capability_envelope: envelope,
    invariants: [],
    required_actions: [],
    forbidden_actions: [],
    validation_requirements: [],
    deliverables: [],
    stop_conditions: [],
    report_contract: contract,
    verification_policy: { mode: "immediate" },
  };
}

/** The current supervisor binding row of the world's run. */
export function bindingOf(world: AcceptanceWorld) {
  return world.ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, world.executionRunId));
}

/**
 * Supervisor MCP call with an EXPLICIT session + generation — the stale-owner
 * matrix signs the OLD generation, the new owner signs the CURRENT one.
 */
export function supervisorCallAs(
  world: AcceptanceWorld,
  input: { sessionId: string; generation: number; tool: string; business?: Record<string, unknown> },
): Record<string, unknown> {
  const business = input.business ?? {};
  const token = executionToken(world.ctx, {
    sessionId: input.sessionId,
    workspaceId: world.f.workspaceId,
    runId: world.executionRunId,
    finalPlanId: world.f.finalPlanId,
    generation: input.generation,
    tool: input.tool,
    business,
  });
  return executePhasePlanTool(world.ctx, input.tool, { ...business, _hostContext: token }) as Record<string, unknown>;
}
