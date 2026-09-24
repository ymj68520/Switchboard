import { describe, expect, it } from "vitest";

import {
  probeSqliteCapability,
  SQLITE_PROBE_STEPS,
  sqliteUnavailable,
  type SqliteModuleLoader,
} from "../src/store/sqlite-capability.js";
import { FakeDatabaseSync, failingSqliteLoader, fakeSqliteLoader, fakeSqliteModule } from "./helpers.js";

describe("sqlite capability probe (injected module)", () => {
  it("runs the full smoke sequence and passes every step", async () => {
    const result = await probeSqliteCapability(fakeSqliteLoader());
    expect(result.available).toBe(true);
    expect(result.failedStep).toBeUndefined();
    for (const step of SQLITE_PROBE_STEPS) {
      expect(result.steps[step], step).toBe("pass");
    }
    expect(result.sqliteVersion).toBe("9.9.9-fake");
  });

  it("short-circuits at module_load when node:sqlite cannot be imported", async () => {
    const result = await probeSqliteCapability(failingSqliteLoader(new Error("ERR_UNKNOWN_BUILTIN_MODULE")));
    expect(result.available).toBe(false);
    expect(result.failedStep).toBe("module_load");
    expect(result.cause).toContain("ERR_UNKNOWN_BUILTIN_MODULE");
    expect(result.steps.open).toBe("fail");
  });

  it("reports the failing step for mid-sequence SQL failures", async () => {
    class FailingCreateDb extends FakeDatabaseSync {
      override exec(sql: string): void {
        if (sql.includes("CREATE TABLE")) throw new Error("syntax error near CREATE");
        super.exec(sql);
      }
    }
    const result = await probeSqliteCapability(fakeSqliteLoader(fakeSqliteModule({ DatabaseSync: FailingCreateDb })));
    expect(result.available).toBe(false);
    expect(result.failedStep).toBe("create");
    expect(result.steps.open).toBe("pass");
    expect(result.steps.insert).toBe("fail");
  });

  it("detects a wrong SELECT result (statement executes but data is wrong)", async () => {
    class LyingSelectDb extends FakeDatabaseSync {
      override prepare(sql: string) {
        const prepared = super.prepare(sql);
        if (sql.toUpperCase().startsWith("SELECT") && !sql.includes("sqlite_version")) {
          return { run: prepared.run, get: () => ({ v: "wrong" }) };
        }
        return prepared;
      }
    }
    const result = await probeSqliteCapability(fakeSqliteLoader(fakeSqliteModule({ DatabaseSync: LyingSelectDb })));
    expect(result.available).toBe(false);
    expect(result.failedStep).toBe("select");
  });

  it("reports close failures (deterministic close is part of the capability)", async () => {
    class UnclosableDb extends FakeDatabaseSync {
      override close(): void {
        throw new Error("SQLITE_BUSY: database is locked");
      }
    }
    const result = await probeSqliteCapability(fakeSqliteLoader(fakeSqliteModule({ DatabaseSync: UnclosableDb })));
    expect(result.available).toBe(false);
    expect(result.failedStep).toBe("close");
  });

  it("maps failures onto the SQLITE_UNAVAILABLE envelope", async () => {
    const result = await probeSqliteCapability(failingSqliteLoader(new Error("nope")));
    const err = sqliteUnavailable(result);
    expect(err.code).toBe("SQLITE_UNAVAILABLE");
    expect(err.causeText).toContain("module_load");
  });
});

describe("sqlite capability probe (real node:sqlite)", () => {
  it("performs the real in-memory smoke test against the current Node", async () => {
    // This test runs the REAL node:sqlite module. On compliant Node builds
    // (>= 24.15, and late 22.x experimental builds) the full sequence passes;
    // on builds without the module it must fail closed at module_load — both
    // outcomes are valid probe behavior and the doctor renders them as PASS /
    // FAIL accordingly.
    const result = await probeSqliteCapability();
    if (result.available) {
      expect(result.failedStep).toBeUndefined();
      for (const step of SQLITE_PROBE_STEPS) {
        expect(result.steps[step], step).toBe("pass");
      }
      expect(typeof result.sqliteVersion === "string" || result.sqliteVersion === undefined).toBe(true);
    } else {
      expect(result.failedStep).toBe("module_load");
      expect(result.cause).toBeDefined();
    }
  });
});

describe("sqlite module loader typing", () => {
  it("accepts loader functions returning the minimal module shape", async () => {
    const loader: SqliteModuleLoader = async () => fakeSqliteModule();
    const result = await probeSqliteCapability(loader);
    expect(result.available).toBe(true);
  });
});
