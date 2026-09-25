import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { inspectPlanStore } from "../src/store/sqlite-store.js";
import {
  createSchema0Database,
  makeTempPluginDataRoot,
  rawConnection,
  rawSetSchemaVersion,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";

describe("read-only store inspection (E22/§33)", () => {
  it("reports absent for a fresh plugin data root — without creating anything", () => {
    const root = makeTempPluginDataRoot();
    try {
      const inspection = inspectPlanStore(root);
      expect(inspection).toMatchObject({
        status: "absent",
        supported: 2,
        databasePath: path.join(root, "store", "phase-plan.sqlite3"),
      });
      expect(fs.existsSync(path.join(root, "store"))).toBe(false);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("reports ready with store id after initialization", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      const storeId = store.getStoreMetadata().storeId;
      store.close();
      const inspection = inspectPlanStore(root);
      expect(inspection.status).toBe("ready");
      expect(inspection.schemaVersion).toBe(2);
      expect(inspection.storeId).toBe(storeId);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("reports uninitialized for an existing schema-0 database", () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath } = storePathsFor(root);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      createSchema0Database(databasePath);
      const inspection = inspectPlanStore(root);
      expect(inspection).toMatchObject({ status: "uninitialized", schemaVersion: 0 });
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("reports too_new without touching the store", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      rawSetSchemaVersion(storePathsFor(root).databasePath, 3);
      const inspection = inspectPlanStore(root);
      expect(inspection).toMatchObject({ status: "too_new", schemaVersion: 3, supported: 2 });
      expect(rawConnectionQueriedVersion(storePathsFor(root).databasePath)).toBe(3);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("reports invalid when history and user_version disagree", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      const raw = rawConnection(storePathsFor(root).databasePath, 500);
      try {
        raw.exec("DROP TABLE schema_migrations");
      } finally {
        raw.close();
      }
      const inspection = inspectPlanStore(root);
      expect(inspection.status).toBe("invalid");
      expect((inspection.problems ?? []).length).toBeGreaterThan(0);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("throws STORE_CORRUPT for a non-SQLite file (never treats it as new)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath } = storePathsFor(root);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.writeFileSync(databasePath, "junk bytes, not sqlite");
      expect(() => inspectPlanStore(root)).toThrowError(
        expect.objectContaining({ code: "STORE_CORRUPT" }),
      );
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

function rawConnectionQueriedVersion(databasePath: string): number {
  const db = rawConnection(databasePath, 500);
  try {
    const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    return Object.values(row)[0] as number;
  } finally {
    db.close();
  }
}
