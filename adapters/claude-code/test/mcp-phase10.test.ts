/**
 * Phase 10 MCP surface — revalidate_evidence (§20–§29/§50/§51/§53; E37–E39).
 *
 * The signed HostContext gates every call; the operation id derives from the
 * signed tool use; the result is the §51 projection (never raw rows); no
 * state-setting primitive exists anywhere in the schema.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { executePhasePlanTool, PHASE_PLAN_TOOLS, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { loadHostSecret } from "../src/host/secret.js";
import { createBlobStore } from "../src/store/blob-store.js";
import { captureObservation } from "../src/observations/capture.js";
import { makePhase9Fixture, captureDeps, executionEvent, sourceEvent, writeSourceFile, type Phase9Fixture } from "./phase9-helpers.js";
import { hostToken } from "./context-helpers.js";
import { fixedClock } from "./store-helpers.js";

async function withPhase10(fn: (fixture: Phase9Fixture, ctx: PhasePlanToolContext, secret: Buffer) => void | Promise<void>): Promise<void> {
  const fixture = await makePhase9Fixture();
  try {
    const secret = loadHostSecret(fixture.root).key;
    const ctx: PhasePlanToolContext = {
      store: fixture.store,
      secret,
      clock: fixedClock({ ids: [] }),
      blobs: createBlobStore(path.join(fixture.root, "blobs")),
    };
    await fn(fixture, ctx, secret);
  } finally {
    fixture.close();
  }
}

function idsOf(fixture: Phase9Fixture) {
  return { sessionId: fixture.sessionId, workspaceId: fixture.workspaceId, runId: fixture.runId, generation: fixture.generation };
}

async function promoteSourceEvidence(fixture: Phase9Fixture, ctx: PhasePlanToolContext, secret: Buffer, content = "MCP GATE SOURCE\n") {
  writeSourceFile(fixture, "src/mcp10.txt", content);
  const outcome = await captureObservation(captureDeps(fixture), sourceEvent(fixture, "src/mcp10.txt"));
  expect(outcome.status).toBe("captured");
  const observationId = (outcome as { status: "captured"; observation: { observationId: string } }).observation.observationId;
  const business = {
    claim: "mcp source claim",
    kind: "source_fact",
    scope: { type: "global" },
    confidence: "direct",
    criticality: "critical",
    observation_refs: [observationId],
  };
  const token = hostToken(secret, "promote_evidence", business, idsOf(fixture), { toolUseId: `TU-P${(withPhase10Seq += 1)}` });
  const result = executePhasePlanTool(ctx, "promote_evidence", { ...business, _hostContext: token }) as {
    evidence: { evidence_id: string; revision: number };
    freshness: { state: string };
  };
  expect(result.freshness.state).toBe("fresh");
  return result.evidence;
}

let withPhase10Seq = 0;

function revalidateCall(
  ctx: PhasePlanToolContext,
  secret: Buffer,
  fixture: Phase9Fixture,
  args: Record<string, unknown>,
  toolUseId: string,
) {
  const token = hostToken(secret, "revalidate_evidence", args, idsOf(fixture), { toolUseId });
  return executePhasePlanTool(ctx, "revalidate_evidence", { ...args, _hostContext: token });
}

describe("revalidate_evidence (Phase 10 §20–§29/§51)", () => {
  it("schema: no _meta interaction flag, no state/force fields, no run/workspace authority (§28/§71)", () => {
    const tool = PHASE_PLAN_TOOLS.find((t) => t.name === "revalidate_evidence")!;
    expect(tool._meta).toBeUndefined();
    expect(tool.inputSchema.additionalProperties).toBe(false);
    const properties = Object.keys(tool.inputSchema.properties as Record<string, unknown>).sort();
    expect(properties).toEqual(["_hostContext", "assessment", "derived_from", "evidence_id", "mode", "observation_refs", "revision"]);
    for (const banned of ["state", "force", "skip_evidence", "assume_fresh", "ignore_invalidated", "allow_stale", "run_id", "workspace_id"]) {
      expect(properties).not.toContain(banned);
    }
  });

  it("mode=check revalidates a fingerprint revision and replays idempotently (§21/§27/E39)", async () => {
    await withPhase10(async (fixture, ctx, secret) => {
      const evidence = await promoteSourceEvidence(fixture, ctx, secret);
      writeSourceFile(fixture, "src/mcp10.txt", "changed\n");
      const args = { evidence_id: evidence.evidence_id, revision: evidence.revision, mode: "check" };
      const first = revalidateCall(ctx, secret, fixture, args, "TU-RV-1") as {
        status: string;
        idempotent: boolean;
        target: { current_state: string };
      };
      expect(first.status).toBe("source_changed");
      expect(first.idempotent).toBe(false);
      expect(first.target.current_state).toBe("needs_validation");
      // §51 shape: no raw SQLite rows.
      expect(Object.keys(first).sort()).toEqual(["idempotent", "reason", "status", "target"]);

      // Same tool use replayed → identical answer, idempotent flag set.
      const replay = revalidateCall(ctx, secret, fixture, args, "TU-RV-1") as typeof first;
      expect(replay).toMatchObject({ status: "source_changed", idempotent: true, target: { current_state: "needs_validation" } });

      // Same tool use, different semantics → IDEMPOTENCY_CONFLICT.
      writeSourceFile(fixture, "src/mcp10.txt", "MCP GATE SOURCE\n");
      expect(() =>
        revalidateCall(ctx, secret, fixture, { ...args, mode: "assess", assessment: "confirmed", observation_refs: ["obs_missing"] }, "TU-RV-1"),
      ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    });
  });

  it("mode=assess confirmed creates the fresh replacement and stales the target (§23)", async () => {
    await withPhase10(async (fixture, ctx, secret) => {
      const evidence = await promoteSourceEvidence(fixture, ctx, secret);
      writeSourceFile(fixture, "src/mcp10.txt", "changed\n");
      revalidateCall(ctx, secret, fixture, { evidence_id: evidence.evidence_id, revision: evidence.revision, mode: "check" }, "TU-RV-2");

      const reread = await captureObservation(
        captureDeps(fixture),
        sourceEvent(fixture, "src/mcp10.txt", { toolUseId: "call_mcp_reread" }),
      );
      const observationId = (reread as { status: "captured"; observation: { observationId: string } }).observation.observationId;
      const result = revalidateCall(
        ctx,
        secret,
        fixture,
        {
          evidence_id: evidence.evidence_id,
          revision: evidence.revision,
          mode: "assess",
          assessment: "confirmed",
          observation_refs: [observationId],
        },
        "TU-RV-3",
      ) as { status: string; target: { current_state: string }; replacement: { revision: number; state: string } };
      expect(result.status).toBe("confirmed");
      expect(result.target.current_state).toBe("stale");
      expect(result.replacement).toEqual({ evidence_id: evidence.evidence_id, revision: evidence.revision + 1, state: "fresh" });
    });
  });

  it("check on reobserve evidence and non-current revisions fail with typed codes (§21/§26)", async () => {
    await withPhase10(async (fixture, ctx, secret) => {
      // A reobserve-strategy claim: direct confidence citing an EXECUTION
      // observation (the strategy rule never yields fingerprint for it).
      const observationId = await (async () => {
        const outcome = await captureObservation(captureDeps(fixture), executionEvent(fixture, "reobserve probe"));
        expect(outcome.status).toBe("captured");
        return (outcome as { status: "captured"; observation: { observationId: string } }).observation.observationId;
      })();
      const promotionBusiness = {
        claim: "execution claim",
        kind: "execution_result",
        scope: { type: "global" },
        confidence: "direct",
        criticality: "supporting",
        observation_refs: [observationId],
      };
      const promoteToken = hostToken(secret, "promote_evidence", promotionBusiness, idsOf(fixture), { toolUseId: "TU-PX" });
      const execution = executePhasePlanTool(ctx, "promote_evidence", { ...promotionBusiness, _hostContext: promoteToken }) as {
        evidence: { evidence_id: string; revision: number };
      };
      // Locators/execution → reobserve strategy → mode=check is invalid.
      expect(() =>
        revalidateCall(
          ctx,
          secret,
          fixture,
          { evidence_id: execution.evidence.evidence_id, revision: execution.evidence.revision, mode: "check" },
          "TU-RV-4",
        ),
      ).toThrowError(expect.objectContaining({ code: "EVIDENCE_REVALIDATION_INVALID" }));
      // Unknown evidence → typed not-found.
      expect(() =>
        revalidateCall(ctx, secret, fixture, { evidence_id: "ev_nope", revision: 1, mode: "check" }, "TU-RV-5"),
      ).toThrowError(expect.objectContaining({ code: "EVIDENCE_REVISION_NOT_FOUND" }));
    });
  });

  it("unsigned calls never reach the store (§38/E38)", async () => {
    await withPhase10(async (_fixture, ctx) => {
      expect(() => executePhasePlanTool(ctx, "revalidate_evidence", { evidence_id: "ev_x", revision: 1, mode: "check" })).toThrowError(
        expect.objectContaining({ code: "HOST_CONTEXT_REQUIRED" }),
      );
    });
  });
});
