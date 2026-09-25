/**
 * Shared helpers for the Plan Store test suite (Phase 2).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openDatabase, type StoreConnection } from "../src/store/connection.js";
import { resolveStorePaths } from "../src/store/paths.js";
import type { StoreClock } from "../src/store/migration-runner.js";

/** Temp plugin-data root with the frozen layout NOT yet created. */
export function makeTempPluginDataRoot(prefix = "phase-plan-store-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempPluginDataRoot(root: string): void {
  // Windows can transiently EPERM/EBUSY on freshly written files (AV/indexer
  // scan); rm's built-in bounded retry absorbs that without hiding real
  // retention bugs (retries are exhausted → the error still throws).
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Deterministic clock for injected seams (frozen plan §29). */
export function fixedClock(options: { nowIso?: string; ids?: string[] } = {}): StoreClock & {
  calls: { now: number; id: number };
} {
  let nowCalls = 0;
  let idCalls = 0;
  return {
    calls: {
      get now(): number {
        return nowCalls;
      },
      get id(): number {
        return idCalls;
      },
    },
    nowIso: () => {
      nowCalls += 1;
      return options.nowIso ?? "2026-09-24T12:00:00.000Z";
    },
    newId: () => {
      const id = options.ids?.[idCalls] ?? `id-${idCalls}`;
      idCalls += 1;
      return id;
    },
  };
}

/**
 * Create an "existing schema 0" database (frozen plan §13): a real SQLite
 * file with pre-store sentinel data and user_version left at 0.
 */
export function createSchema0Database(databasePath: string, sentinel = "legacy-sentinel"): void {
  const db = openDatabase(databasePath);
  try {
    db.exec("CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY, note TEXT)");
    db.prepare("INSERT INTO legacy_marker (note) VALUES (?)").run(sentinel);
  } finally {
    db.close();
  }
}

/** Raw test-only connection for simulating other processes (§18/§35). */
export function rawConnection(databasePath: string, busyTimeoutMs = 500): StoreConnection {
  return openDatabase(databasePath, { busyTimeoutMs });
}

/** Read user_version through a throwaway raw connection. */
export function rawSchemaVersion(databasePath: string): number {
  const db = rawConnection(databasePath);
  try {
    const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    return Object.values(row)[0] as number;
  } finally {
    db.close();
  }
}

/** Overwrite user_version through a throwaway raw connection (test-only). */
export function rawSetSchemaVersion(databasePath: string, version: number): void {
  const db = rawConnection(databasePath);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

export function tableNames(databasePath: string): string[] {
  const db = rawConnection(databasePath);
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

export function storePathsFor(root: string): { databasePath: string; backupsDir: string; storeDir: string } {
  const paths = resolveStorePaths(root);
  return { databasePath: paths.databasePath, backupsDir: paths.backupsDir, storeDir: paths.storeDir };
}

/** Create the store directory so a canonical pre-store database can exist. */
export function ensureStoreDir(root: string): { databasePath: string; backupsDir: string; storeDir: string } {
  const paths = storePathsFor(root);
  fs.mkdirSync(paths.storeDir, { recursive: true });
  fs.mkdirSync(paths.backupsDir, { recursive: true });
  return paths;
}

/** List published (non-pending) backup file names in a backups dir. */
export function publishedBackups(backupsDir: string): string[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((name) => name.endsWith(".sqlite3") && !name.startsWith(".pending-"))
    .sort();
}

export function pendingBackups(backupsDir: string): string[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir).filter((name) => name.startsWith(".pending-"));
}
