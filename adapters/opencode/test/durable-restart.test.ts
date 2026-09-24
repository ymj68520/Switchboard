/**
 * Durable store restart, corruption, and concurrency tests — Phase 2B2
 * brief §29/§31/§36/§37/§38.
 *
 * Every "restart" is a REAL close/reopen cycle: the store instance is closed
 * and a brand-new DurablePlanStore is constructed over the same file.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalIDs,
  DurablePlanStore,
  EvidenceIDs,
  InMemoryObservationLedger,
  InMemoryStartAdmissionLedger,
  isUltraPlanError,
  PlanIDs,
  STORE_SCHEMA_VERSION,
  UltraPlanController,
  transitionStage,
  type Evidence,
  type EvidenceID,
  type PlanningRun,
  type PrepareProposalInput,
} from "../src/index.js";
import { readFileSync } from "node:fs";
import type { StoreDocument } from "../src/index.js";

const FIXED = "2026-09-24T20:00:00.000Z";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ultraplan-durable-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function storeFor(): DurablePlanStore {
  return new DurablePlanStore(path.join(dir, "plan-store.json"), { now: () => FIXED });
}

function controllerFor(store: DurablePlanStore): UltraPlanController {
  return new UltraPlanController({
    store,
    ledger: new InMemoryObservationLedger(),
    now: () => FIXED,
  });
}

const DECISION_DRAFT = {
  kind: "add_decision" as const,
  content: {
    decision: { title: "Canonical state", statement: "Plugin storage is canonical", rationale: "r" },
  },
};

function prepareInput(title: string, changes: PreparedInputChanges): PrepareProposalInput {
  return {
    type: "design_checkpoint",
    scope: { type: "architecture" },
    title,
    summary: "s",
    changes,
  };
}

type PreparedInputChanges = PrepareProposalInput["changes"];

/** Start a run AND persist its advance into the detail stage. */
async function startedRun(controller: UltraPlanController, store: DurablePlanStore): Promise<PlanningRun> {
  controller.issueStartAdmission("ses_d");
  let run = (await controller.startOrResume("ses_d")).run;
  run = transitionStage(run, "architecture");
  run = await store.saveRun(run);
  run = transitionStage(run, "detail");
  run = await store.saveRun(run);
  return run;
}

async function prepareAwaiting(controller: UltraPlanController, changes: PreparedInputChanges = [DECISION_DRAFT]) {
  const prepared = await controller.prepareProposal("ses_d", prepareInput("Restart proposal", changes));
  const begun = await controller.beginProposalApproval("ses_d", prepared.proposal.id);
  const { approval } = await controller.recordApproval("ses_d", prepared.proposal.id, begun.request);
  return { prepared, approval };
}

function evidenceFixture(id: EvidenceID): Evidence {
  return {
    id,
    revision: 1,
    kind: "file",
    claim: `Claim ${id}`,
    source: [{ type: "file", path: "src/x.ts" }],
    scope: { kind: "run" },
    confidence: "direct",
    criticality: "supporting",
    freshness: "fresh",
    status: "active",
    discoveredAt: FIXED,
    lastValidatedAt: FIXED,
  };
}

import { DecisionIDs } from "../src/core/ids.js";

describe("schema + version gate (§11/§38)", () => {
  it("creates a fresh store with the current schema version and reopens it", async () => {
    const store = storeFor();
    await store.open();
    const doc = JSON.parse(readFileSync(path.join(dir, "plan-store.json"), "utf8"));
    expect(doc.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    store.close();
    const reopened = storeFor();
    await reopened.open(); // current schema: opens cleanly
    reopened.close();
  });

  it("fails closed on a newer unsupported schema version (§38.1)", async () => {
    const file = path.join(dir, "plan-store.json");
    await writeFile(file, JSON.stringify({ ...baseDoc(), schemaVersion: STORE_SCHEMA_VERSION + 1 }));
    const store = storeFor();
    await expect(Promise.resolve().then(() => store.open())).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "store_version_unsupported",
    );
  });

  it("fails closed on malformed durable JSON (§38.4)", async () => {
    await writeFile(path.join(dir, "plan-store.json"), "{ this is not json");
    const store = storeFor();
    await expect(Promise.resolve().then(() => store.open())).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt",
    );
  });

  it("fails closed when HEAD references a missing snapshot (§38.2)", async () => {
    const doc = baseDoc();
    doc.runs["PLAN-001"] = {
      id: PlanIDs.cast("PLAN-001"),
      sessionID: "s",
      lifecycle: "active",
      stage: "discovery",
      revision: 1,
      goal: { statement: "" },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      headSnapshot: "SNAP-999" as PlanningRun["headSnapshot"],
      createdAt: FIXED,
      updatedAt: FIXED,
    };
    doc.runOrder = ["PLAN-001"];
    await writeFile(path.join(dir, "plan-store.json"), JSON.stringify(doc));
    const store = storeFor();
    await expect(Promise.resolve().then(() => store.open())).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt",
    );
  });

  it("fails closed when a stored proposal hash does not recompute (§38.5)", async () => {
    const doc = baseDoc();
    doc.runs["PLAN-001"] = {
      id: PlanIDs.cast("PLAN-001"),
      sessionID: "s",
      lifecycle: "active",
      stage: "detail",
      revision: 1,
      goal: { statement: "" },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      headSnapshot: "SNAP-001" as PlanningRun["headSnapshot"],
      createdAt: FIXED,
      updatedAt: FIXED,
    };
    doc.runOrder = ["PLAN-001"];
    doc.snapshots["PLAN-001"] = {
      "SNAP-001": {
        id: "SNAP-001" as never,
        planID: "PLAN-001" as never,
        commit: null,
        state: { sectionRevisions: {}, decisionRevisions: {}, constraintIDs: [], openQuestionIDs: [] },
        createdAt: FIXED,
      },
    };
    doc.proposals["PLAN-001"] = {
      "PROP-001": {
        id: "PROP-001" as never,
        type: "design_checkpoint",
        scope: { id: "ARCH", revision: 1 },
        revision: 1,
        status: "awaiting_approval",
        title: "t",
        summary: "s",
        changes: [],
        dependencies: [],
        impact: { affectedSections: [], affectedDecisions: [] },
        createdFrom: { id: "SNAP-001" },
        hash: "tampered-hash",
      } as never,
    };
    await writeFile(path.join(dir, "plan-store.json"), JSON.stringify(doc));
    const store = storeFor();
    await expect(Promise.resolve().then(() => store.open())).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt",
    );
  });
});

function baseDoc(): StoreDocument {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    runs: {},
    runOrder: [],
    events: {},
    committed: {},
    proposals: {},
    approvals: {},
    commits: {},
    commitByProposal: {},
    snapshots: {},
    evidence: {},
  };
}

describe("restart recovery (§18/§29/§36/§37)", () => {
  it("recovers an active run with HEAD across a real reopen (§29.1/§29.17)", async () => {
    const store = storeFor();
    const controller = controllerFor(store);
    const started = await startedRun(controller, store);
    store.close();

    const reopened = storeFor();
    const controller2 = controllerFor(reopened);
    // After restart the user must issue /ultra-plan again (fail-closed §36):
    // the new command mints a fresh admission, which resumes the SAME run.
    controller2.issueStartAdmission("ses_d");
    const result = await controller2.startOrResume("ses_d");
    expect(result.created).toBe(false);
    expect(result.run.id).toBe(started.id);
    expect(result.run.headSnapshot).toBe(started.headSnapshot);
    expect(result.run.stage).toBe("detail");
    reopened.close();
  });

  it("continues ID allocation without collisions after restart (§29.14)", async () => {
    const store = storeFor();
    const controller = controllerFor(store);
    await startedRun(controller, store);
    store.close();

    const reopened = storeFor();
    const controller2 = controllerFor(reopened);
    const prepared = await controller2.prepareProposal("ses_d", prepareInput("post-restart", [DECISION_DRAFT]));
    expect(prepared.proposal.id).toBe("PROP-001");
    reopened.close();
  });

  it("keeps ready / awaiting / rejected proposals in their exact states (§29.6-9, §37)", async () => {
    const store = storeFor();
    const controller = controllerFor(store);
    await startedRun(controller, store);

    const ready = await controller.prepareProposal("ses_d", prepareInput("still ready", [DECISION_DRAFT]));
    const awaiting = await controller.prepareProposal("ses_d", prepareInput("awaiting no approval", [DECISION_DRAFT]));
    const begunAwaiting = await controller.beginProposalApproval("ses_d", awaiting.proposal.id);
    const rejected = await controller.prepareProposal("ses_d", prepareInput("rejected", [DECISION_DRAFT]));
    const begunRejected = await controller.beginProposalApproval("ses_d", rejected.proposal.id);
    await controller.rejectProposal("ses_d", rejected.proposal.id, begunRejected.request);

    store.close();
    const reopened = storeFor();
    const controller2 = controllerFor(reopened);

    expect((await reopened.getProposal(PlanIDs.from(1), ready.proposal.id))?.status).toBe("ready");
    const recoveredAwaiting = await reopened.getProposal(PlanIDs.from(1), awaiting.proposal.id);
    expect(recoveredAwaiting?.status).toBe("awaiting_approval");
    expect(recoveredAwaiting?.hash).toBe(awaiting.proposal.hash);
    // No fake Approval appeared for the approval-less awaiting proposal (§37).
    expect(await reopened.findApprovalForProposal(PlanIDs.from(1), awaiting.proposal.id)).toBeUndefined();
    // It can be safely re-presented and approved after restart.
    const approved = await controller2.recordApprovalAndCommit("ses_d", awaiting.proposal.id, begunAwaiting.request);
    expect(approved.commit.proposalID).toBe(awaiting.proposal.id);

    expect((await reopened.getProposal(PlanIDs.from(1), rejected.proposal.id))?.status).toBe("rejected");
    // Rejected proposals cannot commit.
    await expect(
      reopened.commitTransaction({
        planID: PlanIDs.from(1),
        proposalID: rejected.proposal.id,
        approvalID: ApprovalIDs.from(1),
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isUltraPlanError(e) &&
        e.code === "transaction_validation_failed" &&
        JSON.stringify(e.detail).includes("proposal_not_awaiting_approval"),
    );
    reopened.close();
  });

  it("recovers awaiting+Approval after a crash-before-commit and allows retry (§29.8, §37)", async () => {
    const store = storeFor();
    const controller = controllerFor(store);
    await startedRun(controller, store);
    const { prepared, approval } = await prepareAwaiting(controller);
    store.close(); // "process dies before commit"

    const reopened = storeFor();
    const sameApproval = await reopened.findApprovalForProposal(PlanIDs.from(1), prepared.proposal.id);
    expect(sameApproval).toEqual(approval); // same immutable Approval reloads

    const commit = await reopened.commitTransaction({
      planID: PlanIDs.from(1),
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    expect(commit.proposalID).toBe(prepared.proposal.id);
    expect((await reopened.getProposal(PlanIDs.from(1), prepared.proposal.id))?.status).toBe("approved");
    reopened.close();
  });

  it("recovers committed transactions idempotently (§29.10/§22)", async () => {
    const store = storeFor();
    const controller = controllerFor(store);
    await startedRun(controller, store);
    const { prepared, approval } = await prepareAwaiting(controller);
    const commit = await store.commitTransaction({
      planID: PlanIDs.from(1),
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    store.close();

    const reopened = storeFor();
    const retry = await reopened.commitTransaction({
      planID: PlanIDs.from(1),
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    expect(retry.id).toBe(commit.id);
    expect(await reopened.listCommits(PlanIDs.from(1))).toHaveLength(1);
    expect((await reopened.getHeadSnapshot(PlanIDs.from(1)))?.id).toBe(commit.resultingSnapshot);
    reopened.close();
  });

  it("recovers decisions, evidence, events, and snapshot chains (§29.2-5/§29.11-13)", async () => {
    const store = storeFor();
    const controller = controllerFor(store);
    await startedRun(controller, store);
    await store.putEvidence(PlanIDs.from(1), evidenceFixture(EvidenceIDs.from(1)));
    const { prepared, approval } = await prepareAwaiting(controller);
    await store.commitTransaction({
      planID: PlanIDs.from(1),
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    const eventsBefore = await store.listEvents(PlanIDs.from(1));
    store.close();

    const reopened = storeFor();
    expect(await reopened.listEvidence(PlanIDs.from(1))).toHaveLength(1);
    const decision = await reopened.getDecision(PlanIDs.from(1), {
      id: DecisionIDs.from(1),
      revision: 1,
    });
    expect(decision?.title).toBe("Canonical state");
    expect(await reopened.listCommits(PlanIDs.from(1))).toHaveLength(1);
    expect((await reopened.getHeadSnapshot(PlanIDs.from(1)))?.state.decisionRevisions).toMatchObject({
      "DEC-001": 1,
    });
    expect((await reopened.listEvents(PlanIDs.from(1))).map((e) => e.detail.type)).toEqual(
      eventsBefore.map((e) => e.detail.type),
    );
    reopened.close();
  });

  it("keeps StartAdmissions and the ObservationLedger ephemeral (§36, §7)", async () => {
    const store = storeFor();
    await store.open(); // materialize the document
    const controller = controllerFor(store);
    controller.issueStartAdmission("ses_ephemeral");
    // The durable document must not contain any admission concept.
    const doc = JSON.parse(readFileSync(path.join(dir, "plan-store.json"), "utf8"));
    expect(Object.keys(doc)).not.toContain("admissions");
    store.close();

    // A fresh admission ledger starts empty (fail-closed restart semantics).
    const fresh = new InMemoryStartAdmissionLedger();
    expect(fresh.list("ses_ephemeral")).toHaveLength(0);
    const reopened = storeFor();
    const controller2 = controllerFor(reopened);
    await expect(controller2.startOrResume("ses_ephemeral")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "start_not_authorized",
    );
    reopened.close();
  });
});

describe("concurrent writers (§31)", () => {
  it("second writer fails stale against moved HEAD; exact retry is idempotent", async () => {
    const storeA = storeFor();
    const controllerA = controllerFor(storeA);
    await startedRun(controllerA, storeA);

    // A second independent store instance over the same durable database.
    const storeB = storeFor();

    const proposalA = await controllerA.prepareProposal("ses_d", prepareInput("A", [DECISION_DRAFT]));
    const begunA = await controllerA.beginProposalApproval("ses_d", proposalA.proposal.id);
    const { approval: approvalA } = await controllerA.recordApproval("ses_d", proposalA.proposal.id, begunA.request);

    const proposalB = await controllerA.prepareProposal("ses_d", prepareInput("B", [
      { kind: "add_decision", content: { decision: { title: "B decision", statement: "s", rationale: "r" } } },
    ]));
    const begunB = await controllerA.beginProposalApproval("ses_d", proposalB.proposal.id);
    const { approval: approvalB } = await controllerA.recordApproval("ses_d", proposalB.proposal.id, begunB.request);

    // A commits first: durable HEAD moves to SNAP-002.
    await storeA.commitTransaction({
      planID: PlanIDs.from(1),
      proposalID: proposalA.proposal.id,
      approvalID: approvalA.id,
    });

    // B (the second instance) reloads under the lock and fails stale, closed.
    await expect(
      storeB.commitTransaction({
        planID: PlanIDs.from(1),
        proposalID: proposalB.proposal.id,
        approvalID: approvalB.id,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isUltraPlanError(e) &&
        e.code === "transaction_validation_failed" &&
        JSON.stringify(e.detail).includes("head_snapshot_mismatch"),
    );

    // Exact retry of A's transaction through the OTHER instance is idempotent.
    const retry = await storeB.commitTransaction({
      planID: PlanIDs.from(1),
      proposalID: proposalA.proposal.id,
      approvalID: approvalA.id,
    });
    expect(retry.id).toBe((await storeB.listCommits(PlanIDs.from(1)))[0]?.id);
    expect(await storeB.listCommits(PlanIDs.from(1))).toHaveLength(1);
    storeA.close();
    storeB.close();
  });
});
