/**
 * Phase 7 plugin assets (hooks.json, SKILL.md), doctor capability-proof
 * integration (E43/E44), and the record-capability-proof command.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/doctor/doctor.js";
import { executeCommand } from "../src/runtime/dispatch.js";
import { readCapabilityProofs, writeCapabilityProofs } from "../src/host/capability-proofs.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

const ADAPTER_ROOT = fileURLToPath(new URL("..", import.meta.url));

function readAsset(relative: string): string {
  return fs.readFileSync(path.join(ADAPTER_ROOT, relative), "utf8");
}

describe("hooks.json (directive §35)", () => {
  const hooks: {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; args: string[] }> }>>;
  } = JSON.parse(readAsset("hooks/hooks.json"));

  it("wires all six Phase 7 events in Node exec form", () => {
    const events = Object.keys(hooks.hooks).sort();
    expect(events).toEqual([
      "PermissionRequest",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "UserPromptExpansion",
      "UserPromptSubmit",
    ]);
    for (const entries of Object.values(hooks.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.type).toBe("command");
          expect(hook.command).toBe("node");
          expect(hook.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/dist/phase-plan-runtime.mjs");
          expect(hook.args[1]).toBe("hook");
          // no bash/jq/powershell anywhere (§35)
          expect(hook.command).not.toMatch(/bash|jq|powershell/i);
        }
      }
    }
    const argSets = Object.values(hooks.hooks).map((entries) => entries[0]!.hooks[0]!.args[2]);
    expect(new Set(argSets)).toEqual(
      new Set([
        "SessionStart",
        "SessionEnd",
        "UserPromptSubmit",
        "UserPromptExpansion",
        "PreToolUse",
        "PermissionRequest",
      ]),
    );
  });

  it("PermissionRequest matches only the phase-plan approval/recovery tools; UserPromptExpansion only phase-plan (bare or plugin-namespaced)", () => {
    // The host expands "/phase-plan" to the namespaced "phase-plan:phase-plan".
    expect(hooks.hooks.UserPromptExpansion![0]!.matcher).toBe("^phase-plan(:phase-plan)?$");
    const prMatcher = hooks.hooks.PermissionRequest![0]!.matcher!;
    expect(prMatcher).toContain("start_or_resume");
    expect(prMatcher).toContain("approve_proposal");
    // PreToolUse must see every tool: unknown tools default-deny under drift (§42)
    expect(hooks.hooks.PreToolUse![0]!.matcher).toBeUndefined();
  });
});

describe("phase-plan SKILL.md (E1/E2, directive §8/§9)", () => {
  const skill = readAsset("skills/phase-plan/SKILL.md");
  const frontmatter = skill.split("---")[1]!;

  it("is user-invocable with model invocation disabled and Opus bootstrap", () => {
    expect(frontmatter).toContain("name: phase-plan");
    expect(frontmatter).toContain("disable-model-invocation: true");
    expect(frontmatter).toContain("model: opus");
    expect(frontmatter).not.toContain("context: fork");
  });

  it("directs the model to pass the injected entry token and never fabricate one", () => {
    expect(skill).toContain("_entryIntent");
    expect(skill).toContain("phase-plan:entry-v1 token:");
    expect(skill).toMatch(/Never invent|never .*(invent|fabricate)|Do not/i);
  });
});

describe("doctor × capability proofs (E43/E44)", () => {
  function okSqlite() {
    return {
      available: true as const,
      steps: {
        module_load: "pass" as const,
        open: "pass" as const,
        create: "pass" as const,
        insert: "pass" as const,
        select: "pass" as const,
        transaction: "pass" as const,
        close: "pass" as const,
      },
      sqliteVersion: "3.53.4",
    };
  }

  function doctorDeps(root: string) {
    return {
      detectNodeVersion: () => "24.21.0",
      env: { CLAUDE_PLUGIN_DATA: root },
      probeClaude: async () => ({ status: "ok" as const, version: "2.1.276", raw: "Claude Code 2.1.276", binPath: "claude" }),
      probeSqlite: async () => okSqlite(),
    };
  }

  it("without a proof both runtime capabilities stay UNKNOWN", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const report = await runDoctor(doctorDeps(root));
      const detail = JSON.stringify(report.checks.claudeCapabilities?.detail ?? {});
      expect(detail).toContain("planModeIntegration");
      expect(report.checks.claudeCapabilities!.message).toContain("UNKNOWN");
      expect(report.checks.claudeCapabilities!.message).not.toContain("runtime verified");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("a current-version proof surfaces PASS (runtime verified) without inventing floors", async () => {
    const root = makeTempPluginDataRoot();
    try {
      writeCapabilityProofs(root, {
        claudeVersion: "2.1.276",
        proofVersion: 1,
        hookLifecycleVerified: true,
        planModeIntegrationVerified: true,
        verifiedAt: "2026-09-25T00:00:00.000Z",
      });
      const report = await runDoctor(doctorDeps(root));
      expect(report.checks.claudeCapabilities!.message).toContain("runtime-verified: planModeIntegration, hookLifecycle");
      expect(readCapabilityProofs(root)!.claudeVersion).toBe("2.1.276");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("a proof recorded for a different Claude version is ignored (§46)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      writeCapabilityProofs(root, {
        claudeVersion: "2.0.14",
        proofVersion: 1,
        hookLifecycleVerified: true,
        planModeIntegrationVerified: true,
        verifiedAt: "2026-09-25T00:00:00.000Z",
      });
      const report = await runDoctor(doctorDeps(root));
      expect(report.checks.claudeCapabilities!.message).not.toContain("runtime-verified");
      expect(report.checks.claudeCapabilities!.message).toContain("UNKNOWN unverified");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("record-capability-proof command", () => {
  it("records operator-verified facts atomically and fails closed without CLAUDE_PLUGIN_DATA", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const result = await executeCommand(
        { kind: "record-proof", hooksVerified: true, planModeVerified: true, claudeVersion: "2.1.276" },
        { env: { CLAUDE_PLUGIN_DATA: root } },
      );
      expect(result.exitCode).toBe(0);
      const proof = readCapabilityProofs(root);
      expect(proof).toMatchObject({
        claudeVersion: "2.1.276",
        proofVersion: 1,
        hookLifecycleVerified: true,
        planModeIntegrationVerified: true,
      });
      await expect(
        executeCommand(
          { kind: "record-proof", hooksVerified: false, planModeVerified: false, claudeVersion: "2.1.276" },
          { env: {} },
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_DATA_UNAVAILABLE" });
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rejects malformed invocations with INVALID_RUNTIME_COMMAND", async () => {
    await expect(
      executeCommand({ kind: "record-proof", hooksVerified: false, planModeVerified: false, claudeVersion: undefined }, {
        env: { CLAUDE_PLUGIN_DATA: "D:/x" },
        probeClaude: async () => ({ status: "not_found", attempted: [] }),
      }),
    ).rejects.toMatchObject({ code: "CLAUDE_VERSION_UNREADABLE" });
  });
});
