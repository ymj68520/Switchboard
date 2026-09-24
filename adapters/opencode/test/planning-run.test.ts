import { describe, expect, it } from "vitest";

import { UltraPlanController } from "../src/core/controller.js";
import { isUltraPlanError, UltraPlanError } from "../src/core/errors.js";
import {
  assertPlanningStage,
  canTransitionLifecycle,
  canTransitionStage,
  transitionLifecycle,
  transitionStage,
} from "../src/core/state-machine.js";
import { SectionIDs } from "../src/core/ids.js";
import type { PlanningRun } from "../src/core/types.js";
import { renderStatus } from "../src/memory/renderer.js";
import { admittedStart } from "./helpers.js";
import { InMemoryPlanStore } from "../src/memory/store.js";

function setup(): { store: InMemoryPlanStore; controller: UltraPlanController } {
  const store = new InMemoryPlanStore();
  const controller = new UltraPlanController({ store });
  return { store, controller };
}

/** Drive a fresh run through every stage to `final`, persisting on the way. */
async function runToFinal(store: InMemoryPlanStore, run: PlanningRun): Promise<PlanningRun> {
  let current = run;
  for (const stage of ["architecture", "detail", "synthesis", "final"] as const) {
    current = transitionStage(current, stage);
    current = await store.saveRun(current);
  }
  return current;
}

describe("PlanningRun creation", () => {
  it("creates a PlanningRun bound to the session, active and in discovery", async () => {
    const { store, controller } = setup();

    const result = await admittedStart(controller, "ses_a", "Build a model router");

    expect(result.created).toBe(true);
    expect(result.run.id).toBe("PLAN-001");
    expect(result.run.sessionID).toBe("ses_a");
    expect(result.run.lifecycle).toBe("active");
    expect(result.run.stage).toBe("discovery");
    expect(result.run.goal).toEqual({ statement: "Build a model router" });
    expect(result.run.headCommit).toBeUndefined();
    expect(result.statusText).toContain("Plan: PLAN-001");

    const stored = await store.getRun(result.run.id);
    expect(stored).toBeDefined();
    expect(stored?.stage).toBe("discovery");

    const eventTypes = (await store.listEvents(result.run.id)).map((e) => e.detail.type);
    expect(eventTypes).toContain("run.created");
  });

  it("assigns monotonically increasing plan ids across sessions", async () => {
    const { controller } = setup();
    const first = await admittedStart(controller, "ses_a");
    const second = await admittedStart(controller, "ses_b");
    expect(first.run.id).toBe("PLAN-001");
    expect(second.run.id).toBe("PLAN-002");
  });
});

describe("one active run per session", () => {
  it("prevents a second active PlanningRun for the same session (store-level)", async () => {
    const { store, controller } = setup();
    await admittedStart(controller, "ses_a");

    const duplicate: PlanningRun = {
      id: "PLAN-002" as PlanningRun["id"],
      sessionID: "ses_a",
      lifecycle: "active",
      stage: "discovery",
      revision: 1,
      goal: { statement: "" },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    };

    await expect(store.createRun(duplicate)).rejects.toSatisfy((error: unknown) => {
      return isUltraPlanError(error) && error.code === "multiple_active_runs";
    });
  });

  it("resumes the existing active run instead of creating another (controller-level)", async () => {
    const { controller } = setup();
    const first = await admittedStart(controller, "ses_a");
    const second = await admittedStart(controller, "ses_a", "a changed goal must not apply");

    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    // Resuming reports the existing run; it does not overwrite its goal.
    expect(second.run.goal).toEqual(first.run.goal);
  });

  it("allows a new run only after the previous run completed", async () => {
    const { store, controller } = setup();
    const started = await admittedStart(controller, "ses_a");

    // Completed (and aborted) runs are terminal; the session is free again.
    let run = await runToFinal(store, started.run);
    expect(canTransitionLifecycle("active", "handoff_pending")).toBe(true);
    run = transitionLifecycle(run, "handoff_pending");
    run = await store.saveRun(run);
    run = transitionLifecycle(run, "completed");
    await store.saveRun(run);

    expect(await store.findActiveRunBySession("ses_a")).toBeUndefined();

    const again = await admittedStart(controller, "ses_a");
    expect(again.created).toBe(true);
    expect(again.run.id).toBe("PLAN-002");
  });
});

describe("stage transitions", () => {
  it("walks the frozen stage graph and persists revision bumps", async () => {
    const { store, controller } = setup();
    const started = await admittedStart(controller, "ses_a");

    let run = started.run;
    for (const stage of ["architecture", "detail", "synthesis", "final"] as const) {
      expect(canTransitionStage(run.stage, stage)).toBe(true);
      run = transitionStage(run, stage);
      run = await store.saveRun(run);
    }
    expect(run.stage).toBe("final");
    expect(run.revision).toBe(started.run.revision + 4);

    const stageChanges = (await store.listEvents(run.id))
      .map((event) => event.detail)
      .filter((detail) => detail.type === "run.stage_changed");
    expect(stageChanges).toHaveLength(4); // one per persisted stage move
    expect(stageChanges[3]).toEqual({
      type: "run.stage_changed",
      from: "synthesis",
      to: "final",
    });
  });

  it("rejects transitions outside the frozen stage graph", () => {
    expect(canTransitionStage("discovery", "final")).toBe(false);
    expect(canTransitionStage("synthesis", "architecture")).toBe(false);
    expect(canTransitionStage("final", "discovery")).toBe(false);

    const run: PlanningRun = {
      id: "PLAN-001" as PlanningRun["id"],
      sessionID: "ses_a",
      lifecycle: "active",
      stage: "discovery",
      revision: 1,
      goal: { statement: "" },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    };
    expect(() => transitionStage(run, "synthesis")).toThrowError(UltraPlanError);
    try {
      transitionStage(run, "synthesis");
    } catch (error) {
      expect(isUltraPlanError(error) && error.code).toBe("invalid_stage_transition");
    }
  });

  it("does not recognize execution as a planning stage", () => {
    expect(() => assertPlanningStage("execution")).toThrowError(/not a planning stage/);
    expect(() => assertPlanningStage("discovery")).not.toThrow();
  });
});

describe("lifecycle transitions", () => {
  it("enters handoff_pending only from the final stage and then completes", async () => {
    const { store, controller } = setup();
    const started = await admittedStart(controller, "ses_a");
    const final = await runToFinal(store, started.run);

    // Not allowed before final:
    expect(() => transitionLifecycle(started.run, "handoff_pending")).toThrowError(UltraPlanError);

    let run = transitionLifecycle(final, "handoff_pending");
    run = await store.saveRun(run);
    expect(run.lifecycle).toBe("handoff_pending");

    run = transitionLifecycle(run, "completed");
    run = await store.saveRun(run);
    expect(run.lifecycle).toBe("completed");
  });

  it("treats completed and aborted as terminal", () => {
    expect(canTransitionLifecycle("completed", "active")).toBe(false);
    expect(canTransitionLifecycle("completed", "handoff_pending")).toBe(false);
    expect(canTransitionLifecycle("aborted", "active")).toBe(false);
    expect(() => transitionLifecycle({ lifecycle: "completed" } as PlanningRun, "active")).toThrowError(
      UltraPlanError,
    );
  });

  it("renders lifecycle and stage from structured state", async () => {
    const { controller } = setup();
    const started = await admittedStart(controller, "ses_golden");

    const expected = [
      "Ultra Plan",
      "",
      "Plan: PLAN-001",
      "Lifecycle: active",
      "Stage: discovery",
      "Session: ses_golden",
      "",
      "Architecture: not started",
      "Sections: 0",
      "Open blocking questions: 0",
      "Blocking conflicts: 0",
    ].join("\n");
    expect(started.statusText).toBe(expected);
    expect(await controller.statusOf("ses_golden")).toBe(expected);
    expect(await controller.statusOf("ses_missing")).toBeNull();

    // Render depends on state, not on prose: section counts come from the run.
    const run = {
      ...started.run,
      sections: [{ id: SectionIDs.from(1) }, { id: SectionIDs.from(2) }],
    };
    expect(renderStatus(run)).toContain("Sections: 2 (0 approved)");
  });
});
