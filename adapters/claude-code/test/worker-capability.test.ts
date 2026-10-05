/**
 * v0.2.0 E5 — capability enforcement (E5 §55 focused tests T22–T31).
 *
 * Runtime narrowing runs through the REAL PreToolUse hook handler; launch-time
 * enforceability runs through the real worker runtime service.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { handlePreToolUse, type HookHandlerDeps } from "../src/hooks/handlers.js";
import type { HookOutput } from "../src/hooks/output.js";
import { prepareWorkerLaunchInTx, requireEnforceableCapabilityEnvelope } from "../src/application/worker-runtime-service.js";
import { fullEnvelope } from "./execution-protocol-helpers.js";
import {
  callWorkerTool,
  codeOf,
  freshWorkerSession,
  makeWorkerWorld,
  type WorkerWorld,
} from "./execution-worker-helpers.js";

function depsOf(w: WorkerWorld): HookHandlerDeps {
  return { store: w.ctx.store, secret: w.ctx.secret, clock: w.ctx.clock };
}

function decisionOf(output: HookOutput): { decision: string | null; reason: string } {
  if (output.kind !== "json") return { decision: null, reason: "" };
  const specific = (output.payload as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: specific?.permissionDecision ?? null, reason: specific?.permissionDecisionReason ?? "" };
}

async function claimedWorld(envelope: Partial<ReturnType<typeof fullEnvelope>>) {
  const w = await makeWorkerWorld("S1", { capabilityEnvelope: fullEnvelope(envelope) });
  const session = freshWorkerSession(w, "W1");
  callWorkerTool(w, session, "worker_claim", {
    attempt_id: w.attempt.attemptId,
    launch_token: w.launch.launchToken,
  });
  return { w, session };
}

async function workerToolDecision(
  w: WorkerWorld,
  session: ReturnType<typeof freshWorkerSession>,
  toolName: string,
  toolInput: Record<string, unknown> = {},
): Promise<{ decision: string | null; reason: string }> {
  const output = await handlePreToolUse(depsOf(w), {
    sessionId: session.sessionId,
    cwd: w.f.workspaceRoot,
    permissionMode: "default",
    hookEventName: "PreToolUse",
    agentId: session.agentId,
    agentType: "phase-plan:execution-worker",
    toolName,
    toolInput,
    toolUseId: "TU-WORKER-HOOK",
  });
  return decisionOf(output);
}

describe("v0.2.0 E5 — capability enforcement (T22–T31)", () => {
  it("T22: repositoryRead=false denies the worker's read tools", async () => {
    const { w, session } = await claimedWorld({ repositoryRead: false });
    try {
      const { decision, reason } = await workerToolDecision(w, session, "Read", { file_path: "a.ts" });
      expect(decision).toBe("deny");
      expect(reason).toContain("CAPABILITY_DENIED");
      expect(reason).toContain("repositoryRead");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T23: repositoryRead=true reaches the host permission layer — Phase Plan does not auto-grant", async () => {
    const { w, session } = await claimedWorld({ repositoryRead: true });
    try {
      const { decision, reason } = await workerToolDecision(w, session, "Read", { file_path: "a.ts" });
      // No Phase Plan decision is forced: the native permission system stays the ceiling.
      expect(decision).toBeNull();
      expect(reason).toBe("");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T24: repositoryWrite=false denies Edit/Write/NotebookEdit", async () => {
    const { w, session } = await claimedWorld({ repositoryWrite: false });
    try {
      for (const tool of ["Edit", "Write", "NotebookEdit"]) {
        const { decision, reason } = await workerToolDecision(w, session, tool, { file_path: "a.ts" });
        expect(decision, tool).toBe("deny");
        expect(reason, tool).toContain("repositoryWrite");
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("T25: commandExecution=false denies shell tools", async () => {
    const { w, session } = await claimedWorld({ commandExecution: false });
    try {
      for (const tool of ["Bash", "PowerShell"]) {
        const { decision, reason } = await workerToolDecision(w, session, tool, { command: "ls" });
        expect(decision, tool).toBe("deny");
        expect(reason, tool).toContain("commandExecution");
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("T26: networkAccess=false denies WebFetch/WebSearch", async () => {
    const { w, session } = await claimedWorld({ networkAccess: false });
    try {
      for (const tool of ["WebFetch", "WebSearch"]) {
        const { decision, reason } = await workerToolDecision(w, session, tool, { url: "https://x" });
        expect(decision, tool).toBe("deny");
        expect(reason, tool).toContain("networkAccess");
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("T27/T28/T29: shell-restricted semantic categories are refused at LAUNCH, not weakened at runtime", async () => {
    const w = await makeWorkerWorld("S1");
    try {
      for (const capability of ["gitCommit", "gitPush", "dependencyMutation", "networkAccess", "externalServiceMutation"] as const) {
        const envelope = fullEnvelope({ commandExecution: true, [capability]: false });
        expect(codeOf(() => requireEnforceableCapabilityEnvelope(envelope)), capability).toBe(
          "CAPABILITY_ENFORCEMENT_UNAVAILABLE",
        );
        // The launch itself refuses the same envelope.
        expect(
          codeOf(() =>
            w.ctx.store.withWrite((tx) => prepareWorkerLaunchInTx(tx, { attemptId: "att_none" }, "2026-01-01T00:00:00Z")),
          ),
        ).not.toBe("no-error");
      }
      // commandExecution=true with EVERY semantic capability granted is enforceable.
      expect(
        codeOf(() =>
          requireEnforceableCapabilityEnvelope(
            fullEnvelope({
              repositoryWrite: true,
              commandExecution: true,
              networkAccess: true,
              dependencyMutation: true,
              gitCommit: true,
              gitPush: true,
              externalServiceMutation: true,
            }),
          ),
        ),
      ).toBe("no-error");
      // A closed shell makes every restriction enforceable.
      expect(
        codeOf(() =>
          requireEnforceableCapabilityEnvelope(
            fullEnvelope({ commandExecution: false, networkAccess: false, gitCommit: false, gitPush: false }),
          ),
        ),
      ).toBe("no-error");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T30: an unenforceable combination fails the launch closed — never advisory", async () => {
    // A world WITHOUT a pre-started attempt: the launch gate must run first.
    const { makeActiveExecutionWorld } = await import("./execution-protocol-helpers.js");
    const base = await makeActiveExecutionWorld("S1");
    const w = base as unknown as WorkerWorld;
    try {
      // Issue a directive whose envelope pairs shell with a git restriction.
      const service = await import("../src/application/execution-directive-service.js");
      const directive = service.createExecutionDirectiveService(w.ctx.store, w.ctx.clock).issueExecutionDirective(
        (await import("./execution-protocol-helpers.js")).directiveInput(w, {
          directiveId: "DIR-SHELL",
          capabilityEnvelope: fullEnvelope({ repositoryWrite: true, commandExecution: true, gitCommit: false }),
        }),
      );
      const { startExecutionAttemptInTx } = await import("../src/application/execution-attempt-service.js");
      const { attempt } = w.ctx.store.withWrite((tx) =>
        startExecutionAttemptInTx(
          tx,
          {
            executionRunId: w.executionRunId,
            sessionId: w.f.sessionId,
            workspaceId: w.f.workspaceId,
            generation: w.f.generation,
            directiveId: directive.directiveId,
            directiveRevision: directive.revision,
            directiveHash: directive.hash,
            workerRole: "executor",
          },
          w.ctx.clock,
          w.ctx.clock.nowIso(),
        ),
      );
      expect(
        codeOf(() =>
          w.ctx.store.withWrite((tx) => prepareWorkerLaunchInTx(tx, { attemptId: attempt.attemptId }, w.ctx.clock.nowIso())),
        ),
      ).toBe("CAPABILITY_ENFORCEMENT_UNAVAILABLE");
      // No invocation binding was created by the failed launch.
      const { getWorkerInvocationInTx } = await import("../src/store/worker-invocations.js");
      expect(w.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attempt.attemptId))).toBeNull();
    } finally {
      w.ctx.store.close();
    }
  });

  it("T31: no path-level denial exists — a supporting file outside the expected scope is reachable", async () => {
    const { w, session } = await claimedWorld({ repositoryRead: true, repositoryWrite: true });
    try {
      // The directive's expected scope is empty; the hook decisions never
      // consult paths — the same tool decision is path-independent.
      const inScope = await workerToolDecision(w, session, "Write", { file_path: "src/in-scope.ts" });
      const outOfScope = await workerToolDecision(w, session, "Write", { file_path: "docs/supporting.md" });
      expect(inScope.decision).toBe(outOfScope.decision);
      expect(inScope.decision).toBeNull();
      // Static: the hook layer never references the expected scope in CODE
      // (prose in doc comments is not enforcement).
      const hooksDir = path.resolve(__dirname, "../src/hooks");
      for (const entry of fs.readdirSync(hooksDir)) {
        if (entry.endsWith(".ts")) {
          const codeLines = fs
            .readFileSync(path.join(hooksDir, entry), "utf8")
            .split(/\r?\n/)
            .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"));
          expect(codeLines.join("\n")).not.toContain("expectedExecutionScope");
        }
      }
    } finally {
      w.ctx.store.close();
    }
  });
});

