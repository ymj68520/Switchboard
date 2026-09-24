import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isNodeVersionSupported } from "../src/runtime/node-version.js";
import { runMcpSmoke, runtimeBundlePath } from "./helpers.js";

const BUNDLE = runtimeBundlePath();
const BUNDLE_EXISTS = existsSync(BUNDLE);

describe("mcp bootstrap (built bundle, real stdio)", () => {
  it.skipIf(!BUNDLE_EXISTS)("initializes, serves an empty tool list, and keeps stdout protocol-pure", async () => {
    const nodeSupported = isNodeVersionSupported(process.versions.node);
    const result = await runMcpSmoke(process.execPath, BUNDLE);

    if (!nodeSupported) {
      // Fail-closed runtime prerequisite: on unsupported Node the server must
      // refuse to start with a clean error and an untouched stdout.
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("UNSUPPORTED_NODE_VERSION");
      expect(result.stdoutLines).toEqual([]);
      return;
    }

    expect(result.timedOut, "mcp smoke timed out").toBe(false);
    expect(result.exitCode).toBe(0);

    // Every stdout line must parse as a JSON-RPC protocol message.
    const parsed = result.stdoutLines.map((line) => JSON.parse(line) as { id?: number; result?: unknown });
    expect(parsed).toHaveLength(2);

    const initialize = parsed.find((m) => m.id === 1);
    expect(initialize).toBeDefined();
    expect(initialize?.result).toMatchObject({
      serverInfo: { name: "phase-plan", version: "0.1.0" },
    });

    const tools = parsed.find((m) => m.id === 2);
    expect(tools?.result).toEqual({ tools: [] });

    // Diagnostics belong on stderr only.
    expect(result.stderr).toContain("[phase-plan]");
  });

  it.skipIf(!BUNDLE_EXISTS)("exits 0 immediately on stdin end without any protocol traffic", async () => {
    const nodeSupported = isNodeVersionSupported(process.versions.node);
    const result = await runMcpSmoke(process.execPath, BUNDLE, { initialize: false, toolsList: false });
    if (!nodeSupported) {
      expect(result.exitCode).toBe(3);
      return;
    }
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdoutLines).toEqual([]);
  });
});
