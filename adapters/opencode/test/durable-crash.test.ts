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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DurablePlanStore, PlanIDs } from "../src/index.js";

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

function runProbe(dbFile: string, crashPoint: string): ProbeResult {
  const result = spawnSync(process.execPath, [probe, dbFile, crashPoint], {
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
