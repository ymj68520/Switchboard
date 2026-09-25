import { describe, expect, it } from "vitest";

import { LauncherUsageError, parseLauncherArgs, runLauncher } from "../src/index.js";

describe("parseLauncherArgs (Phase 5 §10/§13)", () => {
  it("splits phase-model flags from codex passthrough args", () => {
    const parsed = parseLauncherArgs([
      "--planning-model",
      "plan-X",
      "--execution-model=exec-Y",
      "--reasoning-effort",
      "high",
      "--config",
      "cfg.json",
      "-s",
      "workspace-write",
      "resume",
      "--last",
    ]);
    expect(parsed.cliOverrides).toEqual({
      planningModel: "plan-X",
      executionModel: "exec-Y",
      reasoningEffort: "high",
    });
    expect(parsed.configFilePath).toBe("cfg.json");
    expect(parsed.passthroughArgs).toEqual(["-s", "workspace-write", "resume", "--last"]);
  });

  it("treats unknown flags as passthrough, never usage errors (§10)", () => {
    const parsed = parseLauncherArgs(["--no-alt-screen", "--search", "-p", "work"]);
    expect(parsed.passthroughArgs).toEqual(["--no-alt-screen", "--search", "-p", "work"]);
  });

  it("rejects a flag missing its value", () => {
    expect(() => parseLauncherArgs(["--planning-model"])).toThrow(LauncherUsageError);
  });

  it("--help raises the usage surface", () => {
    expect(() => parseLauncherArgs(["--help"])).toThrow(LauncherUsageError);
  });
});

describe("runLauncher exit-code policy (Phase 5 §21)", () => {
  const ENV = {
    CODEX_PHASE_MODEL_PLANNING_MODEL: "plan-X",
    CODEX_PHASE_MODEL_EXECUTION_MODEL: "exec-Y",
  };

  it("propagates the TUI exit code", async () => {
    const code = await runLauncher(["--no-alt-screen"], {
      env: ENV,
      sessionFactory: async ({ phaseModel, passthroughArgs }) => {
        expect(phaseModel.executionModel).toBe("exec-Y");
        expect(passthroughArgs).toEqual(["--no-alt-screen"]);
        return { kind: "tui-exit", exitCode: 7, signal: null };
      },
    });
    expect(code).toBe(7);
  });

  it("returns 1 for a bootstrap failure and prints the reason", async () => {
    const lines: string[] = [];
    const code = await runLauncher([], {
      env: ENV,
      warn: (message) => lines.push(message),
      sessionFactory: async () => ({
        kind: "bootstrap-failure",
        message: "app-server bootstrap failed: boom",
      }),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("boom");
  });

  it("returns 1 for an app-server crash", async () => {
    const code = await runLauncher([], {
      env: ENV,
      sessionFactory: async () => ({
        kind: "app-server-crash",
        message: "the dedicated app-server exited unexpectedly",
      }),
    });
    expect(code).toBe(1);
  });

  it("returns 2 for a configuration error without starting any session", async () => {
    const lines: string[] = [];
    let sessionStarted = false;
    const code = await runLauncher(["--planning-model", " "], {
      env: {},
      warn: (message) => lines.push(message),
      sessionFactory: async () => {
        sessionStarted = true;
        return { kind: "tui-exit", exitCode: 0, signal: null };
      },
    });
    expect(code).toBe(2);
    expect(sessionStarted).toBe(false);
    expect(lines.join("\n")).toContain("planning model");
  });

  it("returns 2 for a reserved passthrough conflict (§11 fail fast)", async () => {
    const lines: string[] = [];
    const code = await runLauncher(["--remote", "ws://127.0.0.1:9"], {
      env: ENV,
      warn: (message) => lines.push(message),
      sessionFactory: async () => ({ kind: "tui-exit", exitCode: 0, signal: null }),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("conflicts with a launcher-managed");
  });

  it("maps a signal-only TUI ending to 130", async () => {
    const code = await runLauncher([], {
      env: ENV,
      sessionFactory: async () => ({ kind: "tui-exit", exitCode: null, signal: "SIGINT" }),
    });
    expect(code).toBe(130);
  });
});
