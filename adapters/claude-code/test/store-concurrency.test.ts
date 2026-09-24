import { describe, expect, it } from "vitest";

import { initializePlanStore, openPlanStore } from "../src/store/sqlite-store.js";
import {
  makeTempPluginDataRoot,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";

describe("multi-connection behavior (§35/E3)", () => {
  it("maps a contended write reservation to STORE_BUSY after the bounded wait", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath } = storePathsFor(root);
      const store = await initializePlanStore({ pluginDataRoot: root, busyTimeoutMs: 150 });
      try {
        // Another process/connection holds the writer reservation.
        const holder = rawConnection(databasePath, 5000);
        holder.exec("BEGIN IMMEDIATE");
        const startedAt = Date.now();
        expect(() =>
          store.withWrite((tx) => {
            tx.exec("CREATE TABLE should_not_exist (x TEXT)");
          }),
        ).toThrowError(expect.objectContaining({ code: "STORE_BUSY" }));
        const waitedMs = Date.now() - startedAt;
        expect(waitedMs).toBeGreaterThanOrEqual(100);
        expect(waitedMs).toBeLessThan(4000);
        holder.exec("ROLLBACK");
        holder.close();
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("lets a reader see committed state during an open writer transaction (WAL)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        store.withWrite((tx) => {
          tx.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
          tx.prepare("INSERT INTO notes (body) VALUES (?)").run("committed-1");
        });
        const holder = rawConnection(storePathsFor(root).databasePath, 5000);
        holder.exec("BEGIN IMMEDIATE");
        holder.prepare("INSERT INTO notes (body) VALUES (?)").run("uncommitted");
        try {
          const visible = store.withRead((tx) =>
            tx.prepare("SELECT body FROM notes ORDER BY id").all(),
          ) as { body: string }[];
          expect(visible.map((row) => row.body)).toEqual(["committed-1"]);
        } finally {
          holder.exec("ROLLBACK");
          holder.close();
        }
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("serializes writers through the single-reservation model", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const storeA = await initializePlanStore({ pluginDataRoot: root, busyTimeoutMs: 5000 });
      const storeB = await initializePlanStore({ pluginDataRoot: root, busyTimeoutMs: 5000 });
      try {
        storeA.withWrite((tx) => {
          tx.exec("CREATE TABLE log (id INTEGER PRIMARY KEY, src TEXT)");
          tx.prepare("INSERT INTO log (src) VALUES (?)").run("A");
        });
        storeB.withWrite((tx) => {
          tx.prepare("INSERT INTO log (src) VALUES (?)").run("B");
        });
        const rows = storeA.withRead((tx) =>
          tx.prepare("SELECT src FROM log ORDER BY id").all(),
        ) as { src: string }[];
        expect(rows.map((row) => row.src)).toEqual(["A", "B"]);
      } finally {
        storeA.close();
        storeB.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("applies the documented PRAGMA policy on real connections (E3)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root, busyTimeoutMs: 750 });
      try {
        const pragmas = store.withRead((tx) => ({
          journal: tx.prepare("PRAGMA journal_mode").get(),
          synchronous: tx.prepare("PRAGMA synchronous").get(),
          foreignKeys: tx.prepare("PRAGMA foreign_keys").get(),
          busyTimeout: tx.prepare("PRAGMA busy_timeout").get(),
        }));
        expect(pragmas.journal).toMatchObject({ journal_mode: "wal" });
        expect(pragmas.synchronous).toMatchObject({ synchronous: 2 }); // FULL
        expect(pragmas.foreignKeys).toMatchObject({ foreign_keys: 1 });
        expect(pragmas.busyTimeout).toMatchObject({ timeout: 750 });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("leaves WAL sidecar management to SQLite (no -wal/-shm bookkeeping)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.withWrite((tx) => {
        tx.exec("CREATE TABLE tiny (x TEXT)");
      });
      store.close();
      // The database opens cleanly again — SQLite owns its sidecars.
      const reopened = openPlanStore({ pluginDataRoot: root });
      reopened.close();
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
