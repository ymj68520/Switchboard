import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/connection.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import {
  initializePlanStore,
  inspectPlanStore,
  openPlanStore,
} from "../src/store/sqlite-store.js";
import {
  createSchema0Database,
  fixedClock,
  makeTempPluginDataRoot,
  ensureStoreDir,
  publishedBackups,
  rawConnection,
  rawSchemaVersion,
  rawSetSchemaVersion,
  removeTempPluginDataRoot,
  storePathsFor,
  tableNames,
} from "./store-helpers.js";

describe("store lifecycle (E5/E7/E20)", () => {
  it("initializes a fresh store deterministically to schema v1", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const clock = fixedClock({ nowIso: "2026-09-24T12:00:00.000Z", ids: ["store-uuid-1"] });
      const store = await initializePlanStore({ pluginDataRoot: root, clock });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        const metadata = store.getStoreMetadata();
        expect(metadata.schemaVersion).toBe(1);
        expect(metadata.storeId).toBe("store-uuid-1");
        expect(metadata.protocolVersion).toBe(1);
        expect(metadata.createdAt).toBe("2026-09-24T12:00:00.000Z");
        // Schema v1 contains exactly the two infrastructure tables (E6).
        expect(tableNames(storePathsFor(root).databasePath).sort()).toEqual([
          "schema_migrations",
          "store_metadata",
        ]);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("keeps store_id stable across close/reopen (E7)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const first = await initializePlanStore({ pluginDataRoot: root });
      const storeId = first.getStoreMetadata().storeId;
      first.close();

      const reopened = openPlanStore({ pluginDataRoot: root });
      try {
        expect(reopened.getStoreMetadata().storeId).toBe(storeId);
        expect(reopened.getSchemaVersion()).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("openPlanStore refuses a fresh root (nothing to open)", async () => {
    const absentRoot = makeTempPluginDataRoot();
    try {
      expect(() => openPlanStore({ pluginDataRoot: absentRoot })).toThrowError(
        expect.objectContaining({ code: "STORE_OPEN_FAILED" }),
      );
    } finally {
      removeTempPluginDataRoot(absentRoot);
    }
  });

  it("double initialization is idempotent (one history row, no extra backup)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const first = await initializePlanStore({ pluginDataRoot: root });
      const storeId = first.getStoreMetadata().storeId;
      first.close();
      const second = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(second.getStoreMetadata().storeId).toBe(storeId);
        const history = second.withRead((tx) =>
          tx.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
        ) as { version: number; name: string }[];
        expect(history).toEqual([{ version: 1, name: "initialize-plan-store" }]);
      } finally {
        second.close();
      }
      expect(publishedBackups(storePathsFor(root).backupsDir)).toEqual([]);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("closes deterministically and refuses post-close use (E20)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      store.close(); // idempotent
      expect(() => store.getSchemaVersion()).toThrowError(
        expect.objectContaining({ code: "STORE_OPEN_FAILED" }),
      );
      expect(() => store.withWrite(() => undefined)).toThrowError(
        expect.objectContaining({ code: "STORE_OPEN_FAILED" }),
      );
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("uses the injectable clock in metadata and migration history (§29)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const clock = fixedClock({ nowIso: "2000-01-02T03:04:05.000Z", ids: ["fixed-id"] });
      const store = await initializePlanStore({ pluginDataRoot: root, clock });
      try {
        expect(store.getStoreMetadata().createdAt).toBe("2000-01-02T03:04:05.000Z");
        const rows = store.withRead((tx) =>
          tx.prepare("SELECT applied_at AS appliedAt, runtime_version AS runtimeVersion FROM schema_migrations").all(),
        ) as { appliedAt: string; runtimeVersion: string }[];
        expect(rows[0]?.appliedAt).toBe("2000-01-02T03:04:05.000Z");
        expect(rows[0]?.runtimeVersion).toBe("0.1.0");
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("existing schema-0 databases (E11/E12/E13)", () => {
  it("backs up via the SQLite API, validates, then migrates with sentinel preserved", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = ensureStoreDir(root);
      createSchema0Database(databasePath, "pre-migration-sentinel");
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(1);
        const sentinel = store.withRead((tx) =>
          tx.prepare("SELECT note FROM legacy_marker").all(),
        ) as { note: string }[];
        expect(sentinel[0]?.note).toBe("pre-migration-sentinel");
      } finally {
        store.close();
      }
      const backups = publishedBackups(backupsDir);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(
        /^phase-plan-pre-schema-0-1-\d{8}T\d{6}(\.\d+)?Z?-[0-9a-f-]{8,}\.sqlite3$/,
      );
      // The published backup holds the pre-migration state (schema 0).
      const db = openDatabase(path.join(backupsDir, backups[0]!), { readonly: true });
      try {
        const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(row)[0]).toBe(0);
        const sentinel = db.prepare("SELECT note FROM legacy_marker").all() as { note: string }[];
        expect(sentinel[0]?.note).toBe("pre-migration-sentinel");
      } finally {
        db.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("corruption and invalid state (E19/E15)", () => {
  it("fails closed with STORE_CORRUPT on a non-SQLite file (no reset, no recreate)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath } = ensureStoreDir(root);
      await fs.writeFile(databasePath, "this is not a database — padded beyond SQLite's 100-byte empty-file heuristic so the header check fails deterministically. " + "x".repeat(200));
      await expect(initializePlanStore({ pluginDataRoot: root })).rejects.toMatchObject({
        code: "STORE_CORRUPT",
      });
      // Untouched: same junk bytes, never deleted or recreated.
      expect((await fs.readFile(databasePath, "utf8")).startsWith("this is not a database")).toBe(true);
      // A raw open of the junk file still fails closed with STORE_CORRUPT.
      expect(() => rawSchemaVersion(databasePath)).toThrowError(
        expect.objectContaining({ code: "STORE_CORRUPT" }),
      );
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("fails closed with STORE_SCHEMA_INVALID when history contradicts user_version", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      const { databasePath } = storePathsFor(root);
      const raw = rawConnection(databasePath);
      try {
        raw.exec("DROP TABLE schema_migrations");
      } finally {
        raw.close();
      }
      store.close();

      await expect(initializePlanStore({ pluginDataRoot: root })).rejects.toMatchObject({
        code: "STORE_SCHEMA_INVALID",
      });
      expect(() => openPlanStore({ pluginDataRoot: root })).toThrowError(
        expect.objectContaining({ code: "STORE_SCHEMA_INVALID" }),
      );
      const inspection = inspectPlanStore(root);
      expect(inspection.status).toBe("invalid");
      expect((inspection.problems ?? []).join(" ")).toContain("schema_migrations");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("fails closed with STORE_OPEN_FAILED when the store path is not creatable", async () => {
    const root = makeTempPluginDataRoot();
    const blocker = path.join(root, "blocker");
    await fs.writeFile(blocker, "a file where the store dir must go");
    try {
      await expect(
        initializePlanStore({ pluginDataRoot: path.join(blocker, "nested") }),
      ).rejects.toMatchObject({ code: "STORE_OPEN_FAILED" });
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("schema fencing against newer stores (E17/E18)", () => {
  it("an old connection fails closed with STORE_SCHEMA_TOO_NEW and never writes", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        // Simulate a NEWER binary migrating the store under the old process.
        rawSetSchemaVersion(storePathsFor(root).databasePath, 2);

        let writeRan = false;
        expect(() =>
          store.withWrite((tx) => {
            writeRan = true;
            tx.exec("CREATE TABLE smuggled (x TEXT)");
          }),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_TOO_NEW" }));
        expect(writeRan).toBe(false);
        expect(tableNames(storePathsFor(root).databasePath)).not.toContain("smuggled");

        // Reopening/initializing also refuses — no downgrade, no reset.
        await expect(initializePlanStore({ pluginDataRoot: root })).rejects.toMatchObject({
          code: "STORE_SCHEMA_TOO_NEW",
        });
        expect(() => openPlanStore({ pluginDataRoot: root })).toThrowError(
          expect.objectContaining({ code: "STORE_SCHEMA_TOO_NEW" }),
        );
        expect(rawSchemaVersion(storePathsFor(root).databasePath)).toBe(2);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("business writes on an older schema fail with STORE_SCHEMA_TOO_OLD (§17)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        // Test-only manipulation of user_version (§18 convention); there is no
        // production forceSchemaVersion capability.
        rawSetSchemaVersion(storePathsFor(root).databasePath, 0);
        expect(() => store.withWrite(() => undefined)).toThrowError(
          expect.objectContaining({ code: "STORE_SCHEMA_TOO_OLD" }),
        );
        rawSetSchemaVersion(storePathsFor(root).databasePath, 1);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
