import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createConsistentBackup, backupFileName } from "../src/store/backup.js";
import { sqliteBackupAvailable } from "../src/store/connection.js";
import { validateBackupDatabase } from "../src/store/integrity.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { fixedClock } from "./store-helpers.js";
import {
  createSchema0Database,
  ensureStoreDir,
  makeTempPluginDataRoot,
  pendingBackups,
  publishedBackups,
  rawConnection,
  removeTempPluginDataRoot,
} from "./store-helpers.js";

const backupSupported = sqliteBackupAvailable();

describe.skipIf(!backupSupported)("consistent backup (E12/E13/§19–§21)", () => {
  it("names backups deterministically and publishes them validated", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = ensureStoreDir(root);
      createSchema0Database(databasePath, "backup-me");
      const source = rawConnection(databasePath, 200);
      const clock = fixedClock({ nowIso: "2026-09-24T12:34:56.789Z", ids: ["0ab1cdef"] });
      try {
        const result = await createConsistentBackup({
          sourceConnection: source,
          backupsDir,
          fromVersion: 0,
          toVersion: 1,
          nowIso: clock.nowIso,
          newId: clock.newId,
          busyTimeoutMs: 200,
        });
        const expected = backupFileName(0, 1, "2026-09-24T12:34:56.789Z", "0ab1cdef");
        expect(result.name).toBe("phase-plan-pre-schema-0-1-20260924T123456-0ab1cdef.sqlite3");
        expect(result.name).toBe(expected);
        expect(publishedBackups(backupsDir)).toEqual([result.name]);
        expect(pendingBackups(backupsDir)).toEqual([]);
        // Published backups pass validation and hold the source schema state.
        const validation = validateBackupDatabase(result.path, 0, { busyTimeoutMs: 200 });
        expect(validation.integrity).toBe("ok");
      } finally {
        source.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("cannot run on a connection holding an open write transaction (documents the choreography)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = ensureStoreDir(root);
      createSchema0Database(databasePath);
      const holder = rawConnection(databasePath, 200);
      holder.exec("BEGIN IMMEDIATE");
      try {
        await expect(
          createConsistentBackup({
            sourceConnection: holder,
            backupsDir,
            fromVersion: 0,
            toVersion: 1,
            nowIso: fixedClock().nowIso,
            newId: fixedClock().newId,
            busyTimeoutMs: 200,
          }),
        ).rejects.toMatchObject({ code: "STORE_BACKUP_FAILED" });
        expect(publishedBackups(backupsDir)).toEqual([]);
        expect(pendingBackups(backupsDir)).toEqual([]);
      } finally {
        holder.exec("ROLLBACK");
        holder.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("never publishes a backup that fails validation (garbage content)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = ensureStoreDir(root);
      createSchema0Database(databasePath);
      const source = rawConnection(databasePath, 200);
      const garbageBackup = async (_source: unknown, destination: string): Promise<unknown> => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(destination, "definitely not a sqlite database");
        return 0;
      };
      try {
        await expect(
          createConsistentBackup({
            sourceConnection: source,
            backupsDir,
            fromVersion: 0,
            toVersion: 1,
            nowIso: fixedClock().nowIso,
            newId: fixedClock().newId,
            busyTimeoutMs: 200,
            backupFn: garbageBackup,
          }),
        ).rejects.toMatchObject({ code: "STORE_BACKUP_FAILED" });
        expect(publishedBackups(backupsDir)).toEqual([]);
        expect(pendingBackups(backupsDir)).toEqual([]);
      } finally {
        source.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("aborts migration when the validated backup pipeline fails (E13, §21)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath } = ensureStoreDir(root);
      createSchema0Database(databasePath, "must-survive");
      const garbageBackup = async (_source: unknown, destination: string): Promise<unknown> => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(destination, "not a database");
        return 0;
      };
      await expect(
        initializePlanStore({ pluginDataRoot: root, backupFn: garbageBackup }),
      ).rejects.toMatchObject({ code: "STORE_BACKUP_FAILED" });
      // Migration MUST NOT proceed: source stays schema 0, sentinel intact.
      const probe = rawConnection(databasePath, 200);
      try {
        const rows = probe.prepare("SELECT note FROM legacy_marker").all() as { note: string }[];
        expect(rows[0]?.note).toBe("must-survive");
        const versionRow = probe.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(versionRow)[0]).toBe(0);
      } finally {
        probe.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("backup validation unit (any Node with node:sqlite)", () => {
  it("rejects a non-SQLite file", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const junk = path.join(root, "junk.sqlite3");
      const fs = await import("node:fs/promises");
      await fs.writeFile(junk, "junk bytes");
      expect(() => validateBackupDatabase(junk, 0)).toThrowError(
        expect.objectContaining({ code: "STORE_BACKUP_FAILED" }),
      );
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
