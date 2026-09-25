import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";

import { createProposalService } from "../src/application/proposal-service.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";
import { DECISION_1 } from "./proposal-helpers.js";

const WORKER_SOURCE = fileURLToPath(new URL("./workers/planning-worker.ts", import.meta.url));

interface WorkerResult {
  ok: boolean;
  idempotent?: boolean;
  proposalId?: string;
  approvalId?: string;
  commitId?: string;
  snapshotId?: string;
  sequence?: number;
  revision?: number;
  hash?: string;
  code?: string;
  message?: string;
}

async function bundleWorker(bundledDir: string): Promise<string> {
  const outfile = path.join(bundledDir, "planning-worker.mjs");
  await esbuild.build({
    entryPoints: [WORKER_SOURCE],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  return outfile;
}

function runWorker(workerPath: string, args: string[]): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`planning worker timed out; stderr: ${stderr}`));
    }, 30000);
    child.on("exit", () => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) {
        reject(new Error(`planning worker produced no JSON; stderr: ${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as WorkerResult);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface RaceTarget {
  root: string;
  workspaceId: string;
  runId: string;
  generation: number;
  runRevision: number;
}

async function prepareRaceTarget(): Promise<RaceTarget> {
  const root = makeTempPluginDataRoot();
  const store = await initializePlanStore({ pluginDataRoot: root });
  try {
    const projectDir = path.join(root, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const { registration } = await discoverAndRegisterWorkspace(store, projectDir, fixedClock({ ids: ["r0", "w0"] }));
    const runs = createPlanningRunService(store, fixedClock({ ids: ["id0"] }));
    const { run, binding } = runs.createPlanningRun({
      workspaceId: registration.workspace.workspaceId,
      sessionId: "S1",
      goal: "race target",
    });
    const transitioned = runs.transitionRun({
      runId: run.runId,
      workspaceId: registration.workspace.workspaceId,
      sessionId: "S1",
      bindingGeneration: binding.generation,
      expectedRevision: run.revision,
      event: "DISCOVERY_COMPLETE",
    });
    return {
      root,
      workspaceId: registration.workspace.workspaceId,
      runId: run.runId,
      generation: binding.generation,
      runRevision: transitioned.revision,
    };
  } finally {
    store.close();
  }
}

describe("real multi-process proposal concurrency (§64/§65/§95/E38/E39)", () => {
  it("concurrent prepare from two processes: one awaiting proposal, loser PROPOSAL_ALREADY_AWAITING", async () => {
    const target = await prepareRaceTarget();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-prop-"));
    try {
      const worker = await bundleWorker(bundledDir);
      const args = ["prepare", target.root, target.runId, target.workspaceId, "S1", String(target.generation), String(target.runRevision)];
      const [a, b] = await Promise.all([
        runWorker(worker, [...args, "PREP-A", "10000"]),
        runWorker(worker, [...args, "PREP-B", "10000"]),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.code).toBe("PROPOSAL_ALREADY_AWAITING");

      const store = await initializePlanStore({ pluginDataRoot: target.root });
      try {
        const awaiting = store.withRead((tx) =>
          tx.prepare("SELECT count(*) AS n FROM proposal_states WHERE status = 'awaiting_approval'").get(),
        ) as { n: number };
        expect(awaiting.n).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(target.root);
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });

  it("concurrent different-request approvals of one proposal: exactly one commit (§64/E38)", async () => {
    const target = await prepareRaceTarget();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-prop-"));
    try {
      // Prepare the proposal in-process first.
      const store = await initializePlanStore({ pluginDataRoot: target.root });
      let authorization: { proposalId: string; revision: number; hash: string };
      try {
        const proposals = createProposalService(store, fixedClock({ ids: ["prep"] }));
        const { proposal } = proposals.prepareProposal({
          runId: target.runId,
          workspaceId: target.workspaceId,
          sessionId: "S1",
          bindingGeneration: target.generation,
          expectedRunRevision: target.runRevision,
          type: "design_checkpoint",
          scope: { kind: "architecture" },
          title: "raced approval",
          summary: "one checkpoint",
          changes: [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "DEC-1" }],
        });
        authorization = { proposalId: proposal.proposalId, revision: proposal.revision, hash: proposal.proposalHash };
      } finally {
        store.close();
      }

      const worker = await bundleWorker(bundledDir);
      const base = [
        "approve",
        target.root,
        target.runId,
        target.workspaceId,
        "S1",
        String(target.generation),
      ];
      const [a, b] = await Promise.all([
        runWorker(worker, [...base, "AUTH-X1", authorization.proposalId, String(authorization.revision), authorization.hash, "10000"]),
        runWorker(worker, [...base, "AUTH-X2", authorization.proposalId, String(authorization.revision), authorization.hash, "10000"]),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.code).toBe("PROPOSAL_ALREADY_COMMITTED");

      const reopened = await initializePlanStore({ pluginDataRoot: target.root });
      try {
        const approvals = reopened.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM approvals").get()) as { n: number };
        const commits = reopened.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM plan_commits").get()) as { n: number };
        const snapshots = reopened.withRead((tx) =>
          tx.prepare("SELECT count(*) AS n FROM plan_snapshots WHERE snapshot_id = (SELECT resulting_snapshot_id FROM plan_commits)").get(),
        ) as { n: number };
        expect(approvals.n).toBe(1);
        expect(commits.n).toBe(1);
        expect(snapshots.n).toBe(1);
        const head = reopened.withRead((tx) =>
          tx.prepare("SELECT head_commit_id AS commitId FROM plan_heads WHERE run_id = ?").get(target.runId),
        ) as { commitId: string };
        expect(head.commitId).toBe(winners[0]?.commitId);
      } finally {
        reopened.close();
      }
    } finally {
      removeTempPluginDataRoot(target.root);
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });

  it("same authorizationRequestId from two processes: both succeed with the SAME commit, one set of records (§65/E39)", async () => {
    const target = await prepareRaceTarget();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-prop-"));
    try {
      const store = await initializePlanStore({ pluginDataRoot: target.root });
      let authorization: { proposalId: string; revision: number; hash: string };
      try {
        const proposals = createProposalService(store, fixedClock({ ids: ["prep"] }));
        const { proposal } = proposals.prepareProposal({
          runId: target.runId,
          workspaceId: target.workspaceId,
          sessionId: "S1",
          bindingGeneration: target.generation,
          expectedRunRevision: target.runRevision,
          type: "design_checkpoint",
          scope: { kind: "architecture" },
          title: "raced retry",
          summary: "same request",
          changes: [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "DEC-1" }],
        });
        authorization = { proposalId: proposal.proposalId, revision: proposal.revision, hash: proposal.proposalHash };
      } finally {
        store.close();
      }

      const worker = await bundleWorker(bundledDir);
      const base = [
        "approve",
        target.root,
        target.runId,
        target.workspaceId,
        "S1",
        String(target.generation),
        "AUTH-SHARED",
        authorization.proposalId,
        String(authorization.revision),
        authorization.hash,
      ];
      const [a, b] = await Promise.all([
        runWorker(worker, [...base, "10000"]),
        runWorker(worker, [...base, "10000"]),
      ]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      const idempotentFlags = [a, b].map((r) => r.idempotent).sort();
      expect(idempotentFlags).toEqual([false, true]);
      expect(a.commitId).toBe(b.commitId);
      expect(a.approvalId).toBe(b.approvalId);
      expect(a.snapshotId).toBe(b.snapshotId);

      const reopened = await initializePlanStore({ pluginDataRoot: target.root });
      try {
        const approvals = reopened.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM approvals").get()) as { n: number };
        const commits = reopened.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM plan_commits").get()) as { n: number };
        expect(approvals.n).toBe(1);
        expect(commits.n).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      removeTempPluginDataRoot(target.root);
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });
});
