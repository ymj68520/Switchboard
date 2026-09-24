/**
 * L0 Planning Protocol — the deterministic protocol fragment injected into
 * planning-model context (frozen architecture §14 L0, Phase 2A brief §11).
 *
 * Rendered from static structured configuration plus the current capability
 * set. Never model-generated. Compact by design; token budgeting and the full
 * L1-L5 assembly are later phases.
 */
import { ULTRA_PLAN_CAPABILITIES, getCapabilities, type UltraPlanCapability } from "../core/capabilities.js";
import type { PlanningRun } from "../core/types.js";

const RULES: readonly string[] = [
  "You are operating inside the Ultra Plan planning harness for OpenCode.",
  "OpenCode owns the conversation, session, model inference, repository tools, and execution. Ultra Plan owns planning workflow, committed planning state, approvals, context construction, and repository evidence.",
  "COMMITTED MEMORY is authoritative and versioned. Your working discussion is NOT committed memory.",
  "Approved revisions are immutable. Changing approved design requires a reopen/amendment through a proposal.",
  "Only an explicit USER approval can authorize a Proposal. You can never approve your own work.",
  "Only the Harness transaction engine can commit a Proposal into committed memory. There is no tool for that.",
  "Your available operations are capability-limited to the current run state (listed below). Calling an unauthorized operation fails deterministically.",
  "Repository claims must be grounded: promote observations you actually made into Evidence; direct evidence requires source provenance.",
  "During synthesis you may only project and organize approved design; you may not introduce new unapproved architectural facts.",
  "Final handoff to execution is Harness-controlled and requires explicit Final Plan approval. You can never trigger it.",
];

function describeCapabilities(capabilities: ReadonlySet<UltraPlanCapability>): string {
  const lines = ["Available operations in the current state:"];
  for (const capability of ULTRA_PLAN_CAPABILITIES) {
    lines.push(`- [${capabilities.has(capability) ? "x" : " "}] ${capability}`);
  }
  return lines.join("\n");
}

export interface PlanningProtocolInput {
  run: PlanningRun | undefined;
}

export function renderPlanningProtocol(input: PlanningProtocolInput): string {
  const capabilities = getCapabilities(input.run);
  const state = input.run
    ? `Current run: ${input.run.id} (lifecycle=${input.run.lifecycle}, stage=${input.run.stage})`
    : "No active planning run in this session.";

  return [
    "=== ULTRA PLAN PROTOCOL (L0) ===",
    ...RULES.map((rule, index) => `${index + 1}. ${rule}`),
    "",
    state,
    "",
    describeCapabilities(capabilities),
    "=== END ULTRA PLAN PROTOCOL ===",
  ].join("\n");
}
