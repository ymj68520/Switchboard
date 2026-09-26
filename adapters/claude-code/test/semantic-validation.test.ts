/**
 * Phase 12 — submit_validation (§46–§58, §79, §87–§88, §108).
 *
 * E35–E43, E57–E58, E63: frozen finding vocabulary, clean exclusivity,
 * bundle-bound refs, validator-only caller attestation, immutability, one
 * report per manifest, idempotency, and the no-stage/no-revision/no-HEAD
 * invariants.
 */

import { describe, expect, it } from "vitest";

import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { getHeadCommitRecord } from "../src/store/plan-commits.js";
import { getValidationReportByManifestInTx, getSynthesisManifestByInputInTx } from "../src/store/synthesis.js";
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

async function withValidatedManifest(
  fn: (f: SynthesisFixture, manifestId: string, manifestHash: string) => void | Promise<void>,
): Promise<void> {
  const f = await makeSynthesisFixture();
  try {
    const ctx = toolContextOf(f);
    const submitted = callSubmitSynthesis(ctx, f, minimalManifest(f), { toolUseId: "TU-SYN-BASE" });
    await fn(f, submitted.manifest_id, submitted.manifest_hash);
  } finally {
    f.close();
  }
}

describe("submit_validation caller attestation (§5/§53, E32/E33/E63)", () => {
  it("a main-session call (no agent attestation) fails VALIDATOR_CALLER_REQUIRED even with a perfect payload (§98)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      expect(() =>
        callSubmitValidation(
          ctx,
          f,
          { manifest_id: manifestId, manifest_hash: manifestHash, findings: [{ kind: "clean", summary: "no findings", detail: "n" }] },
          { agent: undefined, toolUseId: "TU-VAL-MAIN" },
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATOR_CALLER_REQUIRED" }));
    });
  });

  it("a non-validator agentType fails closed (§53)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      expect(() =>
        callSubmitValidation(
          ctx,
          f,
          { manifest_id: manifestId, manifest_hash: manifestHash, findings: [{ kind: "clean", summary: "n", detail: "n" }] },
          { agent: { agentId: "agent_x", agentType: "phase12-probe:other" }, toolUseId: "TU-VAL-OTHER" },
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATOR_CALLER_REQUIRED" }));
    });
  });
});

describe("submit_validation report semantics (§47–§51/§58, E35–E39)", () => {
  it("accepts the validator's clean report; isClean is CORE-derived (§48)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      const result = callSubmitValidation(
        ctx,
        f,
        { manifest_id: manifestId, manifest_hash: manifestHash, findings: [{ kind: "clean", summary: "no semantic findings", detail: "bundle is consistent" }] },
        { toolUseId: "TU-VAL-CLEAN", agent: VALIDATOR_AGENT },
      );
      expect(result.status).toBe("ok");
      expect(result.is_clean).toBe(true);
      expect(result.report_id).toMatch(/^valrep_/);
      expect(result.report_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      const stored = f.store.withRead((tx) => getValidationReportByManifestInTx(tx, f.runId, manifestId));
      expect(stored?.isClean).toBe(true);
    });
  });

  it("accepts all non-clean kinds and records their findings immutably (§47/E35)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      const sectionRef = { kind: "section", id: f.sectionIds[0], revision: 1 };
      const findings = (["unsupported_new_fact", "contradiction", "missing_design", "missing_dependency", "incorrect_derivation", "coverage_gap"] as const)
        .map((kind) => ({ kind, summary: `${kind} found`, detail: "explanation", subjectRefs: [sectionRef], supportingRefs: [sectionRef] }));
      const result = callSubmitValidation(
        ctx,
        f,
        { manifest_id: manifestId, manifest_hash: manifestHash, findings },
        { toolUseId: "TU-VAL-KINDS", agent: VALIDATOR_AGENT },
      );
      expect(result.is_clean).toBe(false);
      expect(result.finding_ids).toHaveLength(6);
      for (const findingId of result.finding_ids) expect(findingId).toMatch(/^vf_/);
    });
  });

  it("clean mixed with any other finding is rejected (§48/E36)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      expect(() =>
        callSubmitValidation(
          ctx,
          f,
          {
            manifest_id: manifestId,
            manifest_hash: manifestHash,
            findings: [
              { kind: "clean", summary: "n", detail: "n" },
              { kind: "contradiction", summary: "s", detail: "d", subjectRefs: [{ kind: "section", id: f.sectionIds[0], revision: 1 }] },
            ],
          },
          { toolUseId: "TU-VAL-MIX", agent: VALIDATOR_AGENT },
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_REPORT_INVALID" }));
    });
  });

  it("an empty findings array is rejected (§48)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      expect(() =>
        callSubmitValidation(ctx, f, { manifest_id: manifestId, manifest_hash: manifestHash, findings: [] }, { toolUseId: "TU-VAL-EMPTY", agent: VALIDATOR_AGENT }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_REPORT_INVALID" }));
    });
  });

  it("refs outside the frozen bundle are rejected (§37/E37)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      expect(() =>
        callSubmitValidation(
          ctx,
          f,
          {
            manifest_id: manifestId,
            manifest_hash: manifestHash,
            findings: [{ kind: "contradiction", summary: "s", detail: "d", subjectRefs: [{ kind: "section", id: "SEC-OUTSIDE", revision: 1 }] }],
          },
          { toolUseId: "TU-VAL-OUT", agent: VALIDATOR_AGENT },
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_REPORT_INVALID" }));
    });
  });

  it("a second, different report for the same manifest fails VALIDATION_ALREADY_SUBMITTED (§58/§87/E39)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      callSubmitValidation(
        ctx,
        f,
        { manifest_id: manifestId, manifest_hash: manifestHash, findings: [{ kind: "clean", summary: "n", detail: "n" }] },
        { toolUseId: "TU-VAL-FIRST", agent: VALIDATOR_AGENT },
      );
      expect(() =>
        callSubmitValidation(
          ctx,
          f,
          {
            manifest_id: manifestId,
            manifest_hash: manifestHash,
            findings: [{ kind: "coverage_gap", summary: "s", detail: "d", subjectRefs: [{ kind: "section", id: f.sectionIds[0], revision: 1 }] }],
          },
          { toolUseId: "TU-VAL-SECOND", agent: VALIDATOR_AGENT },
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ALREADY_SUBMITTED" }));
    });
  });

  it("same-invocation retry replays idempotently (§57/E40)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      const first = callSubmitValidation(
        ctx,
        f,
        { manifest_id: manifestId, manifest_hash: manifestHash, findings: [{ kind: "clean", summary: "n", detail: "n" }] },
        { toolUseId: "TU-VAL-RETRY", agent: VALIDATOR_AGENT },
      );
      const replay = callSubmitValidation(
        ctx,
        f,
        { manifest_id: manifestId, manifest_hash: manifestHash, findings: [{ kind: "clean", summary: "n", detail: "n" }] },
        { toolUseId: "TU-VAL-RETRY", agent: VALIDATOR_AGENT },
      );
      expect(replay.idempotent).toBe(true);
      expect(replay.report_id).toBe(first.report_id);
    });
  });
});

describe("submit_validation moves nothing (§56, E41–E43)", () => {
  it("stage stays validation, run revision unchanged, HEAD unchanged", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const before = getPlanningRunRecord(f.store, f.runId)!;
      const headBefore = getHeadCommitRecord(f.store, f.runId)?.commitId ?? null;
      const ctx = toolContextOf(f);
      callSubmitValidation(
        ctx,
        f,
        {
          manifest_id: manifestId,
          manifest_hash: manifestHash,
          findings: [{ kind: "missing_design", summary: "s", detail: "d", subjectRefs: [{ kind: "section", id: f.sectionIds[0], revision: 1 }] }],
        },
        { toolUseId: "TU-VAL-NOOP", agent: VALIDATOR_AGENT },
      );
      const after = getPlanningRunRecord(f.store, f.runId)!;
      expect(after.stage).toBe("validation");
      expect(after.revision).toBe(before.revision);
      expect(getHeadCommitRecord(f.store, f.runId)?.commitId ?? null).toBe(headBefore);
    });
  });

  it("a stale manifest/input identity fails VALIDATION_STALE (§55/§79/§88)", async () => {
    await withValidatedManifest(async (f, manifestId, manifestHash) => {
      const ctx = toolContextOf(f);
      // Reopen the run (stage leaves validation); the validator's in-flight
      // submission must now fail VALIDATION_STALE, never persist (§88).
      callRequestReopen(ctx, f, { target: "detail", reason: "reopen race probe" }, { toolUseId: "TU-REO-RACE" });
      expect(() =>
        callSubmitValidation(
          ctx,
          f,
          { manifest_id: manifestId, manifest_hash: manifestHash, findings: [{ kind: "clean", summary: "n", detail: "n" }] },
          { toolUseId: "TU-VAL-LATE", agent: VALIDATOR_AGENT },
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_STALE" }));
      // The historical manifest/report state is untouched.
      const manifest = f.store.withRead((tx) => getSynthesisManifestByInputInTx(tx, f.runId, f.inputId));
      expect(manifest).not.toBeNull();
      expect(f.store.withRead((tx) => getValidationReportByManifestInTx(tx, f.runId, manifestId))).toBeNull();
    });
  });
});
