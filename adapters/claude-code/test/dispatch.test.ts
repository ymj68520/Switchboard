import { describe, expect, it } from "vitest";

import { RuntimeError, type RuntimeErrorCode } from "../src/runtime/errors.js";
import { EXIT_CODES, exitCodeForError } from "../src/runtime/exit-codes.js";
import { createLogger } from "../src/runtime/logger.js";
import { executeCommand, parseRuntimeCommand, RESERVED_HOOK_EVENTS, usage } from "../src/runtime/dispatch.js";
import { HOOK_EVENTS } from "../src/hooks/run.js";
import type { DoctorReport } from "../src/doctor/report.js";

describe("parseRuntimeCommand", () => {
  it("parses the frozen command model", () => {
    expect(parseRuntimeCommand(["doctor"])).toEqual({ ok: true, command: { kind: "doctor", json: false } });
    expect(parseRuntimeCommand(["doctor", "--json"])).toEqual({ ok: true, command: { kind: "doctor", json: true } });
    expect(parseRuntimeCommand(["mcp"])).toEqual({ ok: true, command: { kind: "mcp" } });
    expect(parseRuntimeCommand(["hook", "SessionStart"])).toEqual({
      ok: true,
      command: { kind: "hook", event: "SessionStart" },
    });
  });

  it("parses help forms", () => {
    expect(parseRuntimeCommand(["--help"])).toEqual({ ok: true, command: { kind: "help" } });
    expect(parseRuntimeCommand(["-h"])).toEqual({ ok: true, command: { kind: "help" } });
    expect(parseRuntimeCommand(["help"])).toEqual({ ok: true, command: { kind: "help" } });
  });

  it("rejects missing/unknown commands with INVALID_RUNTIME_COMMAND", () => {
    const empty = parseRuntimeCommand([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("INVALID_RUNTIME_COMMAND");

    const bogus = parseRuntimeCommand(["bogus"]);
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.error.code).toBe("INVALID_RUNTIME_COMMAND");
  });

  it("rejects unknown flags and stray arguments", () => {
    for (const argv of [
      ["doctor", "--wat"],
      ["mcp", "--json"],
      ["doctor", "extra"],
      ["hook"],
      ["hook", "SessionStart", "extra"],
    ]) {
      const parsed = parseRuntimeCommand(argv);
      expect(parsed.ok, argv.join(" ")).toBe(false);
      if (!parsed.ok) expect(parsed.error.code, argv.join(" ")).toBe("INVALID_RUNTIME_COMMAND");
    }
  });
});

describe("error → exit code mapping", () => {
  const ALL_CODES: RuntimeErrorCode[] = [
    "UNSUPPORTED_NODE_VERSION",
    "SQLITE_UNAVAILABLE",
    "CLAUDE_CLI_NOT_FOUND",
    "CLAUDE_VERSION_UNREADABLE",
    "CLAUDE_CAPABILITY_UNSUPPORTED",
    "PLUGIN_DATA_UNAVAILABLE",
    "PLUGIN_DATA_NOT_WRITABLE",
    "INVALID_RUNTIME_COMMAND",
    "HOOK_NOT_IMPLEMENTED",
    "MCP_BOOTSTRAP_FAILED",
    "INTERNAL_ERROR",
    "STORE_SCHEMA_TOO_NEW",
    "STORE_SCHEMA_TOO_OLD",
    "STORE_SCHEMA_INVALID",
    "STORE_CORRUPT",
    "STORE_OPEN_FAILED",
    "STORE_BUSY",
    "STORE_BACKUP_FAILED",
    "STORE_MIGRATION_FAILED",
  ];

  it("maps every runtime error code to a defined exit code", () => {
    for (const code of ALL_CODES) {
      const exit = exitCodeForError(code);
      expect(Object.values(EXIT_CODES), code).toContain(exit);
    }
  });

  it("keeps the frozen semantic tiers", () => {
    expect(exitCodeForError("INVALID_RUNTIME_COMMAND")).toBe(EXIT_CODES.invocation);
    expect(exitCodeForError("HOOK_NOT_IMPLEMENTED")).toBe(EXIT_CODES.invocation);
    expect(exitCodeForError("UNSUPPORTED_NODE_VERSION")).toBe(EXIT_CODES.runtimePrerequisite);
    expect(exitCodeForError("SQLITE_UNAVAILABLE")).toBe(EXIT_CODES.runtimePrerequisite);
    expect(exitCodeForError("CLAUDE_CLI_NOT_FOUND")).toBe(EXIT_CODES.hostCapability);
    expect(exitCodeForError("CLAUDE_VERSION_UNREADABLE")).toBe(EXIT_CODES.hostCapability);
    expect(exitCodeForError("CLAUDE_CAPABILITY_UNSUPPORTED")).toBe(EXIT_CODES.hostCapability);
    expect(exitCodeForError("PLUGIN_DATA_UNAVAILABLE")).toBe(EXIT_CODES.storageEnvironment);
    expect(exitCodeForError("PLUGIN_DATA_NOT_WRITABLE")).toBe(EXIT_CODES.storageEnvironment);
    expect(exitCodeForError("INTERNAL_ERROR")).toBe(EXIT_CODES.internal);
    for (const code of ALL_CODES.filter((c) => c.startsWith("STORE_"))) {
      expect(exitCodeForError(code), code).toBe(EXIT_CODES.storageEnvironment);
    }
  });
});

describe("executeCommand", () => {
  it("help prints usage and exits 0", async () => {
    const chunks: string[] = [];
    const result = await executeCommand({ kind: "help" }, { out: (t) => chunks.push(t) });
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(chunks.join("")).toContain("Usage:");
  });

  it("doctor prints human output and derives exit code from the report", async () => {
    const report = makeReport({ nodeStatus: "FAIL" });
    const chunks: string[] = [];
    const result = await executeCommand({ kind: "doctor", json: false }, {
      out: (t) => chunks.push(t),
      doctor: async () => report,
    });
    expect(result.exitCode).toBe(3);
    expect(chunks.join("")).toContain("Overall runtime");
  });

  it("doctor --json prints the stable JSON report", async () => {
    const report = makeReport({});
    const chunks: string[] = [];
    const result = await executeCommand({ kind: "doctor", json: true }, {
      out: (t) => chunks.push(t),
      doctor: async () => report,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(chunks.join(""));
    expect(parsed.schema).toBe("phase-plan.doctor-report/1");
  });

  it("mcp refuses to start on unsupported Node (fail-closed)", async () => {
    let mcpStarted = false;
    await expect(
      executeCommand({ kind: "mcp" }, {
        nodeVersion: () => "22.23.2",
        startMcp: async () => {
          mcpStarted = true;
          throw new Error("must not be started");
        },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_NODE_VERSION" });
    expect(mcpStarted).toBe(false);
  });

  it("mcp fails closed without CLAUDE_PLUGIN_DATA and never initializes a store", async () => {
    let storeInitialized = false;
    let mcpStarted = false;
    await expect(
      executeCommand({ kind: "mcp" }, {
        env: {},
        nodeVersion: () => "24.21.0",
        initializeStore: async () => {
          storeInitialized = true;
          throw new Error("must not initialize");
        },
        startMcp: async () => {
          mcpStarted = true;
          throw new Error("must not start");
        },
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_DATA_UNAVAILABLE" });
    expect(storeInitialized).toBe(false);
    expect(mcpStarted).toBe(false);
  });

  it("mcp initializes the store before serving and closes it deterministically after", async () => {
    const events: string[] = [];
    const pluginDataRoot = process.env.PHASE_PLAN_TEST_ROOT ?? "D:/temp/plugin-data";
    let storeClosed = false;
    const fakeStore = {
      path: pluginDataRoot,
      close: () => {
        storeClosed = true;
        events.push("store-closed");
      },
    } as unknown as import("../src/store/sqlite-store.js").PlanStore;
    const result = await executeCommand({ kind: "mcp" }, {
      env: { CLAUDE_PLUGIN_DATA: pluginDataRoot },
      nodeVersion: () => "24.21.0",
      initializeStore: async () => {
        events.push("store-initialized");
        return fakeStore;
      },
      startMcp: async () => {
        events.push("mcp-started");
        return {
          handle: { close: async () => undefined },
          waitStopped: Promise.resolve(),
        };
      },
      logger: createLogger("silent"),
    });
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(events).toEqual(["store-initialized", "mcp-started", "store-closed"]);
    expect(storeClosed).toBe(true);
  });

  it("mcp maps a failed storage preflight onto its stable code", async () => {
    await expect(
      executeCommand({ kind: "mcp" }, {
        env: { CLAUDE_PLUGIN_DATA: "D:/occupied" },
        nodeVersion: () => "24.21.0",
        preflightPluginData: async () => ({
          status: "unavailable",
          errorCode: "PLUGIN_DATA_UNAVAILABLE",
          message: "occupied",
        }),
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_DATA_UNAVAILABLE" });
  });

  it("reserved hook events stay distinct from implemented ones", async () => {
    for (const event of RESERVED_HOOK_EVENTS) {
      await expect(
        executeCommand({ kind: "hook", event }, { env: { CLAUDE_PLUGIN_DATA: "x" }, readStdin: async () => "{}" }),
      ).rejects.toMatchObject({
        code: "HOOK_NOT_IMPLEMENTED",
      });
    }
    await expect(executeCommand({ kind: "hook", event: "NotAHook" })).rejects.toMatchObject({
      code: "INVALID_RUNTIME_COMMAND",
    });
  });

  it("implemented hook events route through the hook runner with CLAUDE_PLUGIN_DATA", async () => {
    const seen: string[] = [];
    const result = await executeCommand({ kind: "hook", event: "SessionStart" }, {
      env: { CLAUDE_PLUGIN_DATA: "D:/tmp/pd" },
      readStdin: async () => '{"hook_event_name":"SessionStart"}',
      runHook: async (input) => {
        seen.push(`${input.event}:${input.raw}:${input.pluginDataRoot}`);
        return { exitCode: 0, stdout: "" };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual(["SessionStart:{\"hook_event_name\":\"SessionStart\"}:D:/tmp/pd"]);
    // Missing CLAUDE_PLUGIN_DATA fails closed before the runner.
    await expect(
      executeCommand({ kind: "hook", event: "SessionStart" }, { env: {}, readStdin: async () => "{}" }),
    ).rejects.toMatchObject({ code: "PLUGIN_DATA_UNAVAILABLE" });
    expect(HOOK_EVENTS.length).toBe(7);
  });

  it("propagates RuntimeError subclasses with stable codes", async () => {
    await expect(
      executeCommand({ kind: "doctor", json: false }, {
        doctor: async () => {
          throw new RuntimeError("INTERNAL_ERROR", "boom");
        },
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("usage text documents every command", () => {
    const text = usage();
    expect(text).toContain("doctor");
    expect(text).toContain("mcp");
    expect(text).toContain("hook <event>");
  });
});

/** Build a fully-passing report with targeted overrides. */
function makeReport(overrides: {
  nodeStatus?: "PASS" | "FAIL";
  claudeCliStatus?: "PASS" | "FAIL";
  pluginDataStatus?: "PASS" | "FAIL" | "NOT_ACTIVE";
}): DoctorReport {
  const nodeStatus = overrides.nodeStatus ?? "PASS";
  const claudeCliStatus = overrides.claudeCliStatus ?? "PASS";
  const pluginDataStatus = overrides.pluginDataStatus ?? "PASS";
  return {
    schema: "phase-plan.doctor-report/1",
    runtime: { name: "phase-plan", version: "0.1.0" },
    overall: nodeStatus === "PASS" ? "READY" : "NOT_READY",
    hostIntegration: claudeCliStatus === "PASS" ? "ACTIVE" : "NOT_READY",
    checks: {
      node: {
        id: "node.version",
        label: "node",
        tier: "runtime",
        status: nodeStatus,
        required: true,
        ...(nodeStatus === "FAIL" ? { errorCode: "UNSUPPORTED_NODE_VERSION" as const } : {}),
        message: "test",
      },
      sqlite: {
        id: "node.sqlite",
        label: "node:sqlite",
        tier: "runtime",
        status: "PASS",
        required: true,
        message: "test",
      },
      claudeCli: {
        id: "claude.cli",
        label: "Claude Code CLI",
        tier: "host",
        status: claudeCliStatus,
        required: true,
        ...(claudeCliStatus === "FAIL" ? { errorCode: "CLAUDE_CLI_NOT_FOUND" as const } : {}),
        message: "test",
      },
      claudeCapabilities: {
        id: "claude.capabilities",
        label: "Claude capabilities",
        tier: "host",
        status: "PASS",
        required: true,
        message: "test",
      },
      pluginEnvironment: {
        id: "claude.plugin_environment",
        label: "plugin environment",
        tier: "host",
        status: "NOT_ACTIVE",
        required: false,
        message: "test",
      },
      pluginData: {
        id: "claude.plugin_data",
        label: "plugin data",
        tier: "host",
        status: pluginDataStatus,
        required: pluginDataStatus !== "NOT_ACTIVE",
        ...(pluginDataStatus === "FAIL" ? { errorCode: "PLUGIN_DATA_NOT_WRITABLE" as const } : {}),
        message: "test",
      },
      planStore: {
        id: "claude.plan_store",
        label: "Plan Store",
        tier: "host",
        status: "NOT_ACTIVE",
        required: false,
        message: "test",
      },
    },
  };
}
