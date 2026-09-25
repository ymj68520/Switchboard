/**
 * Shared Phase 6 fixtures: run-at-architecture-stage harness, typed content
 * builders, and the TEST-ONLY authorization factory (§33).
 *
 * makeTestUserAuthorization deliberately lives under test/ — it must never be
 * exported by the runtime/application production surface (pinned by
 * import-boundary.test.ts). It fabricates the SEAM TYPE only; it never
 * claims authenticity, which remains outside Phase 6 (§32).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { createPlanCommitEngine, type PlanCommitEngine, type UserApprovalAuthorization } from "../src/application/plan-commit-engine.js";
import { createProposalService, type ProposalService } from "../src/application/proposal-service.js";
import { createPlanningRunService, type PlanningRunService } from "../src/application/planning-run-service.js";
import type { RawProposalChange } from "../src/core/proposal.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { fixedClock } from "./store-helpers.js";

export function makeTestUserAuthorization(input: {
  proposalId: string;
  proposalRevision: number;
  proposalHash: string;
  authorizationRequestId?: string;
}): UserApprovalAuthorization {
  return {
    authorizationRequestId: input.authorizationRequestId ?? `AUTH-${input.proposalId}-${input.proposalRevision}`,
    proposalId: input.proposalId,
    proposalRevision: input.proposalRevision,
    proposalHash: input.proposalHash,
  };
}

export const CONSTRAINT_1 = {
  source: "user" as const,
  statement: "No network access at runtime",
  severity: "hard" as const,
  status: "active" as const,
};

export const DECISION_1 = {
  title: "Use SQLite WAL",
  statement: "Store uses node:sqlite with WAL",
  rationale: "single-writer concurrency",
  alternatives: ["flat files"],
  consequences: ["readers never block writers"],
  scope: "storage",
  supportingRefs: [],
};

export const ARCHITECTURE_1 = {
  summary: "Single-store architecture",
  components: ["PlanStore", "Runtime"],
  boundaries: ["plugin data dir"],
  dataFlows: ["events → store"],
  principles: ["fail closed"],
  unresolvedQuestionRefs: [],
  decisionRefs: [],
};

export const SECTION_1_RAW = {
  title: "Store layer",
  objective: "Durable state",
  design: "SQLite WAL + transactions",
  interfaces: ["PlanStore"],
  invariants: ["atomic commits"],
  failureModes: ["disk full"],
  dependencies: [],
  decisionRefs: [],
  openQuestionRefs: [],
  impactRefs: [],
  contract: {
    provides: ["PlanStore API"],
    requires: ["node:sqlite"],
    invariants: ["serializable writes"],
    interfaces: ["PlanStore"],
    decisions: [],
  },
};

export const OPEN_QUESTION_1 = {
  question: "Which WAL checkpoint policy?",
  blocking: true,
  scope: "architecture",
  status: "open" as const,
};

export const OPEN_QUESTION_SOFT = {
  question: "Naming for helper modules?",
  blocking: false,
  scope: "architecture",
  status: "open" as const,
};

export const CONFLICT_1 = {
  type: "contradiction",
  refs: [],
  description: "Two decisions contradict",
  severity: "hard" as const,
  status: "open" as const,
};

export interface ProposalFixture {
  store: PlanStore;
  proposals: ProposalService;
  runs: PlanningRunService;
  engine: PlanCommitEngine;
  runId: string;
  workspaceId: string;
  sessionId: string;
  generation: number;
  runRevision: number;
}

/**
 * A run at the requested stage with a writable binding for S1.
 * `architecture` (default): run transitioned once (revision 2).
 */
export async function makeProposalFixture(
  root: string,
  options: { stage?: "discovery" | "architecture"; sessionId?: string } = {},
): Promise<ProposalFixture> {
  const store = await initializePlanStore({ pluginDataRoot: root });
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const { registration } = await discoverAndRegisterWorkspace(store, projectDir, fixedClock({ ids: ["r0", "w0"] }));
  const runs = createPlanningRunService(store, fixedClock({ ids: ["run-id"] }));
  const sessionId = options.sessionId ?? "S1";
  const { run, binding } = runs.createPlanningRun({
    workspaceId: registration.workspace.workspaceId,
    sessionId,
    goal: "proposal fixture",
  });
  let current = run;
  if ((options.stage ?? "architecture") === "architecture") {
    current = runs.transitionRun({
      runId: run.runId,
      workspaceId: registration.workspace.workspaceId,
      sessionId,
      bindingGeneration: binding.generation,
      expectedRevision: run.revision,
      event: "DISCOVERY_COMPLETE",
    });
  }
  const proposals = createProposalService(store, fixedClock({ ids: ["prop-id", "evt-1", "evt-2", "evt-3", "evt-4"] }));
  const engine = createPlanCommitEngine(store, fixedClock({ ids: ["cmt-id", "appr-id", "snap-id", "evt-c"] }));
  return {
    store,
    proposals,
    runs,
    engine,
    runId: run.runId,
    workspaceId: registration.workspace.workspaceId,
    sessionId,
    generation: binding.generation,
    runRevision: current.revision,
  };
}

export function closeFixture(fixture: ProposalFixture): void {
  fixture.store.close();
}

/** Convenience: prepare a checkpoint with the fixture's ownership inputs. */
export function prepareCheckpoint(
  fixture: ProposalFixture,
  changes: RawProposalChange[],
  overrides: Partial<Parameters<ProposalService["prepareProposal"]>[0]> = {},
) {
  return fixture.proposals.prepareProposal({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    expectedRunRevision: fixture.runRevision,
    type: "design_checkpoint",
    scope: { kind: "architecture" },
    title: "Checkpoint",
    summary: "checkpoint summary",
    changes,
    ...overrides,
  });
}

export interface MemoryCounts {
  artifacts: number;
  revisions: number;
  snapshots: number;
  heads: number;
  commits: number;
  approvals: number;
}

/** Table counts used to prove "no committed-memory mutation" invariants. */
export function memoryCounts(store: PlanStore): MemoryCounts {
  const read = (sql: string): number =>
    (store.withRead((tx) => tx.prepare(sql).get()) as { n: number }).n;
  return {
    artifacts: read("SELECT count(*) AS n FROM memory_artifacts"),
    revisions: read("SELECT count(*) AS n FROM memory_revisions"),
    snapshots: read("SELECT count(*) AS n FROM plan_snapshots"),
    heads: read("SELECT count(*) AS n FROM plan_heads"),
    commits: read("SELECT count(*) AS n FROM plan_commits"),
    approvals: read("SELECT count(*) AS n FROM approvals"),
  };
}
