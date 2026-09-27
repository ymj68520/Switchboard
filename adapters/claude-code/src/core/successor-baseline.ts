/**
 * PlanningRunBaseline canonical model (Phase 15 §22–§31/§26/§27/§62).
 *
 * PURE core: canonical shape, deterministic hashing, and the deterministic
 * baseline issue-set hash. No SQLite, no host, no MCP.
 *
 * Authority model (§27): the baseline's design authority is the predecessor's
 * approved IMMUTABLE FinalPlan — never the Build conversation, never current
 * files, never issue prose, never the current git state (§28/§62: the
 * repository at replan start is recorded SEPARATELY as the successor's
 * re-observation starting point, and never rewrites the predecessor's
 * ExecutionHandoff baseline).
 *
 * The baseline is created once per successor run (§26 — exactly one), is
 * immutable, and carries the complete deterministic open-issue set (§30 — the
 * model never picks issue ids).
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { ExecutionIssueKind, ExecutionIssueAffectedRef } from "./execution-issue.js";
import type { RepositoryBaseline } from "./execution-handoff.js";

export const PLANNING_RUN_BASELINE_VERSION = 1 as const;

/** §56 — the ONLY two baseline scope states a section can carry. */
export const BASELINE_SCOPE_STATES = ["inherited_completed", "needs_review"] as const;
export type BaselineScopeState = (typeof BASELINE_SCOPE_STATES)[number];

/**
 * PlanningRunBaselineV1 (§26) — the immutable design+defect anchor of one
 * successor PlanningRun. `finalSnapshotId`/`finalCommitId` are the
 * predecessor's Final PlanCommit pair (§E22); `repositoryAtReplanStart` is
 * the successor's own re-observation starting point (§24/§28/§62).
 */
export interface PlanningRunBaselineV1 {
  version: typeof PLANNING_RUN_BASELINE_VERSION;
  successorRunId: string;
  predecessorRunId: string;
  finalPlanId: string;
  finalPlanHash: string;
  finalSnapshotId: string;
  finalCommitId: string;
  executionHandoffId: string;
  executionHandoffHash: string;
  issueSetHash: string;
  repositoryAtReplanStart: RepositoryBaseline;
}

/**
 * Deterministic baseline hash (§E20/E21): sha256 over the canonical payload.
 * The baseline id and creation timestamp are excluded — the payload is fully
 * determined by the successor/predecessor identities, the frozen FinalPlan
 * and handoff anchors, the issue set, and the recorded repository reality.
 */
export function planningRunBaselineHash(baseline: PlanningRunBaselineV1): string {
  return `sha256:${createHash("sha256").update(canonicalJson(baseline), "utf8").digest("hex")}`;
}

/**
 * One adopted ExecutionIssue inside the baseline set (§31): the exact issue
 * identity plus its semantic projection, hashed into the set.
 */
export interface BaselineIssueEntry {
  issueId: string;
  issueHash: string;
  kind: ExecutionIssueKind;
  affectedRefs: ExecutionIssueAffectedRef[];
}

/**
 * §30/§31 — the deterministic open-issue-set hash: entries sorted by issueId,
 * sha256 over the canonical array. The model never selects the set; Core
 * derives it from every currently-open issue of the attached FinalPlan.
 */
export function baselineIssueSetHash(entries: BaselineIssueEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.issueId.localeCompare(b.issueId)).map((entry) => ({
    issueId: entry.issueId,
    issueHash: entry.issueHash,
    kind: entry.kind,
    affectedRefs: [...entry.affectedRefs].sort(
      (a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id) || a.revision - b.revision,
    ),
  }));
  return `sha256:${createHash("sha256").update(canonicalJson(sorted), "utf8").digest("hex")}`;
}
