/**
 * v0.2.0 Phase 8 — host tool inventory isolation tests (§12-§16).
 *
 * The per-call `tools` maps are OVERRIDES: a host tool absent from the map
 * stays enabled. The deny maps therefore must cover the host's COMPLETE
 * discovered inventory, not a hardcoded baseline. These tests prove:
 * - discovery from the host endpoint (ok / every failure shape);
 * - the Supervisor denies the whole discovered surface (§13/§19 E19);
 * - the Worker denies discovered tools unless capability-mapped (§14/§20 E20);
 * - an UNKNOWN host tool (`dangerous_new_tool`) is denied by default (§15 E21);
 * - an inventory CHANGE is denied at bundle reconstruction without protocol
 *   source changes (§16 E22);
 * - production bundle construction is fail-closed when no trusted inventory
 *   can be obtained (§13).
 */
import { describe, expect, it } from "vitest";

import {
  buildProductionSupervisedExecutionBundle,
  discoverHostToolNames,
  projectSupervisorToolMap,
  projectWorkerToolMap,
  baselineHostToolNames,
  InMemoryPlanStore,
  type ExecutionCapabilityEnvelope,
} from "../src/index.js";

const FULL_ENVELOPE: ExecutionCapabilityEnvelope = {
  repositoryRead: true,
  repositoryWrite: true,
  commandExecution: true,
  networkAccess: true,
  dependencyMutation: true,
  gitCommit: true,
  gitPush: true,
  externalServiceMutation: true,
};

/** The live 1.18 host surface observed during Phase 8 (subset used in tests). */
const LIVE_HOST_SURFACE = ["invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "websearch", "skill", "apply_patch"];

function fakeInventoryClient(tools: string[]) {
  return { tool: { ids: async () => ({ data: tools }) } };
}

describe("host tool inventory discovery (§12)", () => {
  it("discovers the complete host tool surface from the endpoint", async () => {
    const inventory = await discoverHostToolNames(fakeInventoryClient(LIVE_HOST_SURFACE));
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;
    expect(inventory.source).toBe("host_endpoint");
    expect(inventory.tools).toContain("apply_patch");
    expect(inventory.tools).toContain("websearch");
    expect(inventory.tools).toContain("skill");
    expect(inventory.tools).toContain("question");
    // deduplicated + sorted for deterministic deny maps
    const duped = await discoverHostToolNames(fakeInventoryClient(["bash", "bash", "read"]));
    expect(duped.ok && duped.tools).toEqual(["bash", "read"]);
  });

  it("fails closed on every unusable inventory shape", async () => {
    expect((await discoverHostToolNames({})).ok).toBe(false);
    expect((await discoverHostToolNames({ tool: {} })).ok).toBe(false);
    expect((await discoverHostToolNames({ tool: { ids: async () => ({ data: "bash" }) } })).ok).toBe(false);
    expect((await discoverHostToolNames({ tool: { ids: async () => ({ data: [42] }) } })).ok).toBe(false);
    expect((await discoverHostToolNames({ tool: { ids: async () => ({ data: [""] }) } })).ok).toBe(false);
    const throwing = await discoverHostToolNames({
      tool: { ids: async () => { throw new Error("endpoint gone"); } },
    });
    expect(throwing.ok).toBe(false);
    if (!throwing.ok) expect(throwing.reason).toContain("endpoint gone");
  });
});

describe("unknown tool is denied by default (§15)", () => {
  const discovered = [...LIVE_HOST_SURFACE, "dangerous_new_tool"];

  it("the Supervisor map denies every discovered host tool including the unknown one", () => {
    const tools = projectSupervisorToolMap(discovered);
    for (const name of [...discovered, ...baselineHostToolNames()]) {
      expect(tools[name]).toBe(false);
    }
    expect(tools["dangerous_new_tool"]).toBe(false);
    expect(tools["apply_patch"]).toBe(false);
    expect(tools["websearch"]).toBe(false);
    expect(tools["skill"]).toBe(false);
    expect(tools["question"]).toBe(false);
  });

  it("the Worker map denies the unknown tool even with a full capability envelope", () => {
    const { tools } = projectWorkerToolMap(FULL_ENVELOPE, discovered, ["ultraplan_start"]);
    expect(tools["dangerous_new_tool"]).toBe(false);
    expect(tools["task"]).toBe(false);
    expect(tools["skill"]).toBe(false);
    expect(tools["question"]).toBe(false);
    expect(tools["apply_patch"]).toBe(false);
    expect(tools["websearch"]).toBe(false);
    // capability-mapped baseline stays enabled under the full envelope
    expect(tools["read"]).toBe(true);
    expect(tools["edit"]).toBe(true);
    expect(tools["bash"]).toBe(true);
  });
});

describe("tool inventory change is denied without protocol source change (§16)", () => {
  it("a bundle reconstruction with a grown inventory denies the new tool", async () => {
    const before = ["bash", "read", "edit"];
    const after = ["bash", "read", "edit", "brand_new_future_tool"];
    const beforeMap = projectSupervisorToolMap(before);
    expect(beforeMap["brand_new_future_tool"]).toBeUndefined();
    const afterMap = projectSupervisorToolMap(after);
    expect(afterMap["brand_new_future_tool"]).toBe(false);
    // The Supervisor tool surface itself (execution operations) is unchanged.
    const workerBefore = projectWorkerToolMap(FULL_ENVELOPE, before, []);
    const workerAfter = projectWorkerToolMap(FULL_ENVELOPE, after, []);
    expect(workerAfter.tools["brand_new_future_tool"]).toBe(false);
    expect(workerAfter.tools["read"]).toBe(workerBefore.tools["read"]);
  });
});

describe("production bundle construction is inventory fail-closed (§13)", () => {
  type BundleOptions = Parameters<typeof buildProductionSupervisedExecutionBundle>[0];

  function bundleOptions(client: unknown): BundleOptions {
    return {
      projectID: "opencode-project:p8-inventory",
      client: client as BundleOptions["client"],
      store: new InMemoryPlanStore(),
      config: {},
    };
  }

  it("threads the discovered inventory into both runtime deny maps", async () => {
    const bundle = await buildProductionSupervisedExecutionBundle(bundleOptions(fakeInventoryClient(LIVE_HOST_SURFACE)));
    const supervisorTools = (bundle.supervisor as unknown as { options: { extraHostToolNames?: readonly string[] } }).options.extraHostToolNames ?? [];
    const workerTools = (bundle.worker as unknown as { options: { extraHostToolNames?: readonly string[] } }).options.extraHostToolNames ?? [];
    for (const name of LIVE_HOST_SURFACE) {
      expect(supervisorTools).toContain(name);
      expect(workerTools).toContain(name);
    }
  });

  it("refuses to build when no trusted inventory can be obtained", async () => {
    await expect(buildProductionSupervisedExecutionBundle(bundleOptions({}))).rejects.toThrow(/tool inventory/);
    await expect(
      buildProductionSupervisedExecutionBundle(
        bundleOptions({ tool: { ids: async () => { throw new Error("host too old"); } } }),
      ),
    ).rejects.toThrow(/host too old/);
  });
});
