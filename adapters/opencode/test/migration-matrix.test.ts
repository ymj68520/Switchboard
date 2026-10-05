/**
 * v0.2.0 Phase 8 — migration / backward-compatibility matrix (§31-§33).
 *
 * The durable store is STORE_SCHEMA_VERSION=1 plus ADDITIVE OPTIONAL
 * families. Every retained historical store class must still load under the
 * frozen compatibility policy, and every unknown/impossible authority state
 * must FAIL CLOSED.
 *
 * Two fixture families, both produced by REAL machinery (no hand-crafted
 * authority records):
 * 1. supervised-era documents: a fully-driven current durable document with
 *    later additive families STRIPPED (exactly what an older store lacks),
 *    with run pointers repaired to the era's legal state;
 * 2. pre-cutover legacy documents: marker stripped through the store, then
 *    the REAL v0.1 handoff machinery (assembleExecutionHandoff →
 *    saveExecutionHandoff → prepareHandoffDelivery → recordHandoffDelivered
 *    → completeHandoffRun).
 *
 * Additive-family defaults audited here (§33): absent handoffProtocol =
 * legacy_v0_1; absent Stage.kind = ordinary; absent verificationPurpose =
 * acceptance; absent completionRecord = not completed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  UltraPlanController,
  assembleExecutionHandoff,
  planningRunHandoffProtocol,
  verificationPurposeOf,
  HandoffIDs,
  type ExecutionStage,
  type PlanningRun,
} from "../src/index.js";
import {
  durableHandoffPendingWorld,
  execCleanVerification,
  execRunDirective,
  supervisedWorld,
} from "./execution-world.js";

/** The document families each supervised era PREDATES (stripped to derive the fixture). */
const ERA_FAMILIES = {
  phase5: ["executionCompletions", "completionByExecutionRun", "executionIssues", "issueByExecutionRun", "verificationConflicts", "attemptReconciliations", "reconciliationByAttempt"],
  phase3: [
    "executionCompletions", "completionByExecutionRun", "executionIssues", "issueByExecutionRun", "verificationConflicts",
    "attemptReconciliations", "reconciliationByAttempt", "executionDirectives", "executionAttempts", "executionReports",
    "executionAttemptByDirective", "supervisorAssessments", "executionCommits", "executionCommitByAssessment", "executionCommitByWindow",
  ],
  phase2: [
    "executionCompletions", "completionByExecutionRun", "executionIssues", "issueByExecutionRun", "verificationConflicts",
    "attemptReconciliations", "reconciliationByAttempt", "executionDirectives", "executionAttempts", "executionReports",
    "executionAttemptByDirective", "supervisorAssessments", "executionCommits", "executionCommitByAssessment", "executionCommitByWindow",
    "executionStages", "verificationWindows",
  ],
  phase1: [
    "executionCompletions", "completionByExecutionRun", "executionIssues", "issueByExecutionRun", "verificationConflicts",
    "attemptReconciliations", "reconciliationByAttempt", "executionDirectives", "executionAttempts", "executionReports",
    "executionAttemptByDirective", "supervisorAssessments", "executionCommits", "executionCommitByAssessment", "executionCommitByWindow",
    "executionStages", "verificationWindows", "supervisorBindings",
  ],
} as const;

type Era = keyof typeof ERA_FAMILIES;

const FIXED = "2026-09-29T12:00:00.000Z";
const PLAN_ID = "PLAN-001";

async function openStore(filePath: string): Promise<DurablePlanStore> {
  const store = new DurablePlanStore(filePath);
  await Promise.resolve(store.open());
  return store;
}

async function readDoc(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("§31 — every retained historical store class loads under the frozen compatibility policy", () => {
  let dir: string;
  let currentPath: string;

  it("builds the current document (supervised marker + run/binding/stage/window/directive cycle) and loads it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-migration-"));
    currentPath = path.join(dir, "current", "plan-store.json");
    const handoff = await durableHandoffPendingWorld(currentPath);
    const supervised = await supervisedWorld(handoff as never);
    await execRunDirective(supervised, { objective: "work for STAGE-001" });
    const stage = (await supervised.world.store.getExecutionStage(supervised.stage.id as never)) as ExecutionStage;
    await execCleanVerification(supervised, stage.completionObligations!.map((obligation) => obligation.id as string), { objective: "verify STAGE-001" });
    (supervised.world.store as unknown as DurablePlanStore).close();

    const store = await openStore(currentPath);
    try {
      const run = (await store.getRun(PLAN_ID as never)) as PlanningRun;
      expect(run.handoffProtocol).toBe("supervised_v0_2");
      const doc = await readDoc(currentPath);
      expect(Object.keys((doc["executionRuns"] as Record<string, unknown>) ?? {}).length).toBeGreaterThanOrEqual(1);
      expect(Object.keys((doc["executionStages"] as Record<string, unknown>) ?? {}).length).toBeGreaterThanOrEqual(1);
      expect(Object.keys((doc["executionDirectives"] as Record<string, unknown>) ?? {}).length).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
  });

  async function loadStripped(era: Era, repair: (run: Record<string, unknown>) => void): Promise<DurablePlanStore> {
    const doc = await readDoc(currentPath);
    for (const family of ERA_FAMILIES[era]) delete doc[family];
    // The pointer repair targets the EXECUTION run record (activeStage /
    // openWindow / acceptedHead live there), not the planning run.
    for (const executionRun of Object.values((doc["executionRuns"] as Record<string, Record<string, unknown>>) ?? {})) repair(executionRun);
    const fixture = path.join(dir, era, "plan-store.json");
    await mkdir(path.dirname(fixture), { recursive: true });
    await writeFile(fixture, JSON.stringify(doc));
    return openStore(fixture);
  }

  it("phase-6B-era document (no completion/issue/conflict families) loads", async () => {
    const store = await loadStripped("phase5", () => {});
    try {
      expect(((await store.getRun(PLAN_ID as never)) as PlanningRun).lifecycle).toBe("handoff_pending");
    } finally {
      store.close();
    }
  });

  it("phase-4/5-era document (no directives/attempts/reports/assessments/commits) loads", async () => {
    const store = await loadStripped("phase3", () => {});
    try {
      expect(((await store.getRun(PLAN_ID as never)) as PlanningRun).lifecycle).toBe("handoff_pending");
    } finally {
      store.close();
    }
  });

  it("phase-3-era document (no Stage/Window structures) loads with repaired run pointers", async () => {
    const store = await loadStripped("phase2", (run) => {
      run["activeStage"] = null;
      run["openWindow"] = null;
      run["acceptedHead"] = null;
    });
    try {
      expect(((await store.getRun(PLAN_ID as never)) as PlanningRun).lifecycle).toBe("handoff_pending");
    } finally {
      store.close();
    }
  });

  it("phase-1-era document (prepared ExecutionRun, no binding, no structures) loads", async () => {
    const store = await loadStripped("phase1", (run) => {
      run["lifecycle"] = "prepared";
      run["activeStage"] = null;
      run["openWindow"] = null;
      run["acceptedHead"] = null;
    });
    try {
      expect(((await store.getRun(PLAN_ID as never)) as PlanningRun).lifecycle).toBe("handoff_pending");
      const executionRun = (await store.getExecutionRun("EXEC-001" as never))!;
      expect(executionRun.lifecycle).toBe("prepared");
      expect(executionRun.activeStage ?? null).toBeNull();
    } finally {
      store.close();
    }
  });

  it("pre-v0.2 planning-only document (no execution families, no committed FinalPlan) loads", async () => {
    const planningOnly = path.join(dir, "planning-only", "plan-store.json");
    const store = new DurablePlanStore(planningOnly, { now: () => FIXED });
    await Promise.resolve(store.open());
    const controller = new UltraPlanController({
      store,
      now: () => FIXED,
      semanticValidator: { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } },
    });
    controller.issueStartAdmission("ses_pre_v02");
    await controller.startOrResume("ses_pre_v02", "planning-only era");
    await controller.requestArchitecture("ses_pre_v02");
    const doc = await readDoc(planningOnly);
    store.close();
    for (const key of ["executionRuns", "executionStages", "verificationWindows", "supervisorBindings", "executionHandoffs", "handoffDeliveries", "finalPlans"]) {
      expect(doc[key] === undefined || Object.keys(doc[key] as Record<string, unknown>).length === 0).toBe(true);
    }
    const reopened = await openStore(planningOnly);
    try {
      expect(((await reopened.findActiveRunBySession("ses_pre_v02" as never)) as PlanningRun).stage).toBe("architecture");
    } finally {
      reopened.close();
    }
  });

  async function buildLegacyWorld(prefix: string): Promise<InstanceType<typeof DurablePlanStore>> {
    const legacyPath = path.join(dir, prefix, "plan-store.json");
    const handoff = await durableHandoffPendingWorld(legacyPath);
    const store = handoff.store as unknown as DurablePlanStore;
    const run = (await store.getRun(PLAN_ID as never)) as PlanningRun;
    await store.saveRun({ ...run, handoffProtocol: undefined });
    const finalPlan = (await store.listFinalPlans(PLAN_ID as never))[0]!;
    const requiredContracts = [];
    for (const ref of finalPlan.sections) {
      const revision = await store.getSectionRevision(PLAN_ID as never, ref);
      if (revision) requiredContracts.push(revision.projection.contract);
    }
    const liveRun = (await store.getRun(PLAN_ID as never)) as PlanningRun;
    const assembled = assembleExecutionHandoff({ run: liveRun, finalPlan, requiredContracts, assign: { id: "HANDOFF-001", now: FIXED } });
    await store.saveExecutionHandoff(PLAN_ID as never, assembled.handoff);
    await store.prepareHandoffDelivery(PLAN_ID as never, {
      handoffID: HandoffIDs.cast(assembled.handoff.id),
      handoffHash: assembled.handoff.hash,
      sessionID: liveRun.sessionID,
      deliveryKey: `${PLAN_ID}/HANDOFF-001/${assembled.handoff.hash}`,
    });
    return store;
  }

  it("pre-cutover v0.1 handoff_pending document (marker stripped + REAL prepared legacy handoff) loads as legacy_v0_1", async () => {
    const store = await buildLegacyWorld("legacy-pending");
    const legacyPath = path.join(dir, "legacy-pending", "plan-store.json");
    store.close();
    const reopened = await openStore(legacyPath);
    try {
      const reloaded = (await reopened.getRun(PLAN_ID as never)) as PlanningRun;
      expect(planningRunHandoffProtocol(reloaded)).toBe("legacy_v0_1");
      expect(reloaded.lifecycle).toBe("handoff_pending");
    } finally {
      reopened.close();
    }
  });

  it("legacy-completed store (marker absent + delivered legacy delivery via the REAL completion path) loads", async () => {
    const store = await buildLegacyWorld("legacy-completed");
    const completedPath = path.join(dir, "legacy-completed", "plan-store.json");
    const liveRun = (await store.getRun(PLAN_ID as never)) as PlanningRun;
    await store.beginHandoffDispatch(PLAN_ID as never, HandoffIDs.cast("HANDOFF-001"));
    await store.recordHandoffDelivered(PLAN_ID as never, HandoffIDs.cast("HANDOFF-001"), {
      sessionID: liveRun.sessionID,
      messageID: "msg_legacy_001",
    });
    await store.completeHandoffRun(PLAN_ID as never);
    store.close();

    const reopened = await openStore(completedPath);
    try {
      const reloaded = (await reopened.getRun(PLAN_ID as never)) as PlanningRun;
      expect(reloaded.lifecycle).toBe("completed");
      expect(planningRunHandoffProtocol(reloaded)).toBe("legacy_v0_1");
    } finally {
      reopened.close();
    }
  });
});

describe("§32 — unknown / impossible authority state fails closed", () => {
  async function failClosedFixture(name: string, mutate: (doc: Record<string, unknown>) => void): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-failclosed-"));
    const current = path.join(dir, "current", "plan-store.json");
    const handoff = await durableHandoffPendingWorld(current);
    handoff.store.close();
    const doc = await readDoc(current);
    mutate(doc);
    const fixture = path.join(dir, name, "plan-store.json");
    await mkdir(path.dirname(fixture), { recursive: true });
    await writeFile(fixture, JSON.stringify(doc));
    return fixture;
  }

  it("an unknown handoffProtocol value is corruption, never silently accepted", async () => {
    const fixture = await failClosedFixture("unknown-protocol", (doc) => {
      const runs = doc["runs"] as Record<string, Record<string, unknown>>;
      (runs[PLAN_ID] as Record<string, unknown>)["handoffProtocol"] = "supervised_v9_future";
    });
    await expect(openStore(fixture)).rejects.toThrow(/handoffProtocol|protocol/i);
  });

  it("a future schemaVersion refuses to open (store_version_unsupported)", async () => {
    const fixture = await failClosedFixture("future", (doc) => {
      doc["schemaVersion"] = 999;
    });
    await expect(openStore(fixture)).rejects.toThrow(/newer than supported/);
  });

  it("an impossible graph (finalPlan pointer to a missing revision) fails closed", async () => {
    const fixture = await failClosedFixture("impossible", (doc) => {
      const runs = doc["runs"] as Record<string, Record<string, unknown>>;
      (runs[PLAN_ID] as Record<string, unknown>)["finalPlan"] = { id: "FINAL-001", revision: 99 };
    });
    await expect(openStore(fixture)).rejects.toThrow(/corrupt|missing/i);
  });
});

describe("§33 — additive-family absence defaults are explicit and compatibility-only", () => {
  it("absent Stage.kind reads as ordinary-absent; absent verificationPurpose reads as acceptance", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-defaults-"));
    try {
      const current = path.join(dir, "current", "plan-store.json");
      const handoff = await durableHandoffPendingWorld(current);
      const supervised = await supervisedWorld(handoff as never);
      await execRunDirective(supervised, { objective: "work" });
      const stage = (await supervised.world.store.getExecutionStage(supervised.stage.id as never)) as ExecutionStage;
      await execCleanVerification(supervised, stage.completionObligations!.map((obligation) => obligation.id as string), { objective: "verify" });
      (supervised.world.store as unknown as DurablePlanStore).close();

      const doc = await readDoc(current);
      for (const stageRecord of Object.values(doc["executionStages"] as Record<string, Record<string, unknown>>)) delete stageRecord["kind"];
      for (const family of Object.values(doc["executionDirectives"] as Record<string, Record<string, Record<string, unknown>>>)) {
        for (const directive of Object.values(family)) {
          if (directive["kind"] === "verification") delete directive["verificationPurpose"];
        }
      }
      await writeFile(current, JSON.stringify(doc));

      const store = await openStore(current);
      try {
        const reloadedStage = (await store.getExecutionStage("STAGE-001" as never))!;
        expect(reloadedStage).toBeDefined();
        expect(reloadedStage.kind).toBeUndefined();
        const verifier = await store.getExecutionDirective("DIR-002" as never);
        expect(verifier).toBeDefined();
        expect(verificationPurposeOf(verifier!)).toBe("acceptance");
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the absent marker resolves to legacy_v0_1 through the store resolver — never guessed from artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-defaults-"));
    try {
      const current = path.join(dir, "current", "plan-store.json");
      const handoff = await durableHandoffPendingWorld(current);
      const store = handoff.store as unknown as DurablePlanStore;
      const run = (await store.getRun(PLAN_ID as never)) as PlanningRun;
      await store.saveRun({ ...run, handoffProtocol: undefined });
      const stripped = (await store.getRun(PLAN_ID as never)) as PlanningRun;
      expect(planningRunHandoffProtocol(stripped)).toBe("legacy_v0_1");
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
