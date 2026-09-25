/**
 * Phase 2B2 §30 — process-level crash recovery tests.
 *
 * Each test spawns a REAL child process (scripts/crash-probe.mjs) against a
 * durable store, lets it terminate abruptly at the requested crash point, then
 * reopens the database in THIS process and validates the recovered state.
 *
 *   A/B. crash before the durable rename → zero transaction mutation
 *   C.   crash after the durable rename but before the caller response →
 *        exactly one committed transaction, idempotent retry returns it
 *
 * Requires the built dist (the adapter's `pretest` runs the build).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DurablePlanStore, PlanIDs } from "../src/index.js";
import type { SynthesisManifestDraftInput } from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const probe = path.join(repoRoot, "scripts", "crash-probe.mjs");
const distEntry = path.join(repoRoot, "adapters", "opencode", "dist", "index.js");

const FIXED = "2026-09-24T21:00:00.000Z";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ultraplan-crash-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

interface ProbeResult {
  status: number;
  signal: string | null;
  output: string;
}

function runProbe(dbFile: string, crashPoint: string, mode = "decision"): ProbeResult {
  const result = spawnSync(process.execPath, [probe, dbFile, crashPoint, mode], {
    env: { ...process.env, CRASH_PROBE_ENTRY: distEntry },
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: result.status ?? -1,
    signal: result.signal ?? null,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function planID() {
  return PlanIDs.from(1);
}

describe("process-level crash recovery (§30)", () => {
  it("crash before the durable persist leaves zero transaction mutation (§30.A/B)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist");
    // process.abort() → abnormal termination, not a clean exit.
    // Windows process.abort() exits with status 134 and signal=null, and its
    // buffered stderr output is discarded on abort — so the reliable signals
    // are the abnormal exit status and the absence of a clean-commit marker.
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    // Parent reopens the database: zero partial transaction. The crashed
    // probe left a lock file; a short stale-lock window simulates elapsed
    // time so the lock is stolen deterministically.
    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    expect(await reopened.findLatestRunBySession("ses_crash")).toBeDefined();
    expect(await reopened.listDecisions(planID())).toHaveLength(0);
    expect(await reopened.listCommits(planID())).toHaveLength(0);
    expect((await reopened.getHeadSnapshot(planID()))?.id).toBe("SNAP-001");
    expect((await reopened.getProposal(planID(), "PROP-001" as never))?.status).toBe("awaiting_approval");

    // The Approval is durable and still available for retry (2B1 invariant).
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-001" as never);
    if (!approval) throw new Error("approval missing after crash");
    const commit = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-001" as never,
      approvalID: approval.id,
    });
    expect(commit.id).toBe("COMMIT-001");
    reopened.close();
  });

  it("crash after the durable persist yields exactly one committed transaction (§30.C)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const commits = await reopened.listCommits(planID());
    expect(commits).toHaveLength(1); // exactly once
    expect((await reopened.getProposal(planID(), "PROP-001" as never))?.status).toBe("approved");
    expect((await reopened.getHeadSnapshot(planID()))?.commit).toBe(commits[0]?.id);

    // Idempotent retry after restart returns the SAME PlanCommit.
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-001" as never);
    if (!approval) throw new Error("approval missing after crash");
    const retry = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-001" as never,
      approvalID: approval.id,
    });
    expect(retry.id).toBe(commits[0]?.id);
    expect(await reopened.listCommits(planID())).toHaveLength(1);
    reopened.close();
  });

  it("clean probe run (control) commits exactly once", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "none");
    expect(probeResult.status).toBe(0);
    expect(probeResult.output).toContain("PROBE-COMMITTED COMMIT-001");
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED });
    await reopened.open();
    expect(await reopened.listCommits(planID())).toHaveLength(1);
    reopened.close();
  });
});

describe("process-level crash recovery: architecture completion (Phase 2C §31)", () => {
  it("crash before persist leaves stage=architecture, no Architecture, approval retriable (§31)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "architecture-completion");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.findLatestRunBySession("ses_crash");
    // Zero partial transaction: the stage did NOT move and nothing committed.
    expect(run?.stage).toBe("architecture");
    expect(run?.architecture).toBeUndefined();
    expect(await reopened.listCommits(planID())).toHaveLength(0);
    expect(await reopened.getArchitecture(planID())).toBeUndefined();
    expect(await reopened.listDecisions(planID())).toHaveLength(0);
    expect((await reopened.getRun(planID()))?.constraints).toHaveLength(0);
    expect((await reopened.getProposal(planID(), "PROP-001" as never))?.status).toBe("awaiting_approval");

    // The durable Approval survives; the retry commits Architecture + stage
    // transition together.
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-001" as never);
    if (!approval) throw new Error("approval missing after crash");
    const commit = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-001" as never,
      approvalID: approval.id,
    });
    expect(commit.id).toBe("COMMIT-001");
    const recovered = await reopened.getRun(planID());
    expect(recovered?.stage).toBe("detail");
    expect(recovered?.architecture).toEqual({ id: "ARCH", revision: 1 });
    expect((await reopened.getArchitecture(planID()))?.status).toBe("approved");
    reopened.close();
  });

  it("crash after persist recovers DIRECTLY in detail with the exact Architecture (§31)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "architecture-completion");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    // No ambiguous recovery: the completion commit and the stage transition
    // are one durable fact.
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("detail");
    expect(run?.architecture).toEqual({ id: "ARCH", revision: 1 });
    const architecture = await reopened.getArchitecture(planID());
    expect(architecture?.status).toBe("approved");
    expect(architecture?.components.map((c) => c.name)).toEqual(["Core"]);
    expect(run?.constraints.map((c) => c.id)).toEqual(["CON-001"]);
    const commits = await reopened.listCommits(planID());
    expect(commits).toHaveLength(1);
    expect((await reopened.getProposal(planID(), "PROP-001" as never))?.status).toBe("approved");
    // The stage event is durable in the SAME publication as the commit.
    const eventTypes = (await reopened.listEvents(planID())).map((e) => e.detail.type);
    const stageIndex = eventTypes.indexOf("run.stage_changed");
    const commitIndex = eventTypes.indexOf("transaction.committed");
    expect(stageIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);

    // Idempotent retry after restart returns the SAME PlanCommit.
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-001" as never);
    if (!approval) throw new Error("approval missing after crash");
    const retry = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-001" as never,
      approvalID: approval.id,
    });
    expect(retry.id).toBe(commits[0]?.id);
    expect(await reopened.listCommits(planID())).toHaveLength(1);
    reopened.close();
  });

  it("clean architecture-completion probe (control) ends in detail", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "none", "architecture-completion");
    expect(probeResult.status).toBe(0);
    expect(probeResult.output).toContain("PROBE-COMMITTED COMMIT-001 STAGE=detail");
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED });
    await reopened.open();
    expect((await reopened.getRun(planID()))?.stage).toBe("detail");
    reopened.close();
  });
});

describe("process-level crash recovery: section decomposition (Phase 2D §41)", () => {
  it("crash before persist leaves zero DAG mutation; the durable approval retries (§41 pre)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "section-decomposition");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    // The completion commit survived; the decomposition did NOT partially apply.
    expect(run?.stage).toBe("detail");
    expect(run?.architecture).toEqual({ id: "ARCH", revision: 1 });
    expect(run?.sections).toHaveLength(0);
    expect(run?.activeWork).toBeUndefined();
    expect(await reopened.listSections(planID())).toHaveLength(0);
    expect(await reopened.listCommits(planID())).toHaveLength(1); // completion only
    expect((await reopened.getHeadSnapshot(planID()))?.commit).toBe("COMMIT-001");
    expect((await reopened.getProposal(planID(), "PROP-002" as never))?.status).toBe("awaiting_approval");

    // The decomposition Approval is durable; the retry establishes the whole
    // workspace atomically.
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-002" as never);
    if (!approval) throw new Error("decomposition approval missing after crash");
    const commit = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-002" as never,
      approvalID: approval.id,
    });
    expect(commit.id).toBe("COMMIT-002");
    const recovered = await reopened.getRun(planID());
    expect(recovered?.sections.map((s) => s.id)).toEqual(["SEC-001", "SEC-002"]);
    expect(recovered?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    expect((await reopened.getSection(planID(), "SEC-002" as never))?.dependencies).toEqual(["SEC-001"]);
    reopened.close();
  });

  it("crash after persist recovers exactly one complete DAG transaction (§41 post)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "section-decomposition");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("detail");
    expect(run?.sections.map((s) => s.id)).toEqual(["SEC-001", "SEC-002"]); // canonical order
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    expect(await reopened.listSections(planID())).toHaveLength(2);
    const commits = await reopened.listCommits(planID());
    expect(commits).toHaveLength(2); // completion + decomposition, exactly once
    const decomposition = commits.find((c) => c.id === "COMMIT-002");
    expect(decomposition?.changes.map((c) => c.kind)).toEqual([
      "add_section",
      "add_section",
      "select_initial_section",
    ]);
    // The HEAD snapshot represents the DAG even with no SectionRevisions.
    const snapshot = await reopened.getHeadSnapshot(planID());
    expect(snapshot?.commit).toBe("COMMIT-002");
    expect(snapshot?.state.sectionRoots?.map((r) => r.id)).toEqual(["SEC-001", "SEC-002"]);
    expect(snapshot?.state.sectionRoots?.[1]?.dependencies).toEqual(["SEC-001"]);
    expect(snapshot?.state.sectionRevisions["SEC-001" as never]).toBeUndefined(); // no fake revisions

    // Exact retry returns the existing PlanCommit.
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-002" as never);
    if (!approval) throw new Error("decomposition approval missing after crash");
    const retry = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-002" as never,
      approvalID: approval.id,
    });
    expect(retry.id).toBe("COMMIT-002");
    expect(await reopened.listCommits(planID())).toHaveLength(2);
    reopened.close();
  });

  it("clean section-decomposition probe (control) establishes the full workspace", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "none", "section-decomposition");
    expect(probeResult.status).toBe(0);
    expect(probeResult.output).toContain(
      "PROBE-COMMITTED COMMIT-002 STAGE=detail SECTIONS=2 ACTIVE=SEC-001",
    );
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED });
    await reopened.open();
    expect((await reopened.getRun(planID()))?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    reopened.close();
  });
});

describe("process-level crash recovery: section checkpoint (Phase 2E1 §40)", () => {
  it("crash before persist leaves zero checkpoint mutation; the durable approval retries (§40 pre)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "section-checkpoint");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    // The completion + DAG commits survived; the checkpoint did NOT partially apply.
    expect(run?.stage).toBe("detail");
    expect(run?.sections.map((s) => s.id)).toEqual(["SEC-001", "SEC-002"]);
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-002" });
    const sec2 = await reopened.getSection(planID(), "SEC-002" as never);
    expect(sec2).toMatchObject({ status: "pending", validation: "valid" });
    expect(sec2?.currentRevision).toBeUndefined();
    expect(await reopened.getSectionRevision(planID(), { id: "SEC-002" as never, revision: 1 })).toBeUndefined();
    expect((await reopened.listCommits(planID()))).toHaveLength(2); // completion + DAG only
    expect((await reopened.getHeadSnapshot(planID()))?.commit).toBe("COMMIT-002");
    expect((await reopened.getProposal(planID(), "PROP-003" as never))?.status).toBe("awaiting_approval");

    // The checkpoint Approval is durable; the retry commits the whole
    // checkpoint atomically.
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-003" as never);
    if (!approval) throw new Error("checkpoint approval missing after crash");
    const commit = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-003" as never,
      approvalID: approval.id,
    });
    expect(commit.id).toBe("COMMIT-003");
    expect(commit.changes.map((c) => c.kind)).toEqual(["add_section_revision"]);
    const recoveredRoot = await reopened.getSection(planID(), "SEC-002" as never);
    expect(recoveredRoot).toMatchObject({ status: "active", currentRevision: 1, approvedRevision: 1 });
    reopened.close();
  });

  it("crash after persist recovers exactly one complete checkpoint transaction (§40 post)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "section-checkpoint");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("detail");
    expect(run?.headCommit).toBe("COMMIT-003");
    // Exactly ONE SectionRevision + contract projection; root points at it.
    const revision = await reopened.getSectionRevision(planID(), { id: "SEC-002" as never, revision: 1 });
    expect(revision).toMatchObject({ sectionID: "SEC-002", revision: 1, status: "approved" });
    expect(revision?.projection.contract).toMatchObject({ sectionID: "SEC-002", revision: 1 });
    const root = await reopened.getSection(planID(), "SEC-002" as never);
    expect(root).toMatchObject({ status: "active", currentRevision: 1, approvedRevision: 1, validation: "needs_review" });
    const commits = await reopened.listCommits(planID());
    expect(commits).toHaveLength(3); // completion + DAG + checkpoint, exactly once
    // The snapshot represents the checkpointed root additively.
    const snapshot = await reopened.getHeadSnapshot(planID());
    expect(snapshot?.commit).toBe("COMMIT-003");
    expect(snapshot?.state.sectionRevisions["SEC-002" as never]).toBe(1);
    expect(snapshot?.state.sectionRoots?.find((r) => r.id === "SEC-002")).toMatchObject({
      status: "active",
      currentRevision: 1,
      approvedRevision: 1,
    });
    // Exact retry returns the existing PlanCommit.
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-003" as never);
    if (!approval) throw new Error("checkpoint approval missing after crash");
    const retry = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-003" as never,
      approvalID: approval.id,
    });
    expect(retry.id).toBe("COMMIT-003");
    expect(await reopened.listCommits(planID())).toHaveLength(3);
    reopened.close();
  });

  it("clean section-checkpoint probe (control) commits the exact checkpoint workspace", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "none", "section-checkpoint");
    expect(probeResult.status).toBe(0);
    expect(probeResult.output).toContain(
      "PROBE-COMMITTED COMMIT-003 STAGE=detail SECTIONS=2 ACTIVE=SEC-002 REVISIONS=1",
    );
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED });
    await reopened.open();
    expect((await reopened.getSection(planID(), "SEC-002" as never))?.currentRevision).toBe(1);
    reopened.close();
  });
});

describe("process-level crash recovery: section completion (Phase 2E2 §41)", () => {
  it("ordinary completion: crash before persist leaves the Section active and focus unapplied; the durable approval retries (§41 pre)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "section-completion");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    // SEC-001 completed and SEC-002 checkpointed before the crash; the
    // completion of SEC-002 did NOT partially apply (no approval of focus).
    expect(run?.stage).toBe("detail");
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-002" });
    expect((await reopened.getSection(planID(), "SEC-001" as never))?.status).toBe("approved");
    expect((await reopened.getSection(planID(), "SEC-002" as never))?.status).toBe("active");
    expect(await reopened.listCommits(planID())).toHaveLength(5); // completion+DAG+ckpt+compl+ckpt
    expect((await reopened.getHeadSnapshot(planID()))?.commit).toBe("COMMIT-005");
    expect((await reopened.getProposal(planID(), "PROP-006" as never))?.status).toBe("awaiting_approval");

    // The durable approval retries: completion + next focus publish together.
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-006" as never);
    if (!approval) throw new Error("completion approval missing after crash");
    const commit = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-006" as never,
      approvalID: approval.id,
    });
    expect(commit.id).toBe("COMMIT-006");
    expect(commit.changes.map((c) => c.kind)).toEqual(["complete_section"]);
    const recovered = await reopened.getRun(planID());
    expect(recovered?.stage).toBe("detail");
    expect(recovered?.activeWork).toEqual({ type: "section", id: "SEC-003" });
    expect((await reopened.getSection(planID(), "SEC-002" as never))?.status).toBe("approved");
    reopened.close();
  });

  it("ordinary completion: crash after persist recovers exactly one completion + exact next focus (§41 post)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "section-completion");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("detail");
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-003" }); // exact next focus
    expect((await reopened.getSection(planID(), "SEC-002" as never))?.status).toBe("approved");
    expect(await reopened.listCommits(planID())).toHaveLength(6); // exactly once
    const snapshot = await reopened.getHeadSnapshot(planID());
    expect(snapshot?.commit).toBe("COMMIT-006");
    expect(snapshot?.state.activeWork).toEqual({ type: "section", id: "SEC-003" });
    // Exact retry returns the existing PlanCommit.
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-006" as never);
    if (!approval) throw new Error("completion approval missing after crash");
    const retry = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-006" as never,
      approvalID: approval.id,
    });
    expect(retry.id).toBe("COMMIT-006");
    expect(await reopened.listCommits(planID())).toHaveLength(6);
    reopened.close();
  });

  it("final completion: crash before persist stays in detail with the focus on the last Section (§41 pre)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "section-completion-final");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("detail");
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-003" });
    expect(await reopened.listCommits(planID())).toHaveLength(7);
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-008" as never);
    if (!approval) throw new Error("completion approval missing after crash");
    const commit = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-008" as never,
      approvalID: approval.id,
    });
    expect(commit.id).toBe("COMMIT-008");
    const recovered = await reopened.getRun(planID());
    expect(recovered?.stage).toBe("synthesis");
    expect(recovered?.activeWork).toBeUndefined();
    reopened.close();
  });

  it("final completion: crash after persist recovers the synthesis entry atomically (§41 post)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "section-completion-final");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-COMMITTED");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("synthesis");
    expect(run?.activeWork).toBeUndefined();
    const sections = await reopened.listSections(planID());
    expect(sections.map((s) => s.status)).toEqual(["approved", "approved", "approved"]);
    expect(sections.map((s) => s.validation)).toEqual(["valid", "valid", "valid"]);
    expect(await reopened.listCommits(planID())).toHaveLength(8); // exactly once
    const snapshot = await reopened.getHeadSnapshot(planID());
    expect(snapshot?.commit).toBe("COMMIT-008");
    expect(snapshot?.state.activeWork).toBeUndefined(); // absence is meaningful
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-008" as never);
    if (!approval) throw new Error("completion approval missing after crash");
    const retry = await reopened.commitTransaction({
      planID: planID(),
      proposalID: "PROP-008" as never,
      approvalID: approval.id,
    });
    expect(retry.id).toBe("COMMIT-008");
    reopened.close();
  });

  it("clean section-completion probes (controls) publish the exact progression workspaces", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const ordinary = runProbe(dbFile, "none", "section-completion");
    expect(ordinary.status).toBe(0);
    expect(ordinary.output).toContain(
      "PROBE-COMMITTED COMMIT-006 STAGE=detail SECTIONS=3 ACTIVE=SEC-003 REVISIONS=2",
    );
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED });
    await reopened.open();
    expect((await reopened.getRun(planID()))?.activeWork).toEqual({ type: "section", id: "SEC-003" });
    reopened.close();

    const dbFile2 = path.join(dir, "plan-store-final.json");
    const final = runProbe(dbFile2, "none", "section-completion-final");
    expect(final.status).toBe(0);
    expect(final.output).toContain(
      "PROBE-COMMITTED COMMIT-008 STAGE=synthesis SECTIONS=3 ACTIVE=none REVISIONS=3",
    );
    const reopenedFinal = new DurablePlanStore(dbFile2, { now: () => FIXED });
    await reopenedFinal.open();
    expect((await reopenedFinal.getRun(planID()))?.stage).toBe("synthesis");
    reopenedFinal.close();
  });
});

/**
 * The probe's exact manifest draft — the retry after an after-persist crash
 * must submit the SAME canonical content to prove idempotency.
 */
const PROBE_MANIFEST_DRAFT: SynthesisManifestDraftInput = {
  crossSectionLinks: [
    {
      statement: "SEC-001 provides isec-001-capability consumed by SEC-002",
      sources: [
        { kind: "section" as const, id: "SEC-001", revision: 1 },
        { kind: "section" as const, id: "SEC-002", revision: 1 },
      ],
    },
  ],
  implementationOrder: [
    {
      title: "Deliver the chain",
      description: "One delivery wave over the three approved sections in dependency order.",
      sections: [
        { id: "SEC-001", revision: 1 },
        { id: "SEC-002", revision: 1 },
        { id: "SEC-003", revision: 1 },
      ],
      sources: [{ kind: "architecture" as const }],
    },
  ],
  limitations: [{ statement: "Evidence audit is a later phase.", sources: [{ kind: "architecture" as const }] }],
  unresolvedFindings: [],
};

describe("process-level crash recovery: synthesis derived artifacts (Phase 2F §56)", () => {
  it("input freeze: crash before persist leaves NO SynthesisInput; a retry freezes it (§56 pre)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "synthesis-freeze");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-INPUT");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("synthesis");
    expect(run?.activeWork).toBeUndefined();
    // Zero partial derived-artifact mutation: no input, and NO PlanCommit/HEAD
    // involvement in these writes (the commit chain is unchanged).
    expect(await reopened.listSynthesisInputs(planID())).toHaveLength(0);
    expect(await reopened.listSynthesisManifests(planID())).toHaveLength(0);
    expect(await reopened.listCommits(planID())).toHaveLength(8);
    expect(run?.headCommit).toBe("COMMIT-008");

    // Retry freezes the input through the real controller flow.
    const controller = new UltraPlanController({ store: reopened, now: () => FIXED });
    const { input } = await controller.beginSynthesis("ses_crash");
    expect(input.id).toBe("SYN-IN-001");
    expect(input.baseSnapshot.id).toBe("SNAP-009");
    expect(await reopened.listSynthesisInputs(planID())).toHaveLength(1);
    reopened.close();
  });

  it("input freeze: crash after persist leaves EXACTLY one SynthesisInput; the retry returns the same input (§56 post)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "synthesis-freeze");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-INPUT");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const inputs = await reopened.listSynthesisInputs(planID());
    expect(inputs).toHaveLength(1); // exactly once
    const events = (await reopened.listEvents(planID())).map((e) => e.detail.type);
    expect(events.filter((type) => type === "synthesis.input_frozen")).toHaveLength(1);
    expect(await reopened.listCommits(planID())).toHaveLength(8); // no PlanCommit for the input

    // Idempotent retry returns the SAME input.
    const controller = new UltraPlanController({ store: reopened, now: () => FIXED });
    const retry = await controller.beginSynthesis("ses_crash");
    expect(retry.input.id).toBe(inputs[0]?.id);
    expect(retry.input.hash).toBe(inputs[0]?.hash);
    expect(await reopened.listSynthesisInputs(planID())).toHaveLength(1);
    reopened.close();
  });

  it("manifest save: crash before persist leaves the input intact with NO manifest revision (§56 pre)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "synthesis-manifest");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-MANIFEST");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    // The input freeze SURVIVED (its own complete publication); the manifest
    // did NOT partially apply.
    expect(await reopened.listSynthesisInputs(planID())).toHaveLength(1);
    expect(await reopened.listSynthesisManifests(planID())).toHaveLength(0);
    expect(await reopened.listCommits(planID())).toHaveLength(8);

    // Retry saves the manifest through the real controller flow.
    const controller = new UltraPlanController({ store: reopened, now: () => FIXED });
    const { manifest } = await controller.submitSynthesisManifest("ses_crash", PROBE_MANIFEST_DRAFT);
    expect(manifest.id).toBe("SYN-001");
    expect(manifest.revision).toBe(1);
    expect(await reopened.listSynthesisManifests(planID())).toHaveLength(1);
    reopened.close();
  });

  it("manifest save: crash after persist leaves EXACTLY one manifest revision; the retry is idempotent (§56 post)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "synthesis-manifest");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-MANIFEST");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const manifests = await reopened.listSynthesisManifests(planID());
    expect(manifests).toHaveLength(1); // exactly once
    expect(manifests[0]).toMatchObject({ id: "SYN-001", revision: 1 });
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("synthesis");
    expect(run?.headCommit).toBe("COMMIT-008"); // HEAD never moved for the manifest

    // Exact resubmission of the same content is idempotent.
    const controller = new UltraPlanController({ store: reopened, now: () => FIXED });
    const retry = await controller.submitSynthesisManifest("ses_crash", PROBE_MANIFEST_DRAFT);
    expect(retry.manifest.revision).toBe(1);
    expect(retry.manifest.hash).toBe(manifests[0]?.hash);
    expect(retry.idempotent).toBe(true);
    expect(await reopened.listSynthesisManifests(planID())).toHaveLength(1);
    reopened.close();
  });

  it("clean synthesis probes (controls) publish the exact derived-artifact workspaces", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const freeze = runProbe(dbFile, "none", "synthesis-freeze");
    expect(freeze.status).toBe(0);
    expect(freeze.output).toContain("PROBE-INPUT SYN-IN-001 BASE=SNAP-009 STAGE=synthesis HEAD=COMMIT-008");
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED });
    await reopened.open();
    expect(await reopened.listSynthesisInputs(planID())).toHaveLength(1);
    reopened.close();

    const dbFile2 = path.join(dir, "plan-store-manifest.json");
    const manifestProbe = runProbe(dbFile2, "none", "synthesis-manifest");
    expect(manifestProbe.status).toBe(0);
    expect(manifestProbe.output).toContain("PROBE-MANIFEST SYN-001@1 INPUT=SYN-IN-001 STAGE=synthesis HEAD=COMMIT-008");
    const reopened2 = new DurablePlanStore(dbFile2, { now: () => FIXED });
    await reopened2.open();
    expect(await reopened2.listSynthesisManifests(planID())).toHaveLength(1);
    reopened2.close();
  });
});

// -----------------------------------------------------------------------------
// Phase 2G — semantic validation & reopen admission (§62/§63)
// -----------------------------------------------------------------------------

/** Deterministic TEST-ONLY fake validator matching the probe's output exactly. */
const FAKE_VALIDATOR = {
  async validate() {
    return {
      text: JSON.stringify({
        result: "findings",
        findings: [
          {
            category: "contradiction",
            statement: "The manifest claims SEC-002 allows in-place mutation, contradicting its approved invariants.",
            scope: { sections: [{ id: "SEC-002", revision: 1 }] },
            sources: [{ kind: "section", id: "SEC-002", revision: 1 }],
          },
        ],
      }),
    };
  },
};

describe("process-level crash recovery: semantic validation & reopen (Phase 2G §62/§63)", () => {
  it("validation: crash on the ADMISSION write leaves a reclaimable admission, NO report; a new process retries (§62 pre + §32)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "semantic-validation");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-VALIDATION");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    // No report exists — the execution died before the validator even ran.
    expect(await reopened.listValidationReports(planID())).toHaveLength(0);
    const inputs = await reopened.listSynthesisInputs(planID());
    const manifests = await reopened.listSynthesisManifests(planID());
    expect(inputs).toHaveLength(1);
    expect(manifests).toHaveLength(1);
    expect(await reopened.listCommits(planID())).toHaveLength(8); // no PlanCommit involvement
    // A different pid reclaims the dead process's admission and publishes
    // exactly one report — never a wedge, never a clean result (§32).
    const controller = new UltraPlanController({
      store: reopened,
      now: () => FIXED,
      semanticValidator: FAKE_VALIDATOR,
    });
    const { report, idempotent } = await controller.runSemanticValidation("ses_crash");
    expect(idempotent).toBe(false);
    expect(report.id).toBe("VAL-001");
    expect(report.result).toBe("findings");
    expect(await reopened.listValidationReports(planID())).toHaveLength(1);
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("synthesis");
    expect(run?.headCommit).toBe("COMMIT-008");
    reopened.close();
  });

  it("validation: crash after the report persist leaves EXACTLY one report; retry returns the SAME report (§62 post)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "semantic-validation");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-VALIDATION");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const reports = await reopened.listValidationReports(planID());
    expect(reports).toHaveLength(1); // exactly once
    expect(reports[0]?.result).toBe("findings");
    const events = (await reopened.listEvents(planID())).map((e) => e.detail.type);
    expect(events.filter((type) => type === "validation.report_saved")).toHaveLength(1);
    expect(await reopened.listCommits(planID())).toHaveLength(8);
    expect(reports[0]?.manifest).toEqual({ id: "SYN-001", revision: 1 });

    // Retry returns the SAME report — the anti-laundering identity lookup,
    // NOT a second validator execution.
    const controller = new UltraPlanController({
      store: reopened,
      now: () => FIXED,
      semanticValidator: FAKE_VALIDATOR,
    });
    const retry = await controller.runSemanticValidation("ses_crash");
    expect(retry.idempotent).toBe(true);
    expect(retry.report).toEqual(reports[0]);
    expect(await reopened.listValidationReports(planID())).toHaveLength(1);
    reopened.close();
  });

  it("reopen: crash before the PlanCommit publication leaves the Section approved with a durable Approval; retry commits once (§63 pre)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "reopen");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-REOPEN");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("synthesis");
    expect(run?.activeWork).toBeUndefined();
    expect(run?.headCommit).toBe("COMMIT-008");
    const sec002 = await reopened.getSection(planID(), "SEC-002" as never);
    expect(sec002?.status).toBe("approved");
    // The user approval IS durable (§63 pre: "Approval durable").
    const proposal = await reopened.getProposal(planID(), "PROP-009" as never);
    expect(proposal?.type).toBe("amendment");
    const approval = await reopened.findApprovalForProposal(planID(), "PROP-009" as never);
    expect(approval).toBeDefined();
    // Exactly one findings report, unchanged by the crash.
    expect(await reopened.listValidationReports(planID())).toHaveLength(1);

    // Retry commits NORMALLY (§63: "Retry commits normally").
    const controller = new UltraPlanController({ store: reopened, now: () => FIXED });
    const result = await controller.commitApprovedProposal("ses_crash", "PROP-009" as never);
    expect(result.run?.stage).toBe("detail");
    expect(result.run?.activeWork).toEqual({ type: "section", id: "SEC-002" });
    const reopenedSection = await reopened.getSection(planID(), "SEC-002" as never);
    expect(reopenedSection?.status).toBe("reopened");
    expect(reopenedSection?.validation).toBe("needs_review");
    expect((await reopened.listCommits(planID())).length).toBe(9); // exactly one reopen commit
    reopened.close();
  });

  it("reopen: crash after the PlanCommit publication recovers the reopened workspace; retry is idempotent (§63 post)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "reopen");
    expect(probeResult.status).toBe(134);
    expect(probeResult.output).not.toContain("PROBE-REOPEN");

    const reopened = new DurablePlanStore(dbFile, {
      now: () => FIXED,
      staleLockMs: 200,
      lockTimeoutMs: 2_000,
    });
    await reopened.open();
    const run = await reopened.getRun(planID());
    // §63 post: Section reopened exactly once, stage = detail, activeWork =
    // target, one Snapshot, one PlanCommit, HEAD exact.
    expect(run?.stage).toBe("detail");
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-002" });
    expect(run?.headCommit).toBe("COMMIT-009");
    const sec002 = await reopened.getSection(planID(), "SEC-002" as never);
    expect(sec002?.status).toBe("reopened");
    expect(sec002?.validation).toBe("needs_review");
    expect(sec002?.currentRevision).toBe(1);
    expect(sec002?.approvedRevision).toBe(1);
    expect((await reopened.listCommits(planID())).length).toBe(9);
    const head = await reopened.getHeadSnapshot(planID());
    expect(head?.id).toBe("SNAP-010");

    // Retry is idempotent: the exact retry returns the existing PlanCommit.
    const controller = new UltraPlanController({ store: reopened, now: () => FIXED });
    const retry = await controller.commitApprovedProposal("ses_crash", "PROP-009" as never);
    expect(retry.commit.id).toBe("COMMIT-009");
    expect((await reopened.listCommits(planID())).length).toBe(9);
    reopened.close();
  });

  it("clean semantic-validation + reopen probes (controls) publish the exact 2G workspaces", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const validation = runProbe(dbFile, "none", "semantic-validation");
    expect(validation.status).toBe(0);
    expect(validation.output).toContain(
      "PROBE-VALIDATION VAL-001 RESULT=findings FINDINGS=1 MANIFEST=SYN-001@1 STAGE=synthesis HEAD=COMMIT-008",
    );
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED });
    await reopened.open();
    expect(await reopened.listValidationReports(planID())).toHaveLength(1);
    reopened.close();

    const dbFile2 = path.join(dir, "plan-store-reopen.json");
    const reopen = runProbe(dbFile2, "none", "reopen");
    expect(reopen.status).toBe(0);
    expect(reopen.output).toContain(
      "PROBE-REOPEN SEC-002 STATUS=reopened VALIDATION=needs_review STAGE=detail ACTIVE=SEC-002 HEAD=COMMIT-009",
    );
    const reopened2 = new DurablePlanStore(dbFile2, { now: () => FIXED });
    await reopened2.open();
    expect((await reopened2.getSection(planID(), "SEC-002" as never))?.status).toBe("reopened");
    reopened2.close();
  });
}); 

// -----------------------------------------------------------------------------
// Phase 2H — evidence audit & finalization candidate (§72)
// -----------------------------------------------------------------------------

/** Deterministic TEST-ONLY clean validator matching the probe's finalization mode. */
const CLEAN_PROBE_VALIDATOR = {
  async validate() {
    return { text: JSON.stringify({ result: "clean", findings: [] }) };
  },
};

describe("process-level crash recovery: evidence audit & finalization candidate (Phase 2H §72)", () => {
  it("finalization: crash on the AUDIT publication leaves no audit, no candidate, no HEAD movement; a new process retries (§72 pre)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "finalization");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-FINALIZATION");

    // Zero partial state: the audit publication died before the rename.
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED, staleLockMs: 200 });
    await reopened.open();
    expect(await reopened.listEvidenceAudits(planID())).toHaveLength(0);
    expect(await reopened.listFinalPlanCandidates(planID())).toHaveLength(0);
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("synthesis");
    expect(run?.headCommit).toBe("COMMIT-008"); // HEAD never moved
    // A retry through a NEW process-scoped controller completes the vertical:
    // the report survived, the audit rebuilds, the candidate freezes.
    const controller = new UltraPlanController({
      store: reopened,
      now: () => FIXED,
      semanticValidator: CLEAN_PROBE_VALIDATOR,
    });
    const retry = await controller.requestFinalization("ses_crash");
    expect(retry.gate.result).toBe("pass");
    expect(retry.candidate!.candidate.id).toBe("FPC-001");
    expect(retry.candidate!.candidate.revision).toBe(1);
    expect(await reopened.listEvidenceAudits(planID())).toHaveLength(1);
    expect(await reopened.listFinalPlanCandidates(planID())).toHaveLength(1);
    reopened.close();
  });

  it("finalization: crash after the candidate persist recovers exactly one audit + one candidate; retry is idempotent (§72 post)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "finalization");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-FINALIZATION");

    // The atomic rename happened for BOTH derived artifacts before the abort.
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED, staleLockMs: 200 });
    await reopened.open();
    const audits = await reopened.listEvidenceAudits(planID());
    const candidates = await reopened.listFinalPlanCandidates(planID());
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ id: "AUD-001", result: "pass" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: "FPC-001", revision: 1 });
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("synthesis"); // §76: never entered final
    expect(run?.headCommit).toBe("COMMIT-008"); // HEAD never moved
    expect(run?.finalPlan).toBeUndefined(); // §40

    // The retry through a NEW controller returns the SAME candidate — no
    // duplicate revisions (§17/§38).
    const controller = new UltraPlanController({
      store: reopened,
      now: () => FIXED,
      semanticValidator: CLEAN_PROBE_VALIDATOR,
    });
    const retry = await controller.requestFinalization("ses_crash");
    expect(retry.gate.result).toBe("pass");
    expect(retry.candidate!.idempotent).toBe(true);
    expect(retry.candidate!.candidate.id).toBe("FPC-001");
    expect(retry.candidate!.candidate.revision).toBe(1);
    expect(retry.candidate!.candidate.hash).toBe(candidates[0]?.hash);
    expect(await reopened.listFinalPlanCandidates(planID())).toHaveLength(1);
    expect(await reopened.listEvidenceAudits(planID())).toHaveLength(1);
    reopened.close();
  });
});

describe("process-level crash recovery: Final Proposal & Final PlanCommit (Phase 2I §67/§68)", () => {
  it("§67 pre-persist: crash before the final commit publish leaves zero Final Plan state; the gate-current retry commits", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "before-persist", "final-plan");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-FINAL-PLAN");

    // §67: FinalPlan absent, stage synthesis, lifecycle active, Proposal
    // awaiting_approval, Approval durable, HEAD unchanged.
    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED, staleLockMs: 200 });
    reopened.open();
    expect(await reopened.listFinalPlans(planID())).toHaveLength(0);
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("synthesis");
    expect(run?.lifecycle).toBe("active");
    expect(run?.headCommit).toBe("COMMIT-008");
    expect(run?.finalPlan).toBeUndefined();
    const proposals = await reopened.listProposals(planID());
    const finalProposal = proposals.find((proposal) => proposal.type === "final_plan");
    expect(finalProposal?.status).toBe("awaiting_approval");
    const approval = await reopened.findApprovalForProposal(planID(), finalProposal!.id);
    expect(approval).toBeDefined();
    reopened.close();

    // §67: the exact retry through a NEW process-scoped controller commits —
    // the gate remains current, so the persisted Approval is still valid.
    const store2 = new DurablePlanStore(dbFile, { now: () => FIXED, staleLockMs: 200 });
    store2.open();
    const controller = new UltraPlanController({
      store: store2,
      now: () => FIXED,
      semanticValidator: CLEAN_PROBE_VALIDATOR,
    });
    const retry = await controller.commitApprovedProposal("ses_crash", String(finalProposal!.id));
    const run2 = await store2.getRun(planID());
    expect(run2?.stage).toBe("final");
    expect(run2?.lifecycle).toBe("handoff_pending");
    expect(run2?.finalPlan).toEqual({ id: "FINAL-001", revision: 1 });
    const plans = await store2.listFinalPlans(planID());
    expect(plans).toHaveLength(1);
    expect(retry.commit.changes[0]?.kind).toBe("add_final_plan");
    expect(retry.commit.approvalID).toBe(approval!.id);
    store2.close();
  });

  it("§68 post-persist: crash after the final commit publish recovers the exact handoff_pending state; retry idempotent, no Build handoff", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const probeResult = runProbe(dbFile, "after-persist", "final-plan");
    expect(probeResult.status).toBe(134);
    expect(probeResult.signal).toBeNull();
    expect(probeResult.output).not.toContain("PROBE-FINAL-PLAN");

    const reopened = new DurablePlanStore(dbFile, { now: () => FIXED, staleLockMs: 200 });
    reopened.open();
    // §68: exactly one FinalPlan, run pointer exact, stage final, lifecycle
    // handoff_pending, Proposal approved, HEAD the exact final commit.
    const plans = await reopened.listFinalPlans(planID());
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: "FINAL-001", revision: 1, status: "approved" });
    const run = await reopened.getRun(planID());
    expect(run?.stage).toBe("final");
    expect(run?.lifecycle).toBe("handoff_pending");
    expect(run?.finalPlan).toEqual({ id: "FINAL-001", revision: 1 });
    expect(run?.headCommit).toBe("COMMIT-009");
    const proposals = await reopened.listProposals(planID());
    const finalProposal = proposals.find((proposal) => proposal.type === "final_plan");
    expect(finalProposal?.status).toBe("approved");
    // §38/§80: handoff_pending is NOT Build — no completion, no handoff.
    expect(run?.lifecycle).not.toBe("completed");
    reopened.close();

    // The retry through a NEW controller is idempotent (§59).
    const store2 = new DurablePlanStore(dbFile, { now: () => FIXED, staleLockMs: 200 });
    store2.open();
    const controller = new UltraPlanController({
      store: store2,
      now: () => FIXED,
      semanticValidator: CLEAN_PROBE_VALIDATOR,
    });
    const retry = await controller.commitApprovedProposal("ses_crash", String(finalProposal!.id));
    expect(retry.commit.id).toBe("COMMIT-009");
    expect(await store2.listFinalPlans(planID())).toHaveLength(1);
    store2.close();
  });
});

describe("process-level crash recovery: ExecutionHandoff windows (Phase 2J §89-§95)", () => {
  function runHandoffProbe(dbFile: string, crashPoint: string, fakeHostFile: string): ProbeResult {
    const result = spawnSync(process.execPath, [probe, dbFile, crashPoint, "handoff"], {
      env: { ...process.env, CRASH_PROBE_ENTRY: distEntry, FAKE_HOST_FILE: fakeHostFile },
      encoding: "utf8",
      timeout: 60_000,
    });
    return {
      status: result.status ?? -1,
      signal: result.signal ?? null,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }

  /** Probe #1 crashes on the window; probe #2 recovers. Exactly ONE dispatch. */
  async function expectWindowRecoversWithSingleDispatch(crashPoint: string): Promise<void> {
    const dbFile = path.join(dir, "plan-store.json");
    const fakeHostFile = path.join(dir, "fake-host.json");
    const crash = runHandoffProbe(dbFile, crashPoint, fakeHostFile);
    expect(crash.status).toBe(134);
    expect(crash.output).not.toContain("PROBE-HANDOFF");

    const recovery = runHandoffProbe(dbFile, "recover", fakeHostFile);
    expect(recovery.status).toBe(0);
    expect(recovery.output).toContain("STATUS=completed");
    expect(recovery.output).toContain("LIFECYCLE=completed");
    expect(recovery.output).toContain("DISPATCHES=1");
    // §130: the host received EXACTLY one Build handoff.
    const hostState = JSON.parse(await readFile(fakeHostFile, "utf8")) as { deliveries: Record<string, unknown> };
    expect(Object.keys(hostState.deliveries)).toHaveLength(1);
  }

  it("window A (§89): crash before any handoff artifact — recovery freezes and delivers once", async () => {
    await expectWindowRecoversWithSingleDispatch("before-prepared");
  });

  it("window B (§90): crash after prepared, before host dispatch — recovery dispatches once", async () => {
    await expectWindowRecoversWithSingleDispatch("after-prepared");
  });

  it("window C (§91): crash after the dispatch admission, before the host call — lease reclaimed, dispatched once", async () => {
    await expectWindowRecoversWithSingleDispatch("after-admission");
  });

  it("window D (§92/§130/§137): host accepted before the delivered persist — recovery queries the host and does NOT resend", async () => {
    await expectWindowRecoversWithSingleDispatch("after-host-accept");
  });

  it("window E (§93/§133): delivered persisted before lifecycle completion — recovery completes without resend", async () => {
    await expectWindowRecoversWithSingleDispatch("after-delivered");
  });

  it("window F (§94/§134): after completion, restart recovery does NOTHING (no redispatch)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const fakeHostFile = path.join(dir, "fake-host.json");
    const full = runHandoffProbe(dbFile, "none", fakeHostFile);
    expect(full.status).toBe(0);
    expect(full.output).toContain("PROBE-HANDOFF-FULL LIFECYCLE=completed DISPATCHES=1");

    const recovery = runHandoffProbe(dbFile, "recover", fakeHostFile);
    expect(recovery.status).toBe(0);
    expect(recovery.output).toContain("STATUS=already_completed");
    expect(recovery.output).toContain("DISPATCHES=1");
    const hostState = JSON.parse(await readFile(fakeHostFile, "utf8")) as { deliveries: Record<string, unknown> };
    expect(Object.keys(hostState.deliveries)).toHaveLength(1);
  });
});
