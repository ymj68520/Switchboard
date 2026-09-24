#!/usr/bin/env node
/**
 * Phase 2B2 §30 — crash-probe child process.
 *
 * Runs inside a REAL separate process (spawned by durable-crash.test.ts):
 * opens a durable store, drives a proposal to awaiting_approval with a
 * recorded Approval, then either commits normally or terminates ABRUPTLY at
 * the requested crash point:
 *
 *   before-persist  — abort BEFORE the durable write (state file untouched)
 *   after-persist   — abort AFTER the atomic rename but before the caller
 *                     could observe success
 *
 * Usage:
 *   node scripts/crash-probe.mjs <dbFile> <crashPoint: before-persist|after-persist|none>
 *
 * Exits 0 on clean commit; dies via process.abort() at the crash point.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

const [dbFile, crashPointRaw] = process.argv.slice(2);
const crashPoint = crashPointRaw ?? "none";

if (!dbFile) {
  console.error("usage: crash-probe.mjs <dbFile> [before-persist|after-persist|none]");
  process.exit(2);
}

// Windows: absolute ESM import paths must be file:// URLs.
const entryURL = process.env.CRASH_PROBE_ENTRY
  ? pathToFileURL(process.env.CRASH_PROBE_ENTRY).href
  : new URL("../adapters/opencode/dist/index.js", import.meta.url).href;
const ultra = await import(entryURL);
const { DurablePlanStore, InMemoryObservationLedger, UltraPlanController } = ultra;

const FIXED = "2026-09-24T21:00:00.000Z";
const store = new DurablePlanStore(dbFile, { now: () => FIXED });
const controller = new UltraPlanController({
  store,
  ledger: new InMemoryObservationLedger(),
  now: () => FIXED,
});

controller.issueStartAdmission("ses_crash");
let run = (await controller.startOrResume("ses_crash")).run;
run = transition(run, "architecture");
run = await store.saveRun(run);
run = transition(run, "detail");
run = await store.saveRun(run);

const prepared = await controller.prepareProposal("ses_crash", {
  type: "design_checkpoint",
  scope: { type: "architecture" },
  title: "Crash probe proposal",
  summary: "s",
  changes: [
    { kind: "add_decision", content: { decision: { title: "Crash decision", statement: "s", rationale: "r" } } },
  ],
});
const begun = await controller.beginProposalApproval("ses_crash", prepared.proposal.id);
const { approval } = await controller.recordApproval("ses_crash", prepared.proposal.id, begun.request);

if (crashPoint === "before-persist") {
  // Arm the seam, then commit: die at the durable write.
  store.armCrashSeam("before-persist");
}

const commit = await store.commitTransaction({
  planID: prepared.proposal.createdFrom && run.id ? run.id : run.id,
  proposalID: prepared.proposal.id,
  approvalID: approval.id,
});

if (crashPoint === "after-persist") {
  // The durable rename happened; the caller never saw the result. Die HERE.
  store.armCrashSeam("after-persist");
  process.abort();
}

console.log(`PROBE-COMMITTED ${commit.id}`);
process.exit(0);

function transition(current, stage) {
  // Transition through the real state machine (state transitions are
  // validated and persisted by the caller between stages).
  const { transitionStage } = ultra;
  return transitionStage(current, stage);
}
