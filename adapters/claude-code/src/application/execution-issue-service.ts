/**
 * ExecutionIssue application service (Phase 15 §1–§20).
 *
 * Authority model (§13): report_execution_issue requires the signed
 * EXECUTION HostContext — the exact session that holds the attached
 * ExecutionBinding of a delivered handoff over a completed run. A Planning
 * HostContext is rejected by domain separation before this layer runs.
 *
 * Boundary laws (§3/§4/§14):
 *   - an issue is a Build-discovered semantic DEFECT REPORT, never Evidence,
 *     never Observation, never design authorization — no human approval;
 *   - reporting NEVER mutates the predecessor world: the completed run, the
 *     FinalPlan, the handoff, the Evidence audit, Plan Memory HEAD, Section
 *     workflow history, and Evidence freshness all stay exactly as they are;
 *   - the repository context is captured SERVER-SIDE (§16) from the
 *     workspace's git HEAD with the same fixed-argv/shell=false/bounded
 *     mechanism as the handoff baseline — model-provided revisions are
 *     unrepresentable;
 *   - idempotency (§15): the operation identity is
 *     `execution-issue:<signed toolUseId>`; the SAME semantic payload
 *     replays to the SAME issue, a different payload is IDEMPOTENCY_CONFLICT.
 *
 * Open state (§18/§19/§20): "open" is derived (no adoption row). Any open
 * issue puts the attached FinalPlan into replanRequired — Build semantic
 * mutation pauses until an explicit /phase-plan successor run.
 */

import { canonicalJson } from "../core/canonical-json.js";
import {
  affectedRefProblems,
  executionIssueHash,
  type ExecutionIssueAffectedRef,
  type ExecutionIssueKind,
  type ExecutionIssueV1,
} from "../core/execution-issue.js";
import type { RepositoryBaseline } from "../core/execution-handoff.js";
import { createHandoffService, deriveRepositoryBaseline, parseFinalPlanCanonical } from "./handoff-service.js";
import { RuntimeError } from "../runtime/errors.js";
import {
  countOpenExecutionIssuesInTx,
  findExecutionIssueByOperationInTx,
  insertExecutionIssueInTx,
  listOpenExecutionIssuesInTx,
  type ExecutionIssueRefRow,
  type ExecutionIssueRow,
} from "../store/execution-issues.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";

function issueError(
  code:
    | "EXECUTION_ISSUE_SCOPE_INVALID"
    | "IDEMPOTENCY_CONFLICT"
    | "HANDOFF_NOT_AUTHORIZED",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail });
}

export interface ReportExecutionIssueInput {
  runId: string;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  toolUseId: string;
  finalPlanId: string;
  executionBindingGeneration: number;
  kind: ExecutionIssueKind;
  summary: string;
  detail: string;
  affectedRefs: ExecutionIssueAffectedRef[];
}

export interface ReportExecutionIssueResult {
  issueId: string;
  issueHash: string;
  kind: ExecutionIssueKind;
  summary: string;
  affectedRefs: ExecutionIssueAffectedRef[];
  repositoryContext: RepositoryBaseline;
  openIssues: number;
  replanRequired: boolean;
  idempotent: boolean;
}

export function createExecutionIssueService(store: PlanStore, clock: StoreClock) {
  const handoffService = createHandoffService(store, clock);

  /** §16 — server-captured repository context; never model-provided. */
  function captureRepositoryBaselineInTx(tx: StoreTx, workspaceId: string): RepositoryBaseline {
    const workspaceRow = tx
      .prepare("SELECT kind, canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
      .get(workspaceId) as { kind: string; canonicalRoot: string } | undefined;
    if (workspaceRow === undefined) {
      throw issueError("HANDOFF_NOT_AUTHORIZED", `workspace '${workspaceId}' is not registered`);
    }
    return deriveRepositoryBaseline(workspaceRow.kind, workspaceRow.canonicalRoot);
  }

  /** The refs sorted the way the canonical payload sorts them (§8). */
  function sortedRefs(refs: ExecutionIssueAffectedRef[]): ExecutionIssueAffectedRef[] {
    return [...refs].sort(
      (a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id) || a.revision - b.revision,
    );
  }

  return {
    /**
     * §12–§15 — record one immutable Build-discovered semantic defect.
     * Caller (the MCP handler) has already verified the signed execution
     * authority; this layer revalidates the STORE side of the same authority
     * inside the write transaction and never trusts the tool call alone.
     */
    reportIssue(input: ReportExecutionIssueInput): ReportExecutionIssueResult {
      return store.withWrite((tx) => {
        // §13 — the Store side of the execution authority: completed run +
        // approved FinalPlan + delivered handoff + attached exact-session
        // binding with the exact generation.
        const authority = handoffService.requireBuildReadAuthorityInTx(tx, {
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          finalPlanId: input.finalPlanId,
          generation: input.executionBindingGeneration,
        });
        const plan = parseFinalPlanCanonical(authority.finalPlanRow.canonicalJson, input.runId);

        // §11 — no completely unscoped issue exists.
        if (input.affectedRefs.length === 0) {
          throw issueError(
            "EXECUTION_ISSUE_SCOPE_INVALID",
            "an execution issue must bind at least one exact approved FinalPlan ref",
          );
        }
        // §9/§10 — exact FinalPlan-closure membership only.
        const problems = affectedRefProblems(plan, input.affectedRefs);
        if (problems.length > 0) {
          throw issueError(
            "EXECUTION_ISSUE_SCOPE_INVALID",
            "affected_refs must cite exact approved FinalPlan closure refs (exact id@revision)",
            { detail: { problems: problems.map((problem) => ({ ...problem.ref, reason: problem.problem })) } },
          );
        }

        const now = clock.nowIso();
        const operationId = `execution-issue:${input.toolUseId}`;
        const prior = findExecutionIssueByOperationInTx(tx, input.runId, operationId);
        if (prior !== null) {
          // §15 — same operation id: the STORED semantic payload decides.
          // The repository context is server-derived, so git drift between
          // retries never fabricates a conflict; the model-authored fields
          // (kind/summary/detail/affectedRefs) must match exactly.
          const stored = JSON.parse(prior.canonicalJson) as ExecutionIssueV1;
          const samePayload =
            stored.kind === input.kind &&
            stored.summary === input.summary &&
            stored.detail === input.detail &&
            canonicalJson(sortedRefs(stored.affectedRefs)) === canonicalJson(sortedRefs(input.affectedRefs));
          if (!samePayload) {
            throw issueError(
              "IDEMPOTENCY_CONFLICT",
              `operation '${operationId}' already recorded a different execution issue`,
              { detail: { issueId: prior.issueId } },
            );
          }
          const openIssues = countOpenExecutionIssuesInTx(tx, input.runId);
          return {
            issueId: prior.issueId,
            issueHash: prior.issueHash,
            kind: stored.kind,
            summary: stored.summary,
            affectedRefs: sortedRefs(stored.affectedRefs),
            repositoryContext: stored.repositoryContext,
            openIssues,
            replanRequired: openIssues > 0,
            idempotent: true,
          };
        }

        // §16 — repository context captured server-side, at report time.
        const repositoryContext = captureRepositoryBaselineInTx(tx, input.workspaceId);
        const payload: ExecutionIssueV1 = {
          version: 1,
          finalPlan: { id: authority.finalPlanRow.finalPlanId, hash: authority.finalPlanRow.finalPlanHash },
          handoff: { id: authority.handoff.handoffId, hash: authority.handoff.handoffHash },
          kind: input.kind,
          summary: input.summary,
          detail: input.detail,
          affectedRefs: sortedRefs(input.affectedRefs),
          repositoryContext,
        };
        const issueId = `xissue_${clock.newId()}`;
        const issueHash = executionIssueHash(payload);
        const refs: ExecutionIssueRefRow[] = sortedRefs(input.affectedRefs).map((ref, index) => ({
          position: index + 1,
          refType: ref.type,
          artifactId: ref.id,
          revision: ref.revision,
        }));
        insertExecutionIssueInTx(
          tx,
          {
            runId: input.runId,
            issueId,
            finalPlanId: authority.finalPlanRow.finalPlanId,
            finalPlanHash: authority.finalPlanRow.finalPlanHash,
            handoffId: authority.handoff.handoffId,
            handoffHash: authority.handoff.handoffHash,
            kind: input.kind,
            summary: input.summary,
            detail: input.detail,
            canonicalJson: canonicalJson(payload),
            issueHash,
            repositoryKind: repositoryContext.kind,
            repositoryRevision: repositoryContext.revision,
            operationId,
            sessionId: input.sessionId,
          },
          refs,
          now,
        );
        const openIssues = countOpenExecutionIssuesInTx(tx, input.runId);
        return {
          issueId,
          issueHash,
          kind: input.kind,
          summary: input.summary,
          affectedRefs: sortedRefs(input.affectedRefs),
          repositoryContext,
          openIssues,
          replanRequired: openIssues > 0,
          idempotent: false,
        };
      });
    },

    /** §19 — the Build-view projection: open issues + replanRequired. */
    openIssuesForRun(runId: string): { issues: ExecutionIssueRow[]; openCount: number; replanRequired: boolean } {
      return store.withRead((tx) => {
        const issues = listOpenExecutionIssuesInTx(tx, runId);
        return { issues, openCount: issues.length, replanRequired: issues.length > 0 };
      });
    },

    /** §19 — the count the PreToolUse mutation guard checks. */
    countOpenIssues(runId: string): number {
      return store.withRead((tx) => countOpenExecutionIssuesInTx(tx, runId));
    },
  };
}

export type ExecutionIssueService = ReturnType<typeof createExecutionIssueService>;
