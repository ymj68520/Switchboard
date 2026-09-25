import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { runDoctor, type DoctorDeps } from "../src/doctor/doctor.js";
import { doctorExitCode, renderHumanReport, renderJsonReport } from "../src/doctor/report.js";
import {
  claudeVersionOutcome,
  failingSqliteLoader,
  fakeSpawnRunner,
  makeTempDir,
  removeTempDir,
} from "./helpers.js";
import type { SqliteCapabilityResult } from "../src/store/sqlite-capability.js";

function okSqlite(): SqliteCapabilityResult {
  return {
    available: true,
    steps: {
      module_load: "pass",
      open: "pass",
      create: "pass",
      insert: "pass",
      select: "pass",
      transaction: "pass",
      close: "pass",
    },
    sqliteVersion: "3.53.4",
  };
}

function baseDeps(overrides: DoctorDeps = {}): DoctorDeps {
  return {
    detectNodeVersion: () => "24.21.0",
    probeClaude: async () => ({ status: "ok", version: "2.1.276", raw: "Claude Code 2.1.276", binPath: "claude" }),
    probeSqlite: async () => okSqlite(),
    env: {},
    ...overrides,
  };
}

describe("doctor integration (injected probes)", () => {
  it("reports READY with exit 0 when every required check passes", async () => {
    const report = await runDoctor(baseDeps());
    expect(report.overall).toBe("READY");
    // No plugin_runtime env vars → NOT_ACTIVE (informational, not a failure).
    expect(report.hostIntegration).toBe("NOT_ACTIVE");
    expect(doctorExitCode(report)).toBe(0);
    for (const check of Object.values(report.checks)) {
      expect(["PASS", "NOT_ACTIVE"], check.id).toContain(check.status);
    }
  });

  it("fails on unsupported Node with required/detected in the report (exit 3)", async () => {
    const report = await runDoctor(baseDeps({ detectNodeVersion: () => "24.14.9" }));
    expect(report.overall).toBe("NOT_READY");
    expect(report.checks.node.status).toBe("FAIL");
    expect(report.checks.node.errorCode).toBe("UNSUPPORTED_NODE_VERSION");
    expect(report.checks.node.detail).toMatchObject({ detected: "24.14.9", required: "24.15.0" });
    expect(doctorExitCode(report)).toBe(3);
  });

  it("fails with exit 4 when the Claude CLI is missing", async () => {
    const report = await runDoctor(baseDeps({
      probeClaude: async () => ({ status: "not_found", attempted: ["claude", "claude.cmd"] }),
    }));
    expect(report.overall).toBe("NOT_READY");
    expect(report.checks.claudeCli.errorCode).toBe("CLAUDE_CLI_NOT_FOUND");
    expect(report.checks.claudeCapabilities.status).toBe("FAIL");
    expect(report.checks.claudeCapabilities.detail).toMatchObject({
      capabilities: expect.objectContaining({
        plugins: expect.objectContaining({ status: "UNKNOWN" }),
      }),
    });
    expect(doctorExitCode(report)).toBe(4);
  });

  it("fails with exit 4 when the Claude version is malformed (fail-closed)", async () => {
    const report = await runDoctor(baseDeps({
      probeClaude: async () => ({
        status: "unreadable",
        reason: "could not parse a semver from claude --version output",
        raw: "gibberish",
        binPath: "claude",
        exitCode: 0,
      }),
    }));
    expect(report.checks.claudeCli.errorCode).toBe("CLAUDE_VERSION_UNREADABLE");
    expect(report.checks.claudeCapabilities.status).toBe("FAIL");
    expect(doctorExitCode(report)).toBe(4);
  });

  it("fails with exit 4 when capabilities are below the policy minimum", async () => {
    const report = await runDoctor(baseDeps({
      probeClaude: async () => ({ status: "ok", version: "1.9.9", raw: "claude 1.9.9", binPath: "claude" }),
    }));
    expect(report.checks.claudeCapabilities.errorCode).toBe("CLAUDE_CAPABILITY_UNSUPPORTED");
    expect(doctorExitCode(report)).toBe(4);
  });

  it("rejects Claude 2.1.198: approval capability FAIL, host integration NOT_READY", async () => {
    const report = await runDoctor(baseDeps({
      probeClaude: async () => ({ status: "ok", version: "2.1.198", raw: "Claude Code 2.1.198", binPath: "claude" }),
    }));
    expect(report.checks.claudeCapabilities.status).toBe("FAIL");
    expect(report.checks.claudeCapabilities.errorCode).toBe("CLAUDE_CAPABILITY_UNSUPPORTED");
    expect(report.checks.claudeCapabilities.detail).toMatchObject({
      capabilities: expect.objectContaining({
        requiredUserInteraction: expect.objectContaining({
          status: "FAIL",
          reason: expect.stringContaining("2.1.199"),
        }),
      }),
    });
    expect(report.hostIntegration).toBe("NOT_READY");
    expect(doctorExitCode(report)).toBe(4);
  });

  it("accepts Claude 2.1.199: approval capability PASS, unverified capabilities stay UNKNOWN", async () => {
    const report = await runDoctor(baseDeps({
      probeClaude: async () => ({ status: "ok", version: "2.1.199", raw: "Claude Code 2.1.199", binPath: "claude" }),
    }));
    expect(report.checks.claudeCapabilities.status).toBe("PASS");
    expect(report.checks.claudeCapabilities.detail).toMatchObject({
      capabilities: expect.objectContaining({
        requiredUserInteraction: expect.objectContaining({ status: "PASS" }),
        planModeIntegration: expect.objectContaining({ status: "UNKNOWN" }),
        hookLifecycle: expect.objectContaining({ status: "UNKNOWN" }),
      }),
    });
    expect(doctorExitCode(report)).toBe(0);
  });

  it("fails with exit 3 when node:sqlite is unavailable", async () => {
    const report = await runDoctor(baseDeps({
      probeSqlite: async () => ({
        available: false,
        steps: {
          module_load: "fail",
          open: "fail",
          create: "fail",
          insert: "fail",
          select: "fail",
          transaction: "fail",
          close: "fail",
        },
        failedStep: "module_load",
        cause: "Error: ERR_UNKNOWN_BUILTIN_MODULE",
      }),
    }));
    expect(report.checks.sqlite.errorCode).toBe("SQLITE_UNAVAILABLE");
    expect(doctorExitCode(report)).toBe(3);
  });

  it("preflights a real plugin data root when CLAUDE_PLUGIN_DATA is set", async () => {
    const dataRoot = path.join(await makeTempDir("phase-plan-doctor-"), "plugin data", "ünïcode 数据");
    try {
      const report = await runDoctor(baseDeps({ env: { CLAUDE_PLUGIN_DATA: dataRoot } }));
      expect(report.checks.pluginData.status).toBe("PASS");
      expect(report.checks.pluginData.detail).toMatchObject({
        resolvedRoot: path.resolve(dataRoot),
        createdDirs: ["store", "blobs", "backups", "exports"],
      });
      expect(report.hostIntegration).toBe("ACTIVE");
      expect(doctorExitCode(report)).toBe(0);
      // No probe leftovers.
      const leftovers = (await fs.readdir(dataRoot)).filter((n) => n.includes("write-probe"));
      expect(leftovers).toEqual([]);
    } finally {
      await removeTempDir(dataRoot);
    }
  });

  it("fails with exit 5 when the plugin data root is unavailable", async () => {
    const dir = await makeTempDir("phase-plan-doctor-occ-");
    const occupied = path.join(dir, "occupied-by-file");
    await fs.writeFile(occupied, "x");
    try {
      const report = await runDoctor(baseDeps({ env: { CLAUDE_PLUGIN_DATA: occupied } }));
      expect(report.checks.pluginData.status).toBe("FAIL");
      expect(report.checks.pluginData.errorCode).toBe("PLUGIN_DATA_UNAVAILABLE");
      expect(doctorExitCode(report)).toBe(5);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("reports NOT_ACTIVE plugin env as non-failing outside Claude sessions", async () => {
    const report = await runDoctor(baseDeps());
    expect(report.checks.pluginEnvironment.status).toBe("NOT_ACTIVE");
    expect(report.checks.pluginEnvironment.required).toBe(false);
    expect(report.checks.planStore.status).toBe("NOT_ACTIVE");
    expect(report.hostIntegration).toBe("NOT_ACTIVE");
    expect(report.overall).toBe("READY");
    expect(doctorExitCode(report)).toBe(0);
  });

  it("inspects the store read-only: READY passes, ABSENT is NOT_INITIALIZED (non-blocking)", async () => {
    const root = await makeTempDir("phase-plan-doctor-store-");
    try {
      const report = await runDoctor(baseDeps({ env: { CLAUDE_PLUGIN_DATA: root } }));
      expect(report.checks.pluginData.status).toBe("PASS");
      expect(report.checks.planStore.status).toBe("NOT_INITIALIZED");
      expect(report.checks.planStore.required).toBe(false);
      expect(report.checks.planStore.message).toContain("STORE ABSENT");
      expect(report.overall).toBe("READY");
      expect(doctorExitCode(report)).toBe(0);
      // The doctor must not have created the canonical database.
      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(root, "store", "phase-plan.sqlite3"))).toBe(false);
    } finally {
      await removeTempDir(root);
    }
  });

  it("fails with exit 5 when the store is too new (STORE_SCHEMA_TOO_NEW)", async () => {
    const root = await makeTempDir("phase-plan-doctor-store-");
    try {
      const report = await runDoctor(baseDeps({
        env: { CLAUDE_PLUGIN_DATA: root },
        inspectStore: () => ({
          status: "too_new",
          schemaVersion: 5,
          supported: 4,
          databasePath: path.join(root, "store", "phase-plan.sqlite3"),
        }),
      }));
      expect(report.checks.planStore.status).toBe("FAIL");
      expect(report.checks.planStore.errorCode).toBe("STORE_SCHEMA_TOO_NEW");
      expect(report.hostIntegration).toBe("NOT_READY");
      expect(doctorExitCode(report)).toBe(5);
    } finally {
      await removeTempDir(root);
    }
  });

  it("fails with exit 5 when the store inspection reports an invalid store", async () => {
    const root = await makeTempDir("phase-plan-doctor-store-");
    try {
      const report = await runDoctor(baseDeps({
        env: { CLAUDE_PLUGIN_DATA: root },
        inspectStore: () => ({
          status: "invalid",
          schemaVersion: 1,
          supported: 1,
          databasePath: path.join(root, "store", "phase-plan.sqlite3"),
          problems: ["migration history [2] does not match user_version 1"],
        }),
      }));
      expect(report.checks.planStore.status).toBe("FAIL");
      expect(report.checks.planStore.errorCode).toBe("STORE_SCHEMA_INVALID");
      expect(doctorExitCode(report)).toBe(5);
    } finally {
      await removeTempDir(root);
    }
  });

  it("renders a thrown inspection failure as an invalid-store check instead of crashing", async () => {
    const root = await makeTempDir("phase-plan-doctor-store-");
    try {
      const report = await runDoctor(baseDeps({
        env: { CLAUDE_PLUGIN_DATA: root },
        inspectStore: () => {
          throw new Error("boom during inspection");
        },
      }));
      expect(report.checks.planStore.status).toBe("FAIL");
      expect(report.checks.planStore.errorCode).toBe("STORE_SCHEMA_INVALID");
      expect(report.overall).toBe("NOT_READY");
    } finally {
      await removeTempDir(root);
    }
  });

  it("reports STORE READY when the inspection seam says so", async () => {
    const root = await makeTempDir("phase-plan-doctor-store-");
    try {
      const report = await runDoctor(baseDeps({
        env: { CLAUDE_PLUGIN_DATA: root },
        inspectStore: () => ({
          status: "ready",
          schemaVersion: 4,
          supported: 4,
          databasePath: path.join(root, "store", "phase-plan.sqlite3"),
          storeId: "store-1234",
        }),
      }));
      expect(report.checks.planStore.status).toBe("PASS");
      expect(report.checks.planStore.message).toContain("STORE READY schema=4");
      expect(report.checks.planStore.detail).toMatchObject({ storeId: "store-1234" });
      expect(doctorExitCode(report)).toBe(0);
    } finally {
      await removeTempDir(root);
    }
  });

  it("produces byte-stable JSON across repeated runs with identical inputs", async () => {
    const deps = baseDeps();
    const first = renderJsonReport(await runDoctor(deps));
    const second = renderJsonReport(await runDoctor(deps));
    expect(first).toBe(second);
    const parsed = JSON.parse(first);
    expect(parsed.schema).toBe("phase-plan.doctor-report/1");
    expect(parsed.runtime).toEqual({ name: "phase-plan", version: "0.1.0" });
    expect(Object.keys(parsed.checks)).toEqual([
      "node",
      "sqlite",
      "claudeCli",
      "claudeCapabilities",
      "pluginEnvironment",
      "pluginData",
      "planStore",
    ]);
  });

  it("renders the two-tier human report", async () => {
    const report = await runDoctor(baseDeps({ detectNodeVersion: () => "22.23.2" }));
    const text = renderHumanReport(report);
    expect(text).toContain("Runtime:");
    expect(text).toContain("Claude host:");
    expect(text).toContain("Overall runtime: NOT READY");
    expect(text).toContain("detected 22.23.2");
  });

  it("works end-to-end with real probe implementations (real node, fake claude)", async () => {
    const dataRoot = await makeTempDir("phase-plan-doctor-e2e-");
    try {
      const report = await runDoctor({
        env: { CLAUDE_PLUGIN_DATA: dataRoot },
        // Real probeClaudeVersion drives an injected spawn runner.
        claudeSpawnRunner: fakeSpawnRunner({ claude: claudeVersionOutcome("2.1.0") }),
      });
      // Real node:sqlite runs; node version is whatever the test process is.
      expect(["PASS", "FAIL"]).toContain(report.checks.node.status);
      expect(report.checks.claudeCli.status).toBe("PASS");
      expect(report.checks.claudeCli.detail).toMatchObject({ version: "2.1.0" });
      expect(report.checks.pluginData.status).toBe("PASS");
    } finally {
      await removeTempDir(dataRoot);
    }
  });

  it("sqlite smoke runs through the injected loader in the orchestrator", async () => {
    const report = await runDoctor(baseDeps({
      probeSqlite: async () => (await import("../src/store/sqlite-capability.js")).probeSqliteCapability(
        failingSqliteLoader(new Error("no sqlite here")),
      ),
    }));
    expect(report.checks.sqlite.status).toBe("FAIL");
    expect(report.checks.sqlite.detail).toMatchObject({ failedStep: "module_load" });
  });
});
