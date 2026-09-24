/**
 * The `ultraplan_start` tool — the deterministic workhorse behind /ultra-plan.
 *
 * OpenCode command templates are prompts; the plugin-registered tool is what
 * actually executes. The /ultra-plan command template directs the planning
 * agent to invoke this tool, which drives
 * OpenCode → /ultra-plan → Controller → PlanningRun → Store end to end and
 * returns the deterministic status block.
 */
import { tool, type ToolContext } from "@opencode-ai/plugin";
import type { UltraPlanController } from "../core/controller.js";

export const ULTRA_PLAN_START_TOOL = "ultraplan_start";

export function createUltraPlanStartTool(controller: UltraPlanController) {
  return tool({
    description:
      "Start or resume the Ultra Plan planning run for the current session. " +
      "Creates exactly one active PlanningRun per session (resume on repeat calls) " +
      "and returns the deterministic Ultra Plan status block.",
    args: {
      goal: tool.schema.string().optional().describe(
        "High-level goal for the planning run. Only used when creating a new run.",
      ),
    },
    async execute(args, context: ToolContext) {
      const result = await controller.startOrResume(context.sessionID, args.goal?.trim() || undefined);
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
        },
      };
    },
  });
}
