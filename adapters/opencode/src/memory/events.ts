/**
 * Plan event log types — spec §12 ("Event Log" component of Plan Memory).
 *
 * The event log records state transitions of a PlanningRun. Events are
 * append-only; sequence numbers are assigned per run by the store.
 */
import type { PlanID } from "../core/ids.js";
import type { PlanningLifecycle, PlanningStage } from "../core/types.js";
import type { Timestamp } from "../core/refs.js";

export type PlanEventDetail =
  | { type: "run.created"; sessionID: string }
  | { type: "run.resumed"; sessionID: string }
  | { type: "run.stage_changed"; from: PlanningStage; to: PlanningStage }
  | { type: "run.lifecycle_changed"; from: PlanningLifecycle; to: PlanningLifecycle }
  | { type: "runtime.activated"; mechanism: readonly string[]; unsupported: readonly string[] }
  | { type: "status.reported" };

export interface PlanEvent {
  /** 1-based sequence within the run. */
  seq: number;
  planID: PlanID;
  at: Timestamp;
  detail: PlanEventDetail;
}
