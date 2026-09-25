/**
 * Hook runtime policy (directive §34/§35/E40): per-event fail-closed exit
 * behavior, single-JSON stdout discipline, stderr-only diagnostics — verified
 * in-process AND against the real bundled artifact in a separate process.
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { runHook, HOOK_EVENTS } from "../src/hooks/run.js";
import { runtimeBundlePath } from "./helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { loadHostSecret } from "../src/host/secret.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import { verifyEntryIntent } from "../src/host/entry-intent.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

const SESSION_START_INPUT = {
  session_id: "S1",
  prompt_id: "P1",
  hook_event_name: "SessionStart",
  source: "startup",
  cwd: process.cwd(),
};

function hookInput(event: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: "S1", prompt_id: "P1", hook_event_name: event, ...overrides };
}

describe("runHook failure policy (in-process)", () => {
  it("invalid JSON fails closed per event", async () => {
    const root = makeTempPluginDataRoot();
    try {
      await initializePlanStore({ pluginDataRoot: root }).then((s) => s.close());

      // PreToolUse / UserPromptExpansion → exit 2 (blocks tool/expansion)
      for (const event of ["PreToolUse", "UserPromptExpansion"]) {
        const result = await runHook({ event, raw: "{not json", pluginDataRoot: root });
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
      }
      // SessionStart/SessionEnd are advisory: silent success
      for (const event of ["SessionStart", "SessionEnd"]) {
        const result = await runHook({ event, raw: "{not json", pluginDataRoot: root });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
      }
      // UserPromptSubmit → block decision
      const blocked = await runHook({ event: "UserPromptSubmit", raw: "nope", pluginDataRoot: root });
      expect(blocked.exitCode).toBe(0);
      expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: "block" });
      // PermissionRequest → deny via decision object
      const denied = await runHook({ event: "PermissionRequest", raw: "nope", pluginDataRoot: root });
      expect(denied.exitCode).toBe(0);
      expect(JSON.parse(denied.stdout).hookSpecificOutput.decision.behavior).toBe("deny");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("argv event vs payload event mismatch fails closed; unknown event is a dispatch error", async () => {
    const root = makeTempPluginDataRoot();
    try {
      await initializePlanStore({ pluginDataRoot: root }).then((s) => s.close());
      const result = await runHook({
        event: "PreToolUse",
        raw: JSON.stringify(hookInput("SessionStart")),
        pluginDataRoot: root,
      });
      expect(result.exitCode).toBe(2);
      await expect(runHook({ event: "Nope", raw: "{}", pluginDataRoot: root })).rejects.toMatchObject({
        code: "INVALID_RUNTIME_COMMAND",
      });
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("missing CLAUDE_PLUGIN_DATA store path degrades SessionStart to advisory success", async () => {
    // Nonexistent root: store init will create it (fresh install semantics) —
    // this must SUCCEED and stay silent for an unrelated session.
    const root = makeTempPluginDataRoot();
    try {
      const result = await runHook({
        event: "SessionStart",
        raw: JSON.stringify(SESSION_START_INPUT),
        pluginDataRoot: root,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("UserPromptExpansion emits exactly one JSON object with the signed token", async () => {
    const root = makeTempPluginDataRoot();
    try {
      await initializePlanStore({ pluginDataRoot: root }).then((s) => s.close());
      const result = await runHook({
        event: "UserPromptExpansion",
        raw: JSON.stringify(
          hookInput("UserPromptExpansion", { command_name: "phase-plan", expansion_type: "slash_command" }),
        ),
        pluginDataRoot: root,
      });
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      const context = payload.hookSpecificOutput.additionalContext as string;
      expect(context).toContain("phase-plan:entry-v1 token: ");
      const secret = loadHostSecret(root).key;
      const token = context.split("token: ")[1]!.split("\n")[0]!;
      const intent = verifyEntryIntent(secret, token);
      expect(intent.sessionId).toBe("S1");
      expect(intent.promptId).toBe("P1");
      // the issueEntryIntent import stays exercised for API stability
      expect(issueEntryIntent(secret, { sessionId: "S1", promptId: "P1" })).not.toBe("");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("exposes the seven implemented events (Phase 9 §59: PostToolUse added)", () => {
    expect(HOOK_EVENTS).toEqual([
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "UserPromptExpansion",
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
    ]);
  });
});

describe("bundled runtime subprocess stdout discipline (E40)", () => {
  it("hook <event> writes at most one JSON line to stdout, diagnostics to stderr", async () => {
    const bundle = runtimeBundlePath();
    const root = makeTempPluginDataRoot();
    try {
      await initializePlanStore({ pluginDataRoot: root }).then((s) => s.close());

      const run = (args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [bundle, ...args], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
          });
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
          child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
          child.on("error", reject);
          child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
          child.stdin?.end(input);
        });

      // A missing CLAUDE_PLUGIN_DATA fails closed at dispatch (exit 5).
      const noEnv = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [bundle, "hook", "SessionStart"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, CLAUDE_PLUGIN_DATA: "" },
        });
        let stderr = "";
        child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
        child.stdin?.end("{}");
      });
      expect(noEnv.code).toBe(5);
      expect(noEnv.stderr).toContain("PLUGIN_DATA_UNAVAILABLE");

      // A SessionStart with an unparseable payload: exit 0, NOTHING on stdout.
      const advisory = await run(["hook", "SessionStart"], "{broken");
      expect(advisory.code).toBe(0);
      expect(advisory.stdout).toBe("");
      expect(advisory.stderr).toContain("hook SessionStart failed");

      // A PreToolUse fail: exit 2, nothing on stdout.
      const blocking = await run(["hook", "PreToolUse"], "{broken");
      expect(blocking.code).toBe(2);
      expect(blocking.stdout).toBe("");

      // A healthy PreToolUse deny: exactly one JSON object on stdout.
      const healthy = await run(
        ["hook", "PreToolUse"],
        JSON.stringify({
          session_id: "S1",
          prompt_id: "P1",
          hook_event_name: "PreToolUse",
          permission_mode: "plan",
          tool_name: "mcp__plugin_phase-plan_phase-plan__start_or_resume",
          tool_input: {},
          tool_use_id: "TU-1",
        }),
      );
      expect(healthy.code).toBe(0);
      const lines = healthy.stdout.split("\n").filter((line) => line.trim() !== "");
      expect(lines).toHaveLength(1);
      const payload = JSON.parse(lines[0]!);
      expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(payload.hookSpecificOutput.permissionDecisionReason).toContain("ENTRY_INTENT_REQUIRED");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
