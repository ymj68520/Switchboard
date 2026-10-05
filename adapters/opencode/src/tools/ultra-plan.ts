/**
 * The `ultraplan_start` tool — the deterministic workhorse behind /ultra-plan.
 *
 * OpenCode command templates are prompts; the plugin-registered tool is what
 * actually executes. The /ultra-plan command template directs the planning
 * agent to invoke this tool, which drives
 * OpenCode → /ultra-plan → Controller → PlanningRun → Store end to end and
 * returns the deterministic status block.
 *
 * Phase 7B: the tool RELAYS the user's /ultra-plan arguments into the
 * production controller entry (controller.enter). The typed execution-control
 * authorizations (resume / takeover / abort / replan) are minted HOST-side by
 * the command hook from the RAW user arguments — this tool call can never
 * mint one, so takeover/abort/replan remain explicit human actions (§34).
 */
import { tool, type ToolContext } from "@opencode-ai/plugin";
import { isUltraPlanError } from "../core/errors.js";
import type { UltraPlanController } from "../core/controller.js";

export const ULTRA_PLAN_START_TOOL = "ultraplan_start";

export function createUltraPlanStartTool(controller: UltraPlanController) {
  return tool({
    description:
      "Start or resume the Ultra Plan planning run for the current session. " +
      "Only valid when the user explicitly invoked the /ultra-plan command — " +
      "each invocation consumes a one-shot admission recorded by the command hook. " +
      "Phase 7B: also the supervised-execution control entry — relay the user's " +
      "arguments exactly (resume / takeover / abort / replan); the host " +
      "verifies them against the raw command text. " +
      "Returns the deterministic Ultra Plan status block.",
    args: {
      goal: tool.schema.string().optional().describe(
        "High-level goal for the planning run. Only used when creating a new run.",
      ),
      resume: tool.schema.boolean().optional().describe(
        "The user typed `resume`: resume the session's supervised execution.",
      ),
      resumeExecutionRunID: tool.schema.string().optional().describe(
        "Exact ExecutionRun id (EXEC-###) for resume/takeover, when the user named one.",
      ),
      takeover: tool.schema.boolean().optional().describe(
        "The user explicitly typed `--takeover`: authorized cross-session takeover.",
      ),
      abort: tool.schema.boolean().optional().describe(
        "The user typed `abort EXEC-###`: explicit human abort of that exact run.",
      ),
      abortExecutionRunID: tool.schema.string().optional().describe(
        "Exact ExecutionRun id (EXEC-###) to abort.",
      ),
      replan: tool.schema.boolean().optional().describe(
        "The user typed `replan`: start a new PlanningRun from the ExecutionIssue.",
      ),
      replanExecutionRunID: tool.schema.string().optional().describe(
        "Exact ExecutionRun id (EXEC-###) whose issue seeds the replan, when the user named one.",
      ),
    },
    async execute(args, context: ToolContext) {
      // Reconstruct the typed command line from the relayed args; the HOST
      // (command hook) minted the matching authorizations from the raw user
      // text, so a relayed-but-never-typed control action fails closed.
      const raw = args.abort
        ? `abort ${args.abortExecutionRunID ?? ""}`.trim()
        : args.replan
          ? `replan ${args.replanExecutionRunID ?? ""}`.trim()
          : args.takeover
            ? `takeover ${args.resumeExecutionRunID ?? ""}`.trim()
            : args.resume
              ? `resume ${args.resumeExecutionRunID ?? ""}`.trim()
              : args.goal?.trim() ?? "";
      try {
        const result = await controller.enter(context.sessionID, raw);
        if (result.kind === "supervised") {
          const entry = result.entry;
          return {
            title: `Ultra Plan supervised execution [${entry.status}]`,
            output: entry.statusText,
            metadata: {
              ...("executionRunID" in entry ? { executionRunID: entry.executionRunID } : {}),
              ...("planningRunID" in entry ? { planningRunID: entry.planningRunID } : {}),
              ...("pump" in entry ? { pumpOutcome: entry.pump.outcome } : {}),
              status: entry.status,
            },
          };
        }
        return {
          title: `Ultra Plan ${result.run.id} ${result.created ? "created" : "resumed"}`,
          output: result.statusText,
          metadata: {
            planID: result.run.id,
            sessionID: context.sessionID,
            created: result.created,
            stage: result.run.stage,
            lifecycle: result.run.lifecycle,
            activation: result.activation,
            ...(result.handoff ? { handoff: result.handoff.status } : {}),
          },
        };
      } catch (error) {
        if (isUltraPlanError(error)) {
          return {
            title: `Ultra Plan ${error.code}`,
            output: `ERROR [${error.code}] ${error.message}`,
            metadata: { errorCode: error.code, ...(error.detail ? { detail: error.detail } : {}) },
          };
        }
        throw error;
      }
    },
  });
}
