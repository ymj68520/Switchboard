/**
 * SessionBinding application service (frozen plan §16–§32).
 *
 * Thin typed façade over the store's binding core. This is an INTERNAL
 * application API: Phase 3 implements binding persistence and fencing, NOT
 * caller authentication — sessionId arrives from the embedding application
 * (tests today; HostContext integration later). No model-facing MCP tool
 * accepts session_id/workspace_id/generation inputs in this phase.
 */

import {
  assertWritableBinding,
  bindSession,
  detachBinding,
  getBinding,
  listBindingsForWorkspace,
  reattachBinding,
  takeoverBinding,
  type BindInput,
  type BindingSnapshot,
  type OwnershipInput,
  type ReattachInput,
  type TakeoverInput,
  type WritableBindingInput,
} from "../store/session-bindings.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";

export interface BindingService {
  bind(input: BindInput): BindingSnapshot;
  detach(input: OwnershipInput): BindingSnapshot;
  reattach(input: ReattachInput): BindingSnapshot;
  takeover(input: TakeoverInput): BindingSnapshot;
  assertWritable(input: WritableBindingInput): BindingSnapshot;
  getBinding(runId: string): BindingSnapshot | null;
  listBindingsForWorkspace(workspaceId: string): BindingSnapshot[];
}

export function createBindingService(store: PlanStore, clock: StoreClock): BindingService {
  return {
    bind: (input) => bindSession(store, input, clock),
    detach: (input) => detachBinding(store, input, clock),
    reattach: (input) => reattachBinding(store, input, clock),
    takeover: (input) => takeoverBinding(store, input, clock),
    assertWritable: (input) => assertWritableBinding(store, input),
    getBinding: (runId) => getBinding(store, runId),
    listBindingsForWorkspace: (workspaceId) => listBindingsForWorkspace(store, workspaceId),
  };
}

export type {
  BindingSnapshot,
  BindInput,
  OwnershipInput,
  ReattachInput,
  TakeoverInput,
  WritableBindingInput,
};
