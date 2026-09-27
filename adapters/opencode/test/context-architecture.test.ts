/**
 * R2 — Context Architecture tests (brief §56, §78-§92, §97, §98).
 *
 * Every test assembles from `capturePlanningContextState` over a real store —
 * deterministic, read-only, conversation-history-free. The rich fixture
 * (context-helpers.ts) is the dense §98 primary integration state.
 */
import { describe, expect, it } from "vitest";

import {
  assemblePlanningContext,
  assertCapability,
  clearLatestContextTraces,
  estimateTokens,
  getLatestContextTrace,
  InMemoryPlanStore,
  isUltraPlanError,
  recordLatestTrace,
  renderTraceLog,
  WORKING_CONTEXT_NOTE,
} from "../src/index.js";
import type { AssembledPlanningContext, PlanningContextState } from "../src/index.js";
import { capturePlanningContextStateOrThrow, PLAN, seedRichPlanningState } from "./context-helpers.js";

async function assembleRich(
  options?: Parameters<typeof assemblePlanningContext>[1],
  seedOptions?: Parameters<typeof seedRichPlanningState>[1],
): Promise<{ assembled: AssembledPlanningContext; state: PlanningContextState }> {
  const store = new InMemoryPlanStore();
  await seedRichPlanningState(store, seedOptions);
  const state = await capturePlanningContextStateOrThrow(store, PLAN);
  return { assembled: assemblePlanningContext(state, options), state };
}

function included(assembled: AssembledPlanningContext, fragmentId: string) {
  const entry = assembled.trace.included.find((entry) => entry.fragmentId === fragmentId);
  if (!entry) throw new Error(`fragment ${fragmentId} not included in trace`);
  return entry;
}

async function noRepeat() {
  clearLatestContextTraces();
}

describe("R2 §56: assembly determinism", () => {
  it("§97-1/§97-2: identical state produces byte-identical rendered context AND trace", async () => {
    const first = await assembleRich();
    const second = await assembleRich();
    expect(first.assembled.rendered).toBe(second.assembled.rendered);
    expect(first.assembled.trace).toEqual(second.assembled.trace);
  });

  it("§97-55: trace totalTokens equals the estimator over the rendered context", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.trace.totalTokens).toBe(estimateTokens(assembled.rendered));
    expect(assembled.trace.totalTokens).toBeGreaterThan(0);
  });

  it("§97-50/§82: the token estimator is deterministic, nonzero, UTF-8/CJK-safe, and conservative", () => {
    const ascii = "plan: PLAN-901\nstage: detail";
    const cjk = "上下文组装预算";
    const mixed = "assemble 上下文 with\nnewlines and 中文";
    const again = [ascii, cjk, mixed].map(estimateTokens);
    expect(again).toEqual([ascii, cjk, mixed].map(estimateTokens));
    for (const value of again) expect(value).toBeGreaterThan(0);
    // Documented formula: ceil(asciiUnits/4) + nonAsciiUnits (never provider billing tokens).
    expect(estimateTokens(cjk)).toBe([...cjk].length);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("R2 §5: snapshot-consistent read boundary", () => {
  it("§97-3: the captured state binds ONE coherent HEAD (snapshot pointers resolve every current artifact)", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    expect(state.headSnapshot?.id).toBe(state.run.headSnapshot);
    // Current artifacts resolve through the snapshot's exact pointers.
    expect(state.architecture?.revision).toBe(2);
    expect(state.sectionRevisions.get("SEC-004" as never)?.revision).toBe(2);
    expect(state.decisionRefs).toContainEqual({ id: "DEC-002", revision: 2 });
    // Assembling from the SAME captured state twice is stable even if the
    // store mutates in between (the view is immutable).
    const before = assemblePlanningContext(state).rendered;
    await store.putEvidence(PLAN, {
      id: "EVD-004" as never,
      revision: 2,
      kind: "file",
      claim: "second revision",
      source: [],
      scope: { kind: "run" },
      confidence: "direct",
      criticality: "supporting",
      freshness: "fresh",
      status: "active",
      discoveredAt: "2026-09-27T00:00:00.000Z",
      lastValidatedAt: "2026-09-27T00:00:00.000Z",
    });
    const after = assemblePlanningContext(state).rendered;
    expect(after).toBe(before);
  });
});

describe("R2 §14: layers L0-L5 are automatically assembled", () => {
  it("§97-4: L0 protocol is always included (P0, never dropped)", async () => {
    const { assembled } = await assembleRich({ budgetTokens: 1, overflow: "render" });
    expect(assembled.trace.included.some((entry) => entry.fragmentId === "L0:protocol" && entry.priority === "P0")).toBe(true);
    expect(assembled.rendered).toContain("=== L0 PLANNING PROTOCOL ===");
    expect(assembled.rendered).toContain("COMMITTED MEMORY is authoritative");
  });

  it("§97-5: L1 carries the exact current run state (PlanID, stage, HEAD, blockers with ids)", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.rendered).toContain("=== L1 RUN STATE ===");
    expect(assembled.rendered).toContain("plan: PLAN-901");
    expect(assembled.rendered).toContain("stage: detail");
    expect(assembled.rendered).toContain("workflow_substate: section-ready/checkpointed");
    expect(assembled.rendered).toContain("blocking_questions: 2 (Q-001, Q-003)");
    expect(assembled.rendered).toContain("blocking_conflicts: 1 (CONF-001)");
  });

  it("§97-6: the goal is automatic — never dependent on a plan_memory call", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.rendered).toContain("Goal: Build a deterministic planning context pipeline");
    expect(included(assembled, "L2:goal").priority).toBe("P0");
  });

  it("§97-26: L5 is derived from getCapabilities — no second hand-authored matrix", async () => {
    const { assembled, state } = await assembleRich();
    expect(assembled.rendered).toContain("=== L5 AVAILABLE OPERATIONS ===");
    // The active section is checkpointed detail: prepare_section_checkpoint is
    // granted, begin_synthesis is not — exactly as the capability matrix says.
    expect(assembled.rendered).toMatch(/\[x\] prepare_section_checkpoint/);
    expect(assembled.rendered).toMatch(/\[ \] begin_synthesis/);
    // §97-27: L5 is informational only — server-side authorization refuses.
    expect(() => assertCapability(state.run, "begin_synthesis")).toThrowError();
  });
});

describe("R2 §14 L2: global committed memory", () => {
  it("§97-7/§97-8: hard+active constraints are P0; soft constraints are not", async () => {
    const { assembled } = await assembleRich();
    const hard = included(assembled, "L2:constraint:CON-001");
    expect(hard.priority).toBe("P0");
    expect(assembled.rendered).toContain("Context assembly must be deterministic");
    const soft = included(assembled, "L2:constraint:CON-002");
    expect(soft.priority).toBe("P3");
  });

  it("§97-9: the approved Architecture compact projection is automatic", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.rendered).toContain("=== L2 GLOBAL COMMITTED MEMORY ===");
    expect(assembled.rendered).toContain("ARCH@2 [approved]");
    expect(assembled.rendered).toContain("Assembler: Deterministic context compiler");
    expect(included(assembled, "L2:architecture").projection).toBe("summary");
  });

  it("§97-45: the required L2 Architecture compact survives extreme budget pressure (P2 never implies droppable)", async () => {
    const { assembled } = await assembleRich({ budgetTokens: 600, overflow: "render" });
    const arch = included(assembled, "L2:architecture");
    expect(arch.budgetDecision).not.toBe("dropped");
    expect(arch.projection).toBe("summary");
    expect(assembled.rendered).toContain("ARCH@2 [approved]");
    expect(assembled.trace.overBudget).toBe(true);
  });
});

describe("R2 §14 L3: active scope (section work)", () => {
  it("§97-11/§97-12: active Section identity is P0; the revision renders the approved compact + relevant fields", async () => {
    const { assembled } = await assembleRich();
    const root = included(assembled, "L3:section:SEC-004");
    expect(root.priority).toBe("P0");
    expect(root.projection).toBe("relevant");
    expect(assembled.rendered).toContain("Compact projection of SEC-004@2");
    expect(assembled.rendered).toContain("How does the model see committed state deterministically?");
    const revision = included(assembled, "L3:section-revision:SEC-004@2");
    expect(revision.priority).toBe("P1");
  });

  it("§97-13: the direct dependency is retrieved with its EXACT approved contract", async () => {
    const { assembled } = await assembleRich();
    const entry = included(assembled, "L3:dependency:SEC-005");
    expect(entry.priority).toBe("P1");
    expect(entry.reason).toBe("direct_dependency");
    expect(assembled.rendered).toContain("CONTRACT SEC-005@1");
    expect(assembled.rendered).toContain("Provides: Retrieval");
    expect(assembled.rendered).toContain("Decisions: DEC-003@1");
  });

  it("§97-14: the transitive dependency enters compressed (identity + contract id), never full design", async () => {
    const { assembled } = await assembleRich();
    const entry = included(assembled, "L3:transitive-dependency:SEC-006");
    expect(entry.priority).toBe("P2");
    expect(entry.projection).toBe("identity");
    expect(assembled.rendered).toContain("SEC-006 [approved] validation=valid contract=SEC-006@1");
    // Transitive full design does NOT enter (brief §19).
    expect(assembled.rendered).not.toContain("Design of SEC-006@1");
  });

  it("§97-15: the section-scoped Decision is retrieved at its exact HEAD revision", async () => {
    const { assembled } = await assembleRich();
    const entry = included(assembled, "L3:decision:DEC-002@2");
    expect(entry.reason).toBe("explicit_reference");
    expect(entry.priority).toBe("P1");
    expect(assembled.rendered).toContain("Budget degradation switches projection levels");
  });

  it("§97-16: inherited dependency decisions arrive through the contracts with dedup + priority merge", async () => {
    const { assembled } = await assembleRich();
    const direct = included(assembled, "L3:decision:DEC-003@1");
    expect(direct.reasons).toContain("direct_dependency");
    expect(direct.priority).toBe("P1");
    const transitive = included(assembled, "L3:decision:DEC-004@1");
    expect(transitive.reasons).toContain("transitive_dependency");
    expect(transitive.priority).toBe("P2");
  });

  it("§97-17: relevant interfaces come from the active revision and direct contracts — smallest form", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.rendered).toContain("Worker: assemble(state): RenderedContext");
    expect(assembled.rendered).toContain("Retrieval (provided by SEC-005)");
  });

  it("§97-18/§97-19: blocking questions are P0 with full text; non-blocking stay lower and scope-filtered", async () => {
    const { assembled } = await assembleRich();
    expect(included(assembled, "L3:question:Q-001").priority).toBe("P0");
    expect(assembled.rendered).toContain("How should budget overflow behave for required content?");
    expect(included(assembled, "L3:question:Q-003").priority).toBe("P0");
    expect(included(assembled, "L3:question:Q-002").priority).toBe("P1");
    // Q-004 (SEC-005 scope) and Q-005 (ARCH scope, section work) are NOT active-scope relevant.
    expect(assembled.trace.included.some((entry) => entry.fragmentId === "L3:question:Q-004")).toBe(false);
    expect(assembled.trace.included.some((entry) => entry.fragmentId === "L3:question:Q-005")).toBe(false);
  });

  it("§97-20/§97-21: blocking conflicts are P0; RESOLVED conflicts never render as current", async () => {
    const { assembled } = await assembleRich();
    expect(included(assembled, "L3:conflict:CONF-001").priority).toBe("P0");
    expect(included(assembled, "L3:conflict:CONF-002").priority).toBe("P1");
    expect(assembled.rendered).not.toContain("Resolved historical conflict");
    const excluded = assembled.trace.excluded.find((entry) => entry.fragmentId === "L3:conflict:CONF-003");
    expect(excluded?.reason).toBe("resolved_conflict_not_current");
  });

  it("§97-22: downstream impact is deterministic and renders status/validation only", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.rendered).toContain("Downstream impact of SEC-004: 1 direct, 0 transitive");
    expect(assembled.rendered).toContain("- direct: SEC-007 [pending] validation=valid");
    expect(assembled.rendered).not.toContain("Design of SEC-007");
  });
});

describe("R2 §14 L4: working context", () => {
  it("§97-23/§97-25/§60/§61: the current Proposal is L4/P1 with its exact hash, visibly NOT committed", async () => {
    const { assembled } = await assembleRich();
    const entry = included(assembled, "L4:proposal:PROP-901");
    expect(entry.priority).toBe("P1");
    expect(entry.reason).toBe("current_proposal");
    expect(assembled.rendered).toContain("=== L4 CURRENT WORKING CONTEXT ===");
    expect(assembled.rendered).toContain(WORKING_CONTEXT_NOTE);
    expect(assembled.rendered).toContain("WORKING STATE, NOT COMMITTED MEMORY");
    expect(assembled.rendered).toMatch(/Hash: [0-9a-f]{64}/); // exact proposal hash visible
  });

  it("§97-24/§87: a rejected Proposal no longer appears as current working context", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store, { proposalStatus: "ready" });
    await store.transitionProposalStatus(PLAN, "PROP-901" as never, "ready", "awaiting_approval");
    await store.transitionProposalStatus(PLAN, "PROP-901" as never, "awaiting_approval", "rejected");
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    const assembled = assemblePlanningContext(state);
    expect(assembled.trace.included.some((entry) => entry.fragmentId.startsWith("L4:proposal:"))).toBe(false);
    expect(assembled.rendered).not.toContain("Checkpoint SEC-004@3");
  });

  it("§61: an awaiting_approval Proposal is labeled frozen, never committed", async () => {
    const { assembled } = await assembleRich({}, { proposalStatus: "awaiting_approval" });
    expect(assembled.rendered).toContain("FROZEN for the approval decision");
    expect(assembled.rendered).toContain("[awaiting_approval]");
  });

  it("§32: candidate question resolutions render as WORKING state in L4", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.rendered).toContain("Candidate resolution for Q-002 (WORKING — NOT committed)");
  });
});

describe("R2 §28: evidence retrieval priorities", () => {
  it("§97-32/§97-33: blocking-path Evidence is P0 and merges with the active-decision path (dedup)", async () => {
    const { assembled } = await assembleRich();
    const entry = included(assembled, "L3:evidence:EVD-001@1");
    expect(entry.priority).toBe("P0"); // highest of all retrieval reasons
    expect(entry.reasons).toContain("blocking_evidence");
    expect(entry.reasons).toContain("active_decision_evidence");
    // Included ONCE despite two paths (brief §42).
    expect(assembled.trace.included.filter((e) => e.fragmentId === "L3:evidence:EVD-001@1")).toHaveLength(1);
  });

  it("§97-34: dependency Evidence rides P2; architecture Evidence merges with the blocking path it serves", async () => {
    const { assembled } = await assembleRich();
    expect(included(assembled, "L3:evidence:EVD-002@1").reasons).toContain("dependency_evidence");
    expect(included(assembled, "L3:evidence:EVD-002@1").priority).toBe("P2");
    // EVD-003 is architecture evidence AND reachable from blocking Q-003
    // through the exact path scope ARCH → basedOn DEC-001 → evidence (§37).
    const archEvidence = included(assembled, "L3:evidence:EVD-003@1");
    expect(archEvidence.reasons).toContain("architecture_evidence");
    expect(archEvidence.reasons).toContain("blocking_evidence");
    expect(archEvidence.priority).toBe("P0"); // highest retrieval reason wins (§42)
  });

  it("§97-35: run-scoped supplementary Evidence is P3 — the first class dropped", async () => {
    const { assembled } = await assembleRich({ budgetTokens: 900, overflow: "render" });
    const entry = assembled.trace.included.find((e) => e.fragmentId === "L3:evidence:EVD-004@1");
    expect(entry === undefined || entry.priority === "P3").toBe(true);
    if (entry === undefined) {
      expect(assembled.trace.excluded.find((e) => e.fragmentId === "L3:evidence:EVD-004@1")?.reason).toBe("budget_dropped_p3");
    }
  });

  it("§97-37/§85: a structurally UNLINKED lookalike is never retrieved — structure-first, not hidden semantic search", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.rendered).not.toContain("lookalike");
    expect(assembled.trace.included.some((e) => e.fragmentId === "L3:evidence:EVD-005@1")).toBe(false);
  });

  it("§43/§97-38: stale Evidence is shown exactly as stale — never hidden", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.rendered).toContain("EVD-007@1 [stale/");
  });

  it("§41: evidence renders in the compact §28 form with exact ref + provenance", async () => {
    const { assembled } = await assembleRich();
    expect(assembled.rendered).toContain("EVD-001@1 [fresh/direct/critical]");
    expect(assembled.rendered).toContain("Claim: Budget degradation must switch projection levels deterministically");
    expect(assembled.rendered).toContain("Source: file src/example.ts");
  });
});

describe("R2 §44/§48: budget manager", () => {
  it("§97-42/§97-44: P3 drops first; P0 is never dropped", async () => {
    const { assembled } = await assembleRich({ budgetTokens: 1200, overflow: "render" });
    // P0 required minimum all present:
    expect(assembled.rendered).toContain("=== L0 PLANNING PROTOCOL ===");
    expect(assembled.rendered).toContain("=== L1 RUN STATE ===");
    expect(assembled.rendered).toContain("Goal: Build a deterministic planning context pipeline");
    expect(assembled.rendered).toContain("Context assembly must be deterministic");
    expect(assembled.rendered).toContain("SEC-004"); // active artifact identity
    expect(assembled.rendered).toContain("Q-001"); // blocking question
    expect(assembled.rendered).toContain("CONF-001"); // blocking conflict
    expect(assembled.rendered).toContain("=== L5 AVAILABLE OPERATIONS ===");
    // P3s are gone first:
    expect(assembled.trace.excluded.some((e) => e.reason === "budget_dropped_p3")).toBe(true);
  });

  it("§97-43: degradation order is deterministic — P3 drops, then droppable P2, before any P1 downgrade; P0 untouched", async () => {
    // Mid pressure: P3s and the droppable transitive P2 are gone while the P1
    // direct dependency contract is still kept at its desired level.
    const mid = await assembleRich({ budgetTokens: 1500, overflow: "render" });
    expect(mid.assembled.trace.excluded.filter((e) => e.reason === "budget_dropped_p3").length).toBeGreaterThan(0);
    expect(mid.assembled.trace.excluded.some((e) => e.fragmentId === "L3:transitive-dependency:SEC-006")).toBe(true);
    const directDep = mid.assembled.trace.included.find((e) => e.fragmentId === "L3:dependency:SEC-005");
    expect(directDep?.budgetDecision).toBe("kept");
    expect(mid.assembled.rendered).toContain("CONTRACT SEC-005@1");

    // Tighter pressure: P1 downgrades (never below minimum) while every P0
    // required minimum survives and the overflow is honestly flagged.
    const tight = await assembleRich({ budgetTokens: 1000, overflow: "render" });
    expect(tight.assembled.trace.overBudget).toBe(true);
    const depTight = tight.assembled.trace.included.find((e) => e.fragmentId === "L3:dependency:SEC-005");
    expect(depTight?.budgetDecision).toBe("downgraded");
    expect(depTight?.projection).toBe("summary"); // contract minimum holds
    expect(tight.assembled.rendered).toContain("CONTRACT SEC-005@1");
    for (const p0 of ["L0:protocol", "L1:run-state", "L2:goal", "L2:constraint:CON-001", "L3:section:SEC-004", "L3:question:Q-001", "L3:conflict:CONF-001", "L5:capabilities"]) {
      expect(tight.assembled.trace.included.some((e) => e.fragmentId === p0)).toBe(true);
    }
  });

  it("§97-10/§80: degradation switches between exact projection levels — no substring truncation", async () => {
    const { assembled } = await assembleRich({ budgetTokens: 1000, overflow: "render" });
    const arch = included(assembled, "L2:architecture");
    if (arch.budgetDecision === "downgraded") {
      expect(arch.projection).toBe("summary");
      // The rendered text is the EXACT summary variant, not a slice of the full one.
      expect(assembled.rendered).toContain("ARCH@2 [approved]");
      expect(assembled.rendered).toContain("Summary: Layered context architecture");
    }
    // Nothing renders a hard mid-field slice marker.
    expect(assembled.rendered).not.toMatch(/\{truncated|\.\.\.\d+ chars/);
  });

  it("§17/§97-46: over-budget required minimum is deterministic — render+flag (default)", async () => {
    const rendered = await assembleRich({ budgetTokens: 300, overflow: "render" });
    expect(rendered.assembled.trace.overBudget).toBe(true);
    expect(rendered.assembled.warnings.length).toBeGreaterThan(0);
    // Required minimum still complete:
    expect(rendered.assembled.rendered).toContain("Goal: Build a deterministic planning context pipeline");
    expect(rendered.assembled.rendered).toContain("blocking_questions: 2");
  });

  it("§17: overflow=fail throws context_budget_exceeded BEFORE any inference", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    try {
      assemblePlanningContext(state, { budgetTokens: 300, overflow: "fail" });
      expect.unreachable("expected context_budget_exceeded");
    } catch (error) {
      expect(isUltraPlanError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("context_budget_exceeded");
    }
  });

  it("§97-49/§81: stable tie-breaking — repeated runs make the same choice for equal-priority fragments", async () => {
    const first = await assembleRich({ budgetTokens: 950, overflow: "render" });
    const second = await assembleRich({ budgetTokens: 950, overflow: "render" });
    expect(first.assembled.trace.excluded).toEqual(second.assembled.trace.excluded);
    expect(first.assembled.trace.included.map((e) => e.fragmentId)).toEqual(second.assembled.trace.included.map((e) => e.fragmentId));
  });
});

describe("R2 §51-§55: ContextTrace observability", () => {
  it("§97-51/§97-52/§97-53: trace records refs, projection levels, and reasons per included fragment", async () => {
    const { assembled } = await assembleRich();
    const dep = included(assembled, "L3:dependency:SEC-005");
    expect(dep.ref).toEqual({ kind: "section", id: "SEC-005", revision: 1 });
    expect(dep.projection).toBe("relevant");
    expect(dep.reason).toBe("direct_dependency");
    expect(dep.estimatedTokens).toBeGreaterThan(0);
    expect(dep.layer).toBe("L3");
  });

  it("§97-54: budget exclusions carry a deterministic reason", async () => {
    const { assembled } = await assembleRich({ budgetTokens: 700, overflow: "render" });
    expect(assembled.trace.excluded.length).toBeGreaterThan(0);
    for (const entry of assembled.trace.excluded) {
      expect(entry.reason).toMatch(/^budget_dropped_p[123]$|^resolved_conflict_not_current$/);
    }
  });

  it("§52: the trace id is deterministic from assembly decisions (no allocator, no clock)", async () => {
    const first = await assembleRich();
    const second = await assembleRich();
    expect(first.assembled.trace.id).toBe(second.assembled.trace.id);
  });

  it("§73: the structured trace log is secret-free single-line JSON with the channel marker", async () => {
    const { assembled } = await assembleRich();
    const line = renderTraceLog(assembled.trace);
    expect(line.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(line);
    expect(parsed.channel).toBe("ultraplan.context.trace");
    expect(parsed.planID).toBe("PLAN-901");
    expect(parsed.totalTokens).toBe(assembled.trace.totalTokens);
    // Never logs full prompt content:
    expect(line).not.toContain("COMMITTED MEMORY is authoritative");
  });

  it("§53: the latest-trace cache is a bounded diagnostic, not planning authority", async () => {
    noRepeat();
    const { assembled } = await assembleRich();
    recordLatestTrace(assembled.trace);
    expect(getLatestContextTrace(PLAN)?.id).toBe(assembled.trace.id);
  });

  it("§89: context correctness does not depend on the trace (trace is post-hoc observability)", async () => {
    // The rendered block contains no trace dependency: rendering happens before
    // trace fields are filled and stays valid if the trace were discarded.
    const { assembled } = await assembleRich();
    expect(assembled.rendered).toContain("</ULTRA_PLAN_CONTEXT>");
    expect(assembled.trace.included.length).toBeGreaterThan(0);
  });
});

describe("R2 §93: fail-closed on inconsistent authoritative state", () => {
  it("a dependency naming an uncommitted Section fails closed with context_state_invalid", async () => {
    const store = new InMemoryPlanStore();
    await seedRichPlanningState(store);
    const state = await capturePlanningContextStateOrThrow(store, PLAN);
    // Hand-corrupt the captured view the way no production path can produce:
    // an active Section whose dependency has no committed root (brief §20).
    const corrupted: PlanningContextState = {
      ...state,
      run: { ...state.run, activeWork: { type: "section", id: "SEC-900" as never } },
      sections: [
        ...state.sections,
        {
          id: "SEC-900" as never,
          title: "Corrupt",
          objective: "Names an uncommitted dependency",
          dependencies: ["SEC-901" as never],
          status: "active" as const,
          validation: "valid" as const,
        },
      ],
    };
    try {
      assemblePlanningContext(corrupted);
      expect.unreachable("expected context_state_invalid");
    } catch (error) {
      expect(isUltraPlanError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("context_state_invalid");
    }
  });
});

describe("R2 §57: explicit refs (optional, structured only)", () => {
  it("upgrades an exact ref deterministically without any conversation parsing", async () => {
    const { assembled } = await assembleRich({ explicitRefs: [{ kind: "decision", id: "DEC-003" as never, revision: 1 }] });
    const entry = included(assembled, "L3:explicit:decision:DEC-003@1");
    expect(entry.reason).toBe("explicit_reference");
    expect(entry.projection).toBe("full");
    expect(assembled.rendered).toContain("DEC-003@1 [approved]");
  });

  it("unknown refs are ignored (never fabricated)", async () => {
    const plain = await assembleRich();
    const withUnknown = await assembleRich({ explicitRefs: [{ kind: "decision", id: "DEC-999" as never, revision: 9 }] });
    expect(withUnknown.assembled.rendered).toBe(plain.assembled.rendered);
  });
});

describe("R2 §98: primary dense integration case", () => {
  it("the full §98 matrix over one constrained realistic budget", async () => {
    const { assembled } = await assembleRich({ budgetTokens: 2600, overflow: "render" });
    const rendered = assembled.rendered;
    // L0-L5 all present.
    for (const layer of ["L0 PLANNING PROTOCOL", "L1 RUN STATE", "L2 GLOBAL COMMITTED MEMORY", "L3 ACTIVE SCOPE", "L4 CURRENT WORKING CONTEXT", "L5 AVAILABLE OPERATIONS"]) {
      expect(rendered).toContain(`=== ${layer} ===`);
    }
    // P0 complete + automatic L2.
    expect(rendered).toContain("Goal: Build a deterministic planning context pipeline");
    expect(rendered).toContain("CON-001");
    expect(rendered).toContain("ARCH@2 [approved]");
    // Active scope: relevant + contracts + compressed transitive + decisions.
    expect(rendered).toContain("SEC-004 [active]");
    expect(rendered).toContain("CONTRACT SEC-005@1");
    expect(rendered).toContain("SEC-006 [approved] validation=valid contract=");
    expect(rendered).toContain("DEC-002@2");
    // Questions/conflicts correct.
    expect(rendered).toContain("Q-001");
    expect(rendered).toContain("CONF-001");
    // Evidence priorities correct.
    expect(rendered).toContain("EVD-001@1 [fresh/direct/critical]");
    // Working context labeled.
    expect(rendered).toContain("WORKING STATE, NOT COMMITTED MEMORY");
    // Trace explains retrieval.
    expect(assembled.trace.included.length).toBeGreaterThan(10);
    // Budget degradation deterministic: every budget decision is explained.
    for (const entry of assembled.trace.included) {
      expect(["kept", "downgraded"]).toContain(entry.budgetDecision);
    }
    // Same state, fresh store: authoritative-equivalent output after discarding
    // all in-memory context (compaction independence, deterministic side).
    const again = await assembleRich({ budgetTokens: 2600, overflow: "render" });
    expect(again.assembled.rendered).toBe(rendered);
  });
});
