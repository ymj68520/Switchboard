import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { isNodeVersionSupported } from "../src/runtime/node-version.js";
import { runMcpSmoke, runtimeBundlePath } from "./helpers.js";
import {
  makeTempPluginDataRoot,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";

const BUNDLE = runtimeBundlePath();
const BUNDLE_EXISTS = existsSync(BUNDLE);

describe("mcp bootstrap (built bundle, real stdio, store-first)", () => {
  it.skipIf(!BUNDLE_EXISTS)(
    "initializes the store, then serves an empty tool list with protocol-pure stdout",
    async () => {
      const nodeSupported = isNodeVersionSupported(process.versions.node);
      const pluginDataRoot = makeTempPluginDataRoot();
      try {
        const result = await runMcpSmoke(process.execPath, BUNDLE, {
          env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot },
        });

        if (!nodeSupported) {
          expect(result.exitCode).toBe(3);
          expect(result.stderr).toContain("UNSUPPORTED_NODE_VERSION");
          expect(result.stdoutLines).toEqual([]);
          return;
        }

        expect(result.timedOut, "mcp smoke timed out").toBe(false);
        expect(result.exitCode).toBe(0);

        const parsed = result.stdoutLines.map(
          (line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown> },
        );
        expect(parsed).toHaveLength(2);
        expect(parsed.find((m) => m.id === 1)?.result).toMatchObject({
          serverInfo: { name: "phase-plan", version: "0.1.0" },
        });
        expect(parsed.find((m) => m.id === 2)?.result).toEqual({ tools: [] });
        expect(result.stderr).toContain("[phase-plan]");

        // Store-first: the canonical database exists after a served session.
        expect(existsSync(storePathsFor(pluginDataRoot).databasePath)).toBe(true);
      } finally {
        removeTempPluginDataRoot(pluginDataRoot);
      }
    },
  );

  it.skipIf(!BUNDLE_EXISTS)("fails closed without CLAUDE_PLUGIN_DATA (no cwd/temp fallback)", async () => {
    const nodeSupported = isNodeVersionSupported(process.versions.node);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDE_PLUGIN_DATA;
    const result = await runMcpSmoke(process.execPath, BUNDLE, { env });
    if (!nodeSupported) {
      // The Node gate fires first on old runtimes.
      expect(result.exitCode).toBe(3);
      return;
    }
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("PLUGIN_DATA_UNAVAILABLE");
    expect(result.stdoutLines).toEqual([]);
  });

  it.skipIf(!BUNDLE_EXISTS)("fails closed on a too-new store (STORE_SCHEMA_TOO_NEW)", async () => {
    const nodeSupported = isNodeVersionSupported(process.versions.node);
    const pluginDataRoot = makeTempPluginDataRoot();
    try {
      const { databasePath } = storePathsFor(pluginDataRoot);
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "");
      // Leave a schema-2 marker via raw connection (test-only manipulation).
      const raw = rawConnection(databasePath, 500);
      raw.exec("PRAGMA user_version = 5");
      raw.close();

      const result = await runMcpSmoke(process.execPath, BUNDLE, {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot },
      });
      if (!nodeSupported) {
        expect(result.exitCode).toBe(3);
        return;
      }
      expect(result.exitCode).toBe(5);
      expect(result.stderr).toContain("STORE_SCHEMA_TOO_NEW");
      expect(result.stdoutLines).toEqual([]);
      // Untouched: still schema 2, never downgraded.
      expect(rawConnectionQueried(databasePath)).toBe(5);
    } finally {
      removeTempPluginDataRoot(pluginDataRoot);
    }
  });

  it.skipIf(!BUNDLE_EXISTS)("exits 0 immediately on stdin end without any protocol traffic", async () => {
    const nodeSupported = isNodeVersionSupported(process.versions.node);
    const pluginDataRoot = makeTempPluginDataRoot();
    try {
      const result = await runMcpSmoke(process.execPath, BUNDLE, {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot },
        initialize: false,
        toolsList: false,
      });
      if (!nodeSupported) {
        expect(result.exitCode).toBe(3);
        return;
      }
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdoutLines).toEqual([]);
    } finally {
      removeTempPluginDataRoot(pluginDataRoot);
    }
  });
});

function rawConnectionQueried(databasePath: string): number {
  const db = rawConnection(databasePath, 500);
  try {
    const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    return Object.values(row)[0] as number;
  } finally {
    db.close();
  }
}
