/**
 * RF-01 — approval authority fail-closed (approval-interaction hardening).
 *
 * Real defect (OpenCode 1.18.32, default permission configuration): the
 * approval ask used to be issued with an EMPTY patterns list. The host's
 * ask() evaluates permission rules only inside its loop over patterns, so an
 * empty list skipped evaluation entirely and resolved immediately — an
 * implicit ALLOW under every configuration. Observed live: 5 approvals
 * (actor="user") + 5 PlanCommits recorded in 52 seconds with zero human
 * clicks. That violated Core Invariant 9 (no committed change without an
 * explicit user approval of the exact proposal).
 *
 * The fix has two production halves, both pinned here:
 *   1. the approval ask carries a NON-EMPTY pattern (the exact approval
 *      target), so the host actually evaluates permission rules and can pend;
 *   2. applyToConfig forces the narrow rule `"ultraplan.approval:*" → "ask"`
 *      (agent-scoped AND in the resolved global permission config, appended
 *      LAST so last-match resolution outranks any earlier wildcard) while
 *      preserving every unrelated user permission verbatim.
 */
import { describe, expect, it } from "vitest";

import { OpenCodeRuntimeAdapter, DEFAULT_PLANNING_RUNTIME_SPEC } from "../src/runtime/opencode-plugin.js";
import type { Config as OpenCodeConfig } from "@opencode-ai/plugin";

function adapter(): OpenCodeRuntimeAdapter {
  return new OpenCodeRuntimeAdapter(DEFAULT_PLANNING_RUNTIME_SPEC);
}

describe("RF-01 — applyToConfig forces the approval permission to ask", () => {
  it("forces ultraplan.approval:* → ask on a default (empty) config", () => {
    const config = {} as OpenCodeConfig;
    adapter().applyToConfig(config);
    expect(config.permission).toBeDefined();
    expect((config.permission as Record<string, unknown>)["ultraplan.approval:*"]).toBe("ask");
    // RF-02 added the abort rule alongside; the approval rule is unchanged.
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
    // …and the forced rule is present alongside them.
    expect(permission["ultraplan.approval:*"]).toBe("ask");
  });

  it("overrides an explicit user allow for the approval key (still asks)", () => {
    const config = {
      permission: {
        "ultraplan.approval:*": "allow",
        bash: "allow",
      },
    } as unknown as OpenCodeConfig;
    adapter().applyToConfig(config);
    const permission = config.permission as Record<string, unknown>;
    expect(permission["ultraplan.approval:*"]).toBe("ask");
    expect(permission["bash"]).toBe("allow");
  });

  it("appends the forced rule AFTER a user-level wildcard allow (last-match wins)", () => {
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
    // LAST entries so they outrank the earlier "*": "allow" (RF-02 appended
    // the abort rule after the approval rule; both stay terminal).
    expect(keys[keys.length - 2]).toBe("ultraplan.approval:*");
    expect(keys[keys.length - 1]).toBe("ultraplan.abort.*");
    expect(permission["ultraplan.approval:*"]).toBe("ask");
    expect(permission["ultraplan.abort.*"]).toBe("ask");
  });

  it("is idempotent and keeps the forced rule last across repeated application", () => {
    const config = {} as OpenCodeConfig;
    const runtime = adapter();
    runtime.applyToConfig(config);
    runtime.applyToConfig(config);
    const keys = Object.keys(config.permission as Record<string, unknown>);
    expect(keys[keys.length - 2]).toBe("ultraplan.approval:*");
    expect(keys[keys.length - 1]).toBe("ultraplan.abort.*");
    expect((config.permission as Record<string, unknown>)["ultraplan.approval:*"]).toBe("ask");
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
