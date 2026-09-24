import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import {
  createProductionMigrations,
  validateMigrationRegistry,
  type StoreMigration,
} from "../src/store/migrations/index.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { fixedClock } from "./store-helpers.js";
import {
  createSchema0Database,
  ensureStoreDir,
  makeTempPluginDataRoot,
  publishedBackups,
  rawSchemaVersion,
  removeTempPluginDataRoot,
  storePathsFor,
  tableNames,
} from "./store-helpers.js";

describe("migration registry validation (§14/E8)", () => {
  const base = { apply: () => undefined };

  it("accepts the production chain 0 → 1", () => {
    const registry = createProductionMigrations({ generateStoreId: () => "id", nowIso: () => "now" });
    expect(() => validateMigrationRegistry(registry)).not.toThrow();
    expect(registry[0]).toMatchObject({ from: 0, to: 1, name: "initialize-plan-store" });
  });

  it("rejects gaps", () => {
    expect(() =>
      validateMigrationRegistry([{ ...base, from: 0, to: 1, name: "a" }, { ...base, from: 2, to: 3, name: "b" }]),
    ).toThrowError(/gap/);
  });

  it("rejects duplicate target versions", () => {
    expect(() =>
      validateMigrationRegistry([{ ...base, from: 0, to: 1, name: "a" }, { ...base, from: 1, to: 2, name: "b" }, { ...base, from: 2, to: 2, name: "c" }]),
    ).toThrowError();
  });

  it("rejects non-step and backward migrations", () => {
    expect(() =>
      validateMigrationRegistry([{ ...base, from: 0, to: 2, name: "skip" }]),
    ).toThrowError(/exactly one version/);
    expect(() =>
      validateMigrationRegistry([{ ...base, from: 1, to: 0, name: "backward" }]),
    ).toThrowError();
  });

  it("production registry target equals the supported schema version", () => {
    const registry = createProductionMigrations({ generateStoreId: () => "id", nowIso: () => "now" });
    expect(registry[registry.length - 1]?.to).toBe(SUPPORTED_SCHEMA_VERSION);
  });
});

describe("migration failure semantics (E14/§22)", () => {
  it("rolls back completely on a failing migration and keeps the backup as recovery artifact", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = ensureStoreDir(root);
      createSchema0Database(databasePath, "sentinel-before-failure");

      const failingMigration: StoreMigration = {
        from: 0,
        to: 1,
        name: "deliberately-failing",
        apply(tx) {
          tx.exec("CREATE TABLE half_created (x TEXT)");
          throw new Error("injected mid-DDL failure");
        },
      };

      await expect(
        initializePlanStore({ pluginDataRoot: root, migrations: [failingMigration] }),
      ).rejects.toMatchObject({
        code: "STORE_MIGRATION_FAILED",
        causeText: expect.stringContaining("injected mid-DDL failure"),
      });

      // Source store remains at the old schema with NO partial DDL…
      expect(rawSchemaVersion(databasePath)).toBe(0);
      expect(tableNames(databasePath)).toEqual(["legacy_marker"]);
      // …no migration-history row without a migration…
      // (schema_migrations does not exist at all in the rolled-back state.)
      // …and the consistent pre-migration backup is retained.
      const backups = publishedBackups(backupsDir);
      expect(backups).toHaveLength(1);
      const content = fs.readFileSync(databasePath);
      expect(content.length).toBeGreaterThan(0);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("does not advance user_version when the migration throws after DDL", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const clock = fixedClock();
      const failing: StoreMigration = {
        from: 0,
        to: 1,
        name: "fails-after-ddl",
        apply(tx) {
          tx.exec("CREATE TABLE store_metadata (id INTEGER PRIMARY KEY)");
          tx.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
          throw new Error("boom");
        },
      };
      await expect(
        initializePlanStore({ pluginDataRoot: root, migrations: [failing], clock }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED" });
      // Fresh database: user_version must stay 0 and no tables may persist.
      expect(rawSchemaVersion(storePathsFor(root).databasePath)).toBe(0);
      expect(tableNames(storePathsFor(root).databasePath)).toEqual([]);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("treats a registry not reaching the supported version as fail-closed config error", async () => {
    const root = makeTempPluginDataRoot();
    try {
      await expect(
        initializePlanStore({ pluginDataRoot: root, migrations: [] }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED" });
      // The guard fires before any database is opened; nothing was created.
      expect(fs.existsSync(storePathsFor(root).databasePath)).toBe(false);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
