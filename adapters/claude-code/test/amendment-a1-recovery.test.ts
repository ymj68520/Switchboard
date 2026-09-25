/**
 * Amendment A1 — Plan Mode recovery semantics (§20 of the amendment
 * directive): resume recovers authoritative Phase Plan state without the
 * host's Plan Mode; ordinary continuation stays fail-closed until the user
 * explicitly re-enters /phase-plan, which restores mode to the SAME session
 * and continues the SAME PlanningRun — no new run, approval, commit, or
 * revision increment; no settings persistence anywhere (CC-11).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { executePhasePlanTool } from "../src/mcp/tools.js";
import { handlePermissionRequest, handlePreToolUse, handleSessionStart, handleUserPromptExpansion, handleUserPromptSubmit, type HookHandlerDeps } from "../src/hooks/handlers.js";
import { DRIFT_GUARD_REASON } from "../src/hooks/output.js";
import { loadHostSecret } from "../src/host/secret.js";
import { createBindingService } from "../src/session/binding-service.js";
import { closeFixture, makeProposalFixture, type ProposalFixture } from "./proposal-helpers.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

const ADAPTER_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface A1Harness {
  deps: HookHandlerDeps;
  fixture: ProposalFixture;
  projectDir: string;
  secret: Buffer;
  ctx: ReturnType<typeof makeCtx>;
  close(): void;
}

function makeCtx(fixture: ProposalFixture, secret: Buffer) {
  return { store: fixture.store, secret, clock: fixedClock({ ids: ["a1"] }) };
}

async function makeA1Harness(): Promise<A1Harness> {
  const root = makeTempPluginDataRoot("phase-plan-a1-");
  const fixture = await makeProposalFixture(root);
  const secret = loadHostSecret(root).key;
  return {
    deps: { store: fixture.store, secret, clock: fixedClock() },
    fixture,
    projectDir: path.join(root, "project"),
    secret,
    ctx: makeCtx(fixture, secret),
    close: () => {
      closeFixture(fixture);
      removeTempPluginDataRoot(root);
    },
  };
}

function startResumeInput(h: A1Harness, permissionMode?: string) {
  return {
    sessionId: h.fixture.sessionId,
    hookEventName: "SessionStart",
    source: "resume" as const,
    cwd: h.projectDir,
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

/** Signed start_or_resume tokens exactly as the hook layer would emit them. */
async function entryTokens(h: A1Harness, sessionId: string, promptId: string) {
  const entryIntent = handleUserPromptExpansion(h.deps, {
    sessionId,
    promptId,
    hookEventName: "UserPromptExpansion",
    commandName: "phase-plan",
  });
  const token = ((entryIntent as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as { additionalContext: string }).additionalContext
    .split("token: ")[1]!
    .split("\n")[0]!;
  const pre = await handlePreToolUse(h.deps, {
    sessionId,
    promptId,
    cwd: h.projectDir,
    permissionMode: "default",
    hookEventName: "PreToolUse",
    toolName: "mcp__plugin_phase-plan_phase-plan__start_or_resume",
    toolInput: { _entryIntent: token },
    toolUseId: "TU-A1",
  });
  const updatedInput = ((pre as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
  return { entryToken: token, hostContext: updatedInput._hostContext as string };
}

function counts(store: ProposalFixture["store"]) {
  const read = (sql: string): number => (store.withRead((tx) => tx.prepare(sql).get()) as { n: number }).n;
  return {
    runs: read("SELECT count(*) AS n FROM planning_runs"),
    approvals: read("SELECT count(*) AS n FROM approvals"),
    commits: read("SELECT count(*) AS n FROM plan_commits"),
  };
}

describe("Amendment A1 — resume without host Plan Mode restoration", () => {
  it("recovers the run, blocks ordinary continuation, and the /phase-plan re-entry returns the SAME run", async () => {
    const h = await makeA1Harness();
    try {
      const { runId, sessionId, runRevision: revision } = h.fixture;
      // Simulate the pre-resume world: session ended, binding detached.
      createBindingService(h.fixture.store, fixedClock()).detach({ runId, sessionId });
      const before = counts(h.fixture.store);
      expect(before).toEqual({ runs: 1, approvals: 0, commits: 0 });

      // 1. /resume → SessionStart(resume): exact-session reattach, and the
      //    recovery context explicitly does NOT claim mode restoration.
      const sessionStart = await handleSessionStart(h.deps, startResumeInput(h, "default"));
      const context = ((sessionStart as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(context).toContain(`id=${runId}`);
      expect(context).toContain("Phase Plan run recovered.");
      expect(context).toContain("Claude Plan Mode must be restored by invoking /phase-plan.");
      const reattached = createBindingService(h.fixture.store, fixedClock()).getBinding(runId);
      expect(reattached?.state).toBe("attached");
      // No new run, no approval, no commit, no revision increment.
      expect(counts(h.fixture.store)).toEqual(before);
      expect(h.fixture.runs.getPlanningRun(runId)?.revision).toBe(revision);

      // 2. Ordinary continuation is blocked while mode != plan (A1 §9 wording).
      const blocked = handleUserPromptSubmit(h.deps, {
        sessionId,
        hookEventName: "UserPromptSubmit",
        prompt: "continue the plan",
        permissionMode: "default",
      });
      expect(blocked).toEqual({ kind: "json", payload: { decision: "block", reason: DRIFT_GUARD_REASON } });

      // 3. User invokes /phase-plan → a NEW current EntryIntent is minted…
      const { entryToken, hostContext } = await entryTokens(h, sessionId, "PROMPT-A1-RECOVERY");
      const intentSession = JSON.parse(Buffer.from(entryToken, "base64url").toString("utf8")) as { sessionId: string; promptId: string };
      expect(intentSession).toMatchObject({ sessionId, promptId: "PROMPT-A1-RECOVERY" });

      // 4. …and start_or_resume returns the SAME PlanningRun (no new run).
      const result = executePhasePlanTool(h.ctx, "start_or_resume", {
        _entryIntent: entryToken,
        _hostContext: hostContext,
      });
      expect(result).toMatchObject({ status: "resumed", started: false, reattached: false });
      expect((result.run as { id: string }).id).toBe(runId);
      expect(counts(h.fixture.store)).toEqual(before);
      expect(h.fixture.runs.getPlanningRun(runId)?.revision).toBe(revision);

      // 5. PermissionRequest restores mode to destination=session only.
      const permission = handlePermissionRequest(h.deps, {
        sessionId,
        promptId: "PROMPT-A1-RECOVERY",
        hookEventName: "PermissionRequest",
        toolName: "mcp__plugin_phase-plan_phase-plan__start_or_resume",
        toolInput: { _entryIntent: entryToken, _hostContext: hostContext },
      });
      const decision = ((permission as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
        decision: { behavior: string; updatedPermissions: Array<Record<string, unknown>> };
      }).decision;
      expect(decision.behavior).toBe("allow");
      expect(decision.updatedPermissions).toEqual([{ type: "setMode", mode: "plan", destination: "session" }]);

      // 6. After plan mode: normal continuation is allowed again (the Phase 8
      //    delta-context marker rides along, but nothing is blocked).
      const continuation = handleUserPromptSubmit(h.deps, {
        sessionId,
        hookEventName: "UserPromptSubmit",
        prompt: "continue the plan",
        permissionMode: "plan",
      });
      expect(continuation.kind).toBe("json");
      expect(JSON.stringify(continuation)).not.toContain('"decision":"block"');
      // Still no run/approval/commit/revision delta from the whole chain.
      expect(counts(h.fixture.store)).toEqual(before);
      expect(h.fixture.runs.getPlanningRun(runId)?.revision).toBe(revision);
    } finally {
      h.close();
    }
  });

  it("a resume that lands in plan mode omits the recovery line and allows continuation", async () => {
    const h = await makeA1Harness();
    try {
      const sessionStart = await handleSessionStart(h.deps, startResumeInput(h, "plan"));
      const context = ((sessionStart as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(context).toContain("Phase Plan active:");
      expect(context).not.toContain("Phase Plan run recovered.");
      const continuation = handleUserPromptSubmit(h.deps, {
        sessionId: h.fixture.sessionId,
        hookEventName: "UserPromptSubmit",
        prompt: "continue",
        permissionMode: "plan",
      });
      expect(continuation.kind).toBe("json");
      expect(JSON.stringify(continuation)).not.toContain('"decision":"block"');
    } finally {
      h.close();
    }
  });
});

describe("CC-11 — no settings persistence, ever", () => {
  it("no source file writes Claude settings or non-session permission destinations", () => {
    const srcDir = path.join(ADAPTER_ROOT, "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(srcDir);
    expect(files.length).toBeGreaterThan(20);
    const forbidden =
      /defaultMode|settings\.json|destination:\s*"(localSettings|projectSettings|userSettings)"/;
    const offenders = files.filter((file) => forbidden.test(fs.readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
    // The ONLY destination Phase Plan ever requests is the session scope.
    const destinations = new Set<string>();
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/destination:\s*"([A-Za-z]+)"/g)) {
        destinations.add(match[1]!);
      }
    }
    expect([...destinations]).toEqual(["session"]);
  });

  it("resume + recovery leaves no settings artifacts anywhere under the plugin root", async () => {
    const h = await makeA1Harness();
    try {
      createBindingService(h.fixture.store, fixedClock()).detach({ runId: h.fixture.runId, sessionId: h.fixture.sessionId });
      await handleSessionStart(h.deps, startResumeInput(h, "default"));
      handleUserPromptSubmit(h.deps, {
        sessionId: h.fixture.sessionId,
        hookEventName: "UserPromptSubmit",
        prompt: "continue",
        permissionMode: "default",
      });
      const written = fs.readdirSync(h.projectDir);
      expect(written).toEqual([]); // nothing materialized into the workspace
      // and no settings file appeared anywhere in the plugin-data tree
      const names: string[] = [];
      const walkAll = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walkAll(full);
          else names.push(entry.name);
        }
      };
      walkAll(path.dirname(h.projectDir));
      expect(names.filter((name) => name.toLowerCase().includes("settings"))).toEqual([]);
    } finally {
      h.close();
    }
  });
});
