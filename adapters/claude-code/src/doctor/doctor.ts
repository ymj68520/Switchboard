/**
 * Doctor orchestration (frozen plan §6–§9): run the preflight probes, build
 * the report, render it. All probes are injectable so integration tests
 * never depend on the host machine having a specific Claude Code install or
 * Node version.
 */

import {
  classifyPluginEnvironment,
  preflightPluginData,
  type PluginDataPreflightResult,
  type PluginDataIo,
  nodePluginDataIo,
} from "../claude/environment.js";
import { probeClaudeVersion, type ClaudeVersionResult, nodeSpawnRunner, type SpawnRunner } from "../claude/version.js";
import { probeSqliteCapability, type SqliteCapabilityResult } from "../store/sqlite-capability.js";
import { RUNTIME_NAME, RUNTIME_VERSION } from "../runtime/version.js";
import { SUPPORTED_SCHEMA_VERSION } from "../store/constants.js";
import { RuntimeError, isRuntimeError } from "../runtime/errors.js";
import {
  inspectPlanStore,
  type PlanStoreInspection,
} from "../store/sqlite-store.js";
import { checkClaudeCapabilities, checkClaudeCli, checkNodeVersion, checkPlanStore, checkPluginData, checkPluginEnvironment, checkSqliteCapability } from "./checks.js";
import { evaluateClaudeCapabilities } from "./capabilities.js";
import {
  deriveHostIntegration,
  deriveOverallReadiness,
  type DoctorReport,
} from "./report.js";

export interface DoctorDeps {
  /** Defaults to the running process version (process.versions.node). */
  detectNodeVersion?(): string;
  /** Defaults to spawning `claude --version` via the Node process API. */
  probeClaude?(runner?: SpawnRunner): Promise<ClaudeVersionResult>;
  /** Defaults to the real node:sqlite in-memory smoke test. */
  probeSqlite?(): Promise<SqliteCapabilityResult>;
  /** Environment used for plugin variable classification. */
  env?: NodeJS.ProcessEnv;
  /** Filesystem layer for the plugin data preflight. */
  pluginDataIo?: PluginDataIo;
  claudeSpawnRunner?: SpawnRunner;
  /** Read-only store inspection seam (tests); errors become failed checks. */
  inspectStore?(pluginDataRoot: string): PlanStoreInspection;
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const env = deps.env ?? process.env;

  const detectedNode = deps.detectNodeVersion?.() ?? process.versions.node;
  const nodeCheck = checkNodeVersion(detectedNode);

  const sqliteResult = deps.probeSqlite
    ? await deps.probeSqlite()
    : await probeSqliteCapability();
  const sqliteCheck = checkSqliteCapability(sqliteResult);

  const claudeResult = deps.probeClaude
    ? await deps.probeClaude(deps.claudeSpawnRunner ?? nodeSpawnRunner)
    : await probeClaudeVersion(deps.claudeSpawnRunner ?? nodeSpawnRunner);
  const claudeCliCheck = checkClaudeCli(claudeResult);
  const capabilitiesReport = evaluateClaudeCapabilities(claudeResult);
  const capabilitiesCheck = checkClaudeCapabilities(capabilitiesReport);

  const envReport = classifyPluginEnvironment(env);
  const envCheck = checkPluginEnvironment(envReport);

  let dataPreflight: PluginDataPreflightResult | null = null;
  const rawData = env.CLAUDE_PLUGIN_DATA;
  if (typeof rawData === "string" && rawData.trim() !== "") {
    dataPreflight = await preflightPluginData(rawData, deps.pluginDataIo ?? nodePluginDataIo);
  }
  const dataCheck = checkPluginData(dataPreflight !== null, dataPreflight);

  // Read-only store inspection (never creates/migrates). Inspection errors
  // (corrupt file, unreadable header) surface as a failed check, not a crash.
  let storeInspection: PlanStoreInspection | null = null;
  if (dataPreflight?.status === "ok") {
    try {
      storeInspection = deps.inspectStore
        ? deps.inspectStore(dataPreflight.resolvedRoot)
        : inspectPlanStore(dataPreflight.resolvedRoot);
    } catch (err) {
      const error = isRuntimeError(err)
        ? err
        : new RuntimeError("STORE_CORRUPT", "Plan Store inspection failed", {
            cause: err instanceof Error ? err.message : String(err),
          });
      storeInspection = {
        status: error.code === "STORE_SCHEMA_TOO_NEW" ? "too_new" : "invalid",
        supported: SUPPORTED_SCHEMA_VERSION,
        databasePath: "",
        problems: [error.message],
      };
    }
  }
  const planStoreCheck = checkPlanStore(storeInspection);

  const report: DoctorReport = {
    schema: "phase-plan.doctor-report/1",
    runtime: { name: RUNTIME_NAME, version: RUNTIME_VERSION },
    overall: "NOT_READY",
    hostIntegration: "NOT_READY",
    checks: {
      node: nodeCheck,
      sqlite: sqliteCheck,
      claudeCli: claudeCliCheck,
      claudeCapabilities: capabilitiesCheck,
      pluginEnvironment: envCheck,
      pluginData: dataCheck,
      planStore: planStoreCheck,
    },
  };
  report.overall = deriveOverallReadiness(report);
  report.hostIntegration = deriveHostIntegration(report);
  return report;
}
