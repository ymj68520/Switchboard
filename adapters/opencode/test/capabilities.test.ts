import { describe, expect, it } from "vitest";

import {
  getCapabilities,
  requireRun,
  ULTRA_PLAN_CAPABILITIES,
  type UltraPlanCapability,
} from "../src/core/capabilities.js";
import { isUltraPlanError } from "../src/core/errors.js";
import type { PlanningLifecycle, PlanningRun, PlanningStage } from "../src/core/types.js";

function syntheticRun(lifecycle: PlanningLifecycle, stage: PlanningStage): PlanningRun {
  return {
    id: "PLAN-000" as PlanningRun["id"],
    sessionID: "ses_synthetic",
    lifecycle,
    stage,
    revision: 0,
    goal: { statement: "" },
    constraints: [],
    sections: [],
    decisions: [],
    openQuestions: [],
    conflicts: [],
    createdAt: "",
    updatedAt: "",
  };
}

const MUTATING: readonly UltraPlanCapability[] = [
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "promote_evidence",
  "prepare_proposal",
  "request_reopen",
  "request_completion",
  "request_synthesis",
];

const DISCOVERY: UltraPlanCapability[] = [
  "start_or_resume",
  "read_status",
  "read_memory",
  "record_question",
  "propose_question_resolution",
  "promote_evidence",
];
const ARCHITECTURE: UltraPlanCapability[] = [
  ...DISCOVERY,
  "raise_conflict",
  "prepare_proposal",
  "request_user_approval",
];
const DETAIL: UltraPlanCapability[] = [
  ...ARCHITECTURE,
  "request_completion",
  "request_reopen",
];
const SYNTHESIS: UltraPlanCapability[] = [
  "start_or_resume",
  "read_status",
  "read_memory",
  "record_question",
  "propose_question_resolution",
  "raise_conflict",
  "request_reopen",
  "request_synthesis",
];
const FINAL: UltraPlanCapability[] = ["start_or_resume", "read_status", "read_memory"];

/**
 * The documented protocol matrix
 * (docs/opencode/spec/opencode-ultra-plan-agent-protocol.md §4), as a literal.
 * If this test fails, code and protocol document have diverged — fix BOTH or
 * neither.
 */
const DOCUMENTED_MATRIX: Record<PlanningStage, UltraPlanCapability[]> = {
  discovery: DISCOVERY,
  architecture: ARCHITECTURE,
  detail: DETAIL,
  synthesis: SYNTHESIS,
  final: FINAL,
};

describe("capability matrix", () => {
  it("grants exactly the documented capability set in every active stage", () => {
    for (const stage of Object.keys(DOCUMENTED_MATRIX) as PlanningStage[]) {
      const capabilities = getCapabilities(syntheticRun("active", stage));
      expect([...capabilities].sort(), `stage=${stage}`).toEqual(
        DOCUMENTED_MATRIX[stage].slice().sort(),
      );
    }
  });

  it("exposes no planning mutation capability for completed and aborted runs", () => {
    for (const lifecycle of ["completed", "aborted"] as const) {
      const capabilities = getCapabilities(syntheticRun(lifecycle, "final"));
      for (const capability of MUTATING) {
        expect(capabilities.has(capability), `${lifecycle}/${capability}`).toBe(false);
      }
      // Reads remain available for post-run inspection (spec §34).
      expect(capabilities.has("read_status")).toBe(true);
      expect(capabilities.has("read_memory")).toBe(true);
    }
  });

  it("exposes only handoff-safe capabilities during handoff_pending", () => {
    const capabilities = getCapabilities(syntheticRun("handoff_pending", "final"));
    expect([...capabilities].sort()).toEqual(["read_memory", "read_status"]);
    for (const capability of MUTATING) {
      expect(capabilities.has(capability)).toBe(false);
    }
  });

  it("grants only start_or_resume + status reporting when no run exists", () => {
    const capabilities = getCapabilities(undefined);
    expect([...capabilities].sort()).toEqual(["read_status", "start_or_resume"]);
    expect(capabilities.has("read_memory")).toBe(false);
  });

  it("names every declared capability in the frozen capability list", () => {
    const granted = new Set<UltraPlanCapability>();
    for (const capability of getCapabilities(undefined)) granted.add(capability);
    for (const stage of Object.keys(DOCUMENTED_MATRIX) as PlanningStage[]) {
      for (const capability of getCapabilities(syntheticRun("active", stage))) {
        granted.add(capability);
      }
    }
    for (const capability of getCapabilities(syntheticRun("handoff_pending", "final"))) {
      granted.add(capability);
    }
    expect([...granted].sort()).toEqual([...ULTRA_PLAN_CAPABILITIES].sort());
  });
});

describe("lifecycle restrictions", () => {
  it("refuses run-requiring capabilities on completed runs via requireRun", async () => {
    const completed = syntheticRun("completed", "final");
    for (const capability of MUTATING) {
      try {
        requireRun(completed, capability);
        expect.unreachable(`${capability} should have been refused`);
      } catch (error) {
        expect(isUltraPlanError(error) && error.code).toBe("capability_not_available");
      }
    }
  });

  it("refuses run-requiring capabilities when no run exists with no_active_run", () => {
    try {
      requireRun(undefined, "prepare_proposal");
      expect.unreachable("should have been refused");
    } catch (error) {
      expect(isUltraPlanError(error) && error.code).toBe("no_active_run");
    }
  });
});
