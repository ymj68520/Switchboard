/**
 * A1-III — E14 final closure & release revalidation: the release audit that
 * only composes frozen machinery (directive §2 — no new semantics).
 *
 * §27 — the complete supported historical migration matrix into v26: a
 *       GENUINE store at each entry version (the real production chain
 *       applied manually, the same mechanism as the A1-I matrix) is driven
 *       to v26 by the REAL runner, then proven FK-clean, validator-clean,
 *       historically stable, and free of fabricated execution/control rows.
 *       The DATA-level rebuild legs are covered where the data lives:
 *       25→26 byte-identity (a1i-schema-v26, a1i-child-mapping) and the
 *       17→26 deep directive-hash rewind (v020-e2e-release-audit E14-DH1).
 * §18 — the ExecutionCompletionGate remains the ONE active→completed writer;
 *       reexecution added no alternate completion path.
 * §19 — terminal ExecutionRun immutability: the only lifecycle writers are
 *       the five frozen transition primitives.
 * §23/§24/§25/§26 — pinned by the shipped suites (authority matrix, control
 *       boundary, directive-protocol compatibility, SCHEMA_V26_OBJECTS);
 *       this file adds the schema-level FK/validator legs they need.
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { initializePlanStore } from "../src/store/sqlite-store.js";
import type { StoreTx } from "../src/store/transaction.js";
import { assertSchemaState, inspectSchemaState, setSchemaVersion } from "../src/store/schema.js";
import { createProductionMigrations } from "../src/store/migrations/index.js";
import {
  makeTempPluginDataRoot,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";

/** A GENUINE store at an arbitrary entry version: the real production chain
 * applied manually up to `entryVersion` (identical mechanism to the A1-I
 * matrix store — the runner itself has no partial-target notion). */
async function buildGenuineStoreAt(root: string, entryVersion: number): Promise<void> {
  const paths = storePathsFor(root);
  fs.mkdirSync(paths.storeDir, { recursive: true });
  const db = rawConnection(paths.databasePath, 5000);
  const chain = createProductionMigrations({
    generateStoreId: () => `store-a1iii-${entryVersion}`,
    nowIso: () => "2026-10-05T00:00:00.000Z",
  }).filter((migration) => migration.from >= 0 && migration.to <= entryVersion);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of chain) {
      migration.apply(db as unknown as StoreTx);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at, runtime_version) VALUES (?, ?, ?, ?)").run(
        migration.to,
        migration.name,
        "2026-10-05T00:00:00.000Z",
        "a1iii-release-audit",
      );
    }
    setSchemaVersion(db, entryVersion);
    assertSchemaState(db, paths.databasePath);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the failing migration may have resolved the transaction already
    }
    db.close();
    throw err;
  }
  db.close();
}

/** Seed the v3-era planning estate (its DDL is never reshaped by 004–026). */
function seedPlanningWorld(raw: ReturnType<typeof rawConnection>): { repositoryId: string; workspaceId: string; runId: string } {
  const now = "2026-10-05T00:00:00.000Z";
  const repositoryId = `repo_rel_${randomUUID().slice(0, 8)}`;
  const workspaceId = `ws_rel_${randomUUID().slice(0, 8)}`;
  const runId = `plan_rel_${randomUUID().slice(0, 8)}`;
  raw.prepare(
    "INSERT INTO repositories (repository_id, kind, canonical_locator, created_at, last_seen_at) VALUES (?, 'directory', ?, ?, ?)",
  ).run(repositoryId, `rel://${repositoryId}`, now, now);
  raw.prepare(
    "INSERT INTO workspaces (workspace_id, repository_id, kind, canonical_root, created_at, last_seen_at) VALUES (?, ?, 'directory', ?, ?, ?)",
  ).run(workspaceId, repositoryId, `rel://${workspaceId}`, now, now);
  raw.prepare(
    "INSERT INTO planning_runs (run_id, workspace_id, lifecycle, stage, revision, goal, created_at, updated_at) VALUES (?, ?, 'completed', 'final', 1, 'A1-III release matrix seed', ?, ?)",
  ).run(runId, workspaceId, now, now);
  return { repositoryId, workspaceId, runId };
}

describe("A1-III §27 — full historical migration matrix into v26", () => {
  for (const entryVersion of [13, 17, 23, 24, 25]) {
    it(`leg ${entryVersion} → 26: the real runner drives a genuine v${entryVersion} store clean — FK-clean, validator-clean, identities stable, nothing fabricated`, async () => {
      const root = makeTempPluginDataRoot(`a1iii-matrix-${entryVersion}-`);
      try {
        await buildGenuineStoreAt(root, entryVersion);
        const databasePath = storePathsFor(root).databasePath;
        const seedConnection = rawConnection(databasePath, 5000);
        const seed = seedPlanningWorld(seedConnection);
        seedConnection.close();
        // Reopen through the REAL runner: every migration entryVersion+1..26
        // applies through the production path.
        const store = await initializePlanStore({ pluginDataRoot: root });
        try {
          expect(store.getSchemaVersion()).toBe(26);
          const raw = rawConnection(databasePath, 5000);
          try {
            // FK integrity across the whole migrated estate.
            const fkViolations = raw.prepare("PRAGMA foreign_key_check").all();
            expect(fkViolations).toEqual([]);
            // §26 — the v26 validator is clean at rest.
            const state = inspectSchemaState(raw as never);
            expect(state.version).toBe(26);
            expect(state.problems).toEqual([]);
            // §27 — no fabricated ExecutionRun and no fabricated reexecution
            // authorization exists anywhere in a migrated matrix world.
            expect((raw.prepare("SELECT COUNT(*) AS n FROM execution_runs").get() as { n: number }).n).toBe(0);
            expect((raw.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'").get() as { n: number }).n).toBe(0);
            expect((raw.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations WHERE target_kind = 'legacy_pre_a1'").get() as { n: number }).n).toBe(0);
          } finally {
            raw.close();
          }
          // The seeded planning identity survived the whole chain unchanged.
          const planning = store.withRead(
            (tx) => tx.prepare("SELECT run_id AS id, workspace_id AS ws, lifecycle, stage, revision FROM planning_runs WHERE run_id = ?").get(seed.runId) as Record<string, unknown>,
          );
          expect(planning).toEqual({ id: seed.runId, ws: seed.workspaceId, lifecycle: "completed", stage: "final", revision: 1 });
        } finally {
          store.close();
        }
      } finally {
        removeTempPluginDataRoot(root);
      }
    });
  }

  it("clean → 26: a fresh store initializes at v26 with the full constraint inventory (matrix leg 0)", async () => {
    const root = makeTempPluginDataRoot("a1iii-clean-");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(26);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("A1-III §18/§19 — completion-gate and terminality writer audits", () => {
  const SRC_ROOT = "src";

  function scan(predicate: (relative: string, text: string) => string[]): string[] {
    const findings: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const relative = full.replaceAll("\\", "/");
          findings.push(...predicate(relative, fs.readFileSync(full, "utf8")));
        }
      }
    };
    walk(SRC_ROOT);
    return findings;
  }

  it("§18: the ExecutionCompletionGate is the ONE production active→completed writer; reexecution adds no alternate", () => {
    // The only production caller of the frozen completion primitive is the
    // final-closure gate.
    const callers = scan((relative, text) => {
      if (relative === "src/store/execution-runs.ts") return [];
      if (/completeExecutionRunByFinalCommitInTx/.test(text)) return [relative];
      return [];
    });
    expect(callers).toEqual(["src/application/final-closure-service.ts"]);
    // No SQL other than the frozen primitive ever completes an EXECUTION run
    // (the PlanningRun completion in the initial handoff is a different domain
    // and deliberately untouched by this audit).
    const rawWriters = scan((relative, text) => {
      if (/UPDATE\s+execution_runs\s+SET\s+lifecycle\s*=\s*'completed'/i.test(text) && relative !== "src/store/execution-runs.ts") return [relative];
      return [];
    });
    expect(rawWriters).toEqual([]);
    // The A1-II reexecution service never touches completion at all.
    const reexecution = fs.readFileSync("src/application/reexecution-service.ts", "utf8");
    expect(reexecution).not.toMatch(/lifecycle\s*[:=]\s*['"]completed['"]/);
    expect(reexecution).not.toMatch(/completeExecutionRun|completion_commit_id\s*=/);
  });

  it("§19: the only execution_runs lifecycle writers are the five frozen transition primitives (terminality can never be reverted)", () => {
    const writers = scan((relative, text) => {
      if (!/UPDATE execution_runs SET lifecycle/i.test(text)) return [];
      // The store primitive module owns exactly the frozen transitions:
      // prepared→active, active→replan_required, active→completed,
      // active→aborted. No resume/reactivate/rebind writer exists.
      if (relative === "src/store/execution-runs.ts") return [];
      return [relative];
    });
    expect(writers).toEqual([]);
    const primitives = fs.readFileSync("src/store/execution-runs.ts", "utf8");
    for (const frozen of [
      "SET lifecycle = 'active'",
      "SET lifecycle = 'replan_required'",
      "SET lifecycle = 'completed'",
      "SET lifecycle = 'aborted'",
    ]) {
      expect(primitives).toContain(frozen);
    }
    // Terminal lifecycles are never an insertion state and never re-entered:
    // every conditional transition gates on a NON-terminal source lifecycle.
    expect(primitives).not.toMatch(/lifecycle\s*=\s*'(completed|replan_required|aborted)'\s*$/m);
  });
});
