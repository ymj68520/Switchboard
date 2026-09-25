import { describe, expect, it } from "vitest";

import {
  CodexPhaseModelConfigError,
  DEFAULT_REASONING_EFFORT,
  ENV_EXECUTION_MODEL,
  ENV_PLANNING_MODEL,
  ENV_REASONING_EFFORT,
  loadCodexPhaseModelConfig,
} from "../src/index.js";

const FILE = JSON.stringify({
  planning_model: "file-plan",
  execution_model: "file-exec",
  reasoning_effort: "high",
});

function reader(body: string | null) {
  return (path: string): string => {
    if (body === null) {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return body;
  };
}

describe("CodexPhaseModelConfig surface (Phase 5 §5/§13/§14)", () => {
  it("has exactly three fields; explicit file effort wins (§6/§14)", () => {
    const config = loadCodexPhaseModelConfig({
      env: {},
      readFile: () => FILE,
    });
    expect(Object.keys(config).sort()).toEqual(["executionModel", "planningModel", "reasoningEffort"]);
    expect(config.reasoningEffort).toBe("high");
    expect(config.planningModel).toBe("file-plan");
    expect(config.executionModel).toBe("file-exec");
  });

  it("falls back to xhigh when no layer provides an effort (§6)", () => {
    const config = loadCodexPhaseModelConfig({
      env: {},
      readFile: () => JSON.stringify({ planning_model: "p", execution_model: "e" }),
    });
    expect(config.reasoningEffort).toBe(DEFAULT_REASONING_EFFORT);
  });

  it("requires both model ids from configuration — no default slugs (§2/§5)", () => {
    expect(() => loadCodexPhaseModelConfig({ env: {}, readFile: reader(null) })).toThrow(
      CodexPhaseModelConfigError,
    );
    expect(() =>
      loadCodexPhaseModelConfig({
        env: { [ENV_PLANNING_MODEL]: "only-plan" },
        readFile: reader(null),
      }),
    ).toThrow(/execution model/);
    expect(() =>
      loadCodexPhaseModelConfig({
        env: { [ENV_EXECUTION_MODEL]: "only-exec" },
        readFile: reader(null),
      }),
    ).toThrow(/planning model/);
  });

  it("accepts the conceptual default of identical phase models (§5)", () => {
    const config = loadCodexPhaseModelConfig({
      env: {
        [ENV_PLANNING_MODEL]: " same-model ",
        [ENV_EXECUTION_MODEL]: "same-model",
        [ENV_REASONING_EFFORT]: "  ",
      },
      readFile: reader(null),
    });
    expect(config).toEqual({
      planningModel: "same-model",
      executionModel: "same-model",
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    });
  });

  it("applies precedence: defaults < config file < environment < CLI (§14)", () => {
    const config = loadCodexPhaseModelConfig({
      env: {
        [ENV_PLANNING_MODEL]: "env-plan",
        [ENV_REASONING_EFFORT]: "medium",
      },
      cliOverrides: { executionModel: "cli-exec" },
      readFile: () => FILE,
    });
    expect(config.planningModel).toBe("env-plan"); // env beats file
    expect(config.executionModel).toBe("cli-exec"); // CLI beats file
    expect(config.reasoningEffort).toBe("medium"); // env beats file default
  });

  it("treats an explicit --config file as mandatory (fail fast, §11 spirit)", () => {
    expect(() =>
      loadCodexPhaseModelConfig({
        configFilePath: "missing.json",
        env: {},
        readFile: reader(null),
      }),
    ).toThrow(/config file could not be read/);
  });

  it("rejects an invalid JSON config file", () => {
    expect(() =>
      loadCodexPhaseModelConfig({ env: {}, readFile: () => "{not json" }),
    ).toThrow(/not valid JSON/);
  });

  it("accepts camelCase file fields as well as snake_case", () => {
    const config = loadCodexPhaseModelConfig({
      env: {},
      readFile: () =>
        JSON.stringify({ planningModel: "c-plan", executionModel: "c-exec" }),
    });
    expect(config.planningModel).toBe("c-plan");
    expect(config.executionModel).toBe("c-exec");
  });
});
