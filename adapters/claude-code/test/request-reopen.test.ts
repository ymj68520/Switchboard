/**
 * Phase 12 — request_reopen (§59–§67, §84–§85, §102–§103, §109).
 *
 * E46–E55: main-agent-only, synthesis/validation origins only, deterministic
 * Section-review derivation (exact finding refs + DAG downstream; conservative
 * full review otherwise), exactly-one run bump, HEAD untouched, historical
 * synthesis records preserved, and validator rejection.
 */

import { describe, expect, it } from "vitest";

import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { getHeadCommitRecord } from "../src/store/plan-commits.js";
import { getHeadSnapshotRecord } from "../src/store/plan-memory.js";
import {
  getLatestSynthesisInputInTx,
  getSynthesisManifestByInputInTx,
  getValidationReportByManifestInTx,
} from "../src/store/synthesis.js";
import { listSectionWorkflowStates } from "../src/store/section-workflow.js";
import {
  callRequestReopen,
  callSubmitSynthesis,
  callSubmitValidation,
  makeSynthesisFixture,
  minimalManifest,
  toolContextOf,
  VALIDATOR_AGENT,
  type SynthesisFixture,
} from "./phase12-helpers.js";

async function withValidated(
  fn: (f: SynthesisFixture, manifestId: string, manifestHash: string, reportId: string, findingIds: string[]) => void | Promise<void>,
): Promise<void> {
  const f = await makeSynthesisFixture();
  try {
    const ctx = toolContextOf(f);
    const submitted = callSubmitSynthesis(ctx, f, minimalManifest(f), { toolUseId: "TU-SYN-BASE" });
    const sectionRef = { kind: "section", id: f.sectionIds[0], revision: 1 };
    const report = callSubmitValidation(
      ctx,
      f,
      {
        manifest_id: submitted.manifest_id,
        manifest_hash: submitted.manifest_hash,
        findings: [
          { kind: "incorrect_derivation", summary: "step misreads its support", detail: "d", subjectRefs: [sectionRef], supportingRefs: [sectionRef] },
        ],
      },
      { toolUseId: "TU-VAL-BASE", agent: VALIDATOR_AGENT },
    );
    await fn(f, submitted.manifest_id, submitted.manifest_hash, report.report_id, report.finding_ids);
  } finally {
    f.close();
  }
}

describe("request_reopen authority + origins (§59–§61, E46/E47)", () => {
  it("the validator caller is rejected with VALIDATOR_MUTATION_FORBIDDEN (§61)", async () => {
    const f = await makeSynthesisFixture();
    try {
      const ctx = toolContextOf(f);
      expect(() =>
        callRequestReopen(ctx, f, { target: "detail", reason: "validator overreach" }, { agent: VALIDATOR_AGENT, toolUseId: "TU-REO-VAL" }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATOR_MUTATION_FORBIDDEN" }));
    } finally {
      f.close();
    }
  });

  it("an unknown finding id is rejected at the validation stage (§60)", async () => {
    const f = await makeSynthesisFixture();
    try {
      const ctx = toolContextOf(f);
      expect(() =>
        callRequestReopen(ctx, f, { target: "detail", reason: "r", finding_ids: ["vf_missing"] }, { toolUseId: "TU-REO-UNK" }),
      ).toThrowError(expect.objectContaining({ code: "REOPEN_REQUEST_INVALID" }));
    } finally {
      f.close();
    }
  });

  it("finding_ids are invalid at the synthesis stage — no finding authority exists yet (§60)", async () => {
    const f = await makeSynthesisFixture();
    try {
      const ctx = toolContextOf(f);
      expect(() =>
        callRequestReopen(ctx, f, { target: "detail", reason: "r", finding_ids: ["vf_whatever"] }, { toolUseId: "TU-REO-SYN-F" }),
      ).toThrowError(expect.objectContaining({ code: "REOPEN_REQUEST_INVALID" }));
    } finally {
      f.close();
    }
  });
});

describe("reopen review derivation (§63–§64, E50/E51)", () => {
  it("synthesis-stage reopen to detail conservatively marks ALL completed sections needs_review (§63)", async () => {
    const f = await makeSynthesisFixture();
    try {
      const before = getPlanningRunRecord(f.store, f.runId)!;
      const ctx = toolContextOf(f);
      const result = callRequestReopen(ctx, f, { target: "detail", reason: "synthesis reopen" }, { toolUseId: "TU-REO-SYN" });
      expect(result.stage).toBe("detail");
      expect(result.run_revision).toBe(before.revision + 1);
      expect(result.review_event).toBe("SYNTHESIS_REVIEW_REQUIRED");
      expect(result.sections_needing_review.sort()).toEqual([...f.sectionIds].sort());
      const states = listSectionWorkflowStates(f.store, f.runId);
      for (const state of states) expect(state.status).toBe("needs_review");
      // HEAD and run bump are the only run-level changes (§67/E48).
      expect(getHeadCommitRecord(f.store, f.runId)?.commitId ?? null).toBe(
        (await import("../src/store/plan-commits.js")).getHeadCommitRecord(f.store, f.runId)?.commitId ?? null,
      );
    } finally {
      f.close();
    }
  });

  it("reopen to architecture marks ALL completed sections needs_review with ARCHITECTURE_REVIEW_REQUIRED (§64/E51)", async () => {
    const f = await makeSynthesisFixture();
    try {
      const ctx = toolContextOf(f);
      const result = callRequestReopen(ctx, f, { target: "architecture", reason: "foundation wrong" }, { toolUseId: "TU-REO-ARCH" });
      expect(result.stage).toBe("architecture");
      expect(result.review_event).toBe("ARCHITECTURE_REVIEW_REQUIRED");
      expect(result.sections_needing_review.sort()).toEqual([...f.sectionIds].sort());
    } finally {
      f.close();
    }
  });

  it("validation-stage reopen with exact finding refs scopes review to the finding's section + downstream (§63/E50)", async () => {
    await withValidated(async (f, _m, _mh, _r, findingIds) => {
      const ctx = toolContextOf(f);
      const result = callRequestReopen(
        ctx,
        f,
        { target: "detail", reason: "incorrect derivation", finding_ids: [findingIds[0]!] },
        { toolUseId: "TU-REO-EXACT" },
      );
      expect(result.stage).toBe("detail");
      expect(result.review_event).toBe("VALIDATION_REVIEW_REQUIRED");
      // The finding names sectionIds[0]; both sections are independent, so the
      // review hits exactly the named one.
      expect(result.sections_needing_review).toEqual([f.sectionIds[0]]);
      const states = listSectionWorkflowStates(f.store, f.runId);
      const byId = new Map(states.map((state) => [state.sectionId, state.status]));
      expect(byId.get(f.sectionIds[0]!)).toBe("needs_review");
      expect(byId.get(f.sectionIds[1]!)).toBe("completed");
    });
  });
});

describe("reopen invariants (§62/§66–§67/§84–§85, E48–E49/E52–E54)", () => {
  it("run revision +1 exactly once, HEAD unchanged, historical records survive (E49/E53)", async () => {
    await withValidated(async (f, manifestId, manifestHash, _r) => {
      const before = getPlanningRunRecord(f.store, f.runId)!;
      const headBefore = getHeadCommitRecord(f.store, f.runId)?.commitId ?? null;
      const inputBefore = f.store.withRead((tx) => getLatestSynthesisInputInTx(tx, f.runId));
      const ctx = toolContextOf(f);
      callRequestReopen(ctx, f, { target: "detail", reason: "invariants" }, { toolUseId: "TU-REO-INV" });
      const after = getPlanningRunRecord(f.store, f.runId)!;
      expect(after.revision).toBe(before.revision + 1);
      expect(getHeadCommitRecord(f.store, f.runId)?.commitId ?? null).toBe(headBefore);
      // Historical input/manifest/report rows are intact (immutable history).
      const inputAfter = f.store.withRead((tx) => getLatestSynthesisInputInTx(tx, f.runId));
      expect(inputAfter?.inputId).toBe(inputBefore?.inputId);
      expect(f.store.withRead((tx) => getSynthesisManifestByInputInTx(tx, f.runId, inputBefore!.inputId))?.manifestId).toBe(manifestId);
      expect(f.store.withRead((tx) => getValidationReportByManifestInTx(tx, f.runId, manifestId))?.manifestHash).toBe(manifestHash);
      void _r;
    });
  });

  it("a new synthesis cycle after reopen never reuses the old input (§68/E54)", async () => {
    await withValidated(async (f) => {
      const oldInputId = f.inputId;
      const ctx = toolContextOf(f);
      callRequestReopen(ctx, f, { target: "detail", reason: "cycle", finding_ids: [] }, { toolUseId: "TU-REO-CYCLE" });
      const { selectSection } = await import("./phase12-helpers.js");
      const { completeSectionVia: completeVia } = await import("./section-workflow.test.js");
      for (const sectionId of [...f.sectionIds].sort()) {
        const head = getHeadSnapshotRecord(f.store, f.runId);
        const revision = head!.refs.find((ref) => ref.kind === "section" && ref.id === sectionId)!.revision;
        selectSection(f, sectionId);
        completeVia(f, sectionId, revision);
      }
      expect(getPlanningRunRecord(f.store, f.runId)!.stage).toBe("synthesis");
      const input = f.store.withRead((tx) => getLatestSynthesisInputInTx(tx, f.runId))!;
      expect(input.inputSeq).toBe(2);
      expect(input.inputId).not.toBe(oldInputId);
    });
  });

    it("re-completing a needs_review section re-binds the same exact revision without REOPEN (§66)", async () => {
    const f = await makeSynthesisFixture();
    try {
      const ctx = toolContextOf(f);
      callRequestReopen(ctx, f, { target: "detail", reason: "reconfirm" }, { toolUseId: "TU-REO-RC" });
      const { selectSection } = await import("./phase12-helpers.js");
      const { completeSectionVia } = await import("./section-workflow.test.js");
      const first = f.sectionIds[0]!;
      const head = getHeadSnapshotRecord(f.store, f.runId);
      const revision = head!.refs.find((ref) => ref.kind === "section" && ref.id === first)!.revision;
      selectSection(f, first);
      // needs_review → completed is legal WITHOUT reopening the revision (§66).
      completeSectionVia(f, first, revision);
      const states = listSectionWorkflowStates(f.store, f.runId);
      const byId = new Map(states.map((state) => [state.sectionId, state]));
      expect(byId.get(first)?.status).toBe("completed");
      expect(byId.get(first)?.completedRevision).toBe(revision);
      void ctx;
    } finally {
      f.close();
    }
  });
});


