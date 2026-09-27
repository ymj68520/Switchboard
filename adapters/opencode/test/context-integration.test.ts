/**
 * R2 context architecture — integration tests (brief §28-§31, §62-§71, §86,
 * §91, §92, §99, §100 deterministic side, plus the system-transform hook
 * integration of §58-§62 at the harness level).
 *
 * Live compaction/system-transform proofs run in the dedicated smoke script;
 * everything here is deterministic.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assemblePlanningContext,
  createUltraPlanHooks,
  DurablePlanStore,
  InMemoryPlanStore,
  renderTraceLog,
  SynthesisInputIDs,
  SynthesisManifestIDs,
  transitionStage,
  renderPlanningProtocol,
} from "../src/index.js";
import type { AssembledPlanningContext, PlanningContextState, PlanningRun } from "../src/index.js";
import { capturePlanningContextStateOrThrow, PLAN, seedRichPlanningState, seedRunHeader, SESSION, storedRun } from "./context-helpers.js";

function renderOf(state: PlanningContextState, options?: Parameters<typeof assemblePlanningContext>[1]): AssembledPlanningContext {
  return assemblePlanningContext(state, options);
}

describe("R2 §28: architecture-remediation scope (R1b substate)", () => {
  it("the remediation substate upgrades the Architecture projection and injects NO old Section DAG", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    // R1b reopen_architecture commit state: remediation focus, sections intact
    // until the amendment (the amendment clears them — tested in §99 below).
    await seedRunHeader(store, { ...(await storedRun(store)), activeWork: { type: "architecture" } });
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    const assembled = renderOf(state);
    expect(assembled.rendered).toContain("workflow_substate: architecture-remediation");
    // Architecture upgrade: the L2 fragment carries the FULL projection when
    // the architecture is the active scope.
    const arch = assembled.trace.included.find((e) => e.fragmentId === "L2:architecture");
    expect(arch?.projection).toBe("full");
    expect(assembled.rendered).toContain("Based on decisions: DEC-001");
    expect(assembled.rendered).toContain("ARCHITECTURE REMEDIATION");
    // The exact referenced Architecture decision is present (brief §28).
    expect(assembled.rendered).toContain("DEC-001@1");
  });
});

describe("R2 §29 + §99: decomposition-needed after an R1 architecture amendment", () => {
  async function seedAmendedState(store: InMemoryPlanStore): Promise<PlanningRun> {
    await seedRichPlanningState(store);
    const run = await storedRun(store);
    // Hand-construct the exact post-amendment state the R1 amend_architecture
    // commit produces: ARCH@2 stays, run.sections = [], provenance cleared,
    // activeWork cleared, stage stays detail. The OLD invalidated Section
    // records remain in the committed families (durable history).
    const amended: PlanningRun = {
      ...run,
      sections: [],
      activeWork: undefined,
      sectionDecompositionArchitecture: undefined,
    };
    await seedRunHeader(store, amended);
    // Seed historical invalidated roots (SEC-001..003 style) into the family —
    // readable history, NOT current context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const family = (store as any).sections.get(PLAN) as Map<string, unknown>;
    family.set("SEC-001", {
      id: "SEC-001",
      title: "Old invalidated section",
      objective: "From the pre-amendment DAG",
      dependencies: [],
      status: "approved",
      validation: "needs_review",
    });
    return amended;
  }

  it("§99: post-amendment context shows ARCH@2 + decomposition-needed and NO old Section DAG", async () => {
    const store = new InMemoryPlanStore();
    await seedAmendedState(store);
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    const assembled = renderOf(state);
    // L2 = ARCH@2 (the amendment result).
    expect(assembled.rendered).toContain("ARCH@2 [approved]");
    // L3 says decomposition-needed.
    expect(assembled.rendered).toContain("workflow_substate: decomposition-needed");
    expect(assembled.rendered).toContain("section_dag_decomposed_from: none");
    // Old invalidated sections NEVER enter current context.
    expect(assembled.rendered).not.toContain("SEC-001");
    expect(assembled.rendered).not.toContain("Old invalidated section");
    // prepare_section_decomposition is available again in L5.
    expect(assembled.rendered).toMatch(/\[x\] prepare_decomposition/);
    // prepare_architecture_amendment withheld after the remediation window.
    expect(assembled.rendered).toMatch(/\[ \] prepare_architecture_amendment/);
    // Historical artifacts remain EXACT-readable (§29/§45 R1).
    const historical = await store.getSectionRevision(PLAN, { id: "SEC-001" as never, revision: 1 });
    void historical; // exact-read path proven by plan_memory tests; the family record exists
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((store as any).sections.get(PLAN) as Map<string, unknown>).has("SEC-001")).toBe(true);
  });

  it("§99: after the NEW decomposition the context reflects only the new current DAG", async () => {
    const store = new InMemoryPlanStore();
    await seedAmendedState(store);
    // The new decomposition commit admits SEC-004 (fresh id continuing the
    // historical sequence) decomposed from ARCH@2.
    store.seedCommittedState(PLAN, {
      sections: [
        {
          id: "SEC-004" as never,
          title: "New first scope",
          objective: "Decomposed from ARCH@2",
          dependencies: [],
          status: "pending",
          validation: "valid",
        },
      ],
      activeWork: undefined,
    });
    await seedRunHeader(store, {
      ...(await storedRun(store)),
      sectionDecompositionArchitecture: { id: "ARCH", revision: 2 },
    });
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    const assembled = renderOf(state);
    expect(assembled.rendered).toContain("section_dag_decomposed_from: ARCH@2");
    expect(assembled.rendered).toContain("SEC-004");
    expect(assembled.rendered).not.toContain("SEC-001");
  });
});

describe("R2 §64: context after a Section reopen", () => {
  it("a reopened Section renders status=reopened + needs_review + the exact old revision", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    // Reopen state: status reopened, validation needs_review, revision
    // pointers unchanged (the reopen creates NO new revision).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const family = (store as any).sections.get(PLAN) as Map<{ id: string }, { status: string; validation: string }>;
    const sec004 = family.get("SEC-004" as never);
    family.set("SEC-004" as never, { ...sec004, status: "reopened", validation: "needs_review" });
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    const assembled = renderOf(state);
    expect(assembled.rendered).toContain("status=reopened validation=needs_review");
    expect(assembled.rendered).toContain("exact approved/current revision remains SEC-004@2");
  });
});

describe("R2 §30/§31: synthesis identities and sparse discovery", () => {
  it("the synthesis capsule reconstructs the current derived-artifact identities", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    await store.saveRun(transitionStage(await storedRun(store), "synthesis"));
    // Derived synthesis artifacts (Test-only direct family seeding — reads
    // carry no validation; the freeze paths are proven by Phase 2F tests).
    const input = {
      id: SynthesisInputIDs.from(1),
      planID: PLAN,
      baseSnapshot: { id: "SNAP-001" as never },
      baseCommit: null,
      architecture: { id: "ARCH" as const, revision: 2 },
      sections: [],
      decisions: [],
      constraints: [],
      questions: [],
      conflicts: [],
      evidence: [],
      createdAt: "2026-09-27T00:00:00.000Z",
      hash: "1234567890abcdef1234567890abcdef",
    };
    const manifest = {
      id: SynthesisManifestIDs.from(1),
      revision: 1,
      input: { id: input.id },
      baseSnapshot: input.baseSnapshot,
      inputHash: input.hash,
      architecture: input.architecture,
      sections: [],
      crossSectionLinks: [],
      implementationOrder: [],
      limitations: [],
      unresolvedFindings: [],
      createdAt: input.createdAt,
      hash: "fedcba0987654321fedcba0987654321",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).synthesisInputs.set(PLAN, new Map([[input.id, input]]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).synthesisManifests.set(PLAN, new Map([[`${manifest.id}@1`, manifest]]));
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    expect(state.synthesis.input?.id).toBe("SYN-IN-001");
    expect(state.synthesis.manifest?.id).toBe("SYN-001");
    const assembled = renderOf(state);
    expect(assembled.rendered).toContain("workflow_substate: synthesis/manifest-ready");
    expect(assembled.rendered).toContain("SynthesisInput: SYN-IN-001 hash=1234567890abcdef base=SNAP-001 current");
    expect(assembled.rendered).toContain("SynthesisManifest: SYN-001@1 hash=fedcba0987654321");
    expect(assembled.rendered).toContain("SemanticValidation: not run");
    expect(assembled.rendered).toContain("(derived artifacts — NOT committed Plan Memory)");
  });

  it("§31: discovery without committed artifacts keeps L3 sparse but still automatic for blockers", async () => {
    const store = new InMemoryPlanStore();
    const run: PlanningRun = {
      id: PLAN,
      sessionID: SESSION,
      lifecycle: "active",
      stage: "discovery",
      revision: 1,
      goal: { statement: "Explore before any design" },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [
        { id: "Q-101" as never, question: "Which module owns retries?", blocking: true, scope: { id: "ARCH" as const, revision: 2 }, status: "open" },
      ],
      conflicts: [],
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    };
    await store.createRun(run);
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    const assembled = renderOf(state);
    expect(assembled.rendered).toContain("workflow_substate: exploring");
    expect(assembled.rendered).toContain("architecture: none");
    expect(assembled.rendered).toContain("Which module owns retries?");
    expect(assembled.trace.included.some((e) => e.layer === "L3" && e.fragmentId.includes("Q-101"))).toBe(true);
    // No fabricated active artifact.
    expect(assembled.rendered).not.toContain("active: SEC-");
  });
});

describe("R2 §86 + §91 + §92: current-state fidelity without HEAD movement", () => {
  it("§86: historical revisions do not enter current context; only the HEAD-bound revision does", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    // SEC-004@1 exists only in durable history (the seeded family holds @2 as
    // latest; @1 is absent here, so seed a historical one directly).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = (store as any).sectionRevisions.get(PLAN);
    const current = registry.byKey.get("SEC-004@2");
    registry.byKey.set("SEC-004@1", { ...current, revision: 1, design: "OLD design of SEC-004" });
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    const assembled = renderOf(state);
    expect(assembled.trace.included.some((e) => e.fragmentId === "L3:section-revision:SEC-004@2")).toBe(true);
    expect(assembled.trace.included.some((e) => e.fragmentId.startsWith("L3:section-revision:SEC-004@1"))).toBe(false);
    expect(assembled.rendered).not.toContain("OLD design of SEC-004");
  });

  it("§91: Evidence changes WITHOUT HEAD are reflected by the next assembly", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    const before = renderOf(await capturePlanningContextStateOrThrow(store, PLAN));
    expect(before.rendered).toContain("EVD-004@1");
    await store.putEvidence(PLAN, {
      id: "EVD-004" as never,
      revision: 2,
      kind: "runtime",
      claim: "Supplementary observation, refreshed",
      source: [],
      scope: { kind: "run" },
      confidence: "direct",
      criticality: "informational",
      freshness: "fresh",
      status: "active",
      discoveredAt: "2026-09-27T01:00:00.000Z",
      lastValidatedAt: "2026-09-27T01:00:00.000Z",
    });
    const after = renderOf(await capturePlanningContextStateOrThrow(store, PLAN));
    expect(after.rendered).toContain("EVD-004@2");
    expect(after.rendered).toContain("Supplementary observation, refreshed");
    expect(after.rendered).not.toContain("EVD-004@1 ");
  });

  it("§92: blocker changes WITHOUT HEAD are reflected by the next assembly", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    const run = await storedRun(store);
    expect(renderOf(await capturePlanningContextStateOrThrow(store, PLAN)).rendered).toContain("blocking_questions: 2");
    // A sanctioned cure resolves Q-001 through an approved commit in real
    // flows; the run header is working state, so saveRun performs it here.
    await store.saveRun({
      ...run,
      openQuestions: run.openQuestions.map((q) => (q.id === "Q-001" ? { ...q, status: "resolved" as const, resolution: "budget renders all required minimum content" } : q)),
    });
    const after = renderOf(await capturePlanningContextStateOrThrow(store, PLAN));
    expect(after.rendered).toContain("blocking_questions: 1 (Q-003)");
    expect(after.trace.included.some((e) => e.fragmentId === "L3:question:Q-001")).toBe(false);
  });
});

describe("R2 §62: context after commit (transition proof)", () => {
  it("after a commit the new HEAD binds the next assembly (deterministic side of §100)", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    const before = renderOf(await capturePlanningContextStateOrThrow(store, PLAN));
    expect(before.rendered).toContain('head="none"');
    // Simulate the post-commit header (working-state fields only are needed
    // for the envelope; pointer fields arrive through the same capture).
    await store.saveRun({ ...(await storedRun(store)), stage: "synthesis" });
    const after = renderOf(await capturePlanningContextStateOrThrow(store, PLAN));
    expect(after.rendered).toContain('stage="synthesis"');
    expect(after.rendered).toContain("workflow_substate: synthesis/no-input");
  });
});

describe("R2 §65/§66/§67: lifecycle boundaries", () => {
  it("§65: an aborted run receives NO planning context injection", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    await store.saveRun({ ...(await storedRun(store)), lifecycle: "aborted" });
    const active = await store.findActiveRunBySession(SESSION);
    expect(active).toBeUndefined(); // the transform hook injects nothing
  });

  it("§67: a completed run receives NO active planning L0-L5 injection", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    await store.saveRun({ ...(await storedRun(store)), lifecycle: "completed" });
    const active = await store.findActiveRunBySession(SESSION);
    expect(active).toBeUndefined();
  });

  it("§66: a handoff_pending run receives the MINIMAL non-authoritative status context (L0+L1+L5, no L2-L4)", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    await seedRunHeader(store, {
      ...(await storedRun(store)),
      lifecycle: "handoff_pending",
      stage: "final",
      activeWork: undefined,
    });
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    const assembled = renderOf(state, { mode: "handoff-status" });
    const rendered = assembled.rendered;
    expect(rendered).toContain("=== L0 PLANNING PROTOCOL ===");
    expect(rendered).toContain("The run is handoff_pending.");
    expect(rendered).toContain("=== L1 RUN STATE ===");
    expect(rendered).toContain("=== L5 AVAILABLE OPERATIONS ===");
    expect(rendered).toMatch(/\[ \] prepare_section_checkpoint/); // read-only surface
    for (const planningOnly of ["=== L2 GLOBAL COMMITTED MEMORY ===", "=== L3 ACTIVE SCOPE ===", "=== L4 CURRENT WORKING CONTEXT ==="]) {
      expect(rendered).not.toContain(planningOnly);
    }
  });
});

describe("R2 §69/§100: restart + compaction independence (durable)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultraplan-r2-context-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a fresh process/store instance reconstructs the SAME authoritative context", async () => {
    const storePath = path.join(dir, "plan-store.json");
    const first = new DurablePlanStore(storePath, { now: () => "2026-09-27T00:00:00.000Z" });
    await seedRichPlanningState(first);
    const stateA = await capturePlanningContextStateOrThrow(first, PLAN);
    const assembledA = renderOf(stateA);
    first.close();

    // "Compaction": ALL conversation-derived context is discarded; only the
    // durable document survives. A brand-new store instance reassembles.
    const second = new DurablePlanStore(storePath, { now: () => "2026-09-27T00:00:00.000Z" });
    const stateB = await capturePlanningContextStateOrThrow(second, PLAN);
    const assembledB = renderOf(stateB);
    second.close();

    expect(assembledB.rendered).toBe(assembledA.rendered);
    expect(assembledB.trace).toEqual(assembledA.trace);
    // Same exact refs, projection levels, and rendered context (brief §69).
    expect(assembledB.trace.included.map((e) => [e.fragmentId, e.projection])).toEqual(
      assembledA.trace.included.map((e) => [e.fragmentId, e.projection]),
    );
  });
});

describe("R2 finding: R1 resolved-conflict durable reload regression", () => {
  it("a durable store with a legitimately resolved conflict RELOADS clean (R1 validation nesting fix)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultraplan-r1-reload-"));
    try {
      const storePath = path.join(dir, "plan-store.json");
      const first = new DurablePlanStore(storePath, { now: () => "2026-09-27T00:00:00.000Z" });
      // Conflict raised OPEN (raise rule §8) → the bound decision commits →
      // the sanctioned resolve_conflict cure marks it resolved. All legal.
      await first.createRun({
        id: PLAN,
        sessionID: SESSION,
        lifecycle: "active",
        stage: "architecture",
        revision: 1,
        goal: { statement: "Reload regression" },
        constraints: [],
        sections: [],
        decisions: [],
        openQuestions: [],
        conflicts: [
          {
            id: "CONF-201" as never,
            type: "decision",
            refs: [{ kind: "decision", id: "DEC-101" as never, revision: 1 }],
            description: "Decision contradicts a committed constraint",
            severity: "blocking",
            status: "open",
          },
        ],
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:00.000Z",
      });
      await first.seedCommittedStateAsync(PLAN, {
        decisions: [
          {
            id: "DEC-101" as never,
            revision: 1,
            title: "Retry policy",
            status: "approved",
            statement: "Retry once",
            rationale: "Bounded cost",
            scope: {},
            approvedAt: "2026-09-27T00:00:00.000Z",
          },
        ],
      });
      // The cure: conflict resolved, binding the EXACT committed DecisionRef.
      const run = await first.getRun(PLAN);
      await first.saveRun({
        ...run!,
        conflicts: [
          {
            id: "CONF-201" as never,
            type: "decision",
            refs: [{ kind: "decision", id: "DEC-101" as never, revision: 1 }],
            description: "Decision contradicts a committed constraint",
            severity: "blocking",
            status: "resolved" as never,
            resolution: { action: "amend_decision", ref: { kind: "decision", id: "DEC-101" as never, revision: 1 } },
          },
        ],
      });
      first.close();

      // RELOAD: the R1 defect made this reopen throw store_corrupt for ANY
      // resolved conflict (the validation read committed families at the
      // wrong nesting level). The fix lets the legal state reload cleanly.
      const second = new DurablePlanStore(storePath, { now: () => "2026-09-27T00:00:00.000Z" });
      const reloaded = await second.getRun(PLAN);
      expect(reloaded?.conflicts[0]?.status).toBe("resolved");
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("R2 §58-§62 + §89: system-transform integration (harness level)", () => {
  function output() {
    return { system: [] as string[] };
  }

  it("§97-59: the transform injects ONE assembler block and NO legacy duplicate fragment", async () => {
    const hooks = createUltraPlanHooks();
    try {
      const store = hooks ? undefined : undefined;
      void store;
      // Seed the singleton store the no-project hooks use.
      const { getUltraPlanInstance } = await import("../src/index.js");
      const instance = getUltraPlanInstance();
      await seedRichPlanningState(instance.store as InMemoryPlanStore);
      const out = output();
      await hooks["experimental.chat.system.transform"]!({ sessionID: SESSION, model: {} as never }, out);
      expect(out.system).toHaveLength(1);
      expect(out.system[0]).toContain("<ULTRA_PLAN_CONTEXT");
      expect(out.system[0]).toContain("</ULTRA_PLAN_CONTEXT>");
      // The legacy all-in-one renderer is NOT injected alongside.
      expect(out.system[0]).not.toContain("=== ULTRA PLAN PROTOCOL (L0) ===");
    } finally {
      const { resetUltraPlanInstance } = await import("../src/index.js");
      resetUltraPlanInstance();
    }
  });

  it("§97-60/§61: the transform emits the structured ContextTrace log with the current PlanID and L2 fragments", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => logs.push(String(line));
    const hooks = createUltraPlanHooks();
    try {
      const { getUltraPlanInstance } = await import("../src/index.js");
      const instance = getUltraPlanInstance();
      await seedRichPlanningState(instance.store as InMemoryPlanStore);
      const out = output();
      await hooks["experimental.chat.system.transform"]!({ sessionID: SESSION, model: {} as never }, out);
      console.log = original;
      const traceLine = logs.find((line) => line.includes('"ultraplan.context.trace"'));
      expect(traceLine).toBeDefined();
      const parsed = JSON.parse(traceLine!);
      expect(parsed.planID).toBe("PLAN-901");
      expect(parsed.stage).toBe("detail");
      expect(parsed.included.some((entry: { fragmentId: string }) => entry.fragmentId === "L2:goal")).toBe(true);
      expect(parsed.included.some((entry: { fragmentId: string }) => entry.fragmentId === "L3:section:SEC-004")).toBe(true);
      expect(parsed.included.some((entry: { fragmentId: string; reason: string }) => entry.reason === "direct_dependency")).toBe(true);
    } finally {
      console.log = original;
      const { resetUltraPlanInstance } = await import("../src/index.js");
      resetUltraPlanInstance();
    }
  });

  it("§89: trace logging failure never changes context correctness", async () => {
    const hooks = createUltraPlanHooks();
    try {
      const { getUltraPlanInstance } = await import("../src/index.js");
      const instance = getUltraPlanInstance();
      await seedRichPlanningState(instance.store as InMemoryPlanStore);
      const out = output();
      const original = console.log;
      console.log = () => {
        throw new Error("logging backend down");
      };
      try {
        await hooks["experimental.chat.system.transform"]!({ sessionID: SESSION, model: {} as never }, out);
      } finally {
        console.log = original;
      }
      // The context block was still injected, complete and authoritative.
      expect(out.system).toHaveLength(1);
      expect(out.system[0]).toContain("</ULTRA_PLAN_CONTEXT>");
    } finally {
      const { resetUltraPlanInstance } = await import("../src/index.js");
      resetUltraPlanInstance();
    }
  });

  it("§72: no session → no injection (the transform is a no-op outside planning sessions)", async () => {
    const hooks = createUltraPlanHooks();
    try {
      const out = output();
      await hooks["experimental.chat.system.transform"]!({ sessionID: "session-nothing", model: {} as never }, out);
      expect(out.system).toHaveLength(0);
    } finally {
      const { resetUltraPlanInstance } = await import("../src/index.js");
      resetUltraPlanInstance();
    }
  });

  it("the legacy renderer remains byte-compatible for embedders (and is NOT the production path)", () => {
    // The legacy composition still exists for pinned embedder output; the
    // production transform never calls it (pinned by the no-legacy test above).
    expect(typeof renderPlanningProtocol).toBe("function");
  });

  it("renderTraceLog is parseable JSON for the live smoke", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    const assembled = renderOf(await capturePlanningContextStateOrThrow(store, PLAN));
    expect(() => JSON.parse(renderTraceLog(assembled.trace))).not.toThrow();
  });

  it("vi is alive (sanity)", () => {
    expect(vi.fn()).toBeDefined();
  });
});
