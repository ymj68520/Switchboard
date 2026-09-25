/**
 * Phase 9 MCP surface (§21/§22/§44/§45/§58; E32/E33/E34/E37/E41).
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { executePhasePlanTool, PHASE_PLAN_TOOLS, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { REQUIRES_USER_INTERACTION_META } from "../src/mcp/tools.js";
import { loadHostSecret } from "../src/host/secret.js";
import { createBlobStore } from "../src/store/blob-store.js";
import { captureObservation } from "../src/observations/capture.js";
import { makePhase9Fixture, captureDeps, sourceEvent, writeSourceFile, type Phase9Fixture } from "./phase9-helpers.js";
import { hostToken } from "./context-helpers.js";
import { fixedClock } from "./store-helpers.js";

async function withPhase9(fn: (fixture: Phase9Fixture, ctx: PhasePlanToolContext, secret: Buffer) => void | Promise<void>): Promise<void> {
  const fixture = await makePhase9Fixture();
  try {
    const secret = loadHostSecret(fixture.root).key;
    const ctx: PhasePlanToolContext = {
      store: fixture.store,
      secret,
      clock: fixedClock({ ids: ["x", "ev", "evt"] }),
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

async function capturedSource(fixture: Phase9Fixture, relative = "src/mcp.txt") {
  writeSourceFile(fixture, relative, "MCP PROMOTION SOURCE beta\n");
  const outcome = await captureObservation(captureDeps(fixture), sourceEvent(fixture, relative));
  expect(outcome.status).toBe("captured");
  return (outcome as { status: "captured"; observation: { observationId: string } }).observation.observationId;
}

describe("Phase 9 tool schemas (§58, E41)", () => {
  it("promote_evidence never carries the interaction flag; schemas accept no run/workspace authority", () => {
    const promote = PHASE_PLAN_TOOLS.find((tool) => tool.name === "promote_evidence")!;
    expect(promote._meta).toBeUndefined();
    expect(promote.inputSchema.additionalProperties).toBe(false);
    const list = PHASE_PLAN_TOOLS.find((tool) => tool.name === "list_observations")!;
    expect(list.inputSchema.additionalProperties).toBe(false);
    for (const tool of [promote, list]) {
      const properties = Object.keys(tool.inputSchema.properties as Record<string, unknown>);
      for (const banned of ["run_id", "workspace_id", "session_id", "database_path", "workspace_path"]) {
        expect(properties).not.toContain(banned);
      }
    }
    const approve = PHASE_PLAN_TOOLS.find((tool) => tool.name === "approve_proposal")!;
    expect(approve._meta).toEqual(REQUIRES_USER_INTERACTION_META);
  });
});

describe("list_observations (§21/§22)", () => {
  it("returns no_active_run for an unbound session; requires the signed host context", async () => {
    await withPhase9(async (fixture, ctx, secret) => {
      // A session with NO binding of any kind has no run to observe.
      const token = hostToken(secret, "list_observations", {}, {
        sessionId: "S-never-bound",
        workspaceId: fixture.workspaceId,
      });
      expect(executePhasePlanTool(ctx, "list_observations", { _hostContext: token })).toEqual({ status: "no_active_run" });

      expect(() => executePhasePlanTool(ctx, "list_observations", {})).toThrowError(
        expect.objectContaining({ code: "HOST_CONTEXT_REQUIRED" }),
      );
    });
  });

  it("returns ledger summaries with provenance fields, never payloads", async () => {
    await withPhase9(async (fixture, ctx, secret) => {
      const observationId = await capturedSource(fixture);
      const token = hostToken(secret, "list_observations", {}, idsOf(fixture));
      const result = executePhasePlanTool(ctx, "list_observations", { _hostContext: token }) as {
        status: string;
        observations: Array<Record<string, unknown>>;
      };
      expect(result.status).toBe("ok");
      expect(result.observations).toHaveLength(1);
      const view = result.observations[0]!;
      expect(view).toMatchObject({
        observation_id: observationId,
        observation_seq: 1,
        class: "source",
        tool: "Read",
        input: { kind: "source", path: "src/mcp.txt" },
        promotable: true,
        evidence_refs: [],
      });
      expect(view.payload_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      // No raw payload bytes in the summary.
      expect(JSON.stringify(view)).not.toContain("MCP PROMOTION SOURCE beta");
    });
  });

  it("class filter, limit, and the seq cursor paginate deterministically", async () => {
    await withPhase9(async (fixture, ctx, secret) => {
      await capturedSource(fixture, "a.txt");
      await captureObservation(captureDeps(fixture, { clock: fixedClock({ ids: ["o2"] }) }), sourceEvent(fixture, "a.txt", { toolName: "Grep", toolUseId: "call_g", toolInput: { pattern: "x" } }));
      await captureObservation(captureDeps(fixture, { clock: fixedClock({ ids: ["o3"] }) }), sourceEvent(fixture, "a.txt", { toolName: "PowerShell", toolUseId: "call_e", toolInput: { command: "node --version" }, toolResponse: { stdout: "v", stderr: "", interrupted: false, isImage: false } }));
      const token = hostToken(secret, "list_observations", { limit: 2 }, idsOf(fixture));
      const page1 = executePhasePlanTool(ctx, "list_observations", { _hostContext: token, limit: 2 }) as {
        observations: Array<{ observation_seq: number }>;
        next_after?: string;
      };
      expect(page1.observations.map((o) => o.observation_seq)).toEqual([1, 2]);
      expect(page1.next_after).toBe("seq:2");
      const token2 = hostToken(secret, "list_observations", { limit: 2, after: page1.next_after }, idsOf(fixture));
      const page2 = executePhasePlanTool(ctx, "list_observations", { _hostContext: token2, limit: 2, after: page1.next_after }) as {
        observations: Array<{ observation_seq: number }>;
        next_after?: string;
      };
      expect(page2.observations.map((o) => o.observation_seq)).toEqual([3]);
      expect(page2.next_after).toBeUndefined();

      const token3 = hostToken(secret, "list_observations", { class: "execution" }, idsOf(fixture));
      const filtered = executePhasePlanTool(ctx, "list_observations", { _hostContext: token3, class: "execution" }) as {
        observations: Array<{ class: string }>;
      };
      expect(filtered.observations).toHaveLength(1);

      const token4 = hostToken(secret, "list_observations", { after: "garbage" }, idsOf(fixture));
      expect(() =>
        executePhasePlanTool(ctx, "list_observations", { _hostContext: token4, after: "garbage" }),
      ).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
      expect(() =>
        executePhasePlanTool(ctx, "list_observations", { _hostContext: token3, run_id: fixture.runId }),
      ).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
    });
  });

  it("exposes promoted Evidence references on the summarized observations (§1 minimal integration)", async () => {
    await withPhase9(async (fixture, ctx, secret) => {
      const observationId = await capturedSource(fixture);
      const business = {
        claim: "mcp file fact",
        kind: "source_fact",
        scope: { type: "global" },
        confidence: "direct",
        criticality: "supporting",
        observation_refs: [observationId],
      };
      const promoteToken = hostToken(secret, "promote_evidence", business, idsOf(fixture), { toolUseId: "TU-PROMO" });
      executePhasePlanTool(ctx, "promote_evidence", {
        _hostContext: promoteToken,
        ...business,
      });
      const listToken = hostToken(secret, "list_observations", {}, idsOf(fixture));
      const result = executePhasePlanTool(ctx, "list_observations", { _hostContext: listToken }) as {
        observations: Array<{ observation_id: string; evidence_refs: string[] }>;
      };
      expect(result.observations[0]!.evidence_refs).toHaveLength(1);
      expect(result.observations[0]!.evidence_refs[0]).toMatch(/^ev_.*@1$/);
    });
  });
});

describe("promote_evidence (§28/§44/§45)", () => {
  it("promotes through the signed context; retries with the same tool use are idempotent (E32/E33)", async () => {
    await withPhase9(async (fixture, ctx, secret) => {
      const observationId = await capturedSource(fixture);
      const business = {
        claim: "the source file declares beta",
        kind: "source_fact",
        scope: { type: "global" },
        confidence: "direct",
        criticality: "supporting",
        observation_refs: [observationId],
      };
      // The host token's business-input hash binds to the full args including
      // _hostContext-less business fields; sign accordingly for each call.
      const call = (extra: Record<string, unknown> = {}) =>
        executePhasePlanTool(ctx, "promote_evidence", {
          ...business,
          _hostContext: hostToken(secret, "promote_evidence", { ...business, ...extra }, idsOf(fixture), { toolUseId: "TU-1" }),
          ...extra,
        }) as { status: string; idempotent: boolean; evidence: { evidence_id: string; revision: number; validation_strategy: string } };

      const first = call();
      expect(first.status).toBe("ok");
      expect(first.idempotent).toBe(false);
      expect(first.evidence.evidence_id).toMatch(/^ev_/);
      expect(first.evidence.revision).toBe(1);
      expect(first.evidence.validation_strategy).toBe("fingerprint");

      const retry = call();
      expect(retry.idempotent).toBe(true);
      expect(retry.evidence.evidence_id).toBe(first.evidence.evidence_id);
    });
  });

  it("same tool use with different semantics → IDEMPOTENCY_CONFLICT (§44)", async () => {
    await withPhase9(async (fixture, ctx, secret) => {
      const observationId = await capturedSource(fixture);
      const call = (claim: string) =>
        executePhasePlanTool(ctx, "promote_evidence", {
          claim,
          kind: "source_fact",
          scope: { type: "global" },
          confidence: "direct",
          criticality: "supporting",
          observation_refs: [observationId],
          _hostContext: hostToken(secret, "promote_evidence", {
            claim,
            kind: "source_fact",
            scope: { type: "global" },
            confidence: "direct",
            criticality: "supporting",
            observation_refs: [observationId],
          }, idsOf(fixture), { toolUseId: "TU-DRIFT" }),
        });
      expect(call("first claim")).toMatchObject({ status: "ok" });
      expect(() => call("second claim")).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    });
  });

  it("rejects model-supplied authority fields and forged refs (E24/E34)", async () => {
    await withPhase9(async (fixture, ctx, secret) => {
      const observationId = await capturedSource(fixture);
      const call = (extra: Record<string, unknown>) =>
        executePhasePlanTool(ctx, "promote_evidence", {
          claim: "c",
          kind: "source_fact",
          scope: { type: "global" },
          confidence: "direct",
          criticality: "supporting",
          observation_refs: [observationId],
          _hostContext: hostToken(secret, "promote_evidence", {
            claim: "c",
            kind: "source_fact",
            scope: { type: "global" },
            confidence: "direct",
            criticality: "supporting",
            observation_refs: [observationId],
            ...extra,
          }, idsOf(fixture), { toolUseId: "TU-X" }),
          ...extra,
        });
      expect(() => call({ run_id: fixture.runId })).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
      expect(() => call({ payload_hash: "sha256:00" })).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
      expect(() => call({ source_hash: "sha256:01" })).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
      expect(() => call({ approved: true })).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
    });
  });

  it("wrong-tool or tampered host contexts fail closed", async () => {
    await withPhase9(async (fixture, ctx, secret) => {
      const token = hostToken(secret, "get_context", {}, idsOf(fixture));
      expect(() =>
        executePhasePlanTool(ctx, "promote_evidence", { _hostContext: token, claim: "c", kind: "source_fact", scope: { type: "global" }, confidence: "direct", criticality: "supporting" }),
      ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_TOOL_MISMATCH" }));
      expect(() =>
        executePhasePlanTool(ctx, "promote_evidence", { claim: "c", kind: "source_fact", scope: { type: "global" }, confidence: "direct", criticality: "supporting" }),
      ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_REQUIRED" }));
    });
  });
});
