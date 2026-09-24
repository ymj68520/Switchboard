/**
 * Claude plugin environment preflight (frozen plan §8/§9, architecture §25.1).
 *
 * The doctor distinguishes three classifications so a plain developer run
 * (`node phase-plan-runtime.mjs doctor` outside Claude Code) is never
 * misdiagnosed as broken:
 *
 *  - plugin_runtime: variables Claude Code provides to plugin-spawned
 *    processes. Absence means "not inside a plugin session" (NOT_ACTIVE),
 *    not "broken".
 *  - host_session: variables tied to a live Claude Code session; optional.
 *  - optional: presence is informational only.
 *
 * When CLAUDE_PLUGIN_DATA is available its path is preflighted for the frozen
 * storage layout (store/, blobs/, backups/, exports/) with a temporary write
 * probe that is always cleaned up.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { RuntimeError } from "../runtime/errors.js";

export type EnvVarClassification = "plugin_runtime" | "host_session" | "optional";

export interface EnvVarSpec {
  classification: EnvVarClassification;
  purpose: string;
}

/** Single source of truth for Phase Plan's host environment variables. */
export const PHASE_PLAN_ENV_SPEC: Readonly<Record<string, EnvVarSpec>> = {
  CLAUDE_PLUGIN_ROOT: {
    classification: "plugin_runtime",
    purpose: "plugin installation root (Claude Code provides it to plugin processes)",
  },
  CLAUDE_PLUGIN_DATA: {
    classification: "plugin_runtime",
    purpose: "persistent plugin data root — canonical Phase Plan storage domain (architecture §25.1)",
  },
  CLAUDE_PROJECT_DIR: {
    classification: "host_session",
    purpose: "project directory of the active Claude Code session",
  },
  CLAUDE_CODE_SESSION_ID: {
    classification: "host_session",
    purpose: "active Claude Code session id",
  },
};

export interface EnvVariableReport {
  name: string;
  classification: EnvVarClassification;
  purpose: string;
  present: boolean;
  value?: string;
}

export type PluginEnvStatus = "ACTIVE" | "NOT_ACTIVE";

export interface PluginEnvironmentReport {
  status: PluginEnvStatus;
  variables: EnvVariableReport[];
}

export function classifyPluginEnvironment(env: NodeJS.ProcessEnv = process.env): PluginEnvironmentReport {
  const variables: EnvVariableReport[] = [];
  let active = false;
  for (const [name, spec] of Object.entries(PHASE_PLAN_ENV_SPEC)) {
    const value = env[name];
    const present = typeof value === "string" && value.trim() !== "";
    if (present && spec.classification === "plugin_runtime") {
      active = true;
    }
    variables.push({
      name,
      classification: spec.classification,
      purpose: spec.purpose,
      present,
      ...(present ? { value: value!.trim() } : {}),
    });
  }
  return { status: active ? "ACTIVE" : "NOT_ACTIVE", variables };
}

/** Top-level directories of the frozen storage layout (architecture §25.1). */
export const PHASE_PLAN_DATA_SUBDIRS = ["store", "blobs", "backups", "exports"] as const;

export type PluginDataPreflightResult =
  | {
      status: "ok";
      root: string;
      resolvedRoot: string;
      createdRoot: boolean;
      createdDirs: string[];
    }
  | { status: "unavailable"; errorCode: "PLUGIN_DATA_UNAVAILABLE"; message: string }
  | { status: "not_writable"; errorCode: "PLUGIN_DATA_NOT_WRITABLE"; message: string };

export interface PluginDataIo {
  stat(path: string): Promise<{ isDirectory(): boolean } | null>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

export const nodePluginDataIo: PluginDataIo = {
  stat: async (p) => {
    try {
      return await fs.stat(p);
    } catch {
      return null;
    }
  },
  mkdir: (p, options) => fs.mkdir(p, options),
  writeFile: (p, data) => fs.writeFile(p, data),
  unlink: (p) => fs.unlink(p),
  readdir: (p) => fs.readdir(p),
};

/**
 * Preflight the plugin data root: resolve the path, create it (and the frozen
 * layout subdirs) when absent, and prove writability with a probe file that
 * is removed afterwards. Never leaves the probe behind.
 */
export async function preflightPluginData(
  rawPath: string,
  io: PluginDataIo = nodePluginDataIo,
): Promise<PluginDataPreflightResult> {
  if (rawPath.trim() === "") {
    return {
      status: "unavailable",
      errorCode: "PLUGIN_DATA_UNAVAILABLE",
      message: "CLAUDE_PLUGIN_DATA is set but empty",
    };
  }
  let resolvedRoot: string;
  try {
    resolvedRoot = path.resolve(rawPath);
  } catch (err) {
    return {
      status: "unavailable",
      errorCode: "PLUGIN_DATA_UNAVAILABLE",
      message: `cannot resolve CLAUDE_PLUGIN_DATA path: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const existing = await io.stat(resolvedRoot);
  if (existing !== null && !existing.isDirectory()) {
    return {
      status: "unavailable",
      errorCode: "PLUGIN_DATA_UNAVAILABLE",
      message: `CLAUDE_PLUGIN_DATA path exists and is not a directory: ${resolvedRoot}`,
    };
  }
  const createdRoot = existing === null;
  try {
    if (createdRoot) {
      await io.mkdir(resolvedRoot, { recursive: true });
    }
    const createdDirs: string[] = [];
    for (const sub of PHASE_PLAN_DATA_SUBDIRS) {
      const dir = path.join(resolvedRoot, sub);
      const stat = await io.stat(dir);
      if (stat === null) {
        await io.mkdir(dir, { recursive: true });
        createdDirs.push(sub);
      }
    }
    // Write probe: unique temp file, fsync via handle close is implied by
    // writeFile completion; always removed before returning.
    const probe = path.join(
      resolvedRoot,
      `.phase-plan-write-probe-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      await io.writeFile(probe, "phase-plan write probe\n");
    } catch (err) {
      return {
        status: "not_writable",
        errorCode: "PLUGIN_DATA_NOT_WRITABLE",
        message: `cannot write into ${resolvedRoot}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      await io.unlink(probe);
    } catch {
      // A leftover probe would be junk; surface it as not writable since the
      // directory misbehaves on delete.
      return {
        status: "not_writable",
        errorCode: "PLUGIN_DATA_NOT_WRITABLE",
        message: `write probe could not be removed in ${resolvedRoot}`,
      };
    }
    const remaining = (await io.readdir(resolvedRoot)).filter((name) =>
      name.startsWith(".phase-plan-write-probe-"),
    );
    if (remaining.length > 0) {
      return {
        status: "not_writable",
        errorCode: "PLUGIN_DATA_NOT_WRITABLE",
        message: `write probe leftover detected in ${resolvedRoot}`,
      };
    }
    return { status: "ok", root: rawPath, resolvedRoot, createdRoot, createdDirs };
  } catch (err) {
    return {
      status: "unavailable",
      errorCode: "PLUGIN_DATA_UNAVAILABLE",
      message: `cannot prepare plugin data directory ${resolvedRoot}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Throwing variant used by runtime commands that require storage (kept for
 * Phase 2 store bootstrap; doctor uses the non-throwing result directly).
 */
export function assertPluginDataPreflight(result: PluginDataPreflightResult): void {
  if (result.status === "unavailable" || result.status === "not_writable") {
    throw new RuntimeError(result.errorCode, result.message);
  }
}
