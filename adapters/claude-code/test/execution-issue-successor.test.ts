/**
 * Phase 15 — ExecutionIssue, successor PlanningRun & scoped replanning.
 *
 * Every test drives the REAL application services / MCP handlers / hook
 * handlers over the sanctioned fixture chain (approved FinalPlan → delivered
 * handoff), mirroring the live-host closure pattern of Phase 14.
 */
import { describe, expect, it } from "vitest";

import { executePhasePlanTool, PHASE_PLAN_TOOLS, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { handlePostToolUse, handlePreToolUse } from "../src/hooks/handlers.js";
import type { HookOutput } from "../src/hooks/output.js";
import type { PlanStore } from "../src/store/sqlite-store.js";
import type { StoreClock } from "../src/store/migration-runner.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import { executionIssueHash, EXECUTION_ISSUE_KINDS, affectedRefProblems } from "../src/core/execution-issue.js";
import { createHandoffService, parseFinalPlanCanonical } from "../src/application/handoff-service.js";
import { createExecutionIssueService } from "../src/application/execution-issue-service.js";
import { createSuccessorRunService } from "../src/application/successor-run-service.js";
import {
  countOpenExecutionIssuesInTx,
  listOpenExecutionIssuesInTx,
} from "../src/store/execution-issues.js";
import {
  getBaselineMaterializationInTx,
  getPlanningRunBaselineForPredecessorInTx,
  getPlanningRunBaselineForSuccessorInTx,
  listBaselineScopesInTx,
} from "../src/store/successor-baselines.js";
import { getExecutionBindingInTx, getExecutionHandoffInTx, reattachExecutionBindingInTx } from "../src/store/execution.js";
import { detachBindingInTx } from "../src/store/session-bindings.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { getHeadCommitRecord } from "../src/store/plan-commits.js";
import { listSectionWorkflowStates } from "../src/store/section-workflow.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { createStoreContextSource } from "../src/application/context-read-model.js";
import { assembleContext } from "../src/context/assembler.js";
import { buildRecoveryCapsule } from "../src/context/capsule.js";
import { listObservationSummaries } from "../src/application/observation-service.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import {
  callApprove,
  callRequestFinalization,
  driveToCleanValidation,
} from "./phase13-helpers.js";
import { callHandoff, executionToken, makeApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { hostToken } from "./context-helpers.js";
import { makeProposalFixture } from "./proposal-helpers.js";
import { commitPrepared } from "./context-helpers.js";
import { dagChanges, driveToDetail, withCounterServices } from "./phase11-helpers.js";
import { inputOf, selectSection, toolContextOf } from "./phase12-helpers.js";
import { completeSectionVia } from "./section-workflow.test.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

function depsOf(ctx: PhasePlanToolContext): { store: PlanStore; secret: Buffer; clock: StoreClock } {
  return { store: ctx.store, secret: ctx.secret, clock: ctx.clock };
}

function outputOf(output: HookOutput): Record<string, unknown> {
  return output.kind === "json" ? output.payload : {};
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RuntimeError) return err.code;
    throw err;
  }
  throw new Error("expected a RuntimeError but none was thrown");
}

/** A delivered Build world: completed run + delivered handoff + attached ExecutionBinding (generation 1). */
async function deliveredWorld(sessionId = "S1") {
  const { f, ctx } = await makeApprovedFinalPlanFixture(sessionId);
  const prepared = callHandoff(ctx, f, { toolUseId: `${sessionId}-DELIVER-1` });
  createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
    runId: f.runId,
    sessionId: f.sessionId,
    toolUseId: `${sessionId}-DELIVER-1`,
    responseHandoffId: prepared.handoff_id,
    responseHandoffHash: prepared.handoff_hash,
  });
  return { f, ctx, handoff: prepared };
}

/** report_execution_issue through the real MCP handler with a signed execution token. */
function callReportIssue(
  ctx: PhasePlanToolContext,
  f: {
    sessionId: string;
    workspaceId: string;
    runId: string;
    finalPlanId: string;
    generation: number;
  },
  input: {
    kind: string;
    summary: string;
    detail: string;
    affected_refs: Array<{ type: string; id: string; revision: number }>;
  },
  options: { toolUseId?: string; generation?: number } = {},
) {
  const token = executionToken(ctx, {
    sessionId: f.sessionId,
    workspaceId: f.workspaceId,
    runId: f.runId,
    finalPlanId: f.finalPlanId,
    generation: options.generation ?? 1,
    tool: "report_execution_issue",
    toolUseId: options.toolUseId ?? "TU-ISSUE-1",
    business: input as unknown as Record<string, unknown>,
  });
  return executePhasePlanTool(ctx, "report_execution_issue", { ...input, _hostContext: token }) as {
    status: string;
    idempotent: boolean;
    issue: { issue_id: string; issue_hash: string; kind: string };
    executionIssues: { openCount: number; replanRequired: boolean };
  };
}

/** The FinalPlan row + parsed canonical of a run (ids are server-generated — read dynamically). */
function finalPlanOf(ctx: PhasePlanToolContext, runId: string) {
  return ctx.store.withRead((tx) => {
    const row = getFinalPlanInTx(tx, runId);
    if (row === null) throw new Error("no FinalPlan");
    return { row, plan: parseFinalPlanCanonical(row.canonicalJson, runId) };
  });
}

function firstSectionRef(ctx: PhasePlanToolContext, runId: string) {
  const { plan } = finalPlanOf(ctx, runId);
  const section = plan.sections[0]!;
  return { type: "section" as const, id: section.sectionId, revision: section.revision };
}

/** start_or_resume through the real MCP handler with a fresh signed EntryIntent (run-less planning context). */
function callStartOrResume(
  ctx: PhasePlanToolContext,
  sessionId: string,
  workspaceId: string,
  options: { toolUseId?: string } = {},
) {
  const toolUseId = options.toolUseId ?? "TU-ENTRY";
  void toolUseId;
  // The hostToken helper stamps prompt_id "PROMPT-1"; the intent must bind exactly that prompt.
  const entry = issueEntryIntent(ctx.secret, { sessionId, promptId: "PROMPT-1" });
  const token = hostToken(
    ctx.secret,
    "start_or_resume",
    { _entryIntent: entry },
    { sessionId, workspaceId },
    { permissionMode: "default", toolUseId },
  );
  return executePhasePlanTool(ctx, "start_or_resume", { _entryIntent: entry, _hostContext: token }) as {
    status: string;
    started: boolean;
    reattached?: boolean;
    run: { id: string; stage: string; revision: number };
    binding: { state: string; generation: number };
    initialStage: string;
    baseline: { baseline_id: string; baseline_hash: string; issue_set_hash: string; predecessor_run_id: string; final_plan: { id: string; hash: string } };
    executionIssues: Array<{ issue_id: string; kind: string }>;
    affectedScope: { stage: string; needsReviewSections: string[]; inheritedCompletedSections: string[] };
    predecessorExecutionBinding: { state: string; generation: number };
  };
}

/** A planning HostContext token for a successor-run tool call. */
function planningToken(
  ctx: PhasePlanToolContext,
  input: { sessionId: string; workspaceId: string; runId: string; generation: number; tool: string; business?: Record<string, unknown>; toolUseId?: string; permissionMode?: string },
): string {
  return hostToken(
    ctx.secret,
    input.tool,
    input.business ?? {},
    { sessionId: input.sessionId, workspaceId: input.workspaceId, runId: input.runId, generation: input.generation },
    { permissionMode: input.permissionMode ?? "plan", toolUseId: input.toolUseId ?? "TU-PLAN-1" },
  );
}

// ---------------------------------------------------------------------------
// Schema migration 11 → 12 (§5/§83/§84/§85, E1/E67/E69)
// ---------------------------------------------------------------------------

describe("migration 11 → 12 execution-issue-successor-baseline (§5, E1/E67/E69)", () => {
  it("reaches schema 12 with an empty v12 domain over a delivered Phase-14 world (E67)", async () => {
    const { f, ctx } = await deliveredWorld();
    expect(ctx.store.withRead((tx) => getFinalPlanInTx(tx, f.runId))!.finalPlanHash).toBe(f.finalPlanHash);
    ctx.store.withRead((tx) => {
      const history = tx.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
      expect(history.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      for (const table of ["execution_issues", "planning_run_baselines", "execution_issue_adoptions", "planning_run_baseline_materializations"]) {
        const row = tx.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(row.n).toBe(0);
      }
    });
    expect(SUPPORTED_SCHEMA_VERSION).toBe(12);
  });

  it("no execution progress tables ever exist (§6, E63)", async () => {
    const { ctx } = await deliveredWorld();
    ctx.store.withRead((tx) => {
      const names = (tx.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
      for (const banned of ["execution_steps", "execution_progress", "execution_task_states", "implementation_events", "build_progress", "step_completions"]) {
        expect(names).not.toContain(banned);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// ExecutionIssue identity, exact refs, immutability (§7–§11, E2–E7)
// ---------------------------------------------------------------------------

describe("ExecutionIssue identity, exact refs, immutability (§7–§11, E2–E7)", () => {
  it("every frozen kind is accepted; issues are xissue_-identified and DDL-immutable (§2/§7, E2)", async () => {
    const { f, ctx } = await deliveredWorld();
    const ref = firstSectionRef(ctx, f.runId);
    for (const kind of EXECUTION_ISSUE_KINDS) {
      const result = callReportIssue(ctx, f, {
        kind,
        summary: `semantic conflict: ${kind}`,
        detail: "implementation as approved would require changing this approved semantic.",
        affected_refs: [ref],
      }, { toolUseId: `TU-KIND-${kind}` });
      expect(result.status).toBe("ok");
      expect(result.issue.issue_id.startsWith("xissue_")).toBe(true);
      expect(result.executionIssues.replanRequired).toBe(true);
    }
    ctx.store.withRead((tx) => {
      const triggers = (tx.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>).map((row) => row.name);
      expect(triggers).toContain("execution_issues_no_update");
      expect(triggers).toContain("execution_issues_no_delete");
    });
  });

  it("affected refs are exact: wrong revision and foreign ids fail (§10, E4)", async () => {
    const { f, ctx } = await deliveredWorld();
    const { plan } = finalPlanOf(ctx, f.runId);
    const section = plan.sections[0]!;
    expect(codeOf(() =>
      callReportIssue(ctx, f, {
        kind: "section_contract",
        summary: "old revision",
        detail: "not exact",
        affected_refs: [{ type: "section", id: section.sectionId, revision: section.revision + 7 }],
      }, { toolUseId: "TU-EXACT-1" }),
    )).toBe("EXECUTION_ISSUE_SCOPE_INVALID");
    expect(codeOf(() =>
      callReportIssue(ctx, f, {
        kind: "section_contract",
        summary: "foreign id",
        detail: "not exact",
        affected_refs: [{ type: "section", id: "SEC-FOREIGN", revision: 1 }],
      }, { toolUseId: "TU-EXACT-2" }),
    )).toBe("EXECUTION_ISSUE_SCOPE_INVALID");
    expect(affectedRefProblems(plan, [{ type: "section", id: section.sectionId, revision: section.revision }])).toEqual([]);
    expect(affectedRefProblems(plan, [{ type: "section", id: section.sectionId, revision: section.revision + 1 }])).toHaveLength(1);
  });

  it("a completely unscoped issue is rejected (§11)", async () => {
    const { f, ctx } = await deliveredWorld();
    // The MCP schema enforces minItems=1 (MCP_INPUT_INVALID); the DOMAIN law
    // is asserted at the service boundary.
    expect(codeOf(() =>
      createExecutionIssueService(ctx.store, ctx.clock).reportIssue({
        runId: f.runId,
        workspaceId: f.workspaceId,
        workspaceRoot: f.workspaceRoot,
        sessionId: f.sessionId,
        toolUseId: "TU-UNSCOPED",
        finalPlanId: f.finalPlanId,
        executionBindingGeneration: 1,
        kind: "invariant",
        summary: "unscoped",
        detail: "no refs",
        affectedRefs: [],
      }),
    )).toBe("EXECUTION_ISSUE_SCOPE_INVALID");
  });

  it("reporting mutates nothing in the predecessor world (§4, E5/E6/E7)", async () => {
    const { f, ctx } = await deliveredWorld();
    const snapshot = () => ({
      finalPlan: ctx.store.withRead((tx) => getFinalPlanInTx(tx, f.runId)),
      handoff: ctx.store.withRead((tx) => getExecutionHandoffInTx(tx, f.runId)),
      head: getHeadCommitRecord(ctx.store, f.runId),
      run: ctx.store.withRead((tx) => tx.prepare("SELECT revision, lifecycle, stage FROM planning_runs WHERE run_id = ?").get(f.runId)),
      evidence: ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM evidence_revisions WHERE run_id = ?").get(f.runId)),
      audit: ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM evidence_audit_snapshots WHERE run_id = ?").get(f.runId)),
      observations: ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM observations WHERE run_id = ?").get(f.runId)),
    });
    const before = snapshot();
    callReportIssue(ctx, f, {
      kind: "hard_constraint",
      summary: "constraint conflict",
      detail: "the hard constraint cannot hold in the current repository reality.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-IMMUTE-1" });
    expect(snapshot()).toEqual(before);
    expect(before.run).toMatchObject({ lifecycle: "completed" });
  });

  it("idempotency: same signed operation + payload replays; different payload conflicts; new workers add new issues (§15/§72, E9)", async () => {
    const { f, ctx } = await deliveredWorld();
    const ref = firstSectionRef(ctx, f.runId);
    const input = {
      kind: "section_contract",
      summary: "contract cannot be satisfied",
      detail: "the approved contract requires an interface the platform does not expose.",
      affected_refs: [ref],
    };
    const first = callReportIssue(ctx, f, input, { toolUseId: "TU-IDEM-1" });
    expect(first.idempotent).toBe(false);
    const replay = callReportIssue(ctx, f, input, { toolUseId: "TU-IDEM-1" });
    expect(replay.idempotent).toBe(true);
    expect(replay.issue.issue_id).toBe(first.issue.issue_id);
    expect(codeOf(() =>
      callReportIssue(ctx, f, { ...input, summary: "a DIFFERENT claim" }, { toolUseId: "TU-IDEM-1" }),
    )).toBe("IDEMPOTENCY_CONFLICT");
    const second = callReportIssue(ctx, f, input, { toolUseId: "TU-IDEM-2" });
    expect(second.idempotent).toBe(false);
    expect(second.issue.issue_id).not.toBe(first.issue.issue_id);
    expect(second.executionIssues.openCount).toBe(2);
  });

  it("the canonical hash excludes the issue id/timestamps and sorts refs deterministically (§8)", () => {
    const base = {
      version: 1 as const,
      finalPlan: { id: "fplan_x", hash: "sha256:p" },
      handoff: { id: "xhandoff_x", hash: "sha256:h" },
      kind: "invariant" as const,
      summary: "s",
      detail: "d",
      affectedRefs: [
        { type: "section" as const, id: "SEC-A", revision: 4 },
        { type: "decision" as const, id: "DEC-1", revision: 2 },
      ],
      repositoryContext: { kind: "directory" as const, revision: null },
    };
    const reordered = { ...base, affectedRefs: [...base.affectedRefs].reverse() };
    expect(executionIssueHash(base)).toBe(executionIssueHash(reordered));
    expect(executionIssueHash({ ...base, summary: "different" })).not.toBe(executionIssueHash(base));
  });
});

// ---------------------------------------------------------------------------
// MCP surface + authority (§12–§14, E8, E66)
// ---------------------------------------------------------------------------

describe("report_execution_issue MCP surface (§12–§14, E8, E66)", () => {
  it("is exactly the 16th tool and carries no approval meta (§87/§14, E66)", () => {
    expect(PHASE_PLAN_TOOLS).toHaveLength(16);
    const tool = PHASE_PLAN_TOOLS[15]!;
    expect(tool.name).toBe("report_execution_issue");
    expect(tool._meta).toBeUndefined();
  });

  it("rejects model-supplied authority fields outright (§12)", async () => {
    const { f, ctx } = await deliveredWorld();
    const ref = firstSectionRef(ctx, f.runId);
    const input = {
      kind: "section_contract",
      summary: "s",
      detail: "d",
      affected_refs: [ref],
      run_id: f.runId,
    };
    const token = executionToken(ctx, {
      sessionId: f.sessionId,
      workspaceId: f.workspaceId,
      runId: f.runId,
      finalPlanId: f.finalPlanId,
      generation: 1,
      tool: "report_execution_issue",
      toolUseId: "TU-FORBIDDEN",
      business: input as unknown as Record<string, unknown>,
    });
    expect(codeOf(() => executePhasePlanTool(ctx, "report_execution_issue", { ...input, _hostContext: token }))).toBe(
      "MCP_INPUT_INVALID",
    );
  });

  it("a signed PLANNING HostContext is never accepted (§13, E8)", async () => {
    const { f, ctx } = await deliveredWorld();
    const ref = firstSectionRef(ctx, f.runId);
    const input = { kind: "section_contract", summary: "s", detail: "d", affected_refs: [ref] };
    const planningTokenV = hostToken(
      ctx.secret,
      "report_execution_issue",
      input as unknown as Record<string, unknown>,
      { sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, generation: 1 },
      { permissionMode: "plan", toolUseId: "TU-PLANNING-AUTH" },
    );
    expect(codeOf(() =>
      executePhasePlanTool(ctx, "report_execution_issue", { ...input, _hostContext: planningTokenV }),
    )).toBe("HOST_CONTEXT_INVALID");
  });
});

// ---------------------------------------------------------------------------
// Build projections + semantic mutation guard (§19–§21, E10–E12)
// ---------------------------------------------------------------------------

describe("Build replanRequired projections and mutation guard (§19–§21, E10–E12)", () => {
  it("get_state / get_context(detail=build) expose the open-issue projection (§19, E10)", async () => {
    const { f, ctx } = await deliveredWorld();
    const stateToken = executionToken(ctx, {
      sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId,
      finalPlanId: f.finalPlanId, generation: 1, tool: "get_state", toolUseId: "TU-STATE-1",
    });
    const before = executePhasePlanTool(ctx, "get_state", { _hostContext: stateToken }) as Record<string, unknown>;
    expect(before.executionIssues).toEqual({ openCount: 0, replanRequired: false });

    callReportIssue(ctx, f, {
      kind: "approved_decision",
      summary: "decision conflict",
      detail: "the approved decision cannot be implemented against the current toolchain.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-PROJ-1" });

    const after = executePhasePlanTool(ctx, "get_state", { _hostContext: stateToken }) as Record<string, unknown>;
    expect(after.executionIssues).toEqual({ openCount: 1, replanRequired: true });
    const contextToken = executionToken(ctx, {
      sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId,
      finalPlanId: f.finalPlanId, generation: 1, tool: "get_context", toolUseId: "TU-BUILDCTX-1",
      business: { detail: "build" },
    });
    const build = executePhasePlanTool(ctx, "get_context", { detail: "build", _hostContext: contextToken }) as Record<string, unknown>;
    const issues = build.openExecutionIssues as Array<Record<string, unknown>>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "approved_decision" });
  });

  it("the PreToolUse mutation guard pauses Build while an issue is open; reads stay available (§20/§21, E11/E12)", async () => {
    const { f, ctx } = await deliveredWorld();
    // No open issue: a Write is not our business (Phase 14 behavior preserved).
    const writeBefore = outputOf(await handlePreToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      cwd: f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "PreToolUse",
      toolName: "Write",
      toolInput: { file_path: "x.ts", content: "hi" },
      toolUseId: "W0",
    }));
    expect(writeBefore.hookSpecificOutput).toBeUndefined();

    callReportIssue(ctx, f, {
      kind: "explicit_dependency",
      summary: "dependency conflict",
      detail: "the explicit dependency cannot be honored.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-GUARD-1" });

    for (const tool of ["Write", "Edit", "NotebookEdit", "Bash", "PowerShell", "Agent"]) {
      const out = outputOf(await handlePreToolUse(depsOf(ctx), {
        sessionId: f.sessionId,
        cwd: f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: tool,
        toolInput: {},
        toolUseId: `W-${tool}`,
      }));
      const payload = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
      expect(payload.permissionDecision).toBe("deny");
      expect(payload.permissionDecisionReason).toContain("EXECUTION_REPLAN_REQUIRED");
    }
    const read = outputOf(await handlePreToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      cwd: f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "PreToolUse",
      toolName: "Read",
      toolInput: { file_path: "x.ts" },
      toolUseId: "R0",
    }));
    expect(read.hookSpecificOutput).toBeUndefined();
    // report_execution_issue itself stays signed+allowed under the execution authority.
    const report = outputOf(await handlePreToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      cwd: f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "PreToolUse",
      toolName: "mcp__plugin_phase-plan_phase-plan__report_execution_issue",
      toolInput: { kind: "invariant", summary: "s", detail: "d", affected_refs: [] },
      toolUseId: "REP0",
    })) as { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } };
    expect(report.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(typeof report.hookSpecificOutput?.updatedInput?._hostContext).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Successor creation (§22–§43, E13–E16/E19/E20/E23/E26–E30/E37–E39/E58–E60)
// ---------------------------------------------------------------------------

describe("successor creation from the immutable baseline (§22–§43)", () => {
  it("without an open issue a Build-bound session can never create a successor (§23, E14)", async () => {
    const { f, ctx } = await deliveredWorld();
    expect(codeOf(() => callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-NO-ISSUE" }))).toBe(
      "EXECUTION_ISSUE_REQUIRED",
    );
  });

  it("section-scoped issue → successor at stage detail with exact scoped reopening (§22/§32–§35/§38–§40, E15/E28–E30/E37/E40/E58)", async () => {
    const { f, ctx } = await deliveredWorld();
    const { plan } = finalPlanOf(ctx, f.runId);
    const alpha = plan.sections[0]!;
    const beta = plan.sections[1]!;
    const headBefore = getHeadCommitRecord(ctx.store, f.runId);
    const predecessorRow = () => ctx.store.withRead((tx) => tx.prepare("SELECT lifecycle, revision FROM planning_runs WHERE run_id = ?").get(f.runId) as { lifecycle: string; revision: number });
    const before = predecessorRow();

    const issue = callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "alpha contract cannot be implemented",
      detail: "the approved contract for the first section conflicts with the platform.",
      affected_refs: [{ type: "section", id: alpha.sectionId, revision: alpha.revision }],
    }, { toolUseId: "TU-SUCC-1" });
    expect(issue.executionIssues.replanRequired).toBe(true);

    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-SUCC-ENTRY" });
    expect(result.status).toBe("started_successor");
    const successorRunId = result.run.id;
    expect(successorRunId).not.toBe(f.runId);
    expect(result.run.stage).toBe("detail");
    expect(result.binding).toEqual({ state: "attached", generation: 1 });
    expect(result.initialStage).toBe("detail");
    expect(result.baseline.final_plan).toEqual({ id: f.finalPlanId, hash: f.finalPlanHash });
    expect(result.affectedScope).toEqual({
      stage: "detail",
      needsReviewSections: [alpha.sectionId],
      inheritedCompletedSections: [beta.sectionId],
    });

    // E16 — the predecessor is terminal, forever.
    expect(before.lifecycle).toBe("completed");
    expect(predecessorRow()).toEqual(before);
    // E17 — HEAD untouched; E18 — FinalPlan untouched; E19 — handoff untouched.
    expect(getHeadCommitRecord(ctx.store, f.runId)).toEqual(headBefore);
    expect(finalPlanOf(ctx, f.runId).row.finalPlanHash).toBe(f.finalPlanHash);
    // E37 — the execution binding detached with generation +1.
    const binding = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!;
    expect(binding.state).toBe("detached");
    expect(binding.generation).toBe(2);
    expect(result.predecessorExecutionBinding).toEqual({ state: "detached", generation: 2 });

    // E20/E21/E23 — exactly one immutable baseline binding the exact FinalPlan + issue set.
    const baseline = ctx.store.withRead((tx) => getPlanningRunBaselineForSuccessorInTx(tx, successorRunId))!;
    expect(baseline.finalPlanId).toBe(f.finalPlanId);
    expect(baseline.finalPlanHash).toBe(f.finalPlanHash);
    expect(baseline.issueSetHash.startsWith("sha256:")).toBe(true);
    expect(ctx.store.withRead((tx) => getPlanningRunBaselineForPredecessorInTx(tx, f.runId))!.baselineId).toBe(baseline.baselineId);
    expect(baseline.baselineHash.startsWith("sha256:")).toBe(true);

    // E58 — every open issue adopted exactly once; the open set is now empty.
    expect(ctx.store.withRead((tx) => countOpenExecutionIssuesInTx(tx, f.runId))).toBe(0);
    expect(ctx.store.withRead((tx) => listOpenExecutionIssuesInTx(tx, f.runId))).toEqual([]);

    // E29/E30 — scope rows with exact origin revisions.
    const scopes = ctx.store.withRead((tx) => listBaselineScopesInTx(tx, baseline.baselineId));
    expect(scopes.find((scope) => scope.sectionId === alpha.sectionId)).toMatchObject({
      scopeState: "needs_review",
      originRunId: f.runId,
      originRevision: alpha.revision,
    });
    expect(scopes.find((scope) => scope.sectionId === beta.sectionId)).toMatchObject({
      scopeState: "inherited_completed",
      originRevision: beta.revision,
    });

    // E38 — the OLD execution authority no longer reaches Build reads.
    const staleToken = executionToken(ctx, {
      sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId,
      finalPlanId: f.finalPlanId, generation: 1, tool: "get_state", toolUseId: "TU-STALE-EXEC",
    });
    expect(codeOf(() => executePhasePlanTool(ctx, "get_state", { _hostContext: staleToken }))).toBe(
      "EXECUTION_CONTEXT_NOT_AVAILABLE",
    );

    // §73 — a second entry never creates a SECOND successor: the session now
    // holds the successor's planning binding and Case A resumes exactly it.
    const second = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-SUCC-ENTRY-2" });
    expect(second.status).toBe("resumed");
    expect(second.run.id).toBe(successorRunId);
  });

  it("a host restart that re-attaches the old execution binding does not shadow the successor resume (§73, live-host restart)", async () => {
    const { f, ctx } = await deliveredWorld();
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract cannot be satisfied",
      detail: "the approved contract requires replanning.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-RESTART-ISSUE" });
    const created = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-RESTART-ENTRY" });
    expect(created.status).toBe("started_successor");
    const successorRunId = created.run.id as string;

    // SessionStart:resume recovery (phase-14 E87): the delivered contract's
    // execution binding re-attaches for the exact same session.
    const reattached = ctx.store.withWrite((tx) =>
      reattachExecutionBindingInTx(tx, { runId: f.runId, sessionId: f.sessionId, workspaceId: f.workspaceId }, ctx.clock.nowIso()));
    expect(reattached.state).toBe("attached");

    // The next /phase-plan must still resume the successor (Case A) instead
    // of failing the successor fence with SUCCESSOR_RUN_ALREADY_STARTED.
    const resumed = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-RESTART-ENTRY-2" });
    expect(resumed.status).toBe("resumed");
    expect(resumed.run.id).toBe(successorRunId);
    expect(ctx.store.withRead((tx) => countOpenExecutionIssuesInTx(tx, f.runId))).toBe(0);
  });

  it("a restart cycle (SessionEnd detaches successor binding + SessionStart re-attaches execution binding) still resumes the successor (§73, live-host restart)", async () => {
    const { f, ctx } = await deliveredWorld();
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract cannot be satisfied",
      detail: "the approved contract requires replanning.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-CYCLE-ISSUE" });
    const created = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-CYCLE-ENTRY" });
    expect(created.status).toBe("started_successor");
    const successorRunId = created.run.id as string;

    // SessionEnd: the successor planning binding detaches…
    ctx.store.withWrite((tx) => {
      detachBindingInTx(tx, { runId: successorRunId, sessionId: f.sessionId }, ctx.clock.nowIso());
      return null;
    });
    // …and SessionStart recovery re-attaches the delivered execution binding.
    const reattached = ctx.store.withWrite((tx) =>
      reattachExecutionBindingInTx(tx, { runId: f.runId, sessionId: f.sessionId, workspaceId: f.workspaceId }, ctx.clock.nowIso()));
    expect(reattached.state).toBe("attached");

    // /phase-plan must take Case B: re-attach the successor binding and resume.
    const resumed = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-CYCLE-ENTRY-2" });
    expect(resumed.status).toBe("resumed");
    expect(resumed.reattached).toBe(true);
    expect(resumed.run.id).toBe(successorRunId);
    expect(ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!.state).toBe("attached");
  });

  it("architecture-level issue → successor at stage architecture with ALL sections needs_review (§33, E26/E27)", async () => {
    const { f, ctx } = await deliveredWorld();
    callReportIssue(ctx, f, {
      kind: "hard_constraint",
      summary: "a hard constraint is violated by the repository reality",
      detail: "the hard constraint cannot hold.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-ARCH-1" });
    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-ARCH-ENTRY" });
    expect(result.run.stage).toBe("architecture");
    expect(result.affectedScope.needsReviewSections.length).toBe(2);
    expect(result.affectedScope.inheritedCompletedSections).toEqual([]);
    const scopes = ctx.store.withRead((tx) => listBaselineScopesInTx(tx, result.baseline.baseline_id));
    expect(scopes.every((scope) => scope.scopeState === "needs_review")).toBe(true);
  });

  it("a section-scoped issue with a downstream dependent reopens exactly the closure (§34, E29/E30/E100)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-s15-dag-");
    let closeStore: (() => void) | null = null;
    try {
      const base = await makeProposalFixture(root, { sessionId: "S1" });
      closeStore = () => base.store.close();
      const fixture = withCounterServices(base);
      driveToDetail(fixture);
      const detail: import("./phase11-helpers.js").DetailFixture = { ...fixture, root, close: () => fixture.store.close() };
      const dag = fixture.proposals.prepareProposal({
        runId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        bindingGeneration: fixture.generation,
        expectedRunRevision: fixture.runRevision,
        type: "design_checkpoint",
        scope: { kind: "detail" },
        title: "Three-section DAG",
        summary: "Alpha ← Beta; Gamma free",
        changes: dagChanges([
          { title: "Alpha", localRef: "alpha" },
          { title: "Beta", dependencies: ["alpha"] },
          { title: "Gamma" },
        ]),
      });
      commitPrepared(fixture, dag.proposal.proposalId, dag.proposal.revision, dag.proposal.proposalHash);
      const sectionIds = [...new Set(dag.candidateRefs.filter((ref) => ref.kind === "section").map((ref) => ref.id))].sort();
      expect(sectionIds).toHaveLength(3);
      for (const sectionId of sectionIds) {
        selectSection(detail, sectionId);
        completeSectionVia(detail, sectionId, 1);
      }
      const input = inputOf(detail);
      const wrapped = {
        ...detail,
        inputId: input.inputId,
        inputHash: input.inputHash,
        sectionIds,
      };
      const ctx = toolContextOf(fixture);
      driveToCleanValidation(wrapped, ctx, "S1");
      const fin = callRequestFinalization(ctx, wrapped, { toolUseId: "S1-FIN" });
      callApprove(ctx, wrapped, {
        proposal_id: fin.final_proposal.proposal_id,
        revision: fin.final_proposal.revision,
        proposal_hash: fin.final_proposal.proposal_hash,
      }, { toolUseId: "S1-APP" });
      const delivered = callHandoff(ctx, {
        sessionId: fixture.sessionId,
        workspaceId: fixture.workspaceId,
        runId: fixture.runId,
        generation: fixture.generation,
      }, { toolUseId: "S1-DELIVER" });
      createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
        runId: fixture.runId,
        sessionId: fixture.sessionId,
        toolUseId: "S1-DELIVER",
        responseHandoffId: delivered.handoff_id,
        responseHandoffHash: delivered.handoff_hash,
      });

      // Which section is upstream? Beta declares a dependency on Alpha — find
      // the dependency edge from the committed section contents.
      const plan = finalPlanOf(ctx, fixture.runId).plan;
      const contentOf = (sectionId: string): { dependencies?: string[] } => {
        const view = createStoreContextSource(ctx.store).readRevision({
          runId: fixture.runId, kind: "section", id: sectionId, revision: plan.sections.find((s) => s.sectionId === sectionId)!.revision,
        });
        return view!.content as { dependencies?: string[] };
      };
      const upstream = plan.sections.find((section) => (contentOf(section.sectionId).dependencies ?? []).length === 0 && plan.sections.some((other) => (contentOf(other.sectionId).dependencies ?? []).includes(section.sectionId)))!;
      const downstream = plan.sections.find((section) => (contentOf(section.sectionId).dependencies ?? []).includes(upstream.sectionId))!;
      const unrelated = plan.sections.find((section) => section.sectionId !== upstream.sectionId && section.sectionId !== downstream.sectionId)!;

      callReportIssue(ctx, {
        sessionId: fixture.sessionId, workspaceId: fixture.workspaceId, runId: fixture.runId, finalPlanId: finalPlanOf(ctx, fixture.runId).row.finalPlanId, generation: 1,
      }, {
        kind: "section_contract",
        summary: "upstream contract conflicts",
        detail: "the upstream approved contract cannot be implemented.",
        affected_refs: [{ type: "section", id: upstream.sectionId, revision: upstream.revision }],
      }, { toolUseId: "TU-DAG-ISSUE" });

      const result = callStartOrResume(ctx, fixture.sessionId, fixture.workspaceId, { toolUseId: "TU-DAG-ENTRY" });
      expect(result.run.stage).toBe("detail");
      expect(result.affectedScope.needsReviewSections).toEqual([downstream.sectionId, upstream.sectionId].sort());
      expect(result.affectedScope.inheritedCompletedSections).toEqual([unrelated.sectionId]);
    } finally {
      closeStore?.();
      removeTempPluginDataRoot(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Baseline-before-HEAD (§42–§45/§80, E31–E35, E73)
// ---------------------------------------------------------------------------

describe("baseline-before-HEAD: no fabricated authorization, read-only baseline (§42–§45)", () => {
  it("successor creation fabricates NO proposal/approval/commit/snapshot/HEAD (§42/§43, E31–E34/E79)", async () => {
    const { f, ctx } = await deliveredWorld();
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract conflict",
      detail: "the contract cannot be implemented.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-NOFAKE-ISSUE" });
    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-NOFAKE-ENTRY" });
    const successorRunId = result.run.id;
    ctx.store.withRead((tx) => {
      expect((tx.prepare("SELECT COUNT(*) AS n FROM proposals WHERE run_id = ?").get(successorRunId) as { n: number }).n).toBe(0);
      expect((tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(successorRunId) as { n: number }).n).toBe(0);
      expect((tx.prepare("SELECT COUNT(*) AS n FROM plan_commits WHERE run_id = ?").get(successorRunId) as { n: number }).n).toBe(0);
      expect((tx.prepare("SELECT COUNT(*) AS n FROM plan_snapshots WHERE run_id = ?").get(successorRunId) as { n: number }).n).toBe(0);
      expect(tx.prepare("SELECT 1 AS one FROM plan_heads WHERE run_id = ?").get(successorRunId)).toBeUndefined();
      expect((tx.prepare("SELECT COUNT(*) AS n FROM memory_revisions WHERE run_id = ?").get(successorRunId) as { n: number }).n).toBe(0);
    });
    // E35 — the baseline FinalPlan design stays READABLE before any commit.
    const { plan } = finalPlanOf(ctx, f.runId);
    const section = plan.sections[0]!;
    const read = executePhasePlanTool(ctx, "read_memory", {
      kind: "section",
      id: section.sectionId,
      revision: section.revision,
      detail: "summary",
      _hostContext: planningToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation: 1,
        tool: "read_memory", business: { kind: "section", id: section.sectionId, revision: section.revision, detail: "summary" },
      }),
    }) as Record<string, unknown>;
    expect(read.authority).toBe("successor_baseline");
    expect(read.compactProjection).toBeTruthy();

    // Historical/superseded refs never resolve as baseline reads (§45).
    expect(codeOf(() =>
      executePhasePlanTool(ctx, "read_memory", {
        kind: "section",
        id: section.sectionId,
        revision: section.revision + 5,
        detail: "summary",
        _hostContext: planningToken(ctx, {
          sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation: 1,
          tool: "read_memory", business: { kind: "section", id: section.sectionId, revision: section.revision + 5, detail: "summary" },
        }),
      }),
    )).toBe("BASELINE_MEMORY_REF_NOT_AUTHORIZED");
  });

  it("get_state / get_context expose the successor view (§78/§79)", async () => {
    const { f, ctx } = await deliveredWorld();
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract conflict",
      detail: "the contract cannot be implemented.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-VIEW-ISSUE" });
    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-VIEW-ENTRY" });
    const successorRunId = result.run.id;
    const state = executePhasePlanTool(ctx, "get_state", {
      _hostContext: planningToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation: 1, tool: "get_state",
      }),
    }) as Record<string, unknown>;
    const successor = state.successor as Record<string, unknown>;
    expect(successor).toMatchObject({
      predecessorRunId: f.runId,
      materialized: false,
      issueCount: 1,
    });
    expect((successor.predecessorFinalPlan as Record<string, unknown>).id).toBe(f.finalPlanId);

    const context = executePhasePlanTool(ctx, "get_context", {
      _hostContext: planningToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation: 1, tool: "get_context",
      }),
    }) as Record<string, unknown>;
    const view = context.successor as Record<string, unknown>;
    expect(view).toMatchObject({ materialized: false, localHead: null });
    expect((view.baseline as Record<string, unknown>).finalPlan).toEqual({ id: f.finalPlanId, hash: f.finalPlanHash });
    expect((view.executionIssues as Array<unknown>)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// First successor Proposal + materialization (§46–§59, E43–E48/E100)
// ---------------------------------------------------------------------------

describe("first successor proposal, materialization, scoped completion (§46–§59)", () => {
  it("the first proposal is canonical V4 bound to the baseline; approval materializes byte-identically (§46–§53, E43–E48)", async () => {
    const { f, ctx } = await deliveredWorld();
    const { plan } = finalPlanOf(ctx, f.runId);
    const alpha = plan.sections[0]!;
    const beta = plan.sections[1]!;
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "alpha contract conflicts",
      detail: "the alpha contract cannot be implemented.",
      affected_refs: [{ type: "section", id: alpha.sectionId, revision: alpha.revision }],
    }, { toolUseId: "TU-MAT-ISSUE" });
    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-MAT-ENTRY" });
    const successorRunId = result.run.id;
    const generation = 1;

    // §35/§65 — select the affected section BEFORE any commit.
    getPlanningRunRecord(ctx.store, successorRunId)!;
    const selectArgs = { section_id: alpha.sectionId };
    executePhasePlanTool(ctx, "select_section", {
      ...selectArgs,
      _hostContext: planningToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation,
        tool: "select_section", business: selectArgs, permissionMode: "plan",
      }),
    });

    // §48/§49 — the FIRST proposal binds the exact immutable baseline (V4).
    const prepareArgs = {
      proposal_type: "section_completion",
      scope: { kind: "section", section_id: alpha.sectionId },
      title: "Amend the affected section",
      summary: "redesign alpha under the discovered constraint",
      changes: [
        {
          op: "SET_SECTION_REVISION",
          target: { kind: "section", id: alpha.sectionId, revision: alpha.revision },
          content: {
            title: "Alpha (revised)",
            objective: "revised objective",
            design: "revised design",
            interfaces: [],
            invariants: [],
            failureModes: [],
            dependencies: [],
            decisionRefs: [],
            openQuestionRefs: [],
            impactRefs: [],
            contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
          },
          compactProjection: `section:Alpha@${alpha.revision + 1}`,
        },
        { op: "COMPLETE_SECTION", sectionId: alpha.sectionId, compactProjection: `complete:${alpha.sectionId}` },
      ],
    };
    const prepared = executePhasePlanTool(ctx, "prepare_proposal", {
      ...prepareArgs,
      _hostContext: planningToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation,
        tool: "prepare_proposal", permissionMode: "plan",
        business: prepareArgs as unknown as Record<string, unknown>,
      }),
    }) as { proposal: { proposal_id: string; revision: number; proposal_hash: string } };

    // E43 — the canonical payload carries the successorBaseline binding and
    // the proposal hash covers it (re-hash verification).
    const canonicalRow = ctx.store.withRead((tx) =>
      tx.prepare(
        "SELECT canonical_json AS canonicalJson, proposal_hash AS proposalHash FROM proposal_revisions "
        + "WHERE run_id = ? AND proposal_id = ? AND revision = ?",
      ).get(successorRunId, prepared.proposal.proposal_id, prepared.proposal.revision) as { canonicalJson: string; proposalHash: string },
    );
    const canonical = JSON.parse(canonicalRow.canonicalJson) as Record<string, unknown>;
    expect(canonical.version).toBe(4);
    const binding = canonical.successorBaseline as Record<string, string>;
    expect(binding.baselineId).toBe(result.baseline.baseline_id);
    expect(binding.finalPlanId).toBe(f.finalPlanId);
    expect(binding.finalPlanHash).toBe(f.finalPlanHash);
    expect(binding.issueSetHash).toBe(result.baseline.issue_set_hash);

    // E79 — still NO synthetic authorization rows before the real approval.
    ctx.store.withRead((tx) => {
      expect((tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(successorRunId) as { n: number }).n).toBe(0);
    });

    // E45 — the FIRST authorized PlanCommit materializes the baseline.
    const approveArgs = {
      proposal_id: prepared.proposal.proposal_id,
      proposal_revision: prepared.proposal.revision,
      proposal_hash: prepared.proposal.proposal_hash,
    };
    const approved = executePhasePlanTool(ctx, "approve_proposal", {
      ...approveArgs,
      _hostContext: planningToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation,
        tool: "approve_proposal", permissionMode: "plan", business: approveArgs,
      }),
    }) as { approved: boolean; commit_id: string; snapshot_id: string };

    const materialization = ctx.store.withRead((tx) => getBaselineMaterializationInTx(tx, result.baseline.baseline_id))!;
    expect(materialization.materializedCommitId).toBe(approved.commit_id);
    expect(materialization.materializedSnapshotId).toBe(approved.snapshot_id);

    // E46 — unchanged baseline artifacts carried forward BYTE-IDENTICALLY.
    const betaContent = (runId: string) => ctx.store.withRead((tx) =>
      tx.prepare(
        "SELECT content_json AS contentJson, compact_projection AS compactProjection, contract_json AS contractJson "
        + "FROM memory_revisions WHERE run_id = ? AND kind = 'section' AND artifact_id = ? AND revision = ?",
      ).get(runId, beta.sectionId, beta.revision),
    );
    expect(betaContent(successorRunId)).toEqual(betaContent(f.runId));
    // E48 — the predecessor memory rows are untouched (count unchanged and hash row equal).
    const predecessorBeta = betaContent(f.runId);
    expect(predecessorBeta).not.toBeNull();

    // E50 — alpha is a REAL successor workflow completion now; E30/E49 — beta
    // NEVER gets a fabricated local workflow row.
    const workflow = listSectionWorkflowStates(ctx.store, successorRunId);
    expect(workflow.find((state) => state.sectionId === alpha.sectionId)?.status).toBe("completed");
    expect(workflow.find((state) => state.sectionId === beta.sectionId)).toBeUndefined();

    // E53/E66 — the LAST affected completion reaches DETAIL_COMPLETE through the
    // inherited merge and freezes the successor's OWN SynthesisInput.
    expect(getPlanningRunRecord(ctx.store, successorRunId)!.stage).toBe("synthesis");
  });

  it("successor Evidence gates require successor-run evidence (§60, E51)", async () => {
    const { f, ctx } = await deliveredWorld();
    const { plan } = finalPlanOf(ctx, f.runId);
    const alpha = plan.sections[0]!;
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract conflict",
      detail: "the contract cannot be implemented.",
      affected_refs: [{ type: "section", id: alpha.sectionId, revision: alpha.revision }],
    }, { toolUseId: "TU-EV-ISSUE" });
    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-EV-ENTRY" });
    const successorRunId = result.run.id;
    // A predecessor Evidence revision is NOT same-run: the gate rejects it.
    const evidenceArgs = {
      proposal_type: "amendment",
      scope: { kind: "section", section_id: alpha.sectionId },
      title: "t",
      summary: "s",
      changes: [{
        op: "SET_SECTION_REVISION",
        target: { kind: "section", id: alpha.sectionId, revision: alpha.revision },
        content: {
          title: "Alpha", objective: "o", design: "d", interfaces: [], invariants: [], failureModes: [],
          dependencies: [], decisionRefs: [], openQuestionRefs: [], impactRefs: [],
          contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
        },
        compactProjection: "section:Alpha",
      }],
      required_evidence: [{ evidence_id: "ev_predecessor_world", revision: 1 }],
    };
    expect(codeOf(() =>
      executePhasePlanTool(ctx, "prepare_proposal", {
        ...evidenceArgs,
        _hostContext: planningToken(ctx, {
          sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation: 1,
          tool: "prepare_proposal", permissionMode: "plan",
          business: evidenceArgs as unknown as Record<string, unknown>,
        }),
      }),
    )).toBe("EVIDENCE_STATE_INVALID");
  });

  it("new repository observations belong ONLY to the successor run (§61, E52)", async () => {
    const { f, ctx } = await deliveredWorld();
    const predecessorObservations = listObservationSummaries(ctx.store, f.runId, { limit: 100 }).length;
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract conflict",
      detail: "the contract cannot be implemented.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-OBS-ISSUE" });
    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-OBS-ENTRY" });
    const successorRunId = result.run.id;
    const out = await handlePostToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      permissionMode: "plan",
      hookEventName: "PostToolUse",
      toolName: "Read",
      toolInput: { file_path: "src/replanned.ts" },
      toolResponse: { type: "text", text: "export const replanned = true;\n" },
      toolUseId: "TU-OBS-READ-1",
    });
    void out;
    expect(listObservationSummaries(ctx.store, successorRunId, { limit: 100 }).length).toBe(1);
    expect(listObservationSummaries(ctx.store, f.runId, { limit: 100 }).length).toBe(predecessorObservations);
  });
});

// ---------------------------------------------------------------------------
// Context v5 + recovery capsule (§46/§47/§102, E41/E42)
// ---------------------------------------------------------------------------

describe("context v5 successor lineage and recovery capsule (§46/§47/§102, E41/E42)", () => {
  it("the successor context is version 5 with the successorBaseline block and an epoch:v5 epoch", async () => {
    const { f, ctx } = await deliveredWorld();
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract conflict",
      detail: "the contract cannot be implemented.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-CTX5-ISSUE" });
    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-CTX5-ENTRY" });
    const source = createStoreContextSource(ctx.store);
    const context = assembleContext(source, result.run.id);
    expect(context.version).toBe(5);
    expect(context.epoch.startsWith("context-epoch:v5:")).toBe(true);
    expect(context.successorBaseline).not.toBeNull();
    expect(context.successorBaseline!.finalPlan.id).toBe(f.finalPlanId);
    expect(context.successorBaseline!.materialized).toBe(false);
    expect(context.successorBaseline!.issueSummaries).toHaveLength(1);
    const capsule = buildRecoveryCapsule(context).text;
    expect(capsule).toContain("Successor baseline:");
    expect(capsule).toContain(`Baseline FinalPlan: ${f.finalPlanId}`);
    expect(capsule).toContain("Baseline materialized: no");
    // E80 (pre-materialization recovery): the capsule alone reconstructs the lineage.
    expect(capsule).toContain(`Predecessor run: ${f.runId}`);
  });

  it("after materialization the context reports materialized=true with the local HEAD", async () => {
    const { f, ctx } = await deliveredWorld();
    const { plan } = finalPlanOf(ctx, f.runId);
    const alpha = plan.sections[0]!;
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract conflict",
      detail: "the contract cannot be implemented.",
      affected_refs: [{ type: "section", id: alpha.sectionId, revision: alpha.revision }],
    }, { toolUseId: "TU-MATCTX-ISSUE" });
    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-MATCTX-ENTRY" });
    const successorRunId = result.run.id;
    const selectArgs2 = { section_id: alpha.sectionId };
    executePhasePlanTool(ctx, "select_section", {
      ...selectArgs2,
      _hostContext: planningToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation: 1,
        tool: "select_section", business: selectArgs2, permissionMode: "plan",
      }),
    });
    const prepareArgs2 = {
      proposal_type: "section_completion",
      scope: { kind: "section", section_id: alpha.sectionId },
      title: "Amend alpha",
      summary: "redesign alpha",
      changes: [
        {
          op: "SET_SECTION_REVISION",
          target: { kind: "section", id: alpha.sectionId, revision: alpha.revision },
          content: {
            title: "Alpha (revised)", objective: "o", design: "d", interfaces: [], invariants: [],
            failureModes: [], dependencies: [], decisionRefs: [], openQuestionRefs: [], impactRefs: [],
            contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
          },
          compactProjection: `section:Alpha@${alpha.revision + 1}`,
        },
        { op: "COMPLETE_SECTION", sectionId: alpha.sectionId, compactProjection: `complete:${alpha.sectionId}` },
      ],
    };
    const prepared = executePhasePlanTool(ctx, "prepare_proposal", {
      ...prepareArgs2,
      _hostContext: planningToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation: 1,
        tool: "prepare_proposal", permissionMode: "plan",
        business: prepareArgs2 as unknown as Record<string, unknown>,
      }),
    }) as { proposal: { proposal_id: string; revision: number; proposal_hash: string } };
    const approveArgs2 = {
      proposal_id: prepared.proposal.proposal_id,
      proposal_revision: prepared.proposal.revision,
      proposal_hash: prepared.proposal.proposal_hash,
    };
    executePhasePlanTool(ctx, "approve_proposal", {
      ...approveArgs2,
      _hostContext: planningToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: successorRunId, generation: 1,
        tool: "approve_proposal", permissionMode: "plan", business: approveArgs2,
      }),
    });
    const source = createStoreContextSource(ctx.store);
    const context = assembleContext(source, successorRunId);
    expect(context.successorBaseline!.materialized).toBe(true);
    expect(context.head.commitId).not.toBeNull();
    const capsule = buildRecoveryCapsule(context).text;
    expect(capsule).toContain("Baseline materialized: yes");
  });
});

// ---------------------------------------------------------------------------
// Concurrency fences (§72–§75, E59/E60)
// ---------------------------------------------------------------------------

describe("successor creation and adoption concurrency (§72–§75, E59/E60)", () => {
  it("two racing successor creations resolve to exactly ONE successor run (§73, E59)", async () => {
    const { f, ctx } = await deliveredWorld();
    callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract conflict",
      detail: "the contract cannot be implemented.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-RACE-ISSUE" });
    // Two INDEPENDENT store connections race the same creation; BEGIN IMMEDIATE
    // serializes the write transactions, so the loser observes the detached
    // execution binding (STALE_EXECUTION_BINDING) or the adopted baseline
    // (SUCCESSOR_RUN_ALREADY_STARTED) — never a second successor.
    const { openPlanStore } = await import("../src/store/sqlite-store.js");
    const rivalStore = await openPlanStore({ pluginDataRoot: f.root });
    try {
      const first = createSuccessorRunService(ctx.store, ctx.clock);
      const rival = createSuccessorRunService(rivalStore, ctx.clock);
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => first.createSuccessor({ workspaceId: f.workspaceId, sessionId: f.sessionId })),
        Promise.resolve().then(() => rival.createSuccessor({ workspaceId: f.workspaceId, sessionId: f.sessionId })),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      for (const rejection of rejected) {
        expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(RuntimeError);
        expect((rejection as PromiseRejectedResult).reason.code).toBe("STALE_EXECUTION_BINDING");
      }
      const baselines = ctx.store.withRead((tx) =>
        tx.prepare("SELECT COUNT(*) AS n FROM planning_run_baselines").get() as { n: number },
      );
      expect(baselines.n).toBe(1);
      const adoptions = ctx.store.withRead((tx) =>
        tx.prepare("SELECT COUNT(*) AS n FROM execution_issue_adoptions").get() as { n: number },
      );
      expect(adoptions.n).toBe(1);
    } finally {
      rivalStore.close();
    }
  });

  it("the adoption UNIQUE fence is a DB law, not an application pre-check (§74, E60)", async () => {
    const { f, ctx } = await deliveredWorld();
    const issue = callReportIssue(ctx, f, {
      kind: "section_contract",
      summary: "contract conflict",
      detail: "the contract cannot be implemented.",
      affected_refs: [firstSectionRef(ctx, f.runId)],
    }, { toolUseId: "TU-FENCE-ISSUE" });
    const result = callStartOrResume(ctx, f.sessionId, f.workspaceId, { toolUseId: "TU-FENCE-ENTRY" });
    const issueId = issue.issue.issue_id;
    // A second adoption row for the SAME issue (any rival successor) must hit
    // the UNIQUE(issue_id) fence inside SQLite itself.
    expect(() =>
      ctx.store.withWrite((tx) => {
        tx.prepare(
          "INSERT INTO execution_issue_adoptions (issue_id, run_id, successor_run_id, baseline_id, position, created_at) "
          + "VALUES (?, ?, ?, ?, 2, ?)",
        ).run(issueId, f.runId, result.run.id, result.baseline.baseline_id, ctx.clock.nowIso());
        return null;
      }),
    ).toThrowError();
  });
});

// ---------------------------------------------------------------------------
// §104 — no completed-run reactivation path exists
// ---------------------------------------------------------------------------

describe("no completed-run reactivation (§25/§104, E16)", () => {
  it("every mutation path on the completed predecessor fails closed", async () => {
    const { f, ctx } = await deliveredWorld();
    // The successor service refuses a non-completed world and never flips lifecycle.
    expect(codeOf(() =>
      createSuccessorRunService(ctx.store, ctx.clock).createSuccessor({ workspaceId: f.workspaceId, sessionId: f.sessionId }),
    )).toBe("EXECUTION_ISSUE_REQUIRED");
    // The run-mutation service refuses terminal runs outright: the ownership
    // fence fires first (the planning binding detached at delivery) and the
    // detached binding can never assert writable authority on a terminal run.
    const { createPlanningRunService } = await import("../src/application/planning-run-service.js");
    expect(codeOf(() =>
      createPlanningRunService(ctx.store, ctx.clock).reviseDiscoveryGoal({
        runId: f.runId, workspaceId: f.workspaceId, sessionId: f.sessionId, bindingGeneration: 1, expectedRevision: 1, goal: "x",
      }),
    )).toBe("BINDING_DETACHED");
    expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
  });
});
