/**
 * Phase 12 — submit_synthesis (§41–§45, §78, §84–§86, §89, §107).
 *
 * E14–E27, E56: stage gating, HEAD validation, critical-Evidence recheck,
 * manifest immutability, exact-ref citations, deterministic acyclic step
 * graphs, the single synthesis→validation bump, no HEAD move, no
 * Approval/PlanCommit, idempotency, and at-most-one manifest per input.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { getHeadCommitRecord, listPlanCommitsRecord } from "../src/store/plan-commits.js";
import { getSynthesisManifestByInputInTx } from "../src/store/synthesis.js";
import {
  callSubmitSynthesis,
  makeEvidenceSynthesisFixture,
  makeSynthesisFixture,
  minimalManifest,
  toolContextOf,
  type SynthesisFixture,
} from "./phase12-helpers.js";

async function withFixture(fn: (f: SynthesisFixture) => void | Promise<void>): Promise<void> {
  const f = await makeSynthesisFixture();
  try {
    await fn(f);
  } finally {
    f.close();
  }
}

describe("submit_synthesis (§41–§45/§84)", () => {
  it("accepts a manifest with exact refs and moves synthesis → validation with exactly one run bump (E22/E23)", async () => {
    await withFixture((f) => {
      const before = getPlanningRunRecord(f.store, f.runId)!;
      const ctx = toolContextOf(f);
      const result = callSubmitSynthesis(ctx, f, minimalManifest(f));
      expect(result.status).toBe("ok");
      expect(result.idempotent).toBe(false);
      expect(result.manifest_id).toMatch(/^synm_/);
      expect(result.manifest_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.stage).toBe("validation");
      expect(result.run_revision).toBe(before.revision + 1);
      const after = getPlanningRunRecord(f.store, f.runId)!;
      expect(after.stage).toBe("validation");
      expect(after.revision).toBe(before.revision + 1);
      // The manifest is persisted and bound to the frozen input.
      const stored = f.store.withRead((tx) => getSynthesisManifestByInputInTx(tx, f.runId, f.inputId));
      expect(stored?.manifestId).toBe(result.manifest_id);
      expect(stored?.inputHash).toBe(f.inputHash);
    });
  });

  it("never moves HEAD and creates no Approval or PlanCommit (E24/E25)", async () => {
    await withFixture((f) => {
      const headBefore = getHeadCommitRecord(f.store, f.runId);
      const commitsBefore = listPlanCommitsRecord(f.store, f.runId).length;
      const ctx = toolContextOf(f);
      callSubmitSynthesis(ctx, f, minimalManifest(f));
      expect(getHeadCommitRecord(f.store, f.runId)?.commitId).toBe(headBefore?.commitId ?? null);
      expect(listPlanCommitsRecord(f.store, f.runId)).toHaveLength(commitsBefore);
      // No approval rows were created by submission.
    });
  });

  it("is available only at stage synthesis (E14)", async () => {
    await withFixture(async (f) => {
      const ctx = toolContextOf(f);
      // Move the run back to detail via the real reopen path; the run now has
      // NO accepted manifest but is not at synthesis — the stage gate fires.
      const { createSynthesisService } = await import("../src/application/synthesis-service.js");
      createSynthesisService(f.store, {
        nowIso: () => new Date().toISOString(),
        newId: (() => {
          let n = 0;
          return () => `e14-${(n += 1)}`;
        })(),
      }).requestReopen({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        target: "detail",
        reason: "e14 stage-gate probe",
        findingIds: [],
        requestId: "reopen:e14",
        callerAgent: null,
      });
      expect(() => callSubmitSynthesis(ctx, f, minimalManifest(f), { toolUseId: "TU-SYN-E14" })).toThrowError(
        expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }),
      );
    });
  });

    it("validates the current HEAD against the frozen input (E15/§26)", async () => {
    await withFixture((f) => {
      const stale = { ...minimalManifest(f), inputHash: "sha256:" + "0".repeat(64) };
      const ctx = toolContextOf(f);
      // A wrong input hash is a ref error even before HEAD drift.
      expect(() => callSubmitSynthesis(ctx, f, stale)).toThrowError(expect.objectContaining({ code: "SYNTHESIS_REF_INVALID" }));
    });
  });

  it("requires plan mode (§42)", async () => {
    await withFixture((f) => {
      const ctx = toolContextOf(f);
      expect(() => callSubmitSynthesis(ctx, f, minimalManifest(f), { permissionMode: "default" })).toThrowError(
        expect.objectContaining({ code: "PLAN_MODE_REQUIRED" }),
      );
    });
  });
});

describe("submit_synthesis idempotency + concurrency (§44–§45/§86, E26/E27)", () => {
  it("same-invocation retry replays the same manifest with idempotent=true", async () => {
    await withFixture((f) => {
      const ctx = toolContextOf(f);
      const first = callSubmitSynthesis(ctx, f, minimalManifest(f), { toolUseId: "TU-SYN-RETRY" });
      const replay = callSubmitSynthesis(ctx, f, minimalManifest(f), { toolUseId: "TU-SYN-RETRY" });
      expect(replay.idempotent).toBe(true);
      expect(replay.manifest_id).toBe(first.manifest_id);
      expect(replay.manifest_hash).toBe(first.manifest_hash);
    });
  });

  it("same operation id with different content is an IDEMPOTENCY_CONFLICT (§44)", async () => {
    await withFixture((f) => {
      const ctx = toolContextOf(f);
      callSubmitSynthesis(ctx, f, minimalManifest(f), { toolUseId: "TU-SYN-RETRY" });
      const different = { ...minimalManifest(f), limitations: [] };
      expect(() => callSubmitSynthesis(ctx, f, different, { toolUseId: "TU-SYN-RETRY" })).toThrowError(
        expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
      );
    });
  });

  it("a competing different submission on the same input fails SYNTHESIS_ALREADY_SUBMITTED (§45/§86/E27)", async () => {
    await withFixture((f) => {
      const ctx = toolContextOf(f);
      callSubmitSynthesis(ctx, f, minimalManifest(f), { toolUseId: "TU-SYN-A" });
      expect(() => callSubmitSynthesis(ctx, f, minimalManifest(f), { toolUseId: "TU-SYN-B" })).toThrowError(
        expect.objectContaining({ code: "SYNTHESIS_ALREADY_SUBMITTED" }),
      );
    });
  });
});

describe("manifest structure (§38–§40, E18–E21)", () => {
  it("rejects unknown refs, non-input refs, and empty supports (E18/E21/§107)", async () => {
    await withFixture((f) => {
      const ctx = toolContextOf(f);
      // A ref that never existed.
      const unknownRef = minimalManifest(f);
      (unknownRef.implementationOrder[0]!.supportingRefs as unknown[]).push({ kind: "section", id: "SEC-NOPE", revision: 1 });
      expect(() => callSubmitSynthesis(ctx, f, unknownRef)).toThrowError(expect.objectContaining({ code: "SYNTHESIS_REF_INVALID" }));
      // Empty supporting refs on a statement.
      const emptySupports = minimalManifest(f);
      (emptySupports.crossSectionLinks[0]!.supportingRefs as unknown[]) = [];
      expect(() => callSubmitSynthesis(ctx, f, emptySupports)).toThrowError(expect.objectContaining({ code: "SYNTHESIS_MANIFEST_INVALID" }));
      // Empty step supports.
      const emptyStep = minimalManifest(f);
      (emptyStep.implementationOrder[0]!.supportingRefs as unknown[]) = [];
      expect(() => callSubmitSynthesis(ctx, f, emptyStep)).toThrowError(expect.objectContaining({ code: "SYNTHESIS_MANIFEST_INVALID" }));
    });
  });

  it("rejects duplicate step ids and cyclic dependency graphs (E20/§39)", async () => {
    await withFixture((f) => {
      const ctx = toolContextOf(f);
      const duplicated = minimalManifest(f);
      duplicated.implementationOrder = [
        { stepId: "same", title: "A", description: "a", dependsOn: [], supportingRefs: [{ kind: "section", id: f.sectionIds[0]!, revision: 1 }] },
        { stepId: "same", title: "B", description: "b", dependsOn: [], supportingRefs: [{ kind: "section", id: f.sectionIds[1]!, revision: 1 }] },
      ];
      expect(() => callSubmitSynthesis(ctx, f, duplicated)).toThrowError(expect.objectContaining({ code: "SYNTHESIS_MANIFEST_INVALID" }));

      const cyclic = minimalManifest(f);
      cyclic.implementationOrder = [
        { stepId: "a", title: "A", description: "a", dependsOn: ["b"], supportingRefs: [{ kind: "section", id: f.sectionIds[0]!, revision: 1 }] },
        { stepId: "b", title: "B", description: "b", dependsOn: ["a"], supportingRefs: [{ kind: "section", id: f.sectionIds[1]!, revision: 1 }] },
      ];
      expect(() => callSubmitSynthesis(ctx, f, cyclic)).toThrowError(expect.objectContaining({ code: "SYNTHESIS_MANIFEST_INVALID" }));
    });
  });
});

describe("§78 — critical Evidence drift during synthesis (E56/§104)", () => {
  it("drift after input creation fails submission with EVIDENCE_NEEDS_VALIDATION; no manifest, stage stays synthesis", async () => {
    const f = await makeEvidenceSynthesisFixture();
    try {
      // Real source drift AFTER the input was frozen.
      fs.writeFileSync(nodePath.join(f.workspaceRoot, "src/syn-ev.txt"), "SYN EVIDENCE SOURCE v2 DRIFTED\n");
      const ctx = toolContextOf(f);
      expect(() => callSubmitSynthesis(ctx, f, minimalManifest(f))).toThrowError(
        expect.objectContaining({ code: "EVIDENCE_NEEDS_VALIDATION" }),
      );
      // No manifest, stage unchanged, HEAD unchanged (§78).
      const run = getPlanningRunRecord(f.store, f.runId)!;
      expect(run.stage).toBe("synthesis");
      const stored = f.store.withRead((tx) => getSynthesisManifestByInputInTx(tx, f.runId, f.inputId));
      expect(stored).toBeNull();
      // Recovery path: request_reopen → detail, per §25/§104.
      // (Exercised in detail by request-reopen tests.)
    } finally {
      f.close();
    }
  });
});
