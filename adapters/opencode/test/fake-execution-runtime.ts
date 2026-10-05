/**
 * Shared scripted runtime ports for the supervised-execution suites (7A/7B).
 *
 * Test infrastructure only. This helper deliberately imports NO test file —
 * importing one would re-collect its tests (the phantom-test quirk).
 */
import type {
  ExecutionSupervisorRuntime,
  ExecutionSupervisorTurnInput,
  ExecutionSupervisorTurnResult,
  ExecutionWorkerRuntime,
  ExecutionWorkerInvocationInput,
  WorkerInvocationResult,
} from "../src/index.js";
import type { WorkerReportPayload } from "../src/index.js";

/** Scripted Supervisor port: each entry is evaluated lazily at its turn. */
export type SupervisorScriptStep = (
  input: ExecutionSupervisorTurnInput,
) => Promise<ExecutionSupervisorTurnResult> | ExecutionSupervisorTurnResult;

export class FakeSupervisor implements ExecutionSupervisorRuntime {
  readonly calls: ExecutionSupervisorTurnInput[] = [];
  script: SupervisorScriptStep[];
  constructor(script: SupervisorScriptStep[] = []) {
    this.script = script;
  }
  async runExecutionSupervisorTurn(input: ExecutionSupervisorTurnInput): Promise<ExecutionSupervisorTurnResult> {
    this.calls.push(input);
    const step = this.script.shift();
    if (!step) return { outcome: "awaiting_supervisor", note: "script exhausted" };
    return step(input);
  }
}

/** Scripted Worker port: mimics the real adapter's host-identity overwrite. */
export type WorkerScriptStep = (
  input: ExecutionWorkerInvocationInput,
) => Promise<WorkerInvocationResult> | WorkerInvocationResult;

export class FakeWorker implements ExecutionWorkerRuntime {
  readonly invocations: (ExecutionWorkerInvocationInput & { workerSessionID: string })[] = [];
  script: WorkerScriptStep[];
  constructor(script: WorkerScriptStep[] = []) {
    this.script = script;
  }
  async invokeWorker(input: ExecutionWorkerInvocationInput): Promise<WorkerInvocationResult> {
    this.invocations.push({ ...input, workerSessionID: `ses_worker_${this.invocations.length + 1}` });
    const step = this.script.shift();
    if (!step) return { kind: "indeterminate", reason: "missing_response", detail: "script exhausted" };
    return step(input);
  }
}

/** Host-identity overwrite, exactly as the real OpenCode worker adapter does it (§42/§43). */
export function reportedPayload(
  input: ExecutionWorkerInvocationInput,
  overrides: Partial<WorkerReportPayload> = {},
): WorkerReportPayload {
  return {
    directive: { id: input.directive.id, revision: input.directive.revision, hash: input.directive.hash },
    workerRole: input.attempt.workerRole,
    result: "completed",
    actionsPerformed: ["did the work"],
    filesExamined: [],
    filesChanged: [],
    commandsRun: [],
    testsRun: [],
    findings: [],
    deviations: [],
    blockers: [],
    deliverables: [],
    candidateMutation: "none",
    baseCandidateRevision: input.context.baseCandidateRevision,
    ...overrides,
  };
}
