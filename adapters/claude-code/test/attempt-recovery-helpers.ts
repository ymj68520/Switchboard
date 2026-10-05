/**
 * Shared fixtures for the v0.2.0 E11 crash-recovery focused tests.
 *
 * Crash boundaries (E11 §1): A = prepared-unclaimed (running Attempt, no
 * claim), C = claimed + authoritative stop (indeterminate), D = claimed +
 * unknown liveness (running). Reconciliation runs through the real MCP
 * surfaces exactly like production.
 */
import {
  makeAcceptanceWorld,
  runWorkerAttempt,
  supervisorCall,
  currentRevision,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { freshWorkerSession, callWorkerTool } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx, resolveUnreportedWorkerExitInTx } from "../src/application/worker-runtime-service.js";
import { issueDirective, fullEnvelope } from "./execution-protocol-helpers.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";

export type RecoveryWorld = AcceptanceWorld;

/** A read-only capability envelope (the reconciliation inspection shape). */
export function readOnlyEnvelope(): Record<string, boolean> {
  return {
    repositoryRead: true,
    repositoryWrite: false,
    commandExecution: false,
    networkAccess: false,
    dependencyMutation: false,
    gitCommit: false,
    gitPush: false,
    externalServiceMutation: false,
  };
}

/** A side-effect-capable envelope (enforceable: no open shell). */
export function effectfulEnvelope(): Record<string, boolean> {
  return {
    repositoryRead: true,
    repositoryWrite: true,
    commandExecution: false,
    networkAccess: false,
    dependencyMutation: false,
    gitCommit: false,
    gitPush: false,
    externalServiceMutation: false,
  };
}

/** A realistic reconciliation contract: factual findings + files examined. */
export const FULL_REPORT_CONTRACT = {
  requireActionsPerformed: false,
  requireFilesExamined: true,
  requireFilesChanged: false,
  requireCommandsRun: false,
  requireTestsRun: false,
  requireFindings: true,
  requireDeviations: false,
  requireBlockers: false,
  requireDeliverables: false,
};

/**
 * Boundary A — the Attempt is running with a PREPARED, UNCLAIMED invocation
 * (the Supervisor crashed between launch preparation and the Worker claim).
 */
export async function makeUnclaimedWorld(
  sessionId = `UA-${Math.random().toString(36).slice(2, 8)}`,
): Promise<{ world: RecoveryWorld; attemptId: string; staleLaunchToken: string }> {
  const world = await makeAcceptanceWorld(sessionId);
  const directive = issueDirective(world, { directiveId: "DIR-UA", kind: "implementation" });
  const { attempt, launch } = world.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: world.executionRunId,
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
        directiveId: directive.directiveId,
        directiveRevision: directive.revision,
        directiveHash: directive.hash,
        workerRole: "executor",
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  return { world, attemptId: attempt.attemptId, staleLaunchToken: launch.launchToken };
}

/**
 * Boundary C — a CLAIMED worker hit an AUTHORITATIVE stop with no durable
 * Report: the E5 convergence already left Attempt=indeterminate +
 * invocation=finished (E11 §42).
 */
export async function makeIndeterminateWorld(options: {
  sessionId?: string;
  directiveId?: string;
  kind?: "implementation" | "inspection" | "verification";
  envelope?: Record<string, boolean>;
  verificationPolicy?: Record<string, unknown>;
} = {}): Promise<{ world: RecoveryWorld; attemptId: string; directiveId: string }> {
  const world = await makeAcceptanceWorld(options.sessionId ?? `IND-${Math.random().toString(36).slice(2, 8)}`);
  const directive = issueDirective(world, {
    directiveId: options.directiveId ?? "DIR-CRASH",
    kind: options.kind ?? "implementation",
    ...(options.envelope === undefined ? {} : { capabilityEnvelope: options.envelope as never }),
    ...(options.verificationPolicy === undefined ? {} : { verificationPolicy: options.verificationPolicy as never }),
  });
  const { attempt, launch } = world.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: world.executionRunId,
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
        directiveId: directive.directiveId,
        directiveRevision: directive.revision,
        directiveHash: directive.hash,
        workerRole: options.kind === "verification" ? "verifier" : "executor",
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  const session = freshWorkerSession(world, `CRASH-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);
  callWorkerTool(world, session, "worker_claim", {
    attempt_id: attempt.attemptId,
    launch_token: launch.launchToken,
  });
  // The authoritative worker stop (E5 §36): claimed + no report → indeterminate.
  world.ctx.store.withWrite((tx) => {
    resolveUnreportedWorkerExitInTx(tx, { attemptId: attempt.attemptId }, world.ctx.clock.nowIso());
  });
  return { world, attemptId: attempt.attemptId, directiveId: directive.directiveId };
}

/** Boundary D — claimed, no report, NO authoritative stop: stays running. */
export async function makeUnknownLivenessWorld(
  sessionId = `UL-${Math.random().toString(36).slice(2, 8)}`,
): Promise<{ world: RecoveryWorld; attemptId: string }> {
  const world = await makeAcceptanceWorld(sessionId);
  const directive = issueDirective(world, { directiveId: "DIR-LIVE", kind: "implementation" });
  const { attempt, launch } = world.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: world.executionRunId,
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
        directiveId: directive.directiveId,
        directiveRevision: directive.revision,
        directiveHash: directive.hash,
        workerRole: "executor",
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  const session = freshWorkerSession(world, "LIVE");
  callWorkerTool(world, session, "worker_claim", {
    attempt_id: attempt.attemptId,
    launch_token: launch.launchToken,
  });
  return { world, attemptId: attempt.attemptId };
}

/** Issue + run one full reconciliation inspection through the REAL surfaces. */
export function runReconciliationInspection(
  world: RecoveryWorld,
  options: {
    attemptId: string;
    directiveId?: string;
    envelope?: Record<string, boolean>;
    reportOverrides?: Record<string, unknown>;
    candidateMutated?: boolean;
  },
): { directiveId: string; revision: number; reportId: string; attemptId: string } {
  // E11 §9 — later inspection passes are REVISIONS of the one bound logical
  // reconciliation Directive, never a second binding.
  const existingBinding = world.ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT directive_id AS id FROM execution_attempt_reconciliation_bindings WHERE attempt_id = ?").get(options.attemptId) as { id: string } | undefined)?.id,
  );
  const response = existingBinding === undefined
    ? (supervisorCall(world, "issue_attempt_reconciliation", {
        attempt_id: options.attemptId,
        objective: "Establish current repository reality for the interrupted work.",
        body: "Inspect the workspace for partial or complete effects of the interrupted Directive; report factually.",
        capability_envelope: options.envelope ?? readOnlyEnvelope(),
        report_contract: FULL_REPORT_CONTRACT,
      }) as { directive: { id: string; revision: number; hash: string } })
    : (() => {
        const scope = world.ctx.store.withRead(
          (tx) =>
            (tx.prepare("SELECT scope_kind AS kind FROM verification_windows WHERE id = ?").get(world.openWindowId) as { kind: string })
              .kind,
        );
        const directive = issueDirective(world, {
          directiveId: existingBinding,
          kind: "inspection",
          ...(scope === "final_closure"
            ? { scopeKind: "final_closure" as never, stageId: undefined, windowId: world.openWindowId }
            : {}),
        });
        return { directive: { id: directive.directiveId, revision: directive.revision, hash: directive.hash } };
      })();
  const startAndPrepare = startWorkerAttemptAndPrepareLaunchInTx;
  const { attempt, launch } = world.ctx.store.withWrite((tx) =>
    startAndPrepare(
      tx,
      {
        executionRunId: world.executionRunId,
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
        directiveId: response.directive.id,
        directiveRevision: response.directive.revision,
        directiveHash: response.directive.hash,
        workerRole: "executor",
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  const session = freshWorkerSession(world, `REC-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);
  const reportId = runWorkerAttempt({ ...world, launch, attemptId: attempt.attemptId }, session, {
    candidate_mutated: options.candidateMutated ?? false,
    files_examined: options.reportOverrides?.files_examined ?? ["src/reconciliation-probe.ts"],
    findings:
      options.reportOverrides?.findings ?? [{ summary: "reconciliation inspection observations", details: null }],
    ...(options.reportOverrides ?? {}),
  });
  return { directiveId: response.directive.id, revision: response.directive.revision, reportId, attemptId: attempt.attemptId };
}

export { supervisorCall, currentRevision, fullEnvelope, getExecutionAttemptInTx };
