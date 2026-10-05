/**
 * Runtime instance ownership (Phase 2B2).
 *
 * Instances are PROJECT-SCOPED: OpenCode's trusted `project.id` (from the
 * plugin input, derived by the host from the project path) selects one durable
 * PlanStore per project — Project A and Project B never share state. Tests use
 * the process-local in-memory singleton via `getUltraPlanInstance()`; the
 * production plugin entry uses `getProjectInstance`, which opens a
 * DurablePlanStore and FAILS LOUDLY if the store cannot be opened (no silent
 * in-memory fallback — that would destroy recovery guarantees).
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { UltraPlanController } from "../core/controller.js";
import { InMemoryStartAdmissionLedger } from "../core/admissions.js";
import type { StartAdmissionLedger } from "../core/admissions.js";
import { DurablePlanStore } from "../memory/durable-store.js";
import { InMemoryPlanStore } from "../memory/store.js";
import type { PlanStore } from "../memory/store.js";
import { InMemoryObservationLedger } from "../repository/observations.js";
import type { ObservationLedger } from "../repository/observations.js";
import { OpenCodeRuntimeAdapter, ULTRA_PLAN_TOOL_NAMES } from "./opencode-plugin.js";
import type { UltraPlanRuntime } from "./types.js";
import { OpenCodeSemanticValidator } from "../validation/opencode-validator.js";
import type { SemanticValidator } from "../validation/types.js";
import { OpenCodeExecutionAdapter } from "./opencode-execution-adapter.js";
import { OpenCodeSupervisorAdapter } from "./opencode-supervisor-adapter.js";
import { OpenCodeWorkerAdapter } from "./opencode-worker-adapter.js";
import {
  DEFAULT_PRODUCTION_EXECUTION_BUDGETS,
  validateModelRef,
  validateProductionExecutionBudgets,
  type ProductionExecutionBudgets,
  type SupervisedExecutionBundle,
} from "./production-pump.js";
import { resolveExecutionModelPolicy } from "./execution-model-policy.js";
import { deriveHostPermissionCeiling } from "./capability-projection.js";
import { discoverHostToolNames } from "./host-tool-inventory.js";
import { UltraPlanError } from "../core/errors.js";
import { InMemoryExecutionRuntimeTracer } from "./execution-runtime.js";
import { observeGitWorkspaceBaseline } from "./workspace-baseline.js";
import type { OpenCodeModelClient } from "./opencode-client.js";
import type { PluginInput } from "@opencode-ai/plugin";

export interface UltraPlanInstance {
  store: PlanStore;
  ledger: ObservationLedger;
  admissions: StartAdmissionLedger;
  runtime: UltraPlanRuntime;
  controller: UltraPlanController;
  /** The bound isolated semantic validator, when the host provides a client. */
  semanticValidator?: SemanticValidator;
  /** Release resources (durable store close); safe to call for memory stores. */
  dispose: () => void;
}

let current: UltraPlanInstance | undefined;
const projectInstances = new Map<string, UltraPlanInstance>();

function buildInstance(
  store: PlanStore,
  options: {
    semanticValidator?: SemanticValidator;
    executionRuntime?: import("../core/controller.js").ControllerOptions["executionRuntime"];
  } = {},
): UltraPlanInstance {
  const ledger = new InMemoryObservationLedger();
  const admissions = new InMemoryStartAdmissionLedger();
  const runtime: UltraPlanRuntime = new OpenCodeRuntimeAdapter();
  return {
    store,
    ledger,
    admissions,
    runtime,
    ...(options.semanticValidator ? { semanticValidator: options.semanticValidator } : {}),
    controller: new UltraPlanController({
      store,
      ledger,
      admissions,
      runtime,
      ...(options.semanticValidator ? { semanticValidator: options.semanticValidator } : {}),
      ...(options.executionRuntime ? { executionRuntime: options.executionRuntime } : {}),
    }),
    dispose: () => {
      if (store instanceof DurablePlanStore) store.close();
    },
  };
}

/** Durable per-project store location (override with ULTRA_PLAN_DATA_DIR for tests). */
export function projectStorePath(projectKey: string): string {
  const dataDir = process.env.ULTRA_PLAN_DATA_DIR
    ? path.resolve(process.env.ULTRA_PLAN_DATA_DIR)
    : path.join(homedir(), ".local", "share", "switchboard", "ultra-plan", "projects");
  const hashed = createHash("sha256").update(projectKey).digest("hex").slice(0, 24);
  return path.join(dataDir, hashed, "plan-store.json");
}

/**
 * Production entry: one durable instance per OpenCode project id. Opening the
 * store happens eagerly and synchronously-validating; failures propagate (the
 * plugin must not silently fall back to memory). When the host provides its
 * SDK client, the isolated OpenCode semantic validator is bound to the
 * controller (Phase 2G); without a client, run_semantic_validation fails
 * honestly with `validator_unavailable` instead of faking results.
 */
export function getProjectInstance(
  projectID: string,
  options: { client?: PluginInput["client"]; worktree?: string } = {},
): UltraPlanInstance {
  const existing = projectInstances.get(projectID);
  if (existing) return existing;
  const store = new DurablePlanStore(projectStorePath(projectID));
  // Force eager open so a corrupt/newer store fails the plugin load loudly.
  const opened = store.open();
  if (isPromise(opened)) opened.then(undefined, undefined);
  const instance = buildInstance(store, {
    ...(options.client
      ? {
          semanticValidator: new OpenCodeSemanticValidator(options.client),
          // Phase 2J: the runtime handoff bundle — the OpenCode execution
          // adapter plus the deterministic execution role policy from the
          // runtime spec (§29/§30). Without a client the handoff stays
          // pending with `execution_runtime_unavailable` (never faked).
          executionRuntime: (() => {
            const spec = new OpenCodeRuntimeAdapter().spec;
            return {
              adapter: new OpenCodeExecutionAdapter(options.client!),
              executionAgent: spec.executionAgent,
              executionModel: spec.executionModel,
            };
          })(),
        }
      : {}),
  });
  projectInstances.set(projectID, instance);
  return instance;
}

/**
 * Phase 7B §20/§58 — build the PRODUCTION supervised-execution bundle from
 * the host client, the resolved host permission config, and the adapter
 * configuration (model policy + budgets). Config validation fails CLOSED at
 * construction (§59) — a bad budget/timeout/model ref refuses the cutover
 * instead of silently degrading mid-execution.
 *
 * Phase 8 §12/§13 — the bundle also DISCOVERS the host's complete
 * currently-registered tool inventory (`client.tool.ids()`) and threads it
 * into both runtime adapters' explicit deny maps (per-call `tools` maps are
 * overrides: a tool absent from the map stays enabled). Discovery failure is
 * fail-closed (§13): the bundle refuses to build rather than falling back to
 * the hardcoded baseline.
 */
export async function buildProductionSupervisedExecutionBundle(options: {
  projectID: string;
  client: PluginInput["client"];
  store: PlanStore;
  worktree?: string;
  /** Configurable runtime spec (model policy + budgets); defaults to the adapter default. */
  runtimeSpec?: import("./types.js").PlanningRuntimeSpec;
  config?: Parameters<OpenCodeRuntimeAdapter["applyToConfig"]>[0];
}): Promise<SupervisedExecutionBundle> {
  const spec = options.runtimeSpec ?? new OpenCodeRuntimeAdapter().spec;
  const policy = resolveExecutionModelPolicy(spec);
  validateModelRef(policy.supervisorModel, "supervisor");
  validateModelRef(policy.workerModel, "worker");
  validateModelRef(policy.verifierModel, "verifier");
  const budgets: ProductionExecutionBudgets = {
    ...DEFAULT_PRODUCTION_EXECUTION_BUDGETS,
    ...(spec.executionBudgets ?? {}),
  };
  validateProductionExecutionBudgets(budgets);
  const inventory = await discoverHostToolNames(options.client);
  if (!inventory.ok) {
    throw new UltraPlanError(
      "supervisor_tool_isolation_blocked",
      `Production supervised execution requires a trusted host tool inventory and it could not be obtained: ${inventory.reason}`,
    );
  }
  // §24 — the trusted workspace identity is the host-derived PROJECT id,
  // exactly the key that scopes this durable store.
  const workspace = { key: `opencode-project:${options.projectID}` };
  const tracer = new InMemoryExecutionRuntimeTracer();
  const hostCeiling = deriveHostPermissionCeiling({
    ...(options.config?.permission !== undefined ? { permission: options.config.permission as Record<string, unknown> } : {}),
    ...(options.config?.agent !== undefined ? { agent: options.config.agent as Record<string, { permission?: Record<string, unknown>; tools?: Record<string, boolean> }> } : {}),
  });
  const modelClient = options.client as OpenCodeModelClient;
  return {
    supervisor: new OpenCodeSupervisorAdapter({
      client: modelClient,
      store: options.store,
      policy,
      trustedCeiling: hostCeiling,
      timeoutMs: budgets.supervisorTimeoutMs,
      maxReadRounds: budgets.maxSupervisorReadOpsPerTurn,
      registeredUltraPlanToolNames: ULTRA_PLAN_TOOL_NAMES,
      extraHostToolNames: inventory.tools,
      tracer,
    }),
    worker: new OpenCodeWorkerAdapter({
      client: modelClient,
      policy,
      hostCeiling,
      timeoutMs: budgets.workerTimeoutMs,
      registeredUltraPlanToolNames: ULTRA_PLAN_TOOL_NAMES,
      extraHostToolNames: inventory.tools,
      tracer,
    }),
    workspace,
    policy,
    trustedCeiling: hostCeiling,
    budgets,
    executionStartBaseline: async () =>
      options.worktree
        ? observeGitWorkspaceBaseline(options.worktree)
        : { workspaceFingerprint: "unobserved:no-worktree-path" },
    tracer,
  };
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

/** Process-local in-memory instance (tests / semantic oracle). */
export function getUltraPlanInstance(): UltraPlanInstance {
  if (!current) {
    const store = new InMemoryPlanStore();
    const ledger = new InMemoryObservationLedger();
    const admissions = new InMemoryStartAdmissionLedger();
    const runtime: UltraPlanRuntime = new OpenCodeRuntimeAdapter();
    current = {
      store,
      ledger,
      admissions,
      runtime,
      controller: new UltraPlanController({ store, ledger, admissions, runtime }),
      dispose: () => {},
    };
  }
  return current;
}

/** Test seam: drop all instances so the next get builds fresh ones. */
export function resetUltraPlanInstance(): void {
  current = undefined;
  for (const instance of projectInstances.values()) instance.dispose();
  projectInstances.clear();
}
