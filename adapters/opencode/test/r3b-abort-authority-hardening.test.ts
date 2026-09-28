/**
 * RF-02 — abort authority fail-closed (terminal-abort confirmation hardening).
 *
 * Discovered during the v0.1 completion re-inspection: while the RF-01 fix
 * hardened the Proposal-approval ask, the terminal-abort confirmation
 * (`ultraplan_request_abort`) still issued `ToolContext.ask` with an EMPTY
 * patterns list. The host evaluates permission rules only inside its loop
 * over patterns, so `patterns: []` skipped evaluation entirely — an implicit
 * ALLOW under every configuration. The abort could therefore execute without
 * a human confirmation, defeating the frozen R1 abort contract (REAL one-shot
 * user decision → abortRun).
 *
 * The fix mirrors RF-01 under the abort's own namespace, pinned here:
 *   1. the abort ask carries a NON-EMPTY pattern (the exact active run ID the
 *      Harness derived — the model supplies nothing), so the host actually
 *      evaluates permission rules and can pend; `always` stays empty;
 *   2. applyToConfig forces `"ultraplan.abort.*" → "ask"` (agent-scoped AND
 *      in the resolved global permission config, re-appended LAST so
 *      last-match resolution outranks any earlier wildcard) while preserving
 *      every unrelated user permission verbatim, alongside the RF-01
 *      approval rule.
 */
import { describe, expect, it } from "vitest";

import { InMemoryPlanStore } from "../src/index.js";
import type { PlanningRun } from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";
import { OpenCodeRuntimeAdapter, DEFAULT_PLANNING_RUNTIME_SPEC } from "../src/runtime/opencode-plugin.js";
import type { Config as OpenCodeConfig } from "@opencode-ai/plugin";
import { admittedStart, fakeToolContext } from "./helpers.js";
import type { CapturedAsk } from "./helpers.js";
import { createUltraPlanTools } from "../src/tools/registry.js";

const FIXED = "2026-09-28T12:00:00.000Z";
const GOAL = "Build the durable planning harness";

function adapter(): OpenCodeRuntimeAdapter {
  return new OpenCodeRuntimeAdapter(DEFAULT_PLANNING_RUNTIME_SPEC);
}

function makeWorld() {
  const store = new InMemoryPlanStore(() => FIXED);
  const controller = new UltraPlanController({ store, now: () => FIXED });
  return { store, controller };
}

async function activeRunWorld() {
  const world = makeWorld();
  const run = (await admittedStart(world.controller, "ses_r3b", GOAL)).run;
  return { ...world, run };
}

// -----------------------------------------------------------------------------
// Config enforcement (§5, §8)
// -----------------------------------------------------------------------------

describe("RF-02 — applyToConfig forces the abort permission to ask", () => {
  it("forces ultraplan.approval:* AND ultraplan.abort.* → ask on a default (empty) config", () => {
    const config = {} as OpenCodeConfig;
    adapter().applyToConfig(config);
    const permission = config.permission as Record<string, unknown>;
    expect(permission["ultraplan.approval:*"]).toBe("ask");
    expect(permission["ultraplan.abort.*"]).toBe("ask");
    expect(config.agent?.[DEFAULT_PLANNING_RUNTIME_SPEC.agentName]?.permission).toEqual({
      "ultraplan.approval:*": "ask",
      "ultraplan.abort.*": "ask",
    });
  });

  it("preserves unrelated user permissions verbatim", () => {
    const config = {
      permission: {
        bash: "ask",
        edit: "allow",
        webfetch: "deny",
        external_directory: { "*": "ask" },
        read: { "*.env": "ask" },
      },
    } as unknown as OpenCodeConfig;
    adapter().applyToConfig(config);
    const permission = config.permission as Record<string, unknown>;
    expect(permission["bash"]).toBe("ask");
    expect(permission["edit"]).toBe("allow");
    expect(permission["webfetch"]).toBe("deny");
    expect(permission["external_directory"]).toEqual({ "*": "ask" });
    expect(permission["read"]).toEqual({ "*.env": "ask" });
    // …and both forced rules sit alongside them.
    expect(permission["ultraplan.approval:*"]).toBe("ask");
    expect(permission["ultraplan.abort.*"]).toBe("ask");
  });

  it("overrides an explicit user allow for the abort key (still asks)", () => {
    const config = {
      permission: {
        "ultraplan.abort.*": "allow",
        bash: "allow",
      },
    } as unknown as OpenCodeConfig;
    adapter().applyToConfig(config);
    const permission = config.permission as Record<string, unknown>;
    expect(permission["ultraplan.abort.*"]).toBe("ask");
    expect(permission["bash"]).toBe("allow");
  });

  it("appends the forced rules AFTER a user-level wildcard allow (last-match wins)", () => {
    const config = {
      permission: {
        "*": "allow",
        question: "allow",
      },
    } as unknown as OpenCodeConfig;
    adapter().applyToConfig(config);
    const permission = config.permission as Record<string, unknown>;
    expect(permission["*"]).toBe("allow");
    const keys = Object.keys(permission);
    // The host resolves rules with findLast — the forced rules must be the
    // LAST entries so they outrank the earlier "*": "allow".
    expect(keys[keys.length - 1]).toBe("ultraplan.abort.*");
    expect(keys[keys.length - 2]).toBe("ultraplan.approval:*");
    expect(permission["ultraplan.approval:*"]).toBe("ask");
    expect(permission["ultraplan.abort.*"]).toBe("ask");
  });

  it("is idempotent across repeated application (no duplicate keys, still last)", () => {
    const config = {} as OpenCodeConfig;
    const runtime = adapter();
    runtime.applyToConfig(config);
    runtime.applyToConfig(config);
    runtime.applyToConfig(config);
    const keys = Object.keys(config.permission as Record<string, unknown>);
    expect(keys.filter((k) => k === "ultraplan.approval:*")).toHaveLength(1);
    expect(keys.filter((k) => k === "ultraplan.abort.*")).toHaveLength(1);
    expect(keys[keys.length - 1]).toBe("ultraplan.abort.*");
    expect(keys[keys.length - 2]).toBe("ultraplan.approval:*");
  });

  it("still registers the /ultra-plan command and planning agent", () => {
    const config = {} as OpenCodeConfig;
    adapter().applyToConfig(config);
    expect(config.command?.[DEFAULT_PLANNING_RUNTIME_SPEC.commandName]?.agent).toBe(
      DEFAULT_PLANNING_RUNTIME_SPEC.agentName,
    );
    expect(config.agent?.[DEFAULT_PLANNING_RUNTIME_SPEC.agentName]?.mode).toBe("primary");
  });
});

// -----------------------------------------------------------------------------
// Ask binding + frozen abort contract (§2, §6, §7, §8)
// -----------------------------------------------------------------------------

describe("RF-02 — the abort ask is exactly bound to the active run", () => {
  it("carries a non-empty pattern bound to the current PlanID with always: []", async () => {
    const { controller, run } = await activeRunWorld();
    const tools = createUltraPlanTools(controller);
    const abortTool = tools["ultraplan_request_abort"]!;
    const captured: CapturedAsk[] = [];
    await abortTool.execute(
      {},
      fakeToolContext("ses_r3b", {
        ask: async (input) => {
          captured.push(input);
        },
      }),
    );
    expect(captured).toHaveLength(1);
    const ask = captured[0]!;
    expect(ask.permission).toBe(`ultraplan.abort.${run.id}`);
    expect(ask.patterns).toEqual([run.id]);
    expect(ask.patterns.length).toBeGreaterThan(0);
    expect(ask.always).toEqual([]);
    expect(ask.metadata).toMatchObject({
      kind: "ultraplan.run-abort",
      oneShot: true,
      planID: run.id,
    });
  });
});

describe("RF-02 — human Deny leaves everything unchanged (§8, §10)", () => {
  it("deny → run stays active with identical header, no lifecycle event, HEAD unchanged", async () => {
    const { store, controller, run } = await activeRunWorld();
    const before = (await store.listEvents(run.id)).length;
    const commitsBefore = (await store.listCommits(run.id)).length;
    const tools = createUltraPlanTools(controller);
    const abortTool = tools["ultraplan_request_abort"]!;
    const result = (await abortTool.execute(
      {},
      fakeToolContext("ses_r3b", {
        ask: async () => {
          throw new Error("user denied");
        },
      }),
    )) as { metadata: Record<string, unknown> };
    expect(result.metadata["aborted"]).toBe(false);

    const after = (await store.getRun(run.id)) as PlanningRun;
    expect(after.lifecycle).toBe("active");
    expect(after.stage).toBe(run.stage);
    expect(after.activeWork).toEqual(run.activeWork);
    expect(after.headCommit).toBe(run.headCommit);
    expect(after.headSnapshot).toBe(run.headSnapshot);
    expect((await store.listCommits(run.id)).length).toBe(commitsBefore);
    // Exactly zero new events: a denied abort must not even leave a trace
    // event, let alone a lifecycle transition.
    expect((await store.listEvents(run.id)).length).toBe(before);
    expect(await store.findActiveRunBySession("ses_r3b")).toBeDefined();
  });
});

describe("RF-02 — human Allow terminates exactly and only the run (§8, §11)", () => {
  it("allow → lifecycle=aborted, activeWork cleared, ONE lifecycle event, HEAD/commits/final state untouched", async () => {
    const { store, controller, run } = await activeRunWorld();
    const commitsBefore = (await store.listCommits(run.id)).length;
    const eventsBefore = await store.listEvents(run.id);
    const tools = createUltraPlanTools(controller);
    const abortTool = tools["ultraplan_request_abort"]!;
    const result = (await abortTool.execute({}, fakeToolContext("ses_r3b"))) as {
      metadata: Record<string, unknown>;
    };
    expect(result.metadata["aborted"]).toBe(true);

    const after = (await store.getRun(run.id)) as PlanningRun;
    expect(after.lifecycle).toBe("aborted");
    expect(after.activeWork).toBeUndefined();
    // HEAD and committed memory untouched: abort is a workflow transition,
    // never a PlanCommit.
    expect(after.headCommit).toBe(run.headCommit);
    expect(after.headSnapshot).toBe(run.headSnapshot);
    expect((await store.listCommits(run.id)).length).toBe(commitsBefore);
    // Exactly ONE new event, and it is the single active→aborted transition.
    const eventsAfter = await store.listEvents(run.id);
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
    const newEvents = eventsAfter.slice(eventsBefore.length);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.detail).toMatchObject({ type: "run.lifecycle_changed", from: "active", to: "aborted" });
    // No handoff, no finalization anywhere in the event log.
    for (const event of eventsAfter) {
      expect(String(event.detail.type)).not.toContain("handoff");
      expect(String(event.detail.type)).not.toContain("final");
    }
    expect(await store.findActiveRunBySession("ses_r3b")).toBeUndefined();
  });

  it("the aborted run never resumes; /ultra-plan admits a NEW run (§12)", async () => {
    const { store, controller, run } = await activeRunWorld();
    const tools = createUltraPlanTools(controller);
    const abortTool = tools["ultraplan_request_abort"]!;
    await abortTool.execute({}, fakeToolContext("ses_r3b"));

    const resumed = await admittedStart(controller, "ses_r3b", GOAL);
    expect(resumed.run.id).not.toBe(run.id);
    expect(resumed.run.lifecycle).toBe("active");
    // The old run stays terminal and immutable in history.
    const old = (await store.getRun(run.id)) as PlanningRun;
    expect(old.lifecycle).toBe("aborted");
    expect(await store.findActiveRunBySession("ses_r3b")).toBeDefined();
  });
});
