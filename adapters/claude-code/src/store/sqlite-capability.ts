/**
 * node:sqlite capability probe (frozen plan §7.2, architecture §26.2).
 *
 * This is a capability smoke test, NOT the Phase 2 store: it proves the
 * module loads, a database opens, statements execute, a transaction runs,
 * and the database closes deterministically — against an in-memory database
 * only. The canonical phase-plan.sqlite3 schema is explicitly out of scope
 * for Phase 1.
 *
 * The module loader is injectable so tests can exercise the full step
 * machine without depending on the host Node version.
 */

import { RuntimeError } from "../runtime/errors.js";

export type SqliteProbeStep =
  | "module_load"
  | "open"
  | "create"
  | "insert"
  | "select"
  | "transaction"
  | "close";

export const SQLITE_PROBE_STEPS: readonly SqliteProbeStep[] = [
  "module_load",
  "open",
  "create",
  "insert",
  "select",
  "transaction",
  "close",
];

export interface SqliteCapabilityResult {
  available: boolean;
  steps: Record<SqliteProbeStep, "pass" | "fail">;
  failedStep?: SqliteProbeStep;
  cause?: string;
  sqliteVersion?: string;
}

/** Minimal structural typing over node:sqlite's DatabaseSync. */
export interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
}

export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

export type SqliteModule = { DatabaseSync: new (path: string) => SqliteDatabaseLike };
export type SqliteModuleLoader = () => Promise<SqliteModule>;

async function defaultLoader(): Promise<SqliteModule> {
  return (await import("node:sqlite")) as SqliteModule;
}

/**
 * Run the full in-memory smoke sequence. Any failure short-circuits with the
 * failing step, a stable SQLITE_UNAVAILABLE code, and the underlying cause.
 */
export async function probeSqliteCapability(
  loader: SqliteModuleLoader = defaultLoader,
): Promise<SqliteCapabilityResult> {
  const steps = Object.fromEntries(SQLITE_PROBE_STEPS.map((s) => [s, "fail"])) as Record<
    SqliteProbeStep,
    "pass" | "fail"
  >;
  const fail = (step: SqliteProbeStep, err: unknown): SqliteCapabilityResult => ({
    available: false,
    steps,
    failedStep: step,
    cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });

  let module: SqliteModule;
  try {
    module = await loader();
  } catch (err) {
    return fail("module_load", err);
  }
  steps.module_load = "pass";

  let db: SqliteDatabaseLike;
  try {
    db = new module.DatabaseSync(":memory:");
  } catch (err) {
    return fail("open", err);
  }
  steps.open = "pass";

  let sqliteVersion: string | undefined;
  try {
    const row = db.prepare("select sqlite_version() as v").get() as { v?: string } | undefined;
    sqliteVersion = typeof row?.v === "string" ? row.v : undefined;
  } catch {
    // Version introspection is best-effort; the capability does not depend on it.
  }

  try {
    db.exec("CREATE TABLE phase_plan_probe (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  } catch (err) {
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
    return fail("create", err);
  }
  steps.create = "pass";

  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO phase_plan_probe (k, v) VALUES (?, ?)");
    insert.run("probe", "ok");
    insert.run("probe2", "ok");
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no transaction to roll back
    }
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
    return fail("transaction", err);
  }
  steps.insert = "pass";
  steps.transaction = "pass";

  try {
    const select = db.prepare("SELECT v FROM phase_plan_probe WHERE k = ?");
    const row = select.get("probe") as { v?: string } | undefined;
    if (row?.v !== "ok") {
      return fail("select", new Error(`unexpected probe row: ${JSON.stringify(row ?? null)}`));
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
    return fail("select", err);
  }
  steps.select = "pass";

  try {
    db.close();
  } catch (err) {
    return fail("close", err);
  }
  steps.close = "pass";

  return {
    available: true,
    steps,
    ...(sqliteVersion === undefined ? {} : { sqliteVersion }),
  };
}

/** Maps a probe result onto the runtime error envelope for fail-closed paths. */
export function sqliteUnavailable(result: SqliteCapabilityResult): RuntimeError {
  return new RuntimeError("SQLITE_UNAVAILABLE", "node:sqlite capability smoke test failed", {
    cause: `${result.failedStep ?? "unknown"}: ${result.cause ?? "unknown"}`,
  });
}
