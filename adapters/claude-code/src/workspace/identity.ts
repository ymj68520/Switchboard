/**
 * Workspace identity application service (frozen plan §14): discovery
 * output → persistent identity registration. Idempotent by locator; the
 * assigned opaque IDs (`repo_`/`ws_` prefixed uuids) never encode paths,
 * names, branches, or sessions.
 */

import { discoverWorkspace, type WorkspaceObservation, type DiscoveryOptions } from "./discovery.js";
import { registerWorkspaceRecord, type WorkspaceRegistration, type WorkspaceRegistrationInput } from "../store/repositories.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";

export async function discoverAndRegisterWorkspace(
  store: PlanStore,
  projectDir: string,
  clock: StoreClock,
  options: DiscoveryOptions = {},
): Promise<{ observation: WorkspaceObservation; registration: WorkspaceRegistration }> {
  const observation = await discoverWorkspace(projectDir, options);
  const registration = registerWorkspace(store, observation, clock);
  return { observation, registration };
}

/** Register (or re-observe) an already-discovered observation. Idempotent. */
export function registerWorkspace(
  store: PlanStore,
  observation: WorkspaceObservation,
  clock: StoreClock,
): WorkspaceRegistration {
  const input: WorkspaceRegistrationInput = {
    repositoryKind: observation.repositoryKind,
    repositoryLocator: observation.repositoryLocator,
    workspaceKind: observation.workspaceKind,
    workspaceRoot: observation.workspaceRoot,
  };
  return registerWorkspaceRecord(store, input, clock);
}

export { discoverWorkspace };
export type { WorkspaceObservation, DiscoveryOptions };
