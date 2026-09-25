import { describe, expect, it } from "vitest";

import {
  FORWARD_STAGE_PATH,
  INITIAL_RUN_STATE,
  PLANNING_LIFECYCLES,
  PLANNING_RUN_EVENTS,
  PLANNING_STAGES,
  isLegalTransition,
  isPlanningRunEvent,
  isPlanningStage,
  isTerminalLifecycle,
  nextStage,
} from "../src/core/state-machine.js";

describe("planning vocabulary (E6/E7/E8)", () => {
  it("lifecycle values are exactly active/completed/aborted", () => {
    expect([...PLANNING_LIFECYCLES]).toEqual(["active", "completed", "aborted"]);
  });

  it("stage values are exactly the six frozen planning stages", () => {
    expect([...PLANNING_STAGES]).toEqual([
      "discovery",
      "architecture",
      "detail",
      "synthesis",
      "validation",
      "final",
    ]);
  });

  it("BUILD and handoff_pending are NOT planning stages", () => {
    expect(isPlanningStage("build")).toBe(false);
    expect(isPlanningStage("handoff_pending")).toBe(false);
    expect(isPlanningStage("BUILD")).toBe(false);
  });

  it("run events are the frozen declarative set", () => {
    expect([...PLANNING_RUN_EVENTS].sort()).toEqual(
      [
        "DISCOVERY_COMPLETE",
        "ARCHITECTURE_APPROVED",
        "DETAIL_COMPLETE",
        "SYNTHESIS_SUBMITTED",
        "REOPEN_DETAIL",
        "REOPEN_ARCHITECTURE",
        "VALIDATION_CLEAN",
      ].sort(),
    );
    expect(isPlanningRunEvent("setStage")).toBe(false);
  });

  it("initial state is deterministically active/discovery/revision 1 (E4/§13)", () => {
    expect(INITIAL_RUN_STATE).toEqual({ lifecycle: "active", stage: "discovery", revision: 1 });
  });
});

describe("frozen transition matrix (E12/E13/§18)", () => {
  it("walks the full forward path deterministically", () => {
    let stage = FORWARD_STAGE_PATH[0]!;
    const walk: string[] = [stage];
    const events = ["DISCOVERY_COMPLETE", "ARCHITECTURE_APPROVED", "DETAIL_COMPLETE", "SYNTHESIS_SUBMITTED", "VALIDATION_CLEAN"] as const;
    for (const event of events) {
      stage = nextStage(stage, event);
      walk.push(stage);
    }
    expect(walk).toEqual(["discovery", "architecture", "detail", "synthesis", "validation", "final"]);
  });

  it("supports reopen from synthesis, validation, and final (E13/§19)", () => {
    for (const stage of ["synthesis", "validation", "final"] as const) {
      expect(nextStage(stage, "REOPEN_DETAIL")).toBe("detail");
      expect(nextStage(stage, "REOPEN_ARCHITECTURE")).toBe("architecture");
    }
    // …but not from discovery/architecture themselves.
    expect(isLegalTransition("discovery", "REOPEN_DETAIL")).toBe(false);
    expect(isLegalTransition("architecture", "REOPEN_DETAIL")).toBe(false);
  });

  it("there is no final → completed stage transition (E10/§12)", () => {
    expect(isLegalTransition("final", "VALIDATION_CLEAN")).toBe(false);
    // No event leads to "completed" from any stage.
    for (const stage of PLANNING_STAGES) {
      for (const event of PLANNING_RUN_EVENTS) {
        if (isLegalTransition(stage, event)) {
          expect(nextStage(stage, event), `${stage}+${event}`).not.toBe("completed");
        }
      }
    }
  });
});

describe("invalid transitions fail closed (E14/§20)", () => {
  const invalid: [string, string][] = [
    ["discovery", "VALIDATION_CLEAN"],
    ["architecture", "DETAIL_COMPLETE"],
    ["final", "SYNTHESIS_SUBMITTED"],
    ["discovery", "ARCHITECTURE_APPROVED"],
    ["detail", "DISCOVERY_COMPLETE"],
    ["validation", "SYNTHESIS_SUBMITTED"],
    ["final", "ARCHITECTURE_APPROVED"],
  ];
  for (const [stage, event] of invalid) {
    it(`${stage} + ${event} → INVALID_RUN_TRANSITION`, () => {
      expect(() => nextStage(stage as never, event as never)).toThrowError(
        new Error(`INVALID_RUN_TRANSITION:${stage}+${event}`),
      );
      expect(isLegalTransition(stage as never, event as never)).toBe(false);
    });
  }
});

describe("purity and terminal helpers (§36)", () => {
  it("is a pure function of (stage, event)", () => {
    for (let i = 0; i < 3; i++) {
      expect(nextStage("discovery", "DISCOVERY_COMPLETE")).toBe("architecture");
      expect(nextStage("final", "REOPEN_ARCHITECTURE")).toBe("architecture");
    }
  });

  it("treats completed/aborted as terminal, active as not (E9)", () => {
    expect(isTerminalLifecycle("completed")).toBe(true);
    expect(isTerminalLifecycle("aborted")).toBe(true);
    expect(isTerminalLifecycle("active")).toBe(false);
  });
});
