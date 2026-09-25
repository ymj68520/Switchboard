/**
 * Phase 7 hook handler behavior, driven against a real store fixture
 * (directive §14/§15/§29/§30/§36–§44).
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  handlePermissionRequest,
  handlePreToolUse,
  handleSessionEnd,
  handleSessionStart,
  handleUserPromptExpansion,
  handleUserPromptSubmit,
  PHASE_PLAN_ENTRY_MARKER,
  type HookHandlerDeps,
} from "../src/hooks/handlers.js";
import { DRIFT_GUARD_REASON, EXIT_PLAN_MODE_REASON } from "../src/hooks/output.js";
import { loadHostSecret } from "../src/host/secret.js";
import {
  buildHostContextEnvelope,
  businessInputHashOf,
  encodeHostContextToken,
} from "../src/host/host-context.js";
import { issueEntryIntent, verifyEntryIntent } from "../src/host/entry-intent.js";
import { createBindingService } from "../src/session/binding-service.js";
import { closeFixture, makeProposalFixture, type ProposalFixture } from "./proposal-helpers.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

interface HandlerHarness {
  deps: HookHandlerDeps;
  fixture: ProposalFixture;
  projectDir: string;
  secret: Buffer;
  root: string;
  close(): void;
}

async function makeHarness(options?: { sessionId?: string }): Promise<HandlerHarness> {
  const root = makeTempPluginDataRoot("phase-plan-hook-handlers-");
  const fixture = await makeProposalFixture(root, { sessionId: options?.sessionId ?? "S1" });
  const secret = loadHostSecret(root).key;
  return {
    deps: { store: fixture.store, secret, clock: fixedClock() },
    fixture,
    projectDir: path.join(root, "project"),
    secret,
    root,
    close: () => {
      closeFixture(fixture);
      removeTempPluginDataRoot(root);
    },
  };
}

function preToolInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "S1",
    promptId: "P1",
    cwd: "D:/irrelevant-for-drift",
    permissionMode: "plan",
    hookEventName: "PreToolUse",
    toolName: "mcp__plugin_phase-plan_phase-plan__start_or_resume",
    toolInput: {} as Record<string, unknown>,
    toolUseId: "TU-1",
    ...overrides,
  };
}

const SCOPED = {
  start: "mcp__plugin_phase-plan_phase-plan__start_or_resume",
  approve: "mcp__plugin_phase-plan_phase-plan__approve_proposal",
  get_state: "mcp__plugin_phase-plan_phase-plan__get_state",
};

describe("SessionStart (§36/§37; Phase 8 §29)", () => {
  it("attached run injects the deterministic Recovery Capsule", async () => {
    const h = await makeHarness();
    try {
      const output = await handleSessionStart(h.deps, {
        sessionId: "S1",
        hookEventName: "SessionStart",
        source: "startup",
        cwd: h.projectDir,
      });
      expect(output.kind).toBe("json");
      const payload = (output as { kind: "json"; payload: Record<string, unknown> }).payload;
      const context = (payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(context).toContain("Phase Plan active:");
      expect(context).toContain("[Phase Plan Recovery v1]");
      expect(context).toContain(`id=${h.fixture.runId}`);
      expect(context).toContain("stage=architecture");
      expect(context).toContain("commit=none");
      expect(context).toContain("snapshot=none");
      expect(context).toContain("context_epoch=");
      expect(context).not.toContain("SQLite");
    } finally {
      h.close();
    }
  });

  it("resume: exact-session detached active run reattaches with generation+1 (spec §23.4)", async () => {
    const h = await makeHarness();
    try {
      const bindings = createBindingService(h.fixture.store, fixedClock({ ids: ["gen"] }));
      const detached = bindings.detach({ runId: h.fixture.runId, sessionId: "S1" });
      expect(detached.state).toBe("detached");

      const output = await handleSessionStart(h.deps, {
        sessionId: "S1",
        hookEventName: "SessionStart",
        source: "resume",
        cwd: h.projectDir,
      });
      const payload = (output as { kind: "json"; payload: Record<string, unknown> }).payload;
      expect((payload.hookSpecificOutput as { additionalContext: string }).additionalContext).toContain(h.fixture.runId);
      const reattached = bindings.getBinding(h.fixture.runId);
      expect(reattached?.state).toBe("attached");
      expect(reattached?.generation).toBe(detached.generation + 1);
    } finally {
      h.close();
    }
  });

  it("clear/fork (new session id) never inherits the old writable binding (E24/E25)", async () => {
    const h = await makeHarness();
    try {
      for (const source of ["clear", "fork", "startup"] as const) {
        const output = await handleSessionStart(h.deps, {
          sessionId: "S2-NEW",
          hookEventName: "SessionStart",
          source,
          cwd: h.projectDir,
        });
        expect(output.kind).toBe("empty");
      }
      // The original binding is untouched — still attached to S1.
      const binding = createBindingService(h.fixture.store, fixedClock()).getBinding(h.fixture.runId);
      expect(binding?.state).toBe("attached");
      expect(binding?.sessionId).toBe("S1");
    } finally {
      h.close();
    }
  });
});

describe("SessionEnd advisory detach (§38/E23)", () => {
  it("detaches the owned run (generation++) without aborting it, and is idempotent", async () => {
    const h = await makeHarness();
    try {
      const first = handleSessionEnd(h.deps, { sessionId: "S1", hookEventName: "SessionEnd", reason: "prompt_input_exit" });
      expect(first.kind).toBe("empty");
      const bindings = createBindingService(h.fixture.store, fixedClock());
      const binding = bindings.getBinding(h.fixture.runId);
      expect(binding?.state).toBe("detached");
      expect(binding?.generation).toBe(h.fixture.generation + 1);
      // run stays active — SessionEnd never aborts
      expect(h.fixture.runs.getPlanningRun(h.fixture.runId)?.lifecycle).toBe("active");
      // second SessionEnd is a harmless no-op
      expect(() =>
        handleSessionEnd(h.deps, { sessionId: "S1", hookEventName: "SessionEnd", reason: "prompt_input_exit" }),
      ).not.toThrow();
    } finally {
      h.close();
    }
  });
});

describe("UserPromptSubmit drift guard (§39/§40/E19)", () => {
  it("blocks ordinary prompts when the active run drifted out of plan mode", async () => {
    const h = await makeHarness();
    try {
      const output = handleUserPromptSubmit(h.deps, {
        sessionId: "S1",
        hookEventName: "UserPromptSubmit",
        prompt: "continue implementing the store",
        permissionMode: "default",
      });
      expect(output).toEqual({ kind: "json", payload: { decision: "block", reason: DRIFT_GUARD_REASON } });
      // absent permission_mode also fails closed for a known active binding
      const noMode = handleUserPromptSubmit(h.deps, {
        sessionId: "S1",
        hookEventName: "UserPromptSubmit",
        prompt: "hello",
      });
      expect(noMode).toEqual({ kind: "json", payload: { decision: "block", reason: DRIFT_GUARD_REASON } });
    } finally {
      h.close();
    }
  });

  it("the /phase-plan entry itself always passes (§39)", async () => {
    const h = await makeHarness();
    try {
      for (const prompt of ["/phase-plan", "  /phase-plan ", `expanded prompt with ${PHASE_PLAN_ENTRY_MARKER} token: x`]) {
        const output = handleUserPromptSubmit(h.deps, {
          sessionId: "S1",
          hookEventName: "UserPromptSubmit",
          prompt,
          permissionMode: "default",
        });
        expect(output.kind).toBe("empty");
      }
      // plan mode → pass through, now with the Phase 8 delta-context epoch
      // marker (directive §34; detailed coverage in context-recovery-hooks).
      expect(
        handleUserPromptSubmit(h.deps, {
          sessionId: "S1",
          hookEventName: "UserPromptSubmit",
          prompt: "go on",
          permissionMode: "plan",
        }).kind,
      ).toBe("json");
      // no active run → no guard
      expect(
        handleUserPromptSubmit(h.deps, {
          sessionId: "OTHER",
          hookEventName: "UserPromptSubmit",
          prompt: "go on",
          permissionMode: "default",
        }).kind,
      ).toBe("empty");
    } finally {
      h.close();
    }
  });
});

describe("UserPromptExpansion entry token (§10/§11/E3)", () => {
  it("issues a signed, session+prompt-bound token via additionalContext", async () => {
    const h = await makeHarness();
    try {
      const output = handleUserPromptExpansion(h.deps, {
        sessionId: "S1",
        promptId: "P1",
        hookEventName: "UserPromptExpansion",
        commandName: "phase-plan",
        expansionType: "slash_command",
      });
      const payload = (output as { kind: "json"; payload: Record<string, unknown> }).payload;
      const context = (payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      const token = context.split("token: ")[1]!.split("\n")[0]!;
      const intent = verifyEntryIntent(h.secret, token);
      expect(intent.sessionId).toBe("S1");
      expect(intent.promptId).toBe("P1");
      expect(intent.commandName).toBe("phase-plan");
      // not written to the Plan Store
      expect(h.fixture.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM proposals").get())).toEqual({ n: 0 });
    } finally {
      h.close();
    }
  });

  it("issues the same bound token for the plugin-namespaced command form phase-plan:phase-plan", async () => {
    const h = await makeHarness();
    try {
      const output = handleUserPromptExpansion(h.deps, {
        sessionId: "S1",
        promptId: "P2",
        hookEventName: "UserPromptExpansion",
        commandName: "phase-plan:phase-plan",
        expansionType: "slash_command",
      });
      expect(output.kind).toBe("json");
      const payload = (output as { kind: "json"; payload: Record<string, unknown> }).payload;
      const context = (payload.hookSpecificOutput as { additionalContext: string }).additionalContext;
      const token = context.split("token: ")[1]!.split("\n")[0]!;
      const intent = verifyEntryIntent(h.secret, token);
      expect(intent.sessionId).toBe("S1");
      expect(intent.promptId).toBe("P2");
    } finally {
      h.close();
    }
  });

  it("missing prompt_id fails closed; other commands are ignored", async () => {
    const h = await makeHarness();
    try {
      expect(() =>
        handleUserPromptExpansion(h.deps, {
          sessionId: "S1",
          hookEventName: "UserPromptExpansion",
          commandName: "phase-plan",
        }),
      ).toThrowError();
      expect(
        handleUserPromptExpansion(h.deps, {
          sessionId: "S1",
          promptId: "P1",
          hookEventName: "UserPromptExpansion",
          commandName: "other-skill",
        }).kind,
      ).toBe("empty");
    } finally {
      h.close();
    }
  });
});

describe("PreToolUse: start_or_resume (§14/E3/E4)", () => {
  it("no entry intent → ENTRY_INTENT_REQUIRED deny; the model cannot self-enter Phase Plan (E4)", async () => {
    const h = await makeHarness();
    try {
      const output = await handlePreToolUse(h.deps, preToolInput({ toolName: SCOPED.start, cwd: h.projectDir }));
      const payload = (output as { kind: "json"; payload: Record<string, unknown> }).payload;
      const spec = payload.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
      expect(spec.permissionDecision).toBe("deny");
      expect(spec.permissionDecisionReason).toContain("ENTRY_INTENT_REQUIRED");
    } finally {
      h.close();
    }
  });

  it("valid entry intent → ask with signed HostContext injected (§14)", async () => {
    const h = await makeHarness();
    try {
      const token = issueEntryIntent(h.secret, { sessionId: "S1", promptId: "P1" });
      const toolInput = { goal: "build it", _entryIntent: token };
      const output = await handlePreToolUse(
        h.deps,
        preToolInput({ toolName: SCOPED.start, cwd: h.projectDir, toolInput }),
      );
      const payload = (output as { kind: "json"; payload: Record<string, unknown> }).payload;
      const spec = payload.hookSpecificOutput as {
        permissionDecision: string;
        updatedInput: Record<string, unknown>;
      };
      expect(spec.permissionDecision).toBe("ask");
      const verified = verifyEntryIntent(h.secret, spec.updatedInput._entryIntent as string);
      expect(verified.promptId).toBe("P1");
      expect(typeof spec.updatedInput._hostContext).toBe("string");
      const envelope = await import("../src/host/host-context.js").then((m) =>
        m.verifyHostContext(h.secret, spec.updatedInput._hostContext as string),
      );
      expect(envelope.workspaceId).toBe(h.fixture.workspaceId);
      expect(envelope.toolUseId).toBe("TU-1");
      expect(envelope.runId).toBe(h.fixture.runId);
      expect(envelope.businessInputHash).toBe(businessInputHashOf(toolInput));
    } finally {
      h.close();
    }
  });

  it("entry intent from another session/prompt fails ENTRY_INTENT_INVALID (E63)", async () => {
    const h = await makeHarness();
    try {
      const stale = issueEntryIntent(h.secret, { sessionId: "S1", promptId: "OLD-PROMPT" });
      const output = await handlePreToolUse(
        h.deps,
        preToolInput({ toolName: SCOPED.start, cwd: h.projectDir, toolInput: { _entryIntent: stale } }),
      );
      const spec = ((output as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
        permissionDecisionReason: string;
      });
      expect(spec.permissionDecisionReason).toContain("ENTRY_INTENT_INVALID");
    } finally {
      h.close();
    }
  });
});

describe("PreToolUse: approve_proposal + get_state (§29/§44)", () => {
  it("injects a signed context with ask (never allow) when the run is owned and mode is plan", async () => {
    const h = await makeHarness();
    try {
      const toolInput = { proposal_id: "PROP-1", proposal_revision: 1, proposal_hash: "sha256:aa" };
      const output = await handlePreToolUse(
        h.deps,
        preToolInput({ toolName: SCOPED.approve, cwd: h.projectDir, toolInput }),
      );
      const spec = ((output as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
        permissionDecision: string;
        updatedInput: Record<string, unknown>;
      });
      expect(spec.permissionDecision).toBe("ask");
      const { verifyHostContext } = await import("../src/host/host-context.js");
      const envelope = verifyHostContext(h.secret, spec.updatedInput._hostContext as string);
      expect(envelope.permissionMode).toBe("plan");
      expect(envelope.runId).toBe(h.fixture.runId);
      expect(envelope.bindingGeneration).toBe(h.fixture.generation);
      expect(envelope.businessInputHash).toBe(businessInputHashOf(toolInput));
    } finally {
      h.close();
    }
  });

  it("denies approve outside plan mode (PLAN_MODE_REQUIRED) and after cwd left the workspace (§44)", async () => {
    const h = await makeHarness();
    try {
      const drifted = await handlePreToolUse(
        h.deps,
        preToolInput({ toolName: SCOPED.approve, cwd: h.projectDir, permissionMode: "default" }),
      );
      expect(
        ((drifted as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
          permissionDecisionReason: string;
        }).permissionDecisionReason,
      ).toContain("PLAN_MODE_REQUIRED");

      const left = await handlePreToolUse(
        h.deps,
        preToolInput({ toolName: SCOPED.approve, cwd: "D:/some-other-project", toolInput: { proposal_id: "P" } }),
      );
      expect(
        ((left as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
          permissionDecisionReason: string;
        }).permissionDecisionReason,
      ).toContain("WORKSPACE_MISMATCH");
    } finally {
      h.close();
    }
  });

  it("get_state gets a read context with no permission decision", async () => {
    const h = await makeHarness();
    try {
      const output = await handlePreToolUse(
        h.deps,
        preToolInput({ toolName: SCOPED.get_state, cwd: h.projectDir }),
      );
      const payload = (output as { kind: "json"; payload: Record<string, unknown> }).payload;
      const spec = payload.hookSpecificOutput as { permissionDecision?: string; updatedInput: Record<string, unknown> };
      expect(spec.permissionDecision).toBeUndefined();
      expect(typeof spec.updatedInput._hostContext).toBe("string");
    } finally {
      h.close();
    }
  });
});

describe("PreToolUse drift guard + ExitPlanMode (§41/§42/E20/E21/E22)", () => {
  it("denies mutation-capable tools under drift, allowlist passes, plan mode is not duplicated", async () => {
    const h = await makeHarness();
    try {
      const denyCase = await handlePreToolUse(
        h.deps,
        preToolInput({ toolName: "Bash", toolInput: { command: "rm -rf /" }, permissionMode: "default" }),
      );
      const denySpec = (denyCase as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
      expect(denySpec.permissionDecision).toBe("deny");
      expect(denySpec.permissionDecisionReason).toContain("PLAN_MODE_REQUIRED");

      for (const allowed of ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"]) {
        expect(
          (
            await handlePreToolUse(
              h.deps,
              preToolInput({ toolName: allowed, toolInput: {}, permissionMode: "default" }),
            )
          ).kind,
        ).toBe("empty");
      }
      // §43 — normal plan mode stays Claude Code's business
      expect(
        (
          await handlePreToolUse(
            h.deps,
            preToolInput({ toolName: "Bash", toolInput: {}, permissionMode: "plan" }),
          )
        ).kind,
      ).toBe("empty");
      // unknown external MCP tool under drift → default deny
      const unknown = await handlePreToolUse(
        h.deps,
        preToolInput({ toolName: "mcp__random-server__delete_everything", toolInput: {}, permissionMode: "default" }),
      );
      expect(
        ((unknown as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
          permissionDecision: string;
        }).permissionDecision,
      ).toBe("deny");
    } finally {
      h.close();
    }
  });

  it("ExitPlanMode is denied while the session owns the active run — even in plan mode (E20)", async () => {
    const h = await makeHarness();
    try {
      const denied = await handlePreToolUse(
        h.deps,
        preToolInput({ toolName: "ExitPlanMode", toolInput: {}, permissionMode: "plan" }),
      );
      const spec = (denied as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
      expect(spec.permissionDecision).toBe("deny");
      expect(spec.permissionDecisionReason).toBe(EXIT_PLAN_MODE_REASON);
      // without an owned run it passes through untouched
      const detached = await (async () => {
        const other = await makeHarness();
        try {
          other.deps.store.withWrite((tx) => {
            tx.prepare("UPDATE session_bindings SET session_id = 'GHOST' WHERE run_id = ?").run(other.fixture.runId);
          });
          return await handlePreToolUse(
            other.deps,
            preToolInput({ sessionId: "S1", toolName: "ExitPlanMode", toolInput: {}, permissionMode: "plan" }),
          );
        } finally {
          other.close();
        }
      })();
      expect(detached.kind).toBe("empty");
    } finally {
      h.close();
    }
  });
});

describe("PermissionRequest (§15/§16/§30/E30)", () => {
  function signedToolInput(h: HandlerHarness, logical: string, businessInput: Record<string, unknown>, opts: { promptId?: string; permissionMode?: string } = {}) {
    const toolName = `mcp__plugin_phase-plan_phase-plan__${logical}`;
    const hostToken = encodeHostContextToken(
      h.secret,
      buildHostContextEnvelope({
        sessionId: "S1",
        promptId: "P1",
        workspaceId: h.fixture.workspaceId,
        runId: h.fixture.runId,
        bindingGeneration: h.fixture.generation,
        permissionMode: opts.permissionMode ?? "default",
        toolUseId: "TU-9",
        toolName,
        businessInputHash: businessInputHashOf(businessInput),
      }),
    );
    return { toolName, toolInput: { ...businessInput, _entryIntent: issueEntryIntent(h.secret, { sessionId: "S1", promptId: "P1" }), _hostContext: hostToken } };
  }

  it("verified start_or_resume → allow with session-scoped setMode(plan) (E16)", async () => {
    const h = await makeHarness();
    try {
      const { toolName, toolInput } = signedToolInput(h, "start_or_resume", { goal: "g" });
      const output = handlePermissionRequest(h.deps, {
        sessionId: "S1",
        promptId: "P1",
        hookEventName: "PermissionRequest",
        toolName,
        toolInput,
      });
      const decision = (output as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
        decision: { behavior: string; updatedPermissions: Array<{ type: string; mode: string; destination: string }> };
      };
      expect(decision.decision.behavior).toBe("allow");
      expect(decision.decision.updatedPermissions).toEqual([{ type: "setMode", mode: "plan", destination: "session" }]);
    } finally {
      h.close();
    }
  });

  it("missing context stays undecided; tampered context denies; approve_proposal is NEVER allowed (E30)", async () => {
    const h = await makeHarness();
    try {
      // no injected context → no decision (ordinary permission flow proceeds)
      expect(
        handlePermissionRequest(h.deps, {
          sessionId: "S1",
          promptId: "P1",
          hookEventName: "PermissionRequest",
          toolName: SCOPED.start,
          toolInput: { goal: "g" },
        }).kind,
      ).toBe("empty");

      // tampered context → deny via decision object
      const { toolName, toolInput } = signedToolInput(h, "start_or_resume", { goal: "g" });
      const decoded = JSON.parse(Buffer.from(toolInput._hostContext as string, "base64url").toString("utf8"));
      decoded.toolUseId = "TU-EVIL";
      const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
      const denied = handlePermissionRequest(h.deps, {
        sessionId: "S1",
        promptId: "P1",
        hookEventName: "PermissionRequest",
        toolName,
        toolInput: { ...toolInput, _hostContext: forged },
      });
      const denyDecision = (denied as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
        decision: { behavior: string };
      };
      expect(denyDecision.decision.behavior).toBe("deny");

      // approve_proposal: hook never answers, whatever the input
      const approve = signedToolInput(h, "approve_proposal", { proposal_id: "P", proposal_revision: 1, proposal_hash: "sha256:x" });
      expect(
        handlePermissionRequest(h.deps, {
          sessionId: "S1",
          promptId: "P1",
          hookEventName: "PermissionRequest",
          toolName: approve.toolName,
          toolInput: approve.toolInput,
        }).kind,
      ).toBe("empty");
    } finally {
      h.close();
    }
  });

  it("rejects a request whose session differs from the signed context", async () => {
    const h = await makeHarness();
    try {
      const { toolName, toolInput } = signedToolInput(h, "start_or_resume", { goal: "g" });
      const output = handlePermissionRequest(h.deps, {
        sessionId: "S2-IMPOSTOR",
        promptId: "P1",
        hookEventName: "PermissionRequest",
        toolName,
        toolInput,
      });
      const decision = (output as { kind: "json"; payload: Record<string, unknown> }).payload.hookSpecificOutput as {
        decision: { behavior: string; reason: string };
      };
      expect(decision.decision.behavior).toBe("deny");
      expect(decision.decision.reason).toContain("different session");
    } finally {
      h.close();
    }
  });
});
