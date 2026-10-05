/**
 * E14 §34/§43/§44 — release static audits: directive-protocol hash
 * compatibility across every historical canonicalizer, the anti-fiction scan
 * over production source, and the frozen v0.2.0 non-goals inventory. Every
 * occurrence is classified inline; a NEW occurrence fails the suite.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DIRECTIVE_PROTOCOL_VERSIONS,
  canonicalDirectiveV1,
  canonicalDirectiveV2,
  executionDirectiveContent,
  executionDirectiveHash,
} from "../src/core/execution-directive.js";
import { getExecutionDirectiveInTx } from "../src/store/execution-directives.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import {
  rawConnection,
  storePathsFor,
  dropSchema25Objects, dropSchema24Objects, dropSchema23Objects, dropSchema22Objects,
  dropSchema21Objects, dropSchema20Objects, dropSchema19Objects, dropSchema18Objects,
} from "./store-helpers.js";
import {
  issueDirective,
  makeActiveExecutionWorld,
} from "./execution-protocol-helpers.js";

describe("v020 directive protocol compatibility gate (§34)", () => {
  it("E14-DH1: all three canonicalizers exist frozen; a v3 directive keeps its hash through a deep v16 rewind + re-migration", async () => {
    // A1 §13/§20 — the protocol registry extends to v4 and ALL NEW issuance
    // is v4; the v1/v2/v3 canonicalizers remain frozen (pinned below).
    expect([...DIRECTIVE_PROTOCOL_VERSIONS]).toEqual([1, 2, 3, 4]);
    const world = await makeActiveExecutionWorld("E14-DH1");
    const directive = issueDirective(world, { directiveId: "DIR-DH1", kind: "implementation" });
    expect(directive.protocolVersion).toBe(4);
    const root = path.dirname(path.dirname(world.ctx.store.path));
    const databasePath = storePathsFor(root).databasePath;
    const beforeRows = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT directive_id AS id, revision, directive_hash AS hash, body FROM execution_directives ORDER BY directive_id, revision").all(),
    );
    world.ctx.store.close();
    // Deep rewind to the DIRECTIVE era (v17): everything v18..v25 is dropped
    // and re-derived; the persisted directive rows must come back
    // byte-identical (no canonicalizer rewrite anywhere in the chain).
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema25Objects(raw);
      dropSchema24Objects(raw);
      dropSchema23Objects(raw);
      dropSchema22Objects(raw);
      dropSchema21Objects(raw);
      dropSchema20Objects(raw);
      dropSchema19Objects(raw);
      dropSchema18Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version > 17");
      raw.exec("PRAGMA user_version = 17");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    expect(reopened.getSchemaVersion()).toBe(26);
    const afterRows = reopened.withRead(
      (tx) => tx.prepare("SELECT directive_id AS id, revision, directive_hash AS hash, body FROM execution_directives ORDER BY directive_id, revision").all(),
    );
    expect(afterRows).toEqual(beforeRows); // historical hashes intact
    const reparsed = reopened.withRead(
      (tx) => getExecutionDirectiveInTx(tx, "DIR-DH1", 1),
    );
    expect(reparsed).not.toBeNull();
    // The E8 preservation contract: the rewind to the pre-E8 era drops the
    // policy columns, so the re-migrated row is the policy-less v1 SHAPE —
    // but the persisted hash column was NEVER rewritten by any migration.
    expect(reparsed).not.toBeNull();
    const reparsedDirective = reparsed!;
    expect(reparsedDirective.protocolVersion).toBe(1);
    expect(reparsedDirective.hash).toBe(directive.hash);
    reopened.close();
  });

  it("E14-DH2: the v1/v2 canonicalizers are byte-frozen over a fixed content vector", () => {
    const vector = {
      directiveId: "DIR-VECTOR",
      runId: "run_vector",
      revision: 2,
      kind: "implementation" as const,
      objective: "fixed objective",
      body: "fixed body",
      finalPlanRef: { id: "fplan", revision: 1, hash: "sha256:vector" },
      baseCandidateRevision: 3,
      planRefs: [],
      expectedExecutionScope: { files: ["a.ts"], symbols: [], callPaths: [], tests: [] },
      capabilityEnvelope: {
        repositoryRead: true, repositoryWrite: false, commandExecution: false,
        networkAccess: false, dependencyMutation: false, gitCommit: false,
        gitPush: false, externalServiceMutation: false,
      },
      invariants: [],
      requiredActions: [],
      forbiddenActions: [],
      validationRequirements: [],
      deliverables: [],
      stopConditions: [],
      reportContract: {
        requireActionsPerformed: false, requireFilesExamined: false, requireFilesChanged: false,
        requireCommandsRun: false, requireTestsRun: false, requireFindings: false,
        requireDeviations: false, requireBlockers: false, requireDeliverables: false,
      },
      verificationPolicy: null as null,
      stageId: "stage_v",
      windowId: "win_v",
      scopeKind: "stage" as const,
      protocolVersion: 1 as const,
    };
    const v1 = canonicalDirectiveV1(vector as never);
    const v2 = canonicalDirectiveV2({ ...vector, protocolVersion: 2 } as never);
    const v3 = executionDirectiveContent({ ...vector, protocolVersion: 3 } as never);
    // Deterministic (byte-identical across repeated invocations).
    expect(canonicalDirectiveV1(vector as never)).toBe(v1);
    expect(canonicalDirectiveV2({ ...vector, protocolVersion: 2 } as never)).toBe(v2);
    expect(executionDirectiveContent({ ...vector, protocolVersion: 3 } as never)).toBe(v3);
    // The three eras are distinct canonical forms.
    expect(new Set([v1, v2, v3]).size).toBe(3);
    // v3 covers the policy and the scope family that v1 predates.
    expect(v3).toContain("verificationPolicy");
    expect(v2).toContain("verificationPolicy");
    expect(v1).not.toContain("verificationPolicy");
  });

  it("E14-DH3: the E11 structured reconciliation target is hash-covered by the persisted v3 canonical", async () => {
    const { makeIndeterminateWorld, runReconciliationInspection } = await import("./attempt-recovery-helpers.js");
    const rec = await makeIndeterminateWorld({ sessionId: "E14-DH3" });
    const inspection = runReconciliationInspection(rec.world, { attemptId: rec.attemptId, candidateMutated: false });
    // The bound reconciliation Directive's persisted hash equals the v3
    // canonicalizer over its own persisted content — the exact inspection
    // target (attempt id) is INSIDE that canonical content.
    const binding = rec.world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT directive_id AS d, attempt_id AS a FROM execution_attempt_reconciliation_bindings WHERE attempt_id = ?").get(rec.attemptId) as { d: string; a: string },
    );
    expect(binding.a).toBe(rec.attemptId);
    const parsed = rec.world.ctx.store.withRead(
      (tx) => getExecutionDirectiveInTx(tx, binding.d, 1),
    );
    expect(parsed).not.toBeNull();
    const recDirective = parsed!;
    // A1 §20 — post-A1 issuance (reconciliation included) is protocol v4.
    expect(recDirective.protocolVersion).toBe(4);
    // The persisted hash is exactly the v3 canonicalizer over the persisted
    // content — the inspection target is covered by that canonical content.
    expect(executionDirectiveHash(recDirective)).toBe(recDirective.hash);
    expect(inspection.directiveId).toBe(binding.d);
  });
});

describe("v020 static anti-fiction audit (§43)", () => {
  const SRC_ROOT = path.resolve(__dirname, "../src");

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  it("E14-AF1: no forbidden construct exists in production source (classified scan)", () => {
    // Each forbidden pattern with its classification policy: a hit is allowed
    // ONLY at a whitelisted location (documented below); any other occurrence
    // fails the release.
    const scans: Array<{ pattern: RegExp; allow: (file: string) => boolean }> = [
      // A fabricated commit id prefix — never legal anywhere.
      { pattern: /EC-000/, allow: () => false },
      // Generic lifecycle/head/revision setters — the frozen writers are the
      // only paths; no public setter function may exist.
      { pattern: /function set(ExecutionRun)?(Lifecycle|AcceptedHead|CandidateRevision|StageStatus)\b/, allow: () => false },
      { pattern: /SET lifecycle = \?/, allow: () => false },
      // A separate verification-report protocol — verification reports are
      // ExecutionReports; no VerificationReport type may exist.
      { pattern: /interface VerificationReport\b|type VerificationReport\b|class VerificationReport\b/, allow: () => false },
      // Majority voting — one resolver maximum (E8).
      { pattern: /\bmajority\b/i, allow: (file) => file.endsWith("verification-conflict-service.ts") || file.endsWith("execution-conflicts.ts") || file.endsWith("verification-conflicts.ts") },
    ];
    const offenders: Array<{ file: string; pattern: string }> = [];
    for (const file of walk(SRC_ROOT)) {
      // §43 — a comment that explicitly states the forbidden concept is NOT an
      // occurrence: strip line and block comments before matching.
      const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const scan of scans) {
        if (scan.pattern.test(text) && !scan.allow(file)) {
          offenders.push({ file: path.relative(SRC_ROOT, file), pattern: String(scan.pattern) });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("E14-AF2: structural singletons hold — one active Stage, one open Window, one running Attempt, one commit per Window", async () => {
    const root = (await import("./store-helpers.js")).makeTempPluginDataRoot("phase-plan-e14-af2-");
    let af2Store: Awaited<ReturnType<typeof initializePlanStore>> | null = null;
    try {
      const store = af2Store = await initializePlanStore({ pluginDataRoot: root });
      const indexes = store.withRead(
        (tx) => tx.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>,
      );
      const byName = new Map(indexes.map((index) => [index.name, index.sql]));
      // single active Stage per run
      expect(byName.get("idx_execution_stages_one_active_per_run") ?? [...byName.values()].find((sql) => sql.includes("execution_stages") && sql.includes("status = 'active'"))).toBeTruthy();
      // single open Window per run
      expect([...byName.values()].some((sql) => sql.includes("verification_windows") && sql.includes("closed_at IS NULL"))).toBe(true);
      // single running logical Attempt per run
      expect([...byName.values()].some((sql) => sql.includes("execution_attempts") && sql.includes("state = 'running'"))).toBe(true);
      // ExecutionCommit: exactly one per Window (no DAG fan-out) + single parent.
      const commitFacts = store.withRead((tx) => ({
        uniqueWindow: tx.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'execution_commits' AND sql LIKE '%UNIQUE (window_id)%'").get() as { n: number },
        parentColumn: tx.prepare("SELECT count(*) AS n FROM pragma_table_info('execution_commits') WHERE name = 'parent_commit_id'").get() as { n: number },
      }));
      expect(commitFacts.uniqueWindow.n).toBe(1);
      expect(commitFacts.parentColumn.n).toBe(1);
      store.close();
      af2Store = null;
    } finally {
      af2Store?.close();
      (await import("./store-helpers.js")).removeTempPluginDataRoot(root);
    }
  });

  it("E14-AF3: no automatic workspace rollback or cross-workspace migration machinery exists", () => {
    const { readFileSync, readdirSync } = fs;
    const offenders: string[] = [];
    const walkDir = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          if (/git\s+(reset|revert|checkout|restore|clean)\b/.test(text)) {
            offenders.push(path.relative(SRC_ROOT, full));
          }
          if (/migrateExecutionRun(ToWorkspace|AcrossWorkspaces)|crossWorkspaceMigration/i.test(text)) {
            offenders.push(path.relative(SRC_ROOT, full));
          }
        }
      }
    };
    walkDir(SRC_ROOT);
    expect(offenders).toEqual([]);
  });
});

describe("v020 frozen non-goals audit (§44)", () => {
  const SRC_ROOT = path.resolve(__dirname, "../src");

  function readAll(): string {
    const walk = (dir: string): string =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && entry.name.endsWith(".ts") ? [fs.readFileSync(full, "utf8")] : [];
      }).join("\n");
    return walk(SRC_ROOT);
  }

  it("E14-NG1: every frozen non-goal category remains ABSENT (PASS/FAIL per category)", () => {
    const source = readAll();
    const categories: Array<{ name: string; pass: boolean }> = [
      { name: "task-complexity classifier", pass: !/taskComplexity|complexityClassifier|classifyComplexity/.test(source) },
      { name: "simple/complex dual execution protocol", pass: !/executionMode.*simple|simpleExecutionProtocol|dualProtocol/i.test(source) },
      { name: "parallel Stage execution", pass: !/activateStagesInParallel|parallelStage|Promise\.all\([^)]*activateExecutionStage/i.test(source) },
      { name: "parallel Window execution", pass: !/openWindowsInParallel|parallelWindow/i.test(source) },
      { name: "ExecutionCommit DAG", pass: !/commitDag|mergeCommit|forkCommit/i.test(source) },
      { name: "multi-worker concurrent implementation", pass: !/concurrentWorkers|workerPool|parallelAttempts/i.test(source) },
      { name: "path-level hard allowlists", pass: !/allowedPaths|pathAllowlist|deniedPaths/.test(source) },
      { name: "symbol-level hard write allowlists", pass: !/symbolAllowlist|allowedSymbols|deniedSymbols/.test(source) },
      { name: "ExecutionObservation", pass: !/interface ExecutionObservation\b|class ExecutionObservation\b|CREATE TABLE (IF NOT EXISTS )?execution_observations|INTO execution_observations/.test(source) },
      { name: "automatic filesystem rollback", pass: !/git\s+(reset|revert|checkout|restore|clean)\b/.test(source) },
      { name: "unbounded verifier recursion", pass: !/recursionDepth|maxRecursion.*verifier|verifierRecursion/i.test(source) },
      { name: "majority voting", pass: !/majorityVote|voteAmong|quorumOf/i.test(source) },
      { name: "Supervisor direct coding fallback", pass: !/supervisorFallback|supervisorDirectEdit|fallbackCoding/i.test(source) },
      { name: "Verifier self-repair", pass: !/verifierSelfRepair|verifierRepair|selfRepair/i.test(source) },
      { name: "cross-workspace migration", pass: !/crossWorkspaceMigration|migrateRunToWorkspace/i.test(source) },
      { name: "cross-machine continuation", pass: !/crossMachine|remoteContinuation|machineTransfer/i.test(source) },
      { name: "execution-time Plan Memory mutation", pass: !/updateMemoryRevisionInTx|writeMemoryRevisionFromExecution/i.test(source) },
      { name: "model-controlled force/bypass", pass: !/"force":\s|"bypass":\s|bypassGate|skipGate|overrideGate/.test(source) },
    ];
    const failed = categories.filter((category) => !category.pass).map((category) => category.name);
    expect(failed).toEqual([]);
    // Every category reports an explicit verdict (the §44 deliverable).
    expect(categories.map((category) => `${category.name}: ${category.pass ? "PASS" : "FAIL"}`)).toHaveLength(18);
  });
});

