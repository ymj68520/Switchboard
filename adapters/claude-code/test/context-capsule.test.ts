/**
 * Phase 8 Recovery Capsule: deterministic rendering (§17), bounded-size
 * policy (§18), and the budget-priority rules that never silently drop a
 * hard constraint or blocking condition (§19, E14–E16).
 */

import { describe, expect, it } from "vitest";

import { assembleContext } from "../src/context/assembler.js";
import { buildRecoveryCapsule, RECOVERY_CAPSULE_MAX_CHARS } from "../src/context/capsule.js";
import { createStoreContextSource } from "../src/application/context-read-model.js";
import { CONSTRAINT_1 } from "./proposal-helpers.js";
import { addRevision, commitCheckpoint, makeContextFixture, publishHead, type ContextFixture } from "./context-helpers.js";

async function withFixture(fn: (fixture: ContextFixture) => void | Promise<void>): Promise<void> {
  const fixture = await makeContextFixture();
  try {
    await fn(fixture);
  } finally {
    fixture.close();
  }
}

async function capsuleFor(fn: (fixture: ContextFixture) => void, options?: { maxChars?: number }) {
  let capsule!: ReturnType<typeof buildRecoveryCapsule>;
  await withFixture((fixture) => {
    fn(fixture);
    const context = assembleContext(createStoreContextSource(fixture.store), fixture.runId);
    capsule = buildRecoveryCapsule(context, options);
  });
  return capsule;
}

describe("Recovery Capsule rendering (§17, E7/E14)", () => {
  it("renders a stable segmented shape for a fresh run", async () => {
    const capsule = await capsuleFor(() => {});
    expect(capsule.text.split("\n")[0]).toBe("[Phase Plan Recovery v1]");
    for (const marker of [
      "Run:",
      "HEAD:",
      "Hard constraints:",
      "Approved architecture: (none)",
      "Active scope: none",
      "Blocking:",
      "Awaiting proposal: (none)",
      "Committed sections:",
      "Available Phase Plan operations:",
    ]) {
      expect(capsule.text).toContain(marker);
    }
    expect(capsule.text).toContain("context_epoch=");
    expect(capsule.truncated).toBe(false);
    expect(capsule.text.length).toBeLessThanOrEqual(RECOVERY_CAPSULE_MAX_CHARS);
  });

  it("is byte-identical for identical Store state and independent of assembly order", async () => {
    await withFixture((fixture) => {
      const a = addRevision(fixture, { kind: "constraint", artifactId: "C-1", content: CONSTRAINT_1, compactProjection: "C-1" });
      const b = addRevision(fixture, { kind: "decision", artifactId: "DEC-1", content: { ...{ title: "t", statement: "s", rationale: "r", alternatives: [], consequences: [], scope: "x", supportingRefs: [] } }, compactProjection: "DEC-1" });
      publishHead(fixture, [a, b]);
      const source = createStoreContextSource(fixture.store);
      const one = buildRecoveryCapsule(assembleContext(source, fixture.runId));
      const two = buildRecoveryCapsule(assembleContext(source, fixture.runId));
      expect(one.text).toBe(two.text);
      expect(one.epoch).toBe(two.epoch);
    });
  });

  it("shows run identity, HEAD, hard constraints, and awaiting proposal facts", async () => {
    let runId = "";
    const capsule = await capsuleFor((fixture) => {
      runId = fixture.runId;
      // Real production path: engine commit creates HEAD C1, then the next
      // checkpoint proposal sits awaiting approval.
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
      fixture.proposals.prepareProposal({
        runId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        bindingGeneration: fixture.generation,
        expectedRunRevision: fixture.runRevision,
        type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: "Awaiting Title",
        summary: "Awaiting summary",
        changes: [{ op: "ADD_DECISION", content: { title: "t", statement: "s", rationale: "r", alternatives: [], consequences: [], scope: "x", supportingRefs: [] }, compactProjection: "DEC-A" }],
      });
    });
    expect(capsule.text).toContain(`id=${runId}`);
    expect(capsule.text).toContain("commit=CMT-");
    expect(capsule.text).toContain("snapshot=snap_");
    expect(capsule.text).toContain("- CONST-1@1 (user): No network access at runtime");
    expect(capsule.text).toContain("Awaiting proposal:");
    expect(capsule.text).toContain("title=Awaiting Title");
    expect(capsule.text).toContain("- approve_proposal");
  });
});

describe("Recovery Capsule budget (§18/§19, E15/E16)", () => {
  it("uses a documented default budget", () => {
    expect(RECOVERY_CAPSULE_MAX_CHARS).toBe(12_000);
  });

  it("keeps hard constraints and drops only P1 segments explicitly when the budget tightens", async () => {
    const capsule = await capsuleFor((fixture) => {
      const c = addRevision(fixture, { kind: "constraint", artifactId: "C-1", content: CONSTRAINT_1, compactProjection: "C-1" });
      const arch = addRevision(fixture, {
        kind: "architecture",
        artifactId: "ARCH-1",
        content: { summary: "s", components: [], boundaries: [], dataFlows: [], principles: [], unresolvedQuestionRefs: [], decisionRefs: [] },
        compactProjection: "ARCH-1@1 | long projection | ".padEnd(400, "x"),
      });
      publishHead(fixture, [c, arch]);
    }, { maxChars: 800 });
    expect(capsule.truncated).toBe(true);
    // P0 facts survive (E16 — never silently removed):
    expect(capsule.text).toContain("- C-1@1 (user): No network access at runtime");
    expect(capsule.text).toContain("context_epoch=");
    expect(capsule.text).toContain("Blocking:");
    expect(capsule.text).toContain("Awaiting proposal: (none)");
    // P1 omission is explicit, not silent:
    expect(capsule.text).toContain("Budget note: omitted due to capsule budget: approved architecture");
    expect(capsule.text).not.toContain("ARCH-1@1 | long projection");
  });

  it("fails closed with CONTEXT_BUDGET_EXCEEDED when P0 cannot fit (§19)", async () => {
    let caught: unknown;
    await withFixture((fixture) => {
      const c = addRevision(fixture, { kind: "constraint", artifactId: "C-1", content: CONSTRAINT_1, compactProjection: "C-1" });
      publishHead(fixture, [c]);
      const context = assembleContext(createStoreContextSource(fixture.store), fixture.runId);
      try {
        buildRecoveryCapsule(context, { maxChars: 80 });
      } catch (err) {
        caught = err;
      }
    });
    expect((caught as { code?: string }).code).toBe("CONTEXT_BUDGET_EXCEEDED");
  });

  it("keeps blocking conditions under budget pressure while dropping optional sections", async () => {
    const capsule = await capsuleFor((fixture) => {
      const c = addRevision(fixture, { kind: "constraint", artifactId: "C-1", content: CONSTRAINT_1, compactProjection: "C-1" });
      const q = addRevision(fixture, { kind: "open_question", artifactId: "Q-1", content: { question: "Blocking question?", blocking: true, scope: "architecture", status: "open" }, compactProjection: "Q-1" });
      const x = addRevision(fixture, { kind: "conflict", artifactId: "X-1", content: { type: "contradiction", refs: [], description: "Hard conflict!", severity: "hard", status: "open" }, compactProjection: "X-1" });
      const s1 = addRevision(fixture, { kind: "section", artifactId: "SEC-1", content: { title: "S", objective: "o", design: "d", interfaces: [], invariants: [], failureModes: [], dependencies: [], decisionRefs: [], openQuestionRefs: [], impactRefs: [], contract: { sectionId: "SEC-1", revision: 1, provides: [], requires: [], invariants: [], interfaces: [], decisions: [] } }, compactProjection: "SEC-1@1" });
      publishHead(fixture, [c, q, x, s1]);
    }, { maxChars: 1400 });
    expect(capsule.text).toContain("- Q-1@1: Blocking question?");
    expect(capsule.text).toContain("- X-1@1 (contradiction): Hard conflict!");
    expect(capsule.text).toContain("- C-1@1 (user): No network access at runtime");
    if (capsule.truncated) {
      expect(capsule.text).toContain("Budget note: omitted due to capsule budget:");
    }
  });
});
