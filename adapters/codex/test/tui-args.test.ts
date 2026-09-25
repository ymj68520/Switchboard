import { describe, expect, it } from "vitest";

import {
  ReservedArgumentConflictError,
  buildCodexTuiArgs,
  createLoopbackEndpoint,
} from "../src/index.js";

const ENDPOINT = createLoopbackEndpoint("127.0.0.1", 54321);
if (ENDPOINT === null) {
  throw new Error("test endpoint must be valid");
}

const BASE = {
  endpoint: ENDPOINT,
  executionModel: "exec-Y",
  reasoningEffort: "xhigh",
  passthroughArgs: [] as readonly string[],
};

describe("buildCodexTuiArgs (Phase 5 §8/§9/§36/§41)", () => {
  it("produces the exact frozen launch argv (§41)", () => {
    const args = buildCodexTuiArgs({
      endpoint: ENDPOINT,
      executionModel: "exec-Y",
      reasoningEffort: "xhigh",
      passthroughArgs: [],
    });
    expect(args).toEqual([
      "--remote",
      "ws://127.0.0.1:54321",
      "--model",
      "exec-Y",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      'plan_mode_reasoning_effort="xhigh"',
    ]);
  });

  it("initializes BOTH native effort keys to the configured effort (§7/§34)", () => {
    const args = buildCodexTuiArgs({ ...BASE, reasoningEffort: "high" });
    expect(args.filter((arg) => arg.includes("reasoning_effort"))).toEqual([
      'model_reasoning_effort="high"',
      'plan_mode_reasoning_effort="high"',
    ]);
  });

  it("pins the TUI startup model to executionModel (§8)", () => {
    const args = buildCodexTuiArgs({ ...BASE, executionModel: "start-model" });
    const modelIndex = args.indexOf("--model");
    expect(args[modelIndex + 1]).toBe("start-model");
  });

  it("escapes TOML string overrides without any shell quoting (§37)", () => {
    const args = buildCodexTuiArgs({ ...BASE, reasoningEffort: 'we"ird\\effort' });
    expect(args).toContain('model_reasoning_effort="we\\"ird\\\\effort"');
    expect(args.join(" ")).not.toContain('""'); // no shell-style doubling
  });

  it("appends passthrough args after the launcher-owned ones (§10/§16)", () => {
    const args = buildCodexTuiArgs({
      ...BASE,
      passthroughArgs: ["-s", "workspace-write", "resume", "--last"],
    });
    expect(args.slice(-4)).toEqual(["-s", "workspace-write", "resume", "--last"]);
  });
});

describe("reserved argument conflict policy (Phase 5 §11/§42)", () => {
  const conflicts: ReadonlyArray<readonly string[]> = [
    ["--remote", "ws://127.0.0.1:9"],
    ["--remote=ws://127.0.0.1:9"],
    ["--model", "x"],
    ["--model=x"],
    ["-m", "x"],
    ["-c", "model=x"],
    ["-c", "model_reasoning_effort=high"],
    ["-c", "plan_mode_reasoning_effort=high"],
    ["--config", "model=x"],
    ["-cmodel=x"],
    ["-cmodel_reasoning_effort=high"],
  ];

  for (const passthrough of conflicts) {
    it(`rejects ${JSON.stringify(passthrough)} instead of silently overriding`, () => {
      expect(() => buildCodexTuiArgs({ ...BASE, passthroughArgs: passthrough })).toThrow(
        ReservedArgumentConflictError,
      );
    });
  }

  const allowed: ReadonlyArray<readonly string[]> = [
    ["-s", "workspace-write"],
    ["--no-alt-screen"],
    ["-c", 'sandbox_permissions=["disk-full-read-access"]'],
    ["-c", "model_reasoning_effort_v2=high"], // near-miss keys pass
    ["resume", "--last"],
    ["--search"],
    ["-C", "D:\\some\\path with spaces"],
  ];

  for (const passthrough of allowed) {
    it(`passes through ${JSON.stringify(passthrough)} (§16)`, () => {
      expect(() => buildCodexTuiArgs({ ...BASE, passthroughArgs: passthrough })).not.toThrow();
    });
  }
});
