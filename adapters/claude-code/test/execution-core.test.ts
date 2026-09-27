/**
 * Phase 14 pure core — ExecutionHandoffV1 hashing/renderer (§23–§31/§107/§132)
 * and ExecutionHostContextV1 signing + cross-authority fencing (§53–§56).
 */
import { describe, expect, it } from "vitest";

import { randomBytes } from "node:crypto";

import { canonicalJson } from "../src/core/canonical-json.js";
import {
  executionHandoffHash,
  renderExecutionContract,
  type ExecutionHandoffV1,
} from "../src/core/execution-handoff.js";
import { encodeHostContextToken, buildHostContextEnvelope, verifyHostContext } from "../src/host/host-context.js";
import {
  assertExecutionHostContextForTool,
  encodeExecutionHostContextToken,
  buildExecutionHostContextEnvelope,
  parseSignedHostContext,
  verifyExecutionHostContext,
} from "../src/host/execution-context.js";
import { hostToken } from "./context-helpers.js";

const SECRET = randomBytes(32);

function baseHandoff(): ExecutionHandoffV1 {
  return {
    version: 1,
    finalPlan: { id: "fplan_x", revision: 1, hash: "sha256:aa" },
    repositoryBaseline: { kind: "git", revision: "a".repeat(40) },
    goal: "Build the thing",
    hardConstraints: [{ id: "CON-2", revision: 1 }, { id: "CON-1", revision: 3 }],
    architectureRef: { id: "ARCH-1", revision: 2 },
    implementationSteps: [
      { stepId: "s2", title: "second", description: "after", dependsOn: ["s1"], supportingRefs: [] },
      { stepId: "s1", title: "first", description: "start", dependsOn: [], supportingRefs: [] },
    ],
    requiredContracts: [{ sectionId: "SEC-B", revision: 2 }, { sectionId: "SEC-A", revision: 1 }],
    criticalDecisions: [{ id: "DEC-1", revision: 1 }],
    knownLimitations: [{ statement: "known limit", supportingRefs: [] }],
    validationRequirements: [],
  };
}

describe("ExecutionHandoffV1 hash (§31, E11)", () => {
  it("is deterministic and collection-order independent; implementation order is semantic", () => {
    const a = executionHandoffHash(baseHandoff());
    const reordered = baseHandoff();
    reordered.hardConstraints = [...reordered.hardConstraints].reverse();
    reordered.requiredContracts = [...reordered.requiredContracts].reverse();
    reordered.criticalDecisions = [...reordered.criticalDecisions].reverse();
    expect(executionHandoffHash(reordered)).toBe(a);
    const swapped = baseHandoff();
    swapped.implementationSteps = [...swapped.implementationSteps].reverse();
    expect(executionHandoffHash(swapped)).not.toBe(a);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when content changes; identical content from a fresh derivation hashes identically", () => {
    const a = executionHandoffHash(baseHandoff());
    const different = baseHandoff();
    different.goal = "different";
    expect(executionHandoffHash(different)).not.toBe(a);
    const same = baseHandoff();
    expect(executionHandoffHash(same)).toBe(a);
  });
});

describe("Execution Contract renderer (§60/§77/§107/§132, E47)", () => {
  it("renders the deterministic contract with the replanning boundary and no secrets", () => {
    const handoff = baseHandoff();
    const a = renderExecutionContract(handoff, { handoffId: "xhandoff_1", handoffHash: "sha256:bb" });
    const b = renderExecutionContract(baseHandoff(), { handoffId: "xhandoff_1", handoffHash: "sha256:bb" });
    expect(a).toBe(b);
    expect(a).toContain("[Phase Plan Execution Contract v1]");
    expect(a).toContain("fplan_x (sha256:aa)");
    expect(a).toContain("Repository baseline: git @ " + "a".repeat(40));
    expect(a).toContain("s1: first — start");
    expect(a).toContain("s2: second — after (after s1)");
    expect(a).toContain("SEC-A@1, SEC-B@2");
    expect(a).toContain("Replanning is required if execution would change:");
    expect(a).toContain("- SectionContract");
    expect(a).toContain("Plan Memory is read-only under the execution contract.");
    // §132 — no host secrets, session identity, signatures, or db paths.
    expect(a).not.toContain("signature");
    expect(a).not.toContain("sess");
    expect(a).not.toContain("phase-plan.sqlite3");
  });
});

describe("ExecutionHostContextV1 (§53–§56, E42/E44/E45)", () => {
  const envelope = buildExecutionHostContextEnvelope({
    sessionId: "sess-1",
    workspaceId: "ws-1",
    runId: "plan-1",
    finalPlanId: "fplan_x",
    executionBindingGeneration: 3,
    permissionMode: "default",
    toolUseId: "call_1",
    toolName: "mcp__plugin_phase-plan_phase-plan__get_state",
    businessInputHash: "hash-1",
  });

  it("round-trips through encode/verify with the execution domain", () => {
    const token = encodeExecutionHostContextToken(SECRET, envelope);
    const verified = verifyExecutionHostContext(SECRET, token);
    expect(verified).toEqual(envelope);
  });

  it("fails closed on tampering and on the planning domain", () => {
    const token = encodeExecutionHostContextToken(SECRET, envelope);
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
    parsed.runId = "plan-forged";
    const tampered = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
    expect(() => verifyExecutionHostContext(SECRET, tampered)).toThrowError(/signature/);
    // a planning context has no authority field and is rejected before HMAC
    const planning = encodeHostContextToken(SECRET, buildHostContextEnvelope({
      sessionId: "sess-1", workspaceId: "ws-1", permissionMode: "plan",
      toolUseId: "call_2", toolName: "get_state", businessInputHash: "h",
    }));
    expect(() => verifyExecutionHostContext(SECRET, planning)).toThrowError(/execution authority/);
  });

  it("a signed Planning HostContext can never be replayed as execution authority (E44) and vice versa (E45)", () => {
    const planningToken = hostToken(SECRET, "get_state", {}, { sessionId: "sess-1", workspaceId: "ws-1", runId: "plan-1", generation: 1 }, { permissionMode: "plan" });
    const parsed = parseSignedHostContext(SECRET, planningToken);
    expect(parsed.authority).toBe("planning");
    const execToken = encodeExecutionHostContextToken(SECRET, envelope);
    const parsedExec = parseSignedHostContext(SECRET, execToken);
    expect(parsedExec.authority).toBe("execution");
    // the planning verifier refuses the execution token
    expect(() => verifyHostContext(SECRET, execToken)).toThrowError();
    // the execution assert refuses a token signed for another tool
    expect(() => assertExecutionHostContextForTool(SECRET, execToken, { tool: "read_memory", businessInput: {} })).toThrowError(/signed for tool/);
  });

  it("canonical JSON of the envelope is stable (signatures never depend on key order)", () => {
    const token = encodeExecutionHostContextToken(SECRET, envelope);
    const once = canonicalJson(verifyExecutionHostContext(SECRET, token));
    const flipped = buildExecutionHostContextEnvelope({ ...envelope });
    expect(canonicalJson(flipped)).toBe(once);
  });
});
