import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { STORE_BUSY_TIMEOUT_MS, STORE_DB_FILENAME, STORE_PROTOCOL_VERSION, SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { resolveStorePaths } from "../src/store/paths.js";
import { STORE_ERROR_CODES } from "../src/store/errors.js";
import { exitCodeForError } from "../src/runtime/exit-codes.js";
import { EXIT_CODES } from "../src/runtime/exit-codes.js";

describe("store constants (single source)", () => {
  it("pins the frozen schema and protocol versions", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(3);
    expect(STORE_PROTOCOL_VERSION).toBe(1);
    expect(STORE_DB_FILENAME).toBe("phase-plan.sqlite3");
  });

  it("defines a finite, nonzero busy timeout", () => {
    expect(Number.isFinite(STORE_BUSY_TIMEOUT_MS)).toBe(true);
    expect(STORE_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("maps every store error code onto the storage exit code", () => {
    for (const code of STORE_ERROR_CODES) {
      expect(exitCodeForError(code), code).toBe(EXIT_CODES.storageEnvironment);
    }
  });
});

describe("store path resolution", () => {
  it("resolves the canonical layout exactly (E1)", () => {
    const paths = resolveStorePaths("D:/plugin data/root");
    expect(paths.databasePath).toBe(pathOf("D:/plugin data/root", "store", "phase-plan.sqlite3"));
    expect(paths.storeDir).toBe(pathOf("D:/plugin data/root", "store"));
    expect(paths.backupsDir).toBe(pathOf("D:/plugin data/root", "backups"));
    expect(paths.blobsDir).toBe(pathOf("D:/plugin data/root", "blobs"));
    expect(paths.exportsDir).toBe(pathOf("D:/plugin data/root", "exports"));
  });

  it("resolves relative roots against cwd without hardcoding user paths", () => {
    const paths = resolveStorePaths("relative-root");
    expect(paths.databasePath.endsWith(path.join("store", "phase-plan.sqlite3"))).toBe(true);
  });

  it("survives spaces and unicode in the root", () => {
    const paths = resolveStorePaths("D:/我的 phase plan/with spaces");
    expect(paths.databasePath).toContain("phase-plan.sqlite3");
    expect(paths.databasePath).toContain("我的 phase plan");
  });
});

function pathOf(...segments: string[]): string {
  return path.resolve(...segments);
}
