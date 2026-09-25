#!/usr/bin/env node
/**
 * TEST-ONLY setup for the Phase 2J live handoff smoke (brief §98).
 *
 * Opens the SAME durable store the real OpenCode server used (located by
 * globbing the ULTRA_PLAN_DATA_DIR handed to the server), finds the run bound
 * to the GIVEN real session id, and drives it from discovery to
 * handoff_pending through the REAL controller flow — exactly the crash-probe
 * drive, but bound to the live session. This is a standalone script, NOT a
 * production seam: production code gains no setup path.
 *
 * Usage: node scripts/opencode-handoff-setup.mjs <dataDir> <sessionID>
 * Prints: PROBE-SETUP LIFECYCLE=<lifecycle> HEAD=<commit> FINAL=<ref>
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const entryURL = process.env.CRASH_PROBE_ENTRY
  ? pathToFileURL(process.env.CRASH_PROBE_ENTRY).href
  : pathToFileURL(path.join(repoRoot, "adapters", "opencode", "dist", "index.js")).href;

const [, , dataDir, sessionID] = process.argv;
if (!dataDir || !sessionID) {
  console.error("usage: opencode-handoff-setup.mjs <dataDir> <sessionID>");
  process.exit(2);
}

const ultra = await import(entryURL);
const { DurablePlanStore, UltraPlanController } = ultra;

async function findStoreFile(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findStoreFile(full);
      if (found) return found;
    } else if (entry.name === "plan-store.json") {
      return full;
    }
  }
  return undefined;
}

const storeFile = await findStoreFile(dataDir);
if (!storeFile) {
  console.error(`no plan-store.json under ${dataDir}`);
  process.exit(1);
}
const store = new DurablePlanStore(storeFile, { now: () => new Date().toISOString() });
const controller = new UltraPlanController({
  store,
  now: () => new Date().toISOString(),
  semanticValidator: {
    async validate() {
      return { text: JSON.stringify({ result: "clean", findings: [] }) };
    },
  },
});

const run = await store.findLatestRunBySession(sessionID);
if (!run) {
  console.error(`no PlanningRun for session ${sessionID}`);
  process.exit(1);
}

const ARCH_CHANGE = {
  kind: "add_architecture",
  content: {
    architecture: {
      summary: "Handoff smoke architecture",
      components: [{ name: "Core", summary: "kernel" }],
      boundaries: [],
      dataFlows: [],
      principles: [],
    },
  },
};

const CHAIN_DECOMPOSITION = {
  sections: [
    { key: "runtime", title: "Runtime Integration", objective: "bind to the OpenCode host" },
    { key: "plan-memory", title: "Plan Memory", objective: "durable state", dependsOn: ["runtime"] },
  ],
  initialSection: "runtime",
};

function checkpointDraft(sectionID) {
  const depID = sectionID === "SEC-001" ? undefined : "SEC-001";
  return {
    problem: `Problem ${sectionID}`,
    design: `Design ${sectionID}`,
    interfaces: [{ name: `I${sectionID}`, description: "boundary" }],
    invariants: ["handoff smoke invariant"],
    failureModes: [],
    dependencies: depID ? [{ sectionID: depID, consumes: [] }] : [],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: `compact ${sectionID}`,
      contract: {
        provides: [`${sectionID.toLowerCase()}-capability`],
        requires: [],
        invariants: ["handoff smoke invariant"],
        interfaces: [{ name: `I${sectionID}` }],
        decisions: [],
      },
    },
  };
}

async function approveAndCommit(proposalID) {
  const begun = await controller.beginProposalApproval(sessionID, proposalID);
  await controller.recordApproval(sessionID, proposalID, begun.request);
  await store.commitTransaction({
    planID: run.id,
    proposalID,
    approvalID: (await store.findApprovalForProposal(run.id, proposalID)).id,
  });
}

async function drive() {
  await controller.requestArchitecture(sessionID);
  const completion = await controller.prepareProposal(sessionID, {
    type: "architecture_completion",
    scope: { type: "architecture" },
    title: "Complete architecture",
    summary: "s",
    changes: [ARCH_CHANGE, { kind: "complete_architecture" }],
  });
  await approveAndCommit(completion.proposal.id);

  const decomposition = await controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
  await approveAndCommit(decomposition.proposal.id);

  for (const sectionID of ["SEC-001", "SEC-002"]) {
    const checkpoint = await controller.prepareSectionCheckpoint(sessionID, checkpointDraft(sectionID));
    await approveAndCommit(checkpoint.proposal.id);
    const sectionCompletion = await controller.requestCompletion(sessionID, { kind: "section" });
    await approveAndCommit(sectionCompletion.proposal.id);
  }

  await controller.beginSynthesis(sessionID);
  await controller.submitSynthesisManifest(sessionID, {
    crossSectionLinks: [
      {
        statement: "SEC-001 provides isec-001-capability consumed by SEC-002",
        sources: [
          { kind: "section", id: "SEC-001", revision: 1 },
          { kind: "section", id: "SEC-002", revision: 1 },
        ],
      },
    ],
    implementationOrder: [
      {
        title: "Deliver the runtime",
        description: "Implement both approved sections in dependency order.",
        sections: [
          { id: "SEC-001", revision: 1 },
          { id: "SEC-002", revision: 1 },
        ],
        sources: [{ kind: "architecture" }, { kind: "section", id: "SEC-001", revision: 1 }],
      },
    ],
    limitations: [
      { statement: "The approved design leaves repository freshness to the Evidence Audit.", sources: [{ kind: "architecture" }] },
    ],
    unresolvedFindings: [],
  });
  await controller.runSemanticValidation(sessionID);
  const finalization = await controller.requestFinalization(sessionID);
  if (finalization.gate.result !== "pass") {
    throw new Error(`finalization gate ${finalization.gate.result}`);
  }
  const prepared = await controller.prepareFinalPlan(sessionID);
  await approveAndCommit(prepared.proposal.id);
}

try {
  // The live session may already sit in ANY lifecycle state (the smoke only
  // requires the run to END at handoff_pending): discovery continues an
  // active run from wherever it is, a handoff_pending run is already done,
  // and a completed run means the smoke's target state was reached by a
  // previous setup pass.
  const current = await store.getRun(run.id);
  if (current.lifecycle === "handoff_pending") {
    console.log(
      `PROBE-SETUP LIFECYCLE=handoff_pending STAGE=${current.stage}` +
        ` HEAD=${current.headCommit ?? "none"}` +
        ` FINAL=${current.finalPlan ? `${current.finalPlan.id}@${current.finalPlan.revision}` : "none"}` +
        ` SESSION=${sessionID}`,
    );
    process.exit(0);
  }
  if (current.lifecycle !== "active") {
    throw new Error(`run is ${current.lifecycle}; the fixture needs an active or handoff_pending run`);
  }
  await drive();
  const finalRun = await store.getRun(run.id);
  console.log(
    `PROBE-SETUP LIFECYCLE=${finalRun.lifecycle} STAGE=${finalRun.stage}` +
      ` HEAD=${finalRun.headCommit ?? "none"}` +
      ` FINAL=${finalRun.finalPlan ? `${finalRun.finalPlan.id}@${finalRun.finalPlan.revision}` : "none"}` +
      ` SESSION=${sessionID}`,
  );
} catch (error) {
  console.error(`PROBE-SETUP-FAILED ${error?.stack ?? error}`);
  process.exit(1);
} finally {
  store.close();
}
