import { describe, expect, it } from "vitest";

import type { Config as OpenCodeConfig, ToolDefinition } from "@opencode-ai/plugin";

import {
  UltraPlanController,
  createUltraPlanHooks,
  createUltraPlanTools,
  FORBIDDEN_TOOL_NAMES,
  getUltraPlanInstance,
  InMemoryObservationLedger,
  InMemoryPlanStore,
  isUltraPlanError,
  OpenCodeRuntimeAdapter,
  DEFAULT_PLANNING_RUNTIME_SPEC,
  ApprovalIDs,
  PlanIDs,
  ProposalIDs,
  renderPlanningProtocol,
  resetUltraPlanInstance,
  ObservationIDs,
  TOOL_CONTRACTS,
  ULTRA_PLAN_START_TOOL,
} from "../src/index.js";
import type { PlanningRun, PlanningStage, PreparedChange } from "../src/index.js";
import { computeProposalHash } from "../src/transaction/hash.js";
import { transitionStage } from "../src/core/state-machine.js";
import { admittedStart, fakeToolContext } from "./helpers.js";

function setup(): {
  store: InMemoryPlanStore;
  ledger: InMemoryObservationLedger;
  controller: UltraPlanController;
} {
  const store = new InMemoryPlanStore();
  const ledger = new InMemoryObservationLedger();
  const controller = new UltraPlanController({ store, ledger });
  return { store, ledger, controller };
}

function structuredTool(tools: Record<string, ToolDefinition>, name: string): ToolDefinition {
  const tool = tools[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

type StructuredResult = Extract<Awaited<ReturnType<ToolDefinition["execute"]>>, { metadata?: unknown }>;

async function invoke(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  sessionID: string,
): Promise<StructuredResult> {
  const result = await tool.execute(args, fakeToolContext(sessionID));
  if (typeof result === "string") throw new Error("expected structured tool result");
  return result;
}

/** Create a run and walk it to the requested stage (persisting transitions). */
async function runInStage(
  store: InMemoryPlanStore,
  controller: UltraPlanController,
  sessionID: string,
  target: PlanningStage,
): Promise<PlanningRun> {
  let run = (await admittedStart(controller, sessionID)).run;
  const order: PlanningStage[] = ["discovery", "architecture", "detail", "synthesis", "final"];
  for (const stage of order.slice(1, order.indexOf(target) + 1)) {
    run = transitionStage(run, stage);
    run = await store.saveRun(run);
  }
  return run;
}

describe("tool contract registry", () => {
  it("registers exactly the contracted tools, none of them forbidden", () => {
    const { controller } = setup();
    const tools = createUltraPlanTools(controller);
    expect(Object.keys(tools).sort()).toEqual(Object.keys(TOOL_CONTRACTS).sort());

    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      expect(tools[forbidden], forbidden).toBeUndefined();
    }
  });

  it("gives no model-visible tool committed-memory mutation power (tests 5/6/7)", () => {
    for (const contract of Object.values(TOOL_CONTRACTS)) {
      expect(contract.mutatesCommittedMemory, contract.name).toBe(false);
      expect(contract.authority).not.toBe("approval");
      expect(contract.authority).not.toBe("commit");
    }
    // Read tools are classified as reads.
    expect(TOOL_CONTRACTS["plan_memory"]?.authority).toBe("read");
    expect(TOOL_CONTRACTS["ultraplan_status"]?.authority).toBe("read");
    // No approval/commit authority class exists at all.
    expect(Object.values(TOOL_CONTRACTS).map((c) => c.authority)).toEqual(
      expect.not.arrayContaining(["approval" as never]),
    );
  });

  it("refuses commitTransaction for an unknown proposal (engine exists; nothing else changed)", async () => {
    const { store } = setup();
    await expect(
      store.commitTransaction({
        planID: PlanIDs.from(1),
        proposalID: ProposalIDs.cast("PROP-001"),
        approvalID: ApprovalIDs.cast("APPR-001"),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isUltraPlanError(error) && error.code === "run_not_found",
    );
  });
});

describe("controller-side authorization (test 8)", () => {
  it("fails invalid-stage invocations deterministically even when called directly", async () => {
    const { store, controller } = setup();
    await runInStage(store, controller, "ses_gate", "synthesis");

    // promote_evidence is not granted in synthesis.
    await expect(
      controller.promoteEvidence("ses_gate", {
        claim: "x",
        kind: "file",
        scopeType: "run",
        criticality: "supporting",
        confidence: "uncertain",
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");

    // request_synthesis is only granted in synthesis — here it IS synthesis,
    // so the gate passes and the deterministic finalization failures surface.
    await expect(controller.requestSynthesis("ses_gate")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "finalization_blocked",
    );

    // From a discovery run, request_synthesis is capability-blocked.
    await runInStage(store, controller, "ses_gate2", "discovery");
    await expect(controller.requestSynthesis("ses_gate2")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available",
    );
  });

  it("refuses working-state operations before /ultra-plan with no_active_run", async () => {
    const { controller } = setup();
    await expect(
      controller.recordQuestion("ses_none", {
        question: "Q?",
        blocking: false,
        scope: { type: "architecture" },
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "no_active_run");
  });
});

describe("working-state operations", () => {
  it("records questions and proposes candidate resolutions WITHOUT clearing blockers (Correction A)", async () => {
    const { store, controller } = setup();
    await admittedStart(controller, "ses_q");

    const question = await controller.recordQuestion("ses_q", {
      question: "Which storage backend?",
      blocking: true,
      scope: { type: "architecture" },
    });
    expect(question.id).toBe("Q-001");

    const proposed = await controller.proposeQuestionResolution("ses_q", {
      questionID: "Q-001",
      resolution: "use plugin-owned storage",
    });
    expect(proposed.status).toBe("open"); // still open — Correction A
    expect(proposed.proposedResolution?.text).toBe("use plugin-owned storage");

    const run = await store.findActiveRunBySession("ses_q");
    expect(run?.openQuestions).toHaveLength(1);
    expect(run?.openQuestions[0]?.status).toBe("open");
    expect(run?.openQuestions[0]?.blocking).toBe(true);
    expect(run?.openQuestions[0]?.resolution).toBeUndefined();
    // Run header working state changed but no commit-gated field moved.
    expect(run?.headSnapshot).toBe("SNAP-001");
  });

  it("validates question scope against the run", async () => {
    const { controller } = setup();
    await admittedStart(controller, "ses_scope");
    await expect(
      controller.recordQuestion("ses_scope", {
        question: "Q?",
        blocking: false,
        scope: { type: "section", sectionID: "SEC-099" },
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("raises conflicts with resolving refs", async () => {
    const { store, controller } = setup();
    // raise_conflict requires architecture stage or later (protocol matrix).
    await runInStage(store, controller, "ses_conflict", "architecture");

    const conflict = await controller.raiseConflict("ses_conflict", {
      type: "decision",
      description: "Two statements contradict",
      severity: "blocking",
      refs: [],
    });
    expect(conflict.id).toBe("CONF-001");

    await expect(
      controller.raiseConflict("ses_conflict", {
        type: "section",
        description: "references an unknown section",
        severity: "warning",
        refs: [{ kind: "section", id: "SEC-001" }],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });
});

describe("read-only memory boundary (tests 5/11)", () => {
  it("never mutates state on reads", async () => {
    const { store, controller } = setup();
    await admittedStart(controller, "ses_read");
    const before = await store.findActiveRunBySession("ses_read");

    await controller.readMemory("ses_read", {});
    await controller.readMemory("ses_read", { ref: { kind: "question", id: "Q-404" } }).catch(() => {});

    const after = await store.findActiveRunBySession("ses_read");
    expect(after?.revision).toBe(before?.revision);
    expect(await store.listEvidence(PlanIDs.from(1))).toHaveLength(0);
    // No runtime bound in this setup → no runtime.activated event.
    expect((await store.listEvents((after as PlanningRun).id)).map((e) => e.detail.type)).toEqual([
      "run.created",
      "status.reported",
    ]);
  });

  it("keeps exact revision semantics — never resolves to latest (test 11)", async () => {
    const { controller } = setup();
    await admittedStart(controller, "ses_exact");

    // Decisions require an exact revision.
    await expect(
      controller.readMemory("ses_exact", { ref: { kind: "decision", id: "DEC-001" } }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");

    // A missing explicit revision is unknown_reference, not a latest-fallback.
    await expect(
      controller.readMemory("ses_exact", { ref: { kind: "architecture", revision: 3 } }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");

    await expect(
      controller.readMemory("ses_exact", { ref: { kind: "section", id: "SEC-001", revision: 7 } }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");

    // Unknown question refs are deterministic misses too.
    await expect(
      controller.readMemory("ses_exact", { ref: { kind: "question", id: "Q-404" } }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");

    // Run-level default read returns the run summary + HEAD snapshot.
    const result = await controller.readMemory("ses_exact", {});
    expect(result.headSnapshot).toBe("SNAP-001");
    expect(result.artifacts[0]?.ref).toEqual({ kind: "run" });
  });
});

describe("evidence promotion boundary (tests 12/13)", () => {
  it("rejects direct evidence without observation provenance", async () => {
    const { controller } = setup();
    await admittedStart(controller, "ses_evd");

    await expect(
      controller.promoteEvidence("ses_evd", {
        claim: "Session exposes switchModel()",
        kind: "symbol",
        scopeType: "run",
        criticality: "critical",
        confidence: "direct",
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "missing_provenance");

    await expect(
      controller.promoteEvidence("ses_evd", {
        claim: "Session exposes switchModel()",
        kind: "symbol",
        scopeType: "run",
        criticality: "critical",
        confidence: "direct",
        observationIDs: ["OBS-999"],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });

  it("promotes real observations into provenance-backed evidence", async () => {
    const { ledger, store, controller } = setup();
    await admittedStart(controller, "ses_evd2");
    await ledger.append("ses_evd2", {
      id: ObservationIDs.cast("OBS-001"),
      tool: "read",
      source: { kind: "file", path: "src/session.ts", range: { startLine: 10, endLine: 20 } },
      observedAt: "2026-09-24T00:00:00.000Z",
    });

    const evidence = await controller.promoteEvidence("ses_evd2", {
      claim: "Session exposes switchModel()",
      kind: "symbol",
      scopeType: "run",
      criticality: "critical",
      confidence: "direct",
      observationIDs: ["OBS-001"],
    });
    expect(evidence.id).toBe("EVD-001");
    expect(evidence.freshness).toBe("fresh");
    expect(evidence.source[0]).toMatchObject({ type: "file", path: "src/session.ts" });

    const stored = await store.listEvidence(PlanIDs.from(1));
    expect(stored).toHaveLength(1);
  });

  it("requires upstream refs for derived evidence and degrades freshness", async () => {
    const { ledger, controller } = setup();
    await admittedStart(controller, "ses_evd3");
    await ledger.append("ses_evd3", {
      id: ObservationIDs.cast("OBS-001"),
      tool: "read",
      observedAt: "2026-09-24T00:00:00.000Z",
    });
    await controller.promoteEvidence("ses_evd3", {
      claim: "base claim",
      kind: "file",
      scopeType: "run",
      criticality: "supporting",
      confidence: "direct",
      observationIDs: ["OBS-001"],
    });

    await expect(
      controller.promoteEvidence("ses_evd3", {
        claim: "derived claim",
        kind: "behavior",
        scopeType: "run",
        criticality: "supporting",
        confidence: "derived",
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "missing_provenance");

    const derived = await controller.promoteEvidence("ses_evd3", {
      claim: "derived claim",
      kind: "behavior",
      scopeType: "run",
      criticality: "supporting",
      confidence: "derived",
      derivedFrom: [{ id: "EVD-001" }],
    });
    expect(derived.freshness).toBe("fresh");

    // Uncertain evidence can never claim freshness.
    const uncertain = await controller.promoteEvidence("ses_evd3", {
      claim: "speculative claim",
      kind: "behavior",
      scopeType: "run",
      criticality: "critical",
      confidence: "uncertain",
    });
    expect(uncertain.freshness).toBe("needs_validation");
  });
});

describe("proposal intent boundary (tests 9/10)", () => {
  it("binds proposals to the active run, HEAD snapshot, and validated scope", async () => {
    const { store, controller } = setup();
    await runInStage(store, controller, "ses_prop", "architecture");

    const prepared = await controller.prepareProposal("ses_prop", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Persistence model",
      summary: "Plugin storage is canonical state",
      changes: [
        {
          kind: "add_decision",
          content: {
            decision: {
              title: "Canonical state",
              statement: "Plugin storage is canonical",
              rationale: "compaction independence",
            },
          },
        },
      ],
    });
    expect(prepared.proposal.id).toBe("PROP-001");
    expect(prepared.proposal.status).toBe("ready");
    expect(prepared.proposal.createdFrom.id).toBe("SNAP-001");
    expect(prepared.proposal.scope).toEqual({ id: "ARCH", revision: 1 });
    expect(prepared.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.proposal.hash).toBe(prepared.hash);

    // Scope validation: unknown section.
    await expect(
      controller.prepareProposal("ses_prop", {
        type: "design_checkpoint",
        scope: { type: "section", sectionID: "SEC-099" },
        title: "bad scope",
        summary: "s",
        changes: [{ kind: "complete_section" }],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("rejects unsupported change kinds and scope/type mismatches", async () => {
    const { store, controller } = setup();
    // detail stage: design_checkpoint AND section_completion are legal types here.
    await runInStage(store, controller, "ses_prop2", "detail");

    // Simulate hostile wire input that bypassed the tool schema: the
    // controller guard must still reject kinds outside the closed vocabulary.
    const hostile = { kind: "set_stage", content: { stage: "final" } } as unknown as PreparedChange;
    await expect(
      controller.prepareProposal("ses_prop2", {
        type: "design_checkpoint",
        scope: { type: "architecture" },
        title: "t",
        summary: "s",
        changes: [hostile],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "proposal_kind_unsupported");

    await expect(
      controller.prepareProposal("ses_prop2", {
        type: "section_completion",
        scope: { type: "architecture" },
        title: "t",
        summary: "s",
        changes: [{ kind: "complete_architecture" }],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("freezes proposals: content-addressed hash, immutable at the boundary (test 10)", async () => {
    const { store, controller } = setup();
    await runInStage(store, controller, "ses_freeze", "architecture");

    const prepared = await controller.prepareProposal("ses_freeze", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "freeze me",
      summary: "s",
      changes: [
        {
          kind: "add_decision",
          content: {
            decision: {
              title: "Freeze decision",
              statement: "Frozen content",
              rationale: "r",
            },
          },
        },
      ],
    });

    // Same content → same hash; content change → different hash.
    const withoutHash = { ...prepared.proposal, hash: undefined };
    expect(computeProposalHash(withoutHash)).toBe(prepared.hash);
    expect(computeProposalHash({ ...withoutHash, title: "changed" })).not.toBe(prepared.hash);

    // The id can never be reused with different content.
    await expect(
      store.saveProposal(PlanIDs.from(1), {
        ...prepared.proposal,
        title: "rewritten after approval",
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "proposal_immutable");
  });
});

describe("synthesis gate", () => {
  it("fails deterministically with the finalization failures while the plan is incomplete", async () => {
    const { store, controller } = setup();
    await runInStage(store, controller, "ses_syn", "synthesis");

    await expect(controller.requestSynthesis("ses_syn")).rejects.toSatisfy(
      (error: unknown) =>
        isUltraPlanError(error) &&
        error.code === "finalization_blocked" &&
        Array.isArray(error.detail?.failures) &&
        (error.detail?.failures as string[]).includes("architecture_not_approved"),
    );
  });
});

describe("tool surface wiring (tests 14/15/16)", () => {
  it("still creates and resumes exactly one active run via the tool surface (test 15)", async () => {
    const { store, controller } = setup();
    const tools = createUltraPlanTools(controller);
    const start = structuredTool(tools, ULTRA_PLAN_START_TOOL);

    controller.issueStartAdmission("ses_slice"); // first /ultra-plan invocation
    const first = await invoke(start, { goal: "Plan the router" }, "ses_slice");
    controller.issueStartAdmission("ses_slice"); // second /ultra-plan invocation
    const second = await invoke(start, {}, "ses_slice");
    expect(first.metadata).toMatchObject({ created: true, planID: "PLAN-001" });
    expect(second.metadata).toMatchObject({ created: false, planID: "PLAN-001" });
    expect(await store.findActiveRunBySession("ses_slice")).toBeDefined();
  });

  it("reports deterministic status including the no-run case", async () => {
    const { controller } = setup();
    const tools = createUltraPlanTools(controller);
    const status = structuredTool(tools, "ultraplan_status");

    const empty = await invoke(status, {}, "ses_ghost");
    expect(empty.output).toContain("No PlanningRun for session ses_ghost");

    await admittedStart(controller, "ses_status");
    const report = await invoke(status, {}, "ses_status");
    expect(report.output).toContain("Lifecycle: active");
    expect(report.output).toContain("Stage: discovery");
  });

  it("renders the L0 planning protocol deterministically (test 14)", async () => {
    const { controller } = setup();
    await admittedStart(controller, "ses_proto");

    const run = (await controller.planStore.findActiveRunBySession("ses_proto")) as PlanningRun;
    const protocol = renderPlanningProtocol({ run });
    expect(renderPlanningProtocol({ run })).toBe(protocol);
    expect(protocol).toContain("Approved revisions are immutable");
    expect(protocol).toContain("Only an explicit USER approval");
    expect(protocol).toContain("- [x] promote_evidence");
    expect(protocol).toContain("- [ ] prepare_proposal");
    expect(renderPlanningProtocol({ run: undefined })).toContain("No active planning run");
  });

  it("records observations via the plugin hook and feeds evidence promotion", async () => {
    resetUltraPlanInstance();
    const hooks = createUltraPlanHooks();
    const afterHook = hooks["tool.execute.after"];
    if (!afterHook) throw new Error("tool.execute.after hook missing");

    const { store, controller } = getUltraPlanInstance();
    await admittedStart(controller, "ses_hook");

    await afterHook({
      tool: "read",
      sessionID: "ses_hook",
      callID: "call-1",
      args: { filePath: "packages/core/src/router.ts" },
    }, { title: "", output: "", metadata: {} });

    const observations = await getUltraPlanInstance().ledger.list("ses_hook");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.source).toEqual({ kind: "file", path: "packages/core/src/router.ts" });
    expect(await store.listEvidence(PlanIDs.from(1))).toHaveLength(0);

    const tools = hooks.tool ?? {};
    const promote = structuredTool(tools, "ultraplan_promote_evidence");
    const result = await invoke(
      promote,
      {
        claim: "Router selects models by tier",
        kind: "symbol",
        scopeType: "run",
        criticality: "supporting",
        confidence: "direct",
        observationIDs: ["OBS-001"],
      },
      "ses_hook",
    );
    expect(result.output).toContain("EVD-001");

    // Harness tools never observe themselves.
    await afterHook({
      tool: "ultraplan_start",
      sessionID: "ses_hook",
      callID: "call-2",
      args: {},
    }, { title: "", output: "", metadata: {} });
    expect(await getUltraPlanInstance().ledger.list("ses_hook")).toHaveLength(1);
    resetUltraPlanInstance();
  });

  it("propagates the configured planning model explicitly (test 16)", () => {
    const configured = new OpenCodeRuntimeAdapter({
      ...DEFAULT_PLANNING_RUNTIME_SPEC,
      planningModel: "opencode/ling-3.0-flash-fin-free",
    });
    const config: OpenCodeConfig = {};
    configured.applyToConfig(config);
    expect(config.command?.["ultra-plan"]?.model).toBe("opencode/ling-3.0-flash-fin-free");
    expect(config.agent?.["ultraplan"]?.model).toBe("opencode/ling-3.0-flash-fin-free");

    // Without a configured model, inheritance of the OpenCode default is
    // explicit: no model key is written at all.
    const fallback = new OpenCodeRuntimeAdapter();
    const defaultConfig: OpenCodeConfig = {};
    fallback.applyToConfig(defaultConfig);
    expect("model" in (defaultConfig.command?.["ultra-plan"] ?? {})).toBe(false);
    expect("model" in (defaultConfig.agent?.["ultraplan"] ?? {})).toBe(false);
  });
});
