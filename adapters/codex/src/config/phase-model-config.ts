/**
 * User-facing phase-model configuration (Phase 5 directive §5, §13-14).
 *
 * EXACTLY three product settings — no more (fallback models, providers,
 * routing strategies, timeouts, phase rules, cost policy are all out of
 * scope by directive §5):
 *
 *   planningModel    — model applied when Codex enters Plan mode
 *   executionModel   — model applied for Default mode / TUI startup
 *   reasoningEffort  — unified startup effort default (both native keys)
 *
 * Model identifiers MUST come from configuration (directive §2): there are
 * deliberately NO default model slugs — the conceptual Sol/Luna roles are
 * product names, never hardcoded IDs. reasoningEffort defaults to "xhigh".
 *
 * Precedence (directive §14), lowest → highest:
 *   defaults < config file < environment < explicit CLI args
 *
 * The user's native ~/.codex/config.toml is NEVER read or written here
 * (directive §15): config.toml stays Codex's own authority; this surface is
 * phase-model-specific and session-scoped.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CodexPhaseModelConfig {
  readonly planningModel: string;
  readonly executionModel: string;
  readonly reasoningEffort: string;
}

export class CodexPhaseModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPhaseModelConfigError";
  }
}

/** The only default value in the surface (directive §6). */
export const DEFAULT_REASONING_EFFORT = "xhigh";

/** Default config file name looked up in the launcher's working directory. */
export const DEFAULT_CONFIG_FILE_NAME = ".codex-phase-model.json";

/** Fixed environment-variable names (directive §13: fixed, documented, tested). */
export const ENV_PLANNING_MODEL = "CODEX_PHASE_MODEL_PLANNING_MODEL";
export const ENV_EXECUTION_MODEL = "CODEX_PHASE_MODEL_EXECUTION_MODEL";
export const ENV_REASONING_EFFORT = "CODEX_PHASE_MODEL_REASONING_EFFORT";

/** Fixed CLI flag names for the phase-model launcher. */
export const CLI_PLANNING_MODEL = "--planning-model";
export const CLI_EXECUTION_MODEL = "--execution-model";
export const CLI_REASONING_EFFORT = "--reasoning-effort";
export const CLI_CONFIG_FILE = "--config";

/** A partially-filled configuration as produced by each precedence layer. */
export interface PartialPhaseModelConfig {
  planningModel?: string;
  executionModel?: string;
  reasoningEffort?: string;
}

/** Accepts both camelCase and the SPEC's snake_case spelling per field. */
function readConfigFileLayer(raw: unknown): PartialPhaseModelConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CodexPhaseModelConfigError("config file must contain a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string): string | undefined => {
    const value = record[camel] ?? record[snake];
    return typeof value === "string" ? value : undefined;
  };
  return {
    planningModel: pick("planningModel", "planning_model"),
    executionModel: pick("executionModel", "execution_model"),
    reasoningEffort: pick("reasoningEffort", "reasoning_effort"),
  };
}

function readEnvLayer(env: NodeJS.ProcessEnv): PartialPhaseModelConfig {
  return {
    planningModel: env[ENV_PLANNING_MODEL],
    executionModel: env[ENV_EXECUTION_MODEL],
    reasoningEffort: env[ENV_REASONING_EFFORT],
  };
}

/** Trim + require non-empty; empty/whitespace values are config errors. */
function finalize(merged: PartialPhaseModelConfig): CodexPhaseModelConfig {
  const planningModel = merged.planningModel?.trim() ?? "";
  const executionModel = merged.executionModel?.trim() ?? "";
  const reasoningEffort = merged.reasoningEffort?.trim() || DEFAULT_REASONING_EFFORT;
  if (planningModel.length === 0) {
    throw new CodexPhaseModelConfigError(
      "planning model is not configured — set planning_model in the config file, " +
        `${ENV_PLANNING_MODEL}, or ${CLI_PLANNING_MODEL} (there is no default model slug)`,
    );
  }
  if (executionModel.length === 0) {
    throw new CodexPhaseModelConfigError(
      "execution model is not configured — set execution_model in the config file, " +
        `${ENV_EXECUTION_MODEL}, or ${CLI_EXECUTION_MODEL} (there is no default model slug)`,
    );
  }
  // Same model for both phases is allowed (directive §5); Codex itself is
  // the authority on whether an identifier is usable.
  return { planningModel, executionModel, reasoningEffort };
}

export interface LoadPhaseModelConfigOptions {
  /** Explicit --config path; a missing file is a hard error. */
  readonly configFilePath?: string;
  /** CLI override layer (highest precedence). */
  readonly cliOverrides?: PartialPhaseModelConfig;
  /** Environment layer. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory for the default config-file lookup. Defaults to cwd. */
  readonly cwd?: string;
  /** Test seam; defaults to node:fs readFileSync. */
  readonly readFile?: (path: string) => string;
}

/**
 * Resolve the effective configuration across all precedence layers
 * (directive §14). The default config file (`.codex-phase-model.json` in
 * the working directory) is optional; an EXPLICITLY requested config file
 * that is missing or unreadable is a hard error (fail fast, §11 spirit).
 */
export function loadCodexPhaseModelConfig(
  options: LoadPhaseModelConfigOptions = {},
): CodexPhaseModelConfig {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const cwd = options.cwd ?? process.cwd();

  const fileLayer: PartialPhaseModelConfig =
    options.configFilePath !== undefined
      ? (readConfigFile(readFile, options.configFilePath, true) ?? {})
      : (readConfigFile(readFile, join(cwd, DEFAULT_CONFIG_FILE_NAME), false) ?? {});

  const envLayer = readEnvLayer(env);
  const cli = options.cliOverrides ?? {};

  return finalize({
    planningModel: cli.planningModel ?? envLayer.planningModel ?? fileLayer.planningModel,
    executionModel: cli.executionModel ?? envLayer.executionModel ?? fileLayer.executionModel,
    reasoningEffort:
      cli.reasoningEffort ?? envLayer.reasoningEffort ?? fileLayer.reasoningEffort,
  });
}

/**
 * Read + parse one config-file layer. `explicit` controls missing-file
 * behavior: hard error vs. null (default file is optional).
 */
function readConfigFile(
  readFile: (path: string) => string,
  path: string,
  explicit: boolean,
): PartialPhaseModelConfig | null {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    if (isNotFoundError(error) && !explicit) {
      return null;
    }
    throw new CodexPhaseModelConfigError(
      `config file could not be read: ${path} (${describe(error)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodexPhaseModelConfigError(`config file is not valid JSON: ${path}`);
  }
  return readConfigFileLayer(parsed);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
