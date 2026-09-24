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
import { OpenCodeRuntimeAdapter } from "./opencode-plugin.js";
import type { UltraPlanRuntime } from "./types.js";

export interface UltraPlanInstance {
  store: PlanStore;
  ledger: ObservationLedger;
  admissions: StartAdmissionLedger;
  runtime: UltraPlanRuntime;
  controller: UltraPlanController;
  /** Release resources (durable store close); safe to call for memory stores. */
  dispose: () => void;
}

let current: UltraPlanInstance | undefined;
const projectInstances = new Map<string, UltraPlanInstance>();

function buildInstance(store: PlanStore): UltraPlanInstance {
  const ledger = new InMemoryObservationLedger();
  const admissions = new InMemoryStartAdmissionLedger();
  const runtime: UltraPlanRuntime = new OpenCodeRuntimeAdapter();
  return {
    store,
    ledger,
    admissions,
    runtime,
    controller: new UltraPlanController({ store, ledger, admissions, runtime }),
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
 * plugin must not silently fall back to memory).
 */
export function getProjectInstance(projectID: string): UltraPlanInstance {
  const existing = projectInstances.get(projectID);
  if (existing) return existing;
  const store = new DurablePlanStore(projectStorePath(projectID));
  // Force eager open so a corrupt/newer store fails the plugin load loudly.
  const opened = store.open();
  if (isPromise(opened)) opened.then(undefined, undefined);
  const instance = buildInstance(store);
  projectInstances.set(projectID, instance);
  return instance;
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
