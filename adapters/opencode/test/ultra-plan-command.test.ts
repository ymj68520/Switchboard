import { beforeEach, describe, expect, it } from "vitest";

import type { Config as OpenCodeConfig } from "@opencode-ai/plugin";

import { isUltraPlanError } from "../src/core/errors.js";
import { ApprovalIDs, PlanIDs, ProposalIDs } from "../src/core/ids.js";
import { renderStatus } from "../src/memory/renderer.js";
import {
  ULTRA_PLAN_START_TOOL,
  createUltraPlanHooks,
  createUltraPlanStartTool,
} from "../src/index.js";
import {
  DEFAULT_PLANNING_RUNTIME_SPEC,
  OpenCodeRuntimeAdapter,
  ULTRA_PLAN_COMMAND_TEMPLATE,
} from "../src/runtime/opencode-plugin.js";
import { getUltraPlanInstance, resetUltraPlanInstance } from "../src/runtime/instance.js";
import { evidence, fakeToolContext } from "./helpers.js";
import { EvidenceIDs } from "../src/core/ids.js";

// Each test gets a fresh in-memory instance (fresh PLAN-001).
beforeEach(() => {
  resetUltraPlanInstance();
});

describe("/ultra-plan vertical slice", () => {
  it("creates a PlanningRun through the registered tool", async () => {
    const hooks = createUltraPlanHooks();
    const startTool = hooks.tool?.[ULTRA_PLAN_START_TOOL];
    if (!startTool) throw new Error("ultraplan_start tool not registered");

    const result = await startTool.execute({ goal: "Build the Switchboard router" }, fakeToolContext("ses_tool"));
    if (typeof result === "string") throw new Error("expected structured tool result");

    expect(result.title).toBe("Ultra Plan PLAN-001 created");
    expect(result.output).toContain("Plan: PLAN-001");
    expect(result.output).toContain("Lifecycle: active");
    expect(result.output).toContain("Stage: discovery");
    expect(result.output).toContain("Session: ses_tool");
    expect(result.output).toContain("Architecture: not started");
    expect(result.output).toContain("Open blocking questions: 0");
    expect(result.metadata).toMatchObject({
      planID: "PLAN-001",
      created: true,
      stage: "discovery",
      lifecycle: "active",
    });

    const { store, controller } = getUltraPlanInstance();
    const run = await store.getRun(PlanIDs.from(1));
    expect(run?.sessionID).toBe("ses_tool");
    expect(await controller.statusOf("ses_tool")).toBe(result.output);
  });

  it("resumes the same run on repeated /ultra-plan invocation", async () => {
    const hooks = createUltraPlanHooks();
    const startTool = hooks.tool?.[ULTRA_PLAN_START_TOOL];
    if (!startTool) throw new Error("ultraplan_start tool not registered");
    const context = fakeToolContext("ses_repeat");

    const first = await startTool.execute({}, context);
    const second = await startTool.execute({}, context);
    if (typeof first === "string" || typeof second === "string") {
      throw new Error("expected structured tool results");
    }

    expect(first.metadata).toMatchObject({ planID: "PLAN-001", created: true });
    expect(second.metadata).toMatchObject({ planID: "PLAN-001", created: false });
    expect(second.title).toBe("Ultra Plan PLAN-001 resumed");
    expect(second.output).toBe(first.output);

    const { store } = getUltraPlanInstance();
    const eventTypes = (await store.listEvents(PlanIDs.from(1))).map((e) => e.detail.type);
    expect(eventTypes.filter((type) => type === "run.resumed")).toHaveLength(1);
  });

  it("registers /ultra-plan and the planning agent through the config hook", async () => {
    const hooks = createUltraPlanHooks();
    if (!hooks.config) throw new Error("config hook missing");

    const config: OpenCodeConfig = {};
    await hooks.config(config);

    const command = config.command?.["ultra-plan"];
    expect(command?.template).toBe(ULTRA_PLAN_COMMAND_TEMPLATE);
    expect(command?.agent).toBe("ultraplan");
    expect(command?.template).toContain("ultraplan_start");

    const agent = config.agent?.["ultraplan"];
    expect(agent?.mode).toBe("primary");
  });

  it("exposes verified runtime capabilities honestly", async () => {
    const { runtime } = getUltraPlanInstance();
    expect(runtime.capabilities.registerCommand).toBe(true);
    expect(runtime.capabilities.registerAgent).toBe(true);
    expect(runtime.capabilities.registerTools).toBe(true);
    expect(runtime.capabilities.dynamicModelSwitch).toBe(false);
    expect(runtime.capabilities.dynamicAgentSwitch).toBe(false);

    const activation = await runtime.activatePlanningRuntime({
      planID: PlanIDs.from(1),
      sessionID: "ses_runtime",
    });
    expect(activation.planID).toBe("PLAN-001");
    expect(activation.unsupported.join("\n")).toContain("dynamicModelSwitch");
    expect(activation.mechanism.join("\n")).toContain("ultra-plan");

    // When configured, the planning model lands in the command + agent binding.
    const adapter = new OpenCodeRuntimeAdapter({
      ...DEFAULT_PLANNING_RUNTIME_SPEC,
      planningModel: "anthropic/claude-opus-4-1",
    });
    const config: OpenCodeConfig = {};
    adapter.applyToConfig(config);
    expect(config.command?.["ultra-plan"]?.model).toBe("anthropic/claude-opus-4-1");
    expect(config.agent?.["ultraplan"]?.model).toBe("anthropic/claude-opus-4-1");
  });
});

describe("storage boundary hard edges", () => {
  it("refuses commitTransaction in Phase 1 (committed memory stays immutable)", async () => {
    const { store } = getUltraPlanInstance();
    await expect(
      store.commitTransaction({
        planID: PlanIDs.from(1),
        proposalID: ProposalIDs.cast("PROP-001"),
        approvalID: ApprovalIDs.cast("APPR-001"),
        parentCommit: null,
      }),
    ).rejects.toSatisfy((error: unknown) => isUltraPlanError(error) && error.code === "phase_boundary");
  });

  it("rejects overwriting an existing evidence revision", async () => {
    const { store } = getUltraPlanInstance();
    const planID = PlanIDs.from(1);
    const first = evidence({ id: EvidenceIDs.from(1) });
    await store.putEvidence(planID, first);

    const duplicate = evidence({ id: EvidenceIDs.from(1), claim: "attempted overwrite" });
    await expect(store.putEvidence(planID, duplicate)).rejects.toSatisfy(
      (error: unknown) => isUltraPlanError(error) && error.code === "duplicate_revision",
    );

    const listed = await store.listEvidence(planID);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.claim).toBe(first.claim);
  });

  it("renders deterministic status from structured state", async () => {
    const { store, controller } = getUltraPlanInstance();
    await controller.startOrResume("ses_render");
    const status = await controller.statusOf("ses_render");
    const run = await store.getRun(PlanIDs.from(1));
    expect(run).toBeDefined();
    expect(status).toBe(
      [
        "Ultra Plan",
        "",
        "Plan: PLAN-001",
        "Lifecycle: active",
        "Stage: discovery",
        "Session: ses_render",
        "",
        "Architecture: not started",
        "Sections: 0",
        "Open blocking questions: 0",
        "Blocking conflicts: 0",
      ].join("\n"),
    );
    expect(renderStatus(run as NonNullable<typeof run>)).toBe(status);
  });
});

describe("tool factory wiring", () => {
  it("binds the controller into the tool", async () => {
    const { controller } = getUltraPlanInstance();
    const tool = createUltraPlanStartTool(controller);
    expect(tool.description).toContain("one active PlanningRun");
    const result = await tool.execute({ goal: "Goal via factory" }, fakeToolContext("ses_factory"));
    if (typeof result === "string") throw new Error("expected structured tool result");
    expect(result.metadata).toMatchObject({ planID: "PLAN-001", created: true });
  });
});
