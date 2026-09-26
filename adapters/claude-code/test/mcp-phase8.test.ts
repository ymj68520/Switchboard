/**
 * Phase 8 MCP read tools: get_context and read_memory contract (directive
 * §20–§25, §39–§42, E24–E31).
 *
 * The Phase 7 surface tests (mcp-phase7.test.ts) still own the shared
 * authority chain; here we pin the Phase 8 read-side behavior: session
 * scoping, exact-revision semantics, detail levels, capability errors, and
 * read-only no-mutation guarantees.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { executePhasePlanTool, PHASE_PLAN_TOOLS, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { loadHostSecret } from "../src/host/secret.js";
import { createBlobStore } from "../src/store/blob-store.js";
import { createStoreContextSource } from "../src/application/context-read-model.js";
import { assembleContext } from "../src/context/assembler.js";
import { getHeadSnapshotRecord } from "../src/store/plan-memory.js";
import { memoryCounts } from "./proposal-helpers.js";
import { rawConnection, storePathsFor, fixedClock } from "./store-helpers.js";
import {
  addRevision,
  commitCheckpoint,
  hostToken,
  makeContextFixture,
  publishHead,
  sectionContent,
  type ContextFixture,
} from "./context-helpers.js";
import { CONSTRAINT_1, DECISION_1 } from "./proposal-helpers.js";

async function withFixture(fn: (fixture: ContextFixture, ctx: PhasePlanToolContext, secret: Buffer) => void | Promise<void>): Promise<void> {
  const fixture = await makeContextFixture();
  try {
    const secret = loadHostSecret(fixture.root).key;
    const ctx: PhasePlanToolContext = { store: fixture.store, secret, clock: fixedClock({ ids: ["x"] }), blobs: createBlobStore(path.join(fixture.root, "blobs")) };
    await fn(fixture, ctx, secret);
  } finally {
    fixture.close();
  }
}

const idsOf = (fixture: ContextFixture) => ({
  sessionId: fixture.sessionId,
  workspaceId: fixture.workspaceId,
  runId: fixture.runId,
  generation: fixture.generation,
});

describe("get_context (§20–§22, E24)", () => {
  it("returns the structured projection with a deterministic epoch; detail=recovery adds the capsule", async () => {
    await withFixture((fixture, ctx, secret) => {
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
      const args = { _hostContext: hostToken(secret, "get_context", {}, idsOf(fixture)) };
      const current = executePhasePlanTool(ctx, "get_context", args);
      expect(current.status).toBe("ok");
      const context = current.context as { epoch: string; run: { runId: string }; globalMemory: { hardConstraints: unknown[] } };
      expect(context.epoch).toMatch(/^[0-9a-f]{64}$/);
      expect(current.context_epoch).toBe(context.epoch);
      expect(context.run.runId).toBe(fixture.runId);
      expect(context.globalMemory.hardConstraints).toHaveLength(1);
      expect(current.recoveryCapsule).toBeUndefined();

      const recovery = executePhasePlanTool(ctx, "get_context", {
        detail: "recovery",
        _hostContext: hostToken(secret, "get_context", { detail: "recovery" }, idsOf(fixture)),
      });
      expect((recovery.recoveryCapsule as string).split("\n")[0]).toBe("[Phase Plan Recovery v1]");
      expect(recovery.context_epoch).toBe(current.context_epoch);
      // Read-only: committed state untouched.
      expect(memoryCounts(fixture.store).commits).toBe(1);
    });
  });

  it("is session-scoped: another session's token sees no run, and run_id input is rejected (§21/§40/§41)", async () => {
    await withFixture((fixture, ctx, secret) => {
      const stranger = hostToken(secret, "get_context", {}, { ...idsOf(fixture), sessionId: "S2-CLEAR", runId: undefined, generation: undefined });
      expect(executePhasePlanTool(ctx, "get_context", { _hostContext: stranger })).toEqual({ status: "no_active_run" });

      // The model cannot name a run: any extra business field is rejected.
      expect(() =>
        executePhasePlanTool(ctx, "get_context", {
          run_id: fixture.runId,
          _hostContext: hostToken(secret, "get_context", { run_id: fixture.runId }, idsOf(fixture)),
        }),
      ).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));

      // HostContext is mandatory, and binding to the tool is verified.
      expect(() => executePhasePlanTool(ctx, "get_context", {})).toThrowError(
        expect.objectContaining({ code: "HOST_CONTEXT_REQUIRED" }),
      );
      expect(() =>
        executePhasePlanTool(ctx, "get_context", { _hostContext: hostToken(secret, "get_state", {}, idsOf(fixture)) }),
      ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_TOOL_MISMATCH" }));
    });
  });

  it("accepts a read-only HostContext without plan mode (§39) and rejects unknown detail values", async () => {
    await withFixture((fixture, ctx, secret) => {
      const manual = { _hostContext: hostToken(secret, "get_context", {}, idsOf(fixture), { permissionMode: "default" }) };
      expect(executePhasePlanTool(ctx, "get_context", manual).status).toBe("ok");
      const badDetail = { detail: "everything" };
      expect(() =>
        executePhasePlanTool(ctx, "get_context", {
          ...badDetail,
          _hostContext: hostToken(secret, "get_context", badDetail, idsOf(fixture), { permissionMode: "default" }),
        }),
      ).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
    });
  });
});

describe("read_memory (§23–§25, E25–E28)", () => {
  it("reads all six artifact kinds with identity/summary/full details", async () => {
    await withFixture((fixture, ctx, secret) => {
      const refs = [
        addRevision(fixture, { kind: "constraint", artifactId: "C-1", content: CONSTRAINT_1, compactProjection: "C-1 short" }),
        addRevision(fixture, { kind: "decision", artifactId: "DEC-1", content: DECISION_1, compactProjection: "DEC-1 short" }),
        addRevision(fixture, {
          kind: "architecture",
          artifactId: "ARCH-1",
          content: { summary: "s", components: [], boundaries: [], dataFlows: [], principles: [], unresolvedQuestionRefs: [], decisionRefs: [] },
          compactProjection: "ARCH short",
        }),
        addRevision(fixture, { kind: "section", artifactId: "SEC-1", content: sectionContent("SEC-1", 1), compactProjection: "SEC-1 short" }),
        addRevision(fixture, { kind: "open_question", artifactId: "Q-1", content: { question: "q?", blocking: true, scope: "architecture", status: "open" }, compactProjection: "Q-1 short" }),
        addRevision(fixture, { kind: "conflict", artifactId: "X-1", content: { type: "t", refs: [], description: "d", severity: "hard", status: "open" }, compactProjection: "X-1 short" }),
      ];
      publishHead(fixture, refs);

      for (const ref of refs) {
        const base = { kind: ref.kind, id: ref.id, revision: ref.revision };
        const token = (business: Record<string, unknown>) => hostToken(secret, "read_memory", business, idsOf(fixture));
        const identityBusiness = { ...base, detail: "identity" };
        const identity = executePhasePlanTool(ctx, "read_memory", { ...identityBusiness, _hostContext: token(identityBusiness) });
        expect(identity).toEqual({
          status: "ok",
          ref: { runId: fixture.runId, kind: ref.kind, id: ref.id, revision: ref.revision },
        });
        const summary = executePhasePlanTool(ctx, "read_memory", { ...base, detail: "summary", _hostContext: token({ ...base, detail: "summary" }) });
        expect(summary.compactProjection).toContain("short");
        const full = executePhasePlanTool(ctx, "read_memory", { ...base, detail: "full", _hostContext: token({ ...base, detail: "full" }) });
        expect(full.content).toBeTruthy();
        expect(full.compactProjection).toContain("short");
      }
      // Default detail is summary.
      const base = { kind: "constraint" as const, id: "C-1", revision: 1 };
      const def = executePhasePlanTool(ctx, "read_memory", {
        ...base,
        _hostContext: hostToken(secret, "read_memory", base, idsOf(fixture)),
      });
      expect(def.compactProjection).toBe("C-1 short");
    });
  });

  it("contract detail is section-only and returns the frozen SectionContract (E27)", async () => {
    await withFixture((fixture, ctx, secret) => {
      addRevision(fixture, { kind: "decision", artifactId: "DEC-1", content: DECISION_1, compactProjection: "DEC-1" });
      addRevision(fixture, { kind: "section", artifactId: "SEC-1", content: sectionContent("SEC-1", 1), compactProjection: "SEC-1" });
      const sectionBusiness = { kind: "section", id: "SEC-1", revision: 1, detail: "contract" };
      const section = executePhasePlanTool(ctx, "read_memory", {
        ...sectionBusiness,
        _hostContext: hostToken(secret, "read_memory", sectionBusiness, idsOf(fixture)),
      });
      expect(section.contract).toMatchObject({ sectionId: "SEC-1", revision: 1, provides: ["provides:SEC-1"] });

      const decisionBusiness = { kind: "decision", id: "DEC-1", revision: 1, detail: "contract" };
      expect(() =>
        executePhasePlanTool(ctx, "read_memory", {
          ...decisionBusiness,
          _hostContext: hostToken(secret, "read_memory", decisionBusiness, idsOf(fixture)),
        }),
      ).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }));
    });
  });

  it("is exact-revision only: misses fail closed and cross-run reads never resolve (E25/E26/E28, §51)", async () => {
    await withFixture((fixture, ctx, secret) => {
      addRevision(fixture, { kind: "decision", artifactId: "DEC-1", content: DECISION_1, compactProjection: "DEC-1@1" });
      const other = fixture.runs.createPlanningRun({ workspaceId: fixture.workspaceId, sessionId: "S-OTHER", goal: "other" });
      addRevision({ ...fixture, runId: other.run.runId } as ContextFixture, {
        kind: "decision", artifactId: "DEC-1", content: { ...DECISION_1, title: "other run decision" }, compactProjection: "OTHER",
      });

      const missing = { kind: "decision", id: "DEC-1", revision: 2 };
      expect(() =>
        executePhasePlanTool(ctx, "read_memory", { ...missing, _hostContext: hostToken(secret, "read_memory", missing, idsOf(fixture)) }),
      ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_NOT_FOUND" }));

      // The current session's run owns the read scope: the same artifact id in
      // another run is unreachable (the ref's run is server-derived).
      const current = { kind: "decision", id: "DEC-1", revision: 1 };
      const view = executePhasePlanTool(ctx, "read_memory", {
        ...current,
        _hostContext: hostToken(secret, "read_memory", current, idsOf(fixture)),
      });
      expect((view.ref as { runId: string }).runId).toBe(fixture.runId);

      // Malformed refs are typed input errors.
      for (const bad of [
        { kind: "memory", id: "DEC-1", revision: 1 },
        { kind: "decision", id: "", revision: 1 },
        { kind: "decision", id: "DEC-1", revision: 0 },
        { kind: "decision", id: "DEC-1", revision: 1.5 },
        { kind: "decision", id: "DEC-1", revision: 1, detail: "latest" },
      ]) {
        expect(() =>
          executePhasePlanTool(ctx, "read_memory", { ...bad, _hostContext: hostToken(secret, "read_memory", bad, idsOf(fixture)) }),
        ).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
      }
    });
  });

  it("never mutates the store and leaves the schema unchanged (E22/E23/§48; Phase 9: v6)", async () => {
    await withFixture((fixture, ctx, secret) => {
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
      const before = memoryCounts(fixture.store);
      executePhasePlanTool(ctx, "get_context", { detail: "recovery", _hostContext: hostToken(secret, "get_context", { detail: "recovery" }, idsOf(fixture)) });
      const committed = getHeadSnapshotRecord(fixture.store, fixture.runId)!.refs.find((ref) => ref.kind === "constraint")!;
      const readBusiness = { kind: committed.kind, id: committed.id, revision: committed.revision };
      executePhasePlanTool(ctx, "read_memory", { ...readBusiness, _hostContext: hostToken(secret, "read_memory", readBusiness, idsOf(fixture)) });
      const missBusiness = { kind: "decision", id: "DEC-GHOST", revision: 1 };
      expect(() =>
        executePhasePlanTool(ctx, "read_memory", { ...missBusiness, _hostContext: hostToken(secret, "read_memory", missBusiness, idsOf(fixture)) }),
      ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_NOT_FOUND" }));
      expect(memoryCounts(fixture.store)).toEqual(before);
      const raw = rawConnection(storePathsFor(fixture.root).databasePath);
      try {
        const row = raw.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(row)[0]).toBe(7);
      } finally {
        raw.close();
      }
    });
  });
});

describe("Phase 8 tool surface (§42, E31)", () => {
  it("Phase 10 (§50): exposes exactly eight tools — revalidate_evidence joins the Phase 9 set", () => {
    expect(PHASE_PLAN_TOOLS.map((tool) => tool.name)).toEqual([
      "start_or_resume",
      "get_state",
      "get_context",
      "read_memory",
      "list_observations",
      "promote_evidence",
      "revalidate_evidence",
      "approve_proposal",
    ]);
    const joined = PHASE_PLAN_TOOLS.map((tool) => tool.name).join(",");
    for (const banned of ["prepare", "takeover", "abort", "submit_synthesis", "request_finalization", "set_evidence_state"]) {
      expect(joined).not.toContain(banned);
    }
  });

  it("get_context matches the assembler's structured output for the same state", async () => {
    await withFixture((fixture, ctx, secret) => {
      commitCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "DEC-1@1" }]);
      const result = executePhasePlanTool(ctx, "get_context", {
        _hostContext: hostToken(secret, "get_context", {}, idsOf(fixture)),
      });
      const direct = assembleContext(createStoreContextSource(fixture.store), fixture.runId);
      expect(result.context).toEqual(direct);
    });
  });
});
