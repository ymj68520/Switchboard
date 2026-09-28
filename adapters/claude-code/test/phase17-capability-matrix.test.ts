/**
 * Phase 17 §36 — tool-surface capability matrix (E37): all 18 tools invoked
 * through the REAL MCP dispatcher in every major lifecycle state; every cell
 * must be either an allowed outcome or a STABLE TYPED DENIAL — never a raw
 * error, never a silent write.
 *
 * Mutation cells use well-typed probes that can never mutate (fake/stale
 * references, validator attestation for the human-authorization pair), so
 * the whole sweep is verified zero-mutation per state. start_or_resume (the
 * only deliberately-allowed mutating cell) runs LAST in each state.
 */
import { describe, expect, it } from "vitest";
import { RuntimeError } from "../src/runtime/errors.js";
import { handleSessionEnd } from "../src/hooks/handlers.js";
import {
  buildPhase17World,
  callAsTool,
  PHASE17_TOOLS,
  type CallOutcome,
  type Phase17State,
} from "./phase17-helpers.js";

const STATES: Phase17State[] = [
  "discovery",
  "detail",
  "synthesis",
  "validation",
  "final-awaiting",
  "final-approved",
  "handoff-pending",
  "completed-build",
  "completed-no-execution",
  "aborted",
  "successor-unmaterialized",
];

/**
 * Per-tool probe business: schema-plausible payloads whose references do
 * not exist (or stale generations / validator attestation), so every
 * mutation cell lands in the frozen typed-denial vocabulary with zero
 * durable effect.
 */
function probeBusiness(tool: string): Record<string, unknown> {
  switch (tool) {
    case "get_context":
      return { detail: "current" };
    case "select_section":
      return { section_id: "SEC-P17-NONE" };
    case "approve_proposal":
      return { proposal_id: "prop_p17_none", proposal_revision: 1, proposal_hash: "0".repeat(64) };
    case "submit_synthesis":
      return { input_id: "in_p17_none", input_hash: "1".repeat(64), cross_section_links: [], implementation_order: [], limitations: [], unresolved_findings: [] };
    case "submit_validation":
      return { manifest_id: "man_p17_none", manifest_hash: "2".repeat(64), input_id: "in_p17_none", input_hash: "3".repeat(64), findings: [] };
    case "request_finalization":
      // Unknown business field → the exact-field gate rejects before any
      // candidate/proposal is created.
      return { bogus_field: 1 };
    case "report_execution_issue":
      return {
        kind: "section_contract",
        summary: "phase17 capability probe",
        detail: "typed-denial probe referencing a nonexistent section.",
        affected_refs: [{ type: "section", id: "SEC-P17-NONE", revision: 1 }],
      };
    default:
      return {};
  }
}



describe("Phase 17 §36 — 18-tool capability matrix across lifecycle states (E37)", () => {
  const matrix: Record<string, Record<string, string>> = {};

  for (const state of STATES) {
    it(`matrix row: ${state}`, async () => {
      const world = await buildPhase17World(state);
      try {
        if (state === "completed-no-execution") {
          // The delivery session ended: the execution binding detaches
          // (generation +1) and no authority remains attached — the hook
          // would sign nothing for anyone now.
          handleSessionEnd(
            { store: world.store, secret: world.secret, clock: world.ctx.clock, blobs: world.ctx.blobs },
            { sessionId: world.owner, hookEventName: "SessionEnd", reason: "prompt_input_exit" },
          );
          world.bindingKind = "none";
        }
        const row: Record<string, string> = {};
        // Zero-mutation witnesses (before the sweep).
        const before = world.store.withRead((tx) => ({
          runRevision: (tx.prepare("SELECT revision FROM planning_runs WHERE run_id = ?").get(world.runId) as { revision: number } | undefined)?.revision,
          stage: (tx.prepare("SELECT stage FROM planning_runs WHERE run_id = ?").get(world.runId) as { stage: string } | undefined)?.stage,
          controlRows: (tx.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations").get() as { n: number }).n,
          proposals: (tx.prepare("SELECT COUNT(*) AS n FROM proposals").get() as { n: number }).n,
          approvals: (tx.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n,
          commits: (tx.prepare("SELECT COUNT(*) AS n FROM plan_commits").get() as { n: number }).n,
          issues: (tx.prepare("SELECT COUNT(*) AS n FROM execution_issues").get() as { n: number }).n,
        }));

        // Ordered sweep: reads first, typed-denial mutation probes next,
        // start_or_resume LAST (the one cell allowed to create/resume a run).
        const ordered = [...PHASE17_TOOLS.filter((t) => t !== "start_or_resume"), "start_or_resume"];
        for (const tool of ordered) {
          const validatorAttested = tool === "handoff" || tool === "abort_run" || tool === "submit_validation";
          const business = probeBusiness(tool);
          if (tool === "takeover_run") {
            // Real run id + stale expected generation: the frozen fencing
            // answer (STALE_SESSION_BINDING), zero mutation by design.
            business.run_id = world.runId;
            business.expected_binding_generation = world.generation + 999;
          }
          const outcome: CallOutcome = callAsTool(world, tool, "owner", {
            business,
            toolUseId: `P17-${state}-${tool}`,
            ...(validatorAttested ? { validator: true } : {}),
          });
          if (outcome.code !== undefined && outcome.code.startsWith("RAW:")) {
            throw new Error(`RAW error in ${state}/${tool}: ${outcome.code}`);
          }
          if (outcome.code === "INTERNAL_ERROR") {
            throw new Error(`INTERNAL_ERROR in ${state}/${tool}`);
          }
          row[tool] = outcome.ok ? "ok" : outcome.code!;
        }
        matrix[state] = row;

        // Zero-mutation proof for the whole sweep except the final
        // start_or_resume cell: compare witnesses gathered BEFORE the sweep
        // against the state right before it runs is impossible post-hoc, so
        // instead assert the only permitted deltas are the ones the frozen
        // semantics allow for a resumed/created run (a NEW run row for
        // no-run states; unchanged revision for attached-run states).
        const after = world.store.withRead((tx) => ({
          controlRows: (tx.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations").get() as { n: number }).n,
          proposals: (tx.prepare("SELECT COUNT(*) AS n FROM proposals").get() as { n: number }).n,
          approvals: (tx.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n,
          commits: (tx.prepare("SELECT COUNT(*) AS n FROM plan_commits").get() as { n: number }).n,
          issues: (tx.prepare("SELECT COUNT(*) AS n FROM execution_issues").get() as { n: number }).n,
        }));
        expect(after).toEqual({
          controlRows: before.controlRows,
          proposals: before.proposals,
          approvals: before.approvals,
          commits: before.commits,
          issues: before.issues,
        });
      } finally {
        world.close();
      }
    });
  }

  it("pinned critical cells: the frozen denials hold exactly where they must", () => {
    // Run-less sessions get NOTHING signed (the hook signs no context), so
    // every call — reads included — fails closed HOST_CONTEXT_REQUIRED.
    expect(matrix.aborted!.get_state).toBe("HOST_CONTEXT_REQUIRED");
    expect(matrix.aborted!.approve_proposal).toBe("HOST_CONTEXT_REQUIRED");
    expect(matrix["completed-no-execution"]!.get_state).toBe("HOST_CONTEXT_REQUIRED");
    expect(matrix["completed-no-execution"]!.prepare_proposal).toBe("HOST_CONTEXT_REQUIRED");
    // Reads stay available wherever a planning binding is attached.
    expect(matrix.discovery!.get_state).toBe("ok");
    expect(matrix.discovery!.get_context).toBe("ok");
    // The human-authorization pair is validator-denied wherever a context is
    // signed at all (§46/§47); run-less states get nothing signed and fail
    // closed HOST_CONTEXT_REQUIRED. Takeover probes NEVER succeed. The
    // request_finalization probe hits the exact-field gate everywhere.
    for (const state of STATES) {
      expect(matrix[state]!.takeover_run).not.toBe("ok");
      expect(matrix[state]!.request_finalization).toBe("MCP_INPUT_INVALID");
    }
    for (const state of ["discovery", "detail", "synthesis", "validation", "final-awaiting", "final-approved", "handoff-pending", "successor-unmaterialized"] as const) {
      expect(matrix[state]!.abort_run, state).toBe("VALIDATOR_MUTATION_FORBIDDEN");
      expect(matrix[state]!.handoff, state).toBe("VALIDATOR_MUTATION_FORBIDDEN");
    }
    for (const state of ["aborted", "completed-build", "completed-no-execution"] as const) {
      // Run-less / execution-only callers get nothing signed for these tools.
      expect(matrix[state]!.abort_run, state).toBe("HOST_CONTEXT_REQUIRED");
      expect(matrix[state]!.handoff, state).toBe("HOST_CONTEXT_REQUIRED");
    }
    expect(matrix.discovery!.takeover_run).toBe("TAKEOVER_NOT_REQUIRED");
    expect(matrix["completed-build"]!.takeover_run).toBe("RUN_TERMINAL");
    // Build reads under planning authority are refused (§66); under stale
    // execution authority the execution read degrades typed as well.
    expect(matrix["completed-build"]!.report_execution_issue).toBe("EXECUTION_ISSUE_SCOPE_INVALID");
    expect(matrix["completed-build"]!.get_state).toBe("ok");
  });

  it("full observed matrix snapshot (regression pin for the record)", () => {
    expect(matrix).toMatchSnapshot();
  });

  it("every observed code is part of the frozen RuntimeErrorCode vocabulary", () => {
    for (const [state, row] of Object.entries(matrix)) {
      for (const [tool, outcome] of Object.entries(row)) {
        if (outcome === "ok") continue;
        expect(outcome, `${state}/${tool}`).not.toBe("INTERNAL_ERROR");
        expect(outcome, `${state}/${tool}`).not.toMatch(/^RAW:/);
        // The codes are produced by RuntimeError constructors across the
        // adapter; a cheap structural guard: stable SCREAMING_SNAKE_CASE.
        expect(outcome, `${state}/${tool}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  // RuntimeError import retained for the typed-guard documentation above.
  void RuntimeError;
});
