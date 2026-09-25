#!/usr/bin/env node
/**
 * Phase 2B2 §30 / Phase 2C §31 — crash-probe child process.
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
 * Modes:
 *   decision                (default, Phase 2B1) commit an add_decision proposal
 *   architecture-completion (Phase 2C) commit an architecture_completion
 *                           proposal (add_architecture + add_constraint +
 *                           complete_architecture) — the crash seam sits
 *                           exactly on the atomic commit+stage-transition
 *                           publication
 *   section-decomposition   (Phase 2D) reach detail via a real completion
 *                           commit, then commit the INITIAL SECTION DAG
 *                           (add_section×N + select_initial_section) with the
 *                           crash seam on the atomic detail-admission
 *                           publication
 *   section-checkpoint      (Phase 2E1) reach detail + committed DAG via real
 *                           commits, then freeze + commit the ACTIVE section's
 *                           first SectionRevision checkpoint
 *                           (add_section_revision + contract projection) with
 *                           the crash seam on the atomic checkpoint publication
 *   section-completion      (Phase 2E2) drive a 3-section chain through real
 *                           checkpoints/completions to the MIDDLE section and
 *                           crash on the atomic completion+progression
 *                           publication (Section approved + next activeWork)
 *   section-completion-final (Phase 2E2) same chain, crash on the LAST
 *                           completion: Section approved + activeWork cleared
 *                           + detail → synthesis, one publication
 *   synthesis-freeze        (Phase 2F) drive the 3-section chain to synthesis
 *                           through real commits, then crash on the atomic
 *                           SynthesisInput freeze publication (NO PlanCommit/
 *                           HEAD movement involved)
 *   synthesis-manifest      (Phase 2F) same drive, freeze the input cleanly,
 *                           then crash on the atomic SynthesisManifest save
 *                           publication (NO PlanCommit/HEAD movement involved)
 *   semantic-validation     (Phase 2G) same drive + clean input/manifest, then
 *                           run semantic validation with a fake validator:
 *                           before-persist dies on the ADMISSION write (a dead
 *                           process's durable admission — reclaimable, §32);
 *                           after-persist completes the report, then aborts
 *                           before the caller response (exactly one report)
 *   reopen                  (Phase 2G) same drive + findings report, freeze
 *                           the reopen amendment, record the user approval,
 *                           then crash on the atomic reopen_section PlanCommit
 *                           publication (section reopened + stage → detail +
 *                           activeWork, §63)
 *   finalization            (Phase 2H) same drive + CURRENT clean validation,
 *                           then walk the deterministic finalization pieces:
 *                           before-persist dies on the AUDIT publication (no
 *                           audit/candidate/HEAD movement); after-persist
 *                           completes the audit + candidate publications, then
 *                           aborts before the response (exactly one of each,
 *                           retry idempotent) — derived artifacts only, no
 *                           PlanCommit/HEAD movement/stage change
 *   final-plan              (Phase 2I) same drive to a CURRENT FinalPlanCandidate,
 *                           then prepare the exact final_plan Proposal, record
 *                           the user Approval, and crash on the FINAL PLANCOMMIT
 *                           publication: before-persist dies before the durable
 *                           write (no FinalPlan, stage synthesis, lifecycle
 *                           active, Proposal awaiting_approval, Approval
 *                           durable, HEAD old — §67); after-persist publishes
 *                           the commit, then aborts before the response (exact
 *                           handoff_pending state recovers; retry idempotent,
 *                           NO Build handoff — §68)
 *   handoff                 (Phase 2J) drive to handoff_pending, then crash on
 *                           each handoff workflow window (§89-§95): A
 *                           before-prepared (no artifact), B after-prepared (§90),
 *                           C after-admission (§91), D after-host-accept (§92 —
 *                           the ambiguity window), E after-delivered (§93);
 *                           crashPoint "recover" runs the coordinator against
 *                           the current state and prints STATUS/DISPATCHES.
 *                           Requires env FAKE_HOST_FILE (a JSON fake host shared
 *                           across probe invocations so a NEW process can query
 *                           host receipts like the §43 algorithm demands).
 *
 * Usage:
 *   node scripts/crash-probe.mjs <dbFile> <crashPoint: before-persist|after-persist|none> [mode]
 *
 * Exits 0 on clean commit; dies via process.abort() at the crash point.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

const [dbFile, crashPointRaw, modeRaw] = process.argv.slice(2);
const crashPoint = crashPointRaw ?? "none";
const mode = modeRaw ?? "decision";

if (!dbFile) {
  console.error("usage: crash-probe.mjs <dbFile> [before-persist|after-persist|none] [decision|architecture-completion]");
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

// Deterministic TEST-ONLY fake validator (Phase 2G §10: fakes live only in
// deterministic tests). Reports one contradiction scoped to SEC-002@1.
const fakeSemanticValidator = {
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

const controller = new UltraPlanController({
  store,
  ledger: new InMemoryObservationLedger(),
  ...(mode === "semantic-validation" || mode === "reopen" ? { semanticValidator: fakeSemanticValidator } : {}),
  now: () => FIXED,
});

function transition(current, stage) {
  // Transition through the real state machine (state transitions are
  // validated and persisted by the caller between stages).
  const { transitionStage } = ultra;
  return transitionStage(current, stage);
}

let run;
let prepared;

async function driveToDetail() {
  // Shared path: real completion commit → detail (stage transition + commit
  // are ONE publication).
  controller.issueStartAdmission("ses_crash");
  run = (await controller.startOrResume("ses_crash", "Build the durable planner")).run;
  run = transition(run, "architecture");
  run = await store.saveRun(run);

  const completion = await controller.prepareProposal("ses_crash", {
    type: "architecture_completion",
    scope: { type: "architecture" },
    title: "Crash probe architecture",
    summary: "s",
    changes: [
      {
        kind: "add_architecture",
        content: {
          architecture: {
            summary: "Probe architecture",
            components: [{ name: "Core", summary: "kernel of the system" }],
            boundaries: [],
            dataFlows: [],
            principles: [],
          },
        },
      },
      { kind: "complete_architecture" },
    ],
  });
  const completionBegun = await controller.beginProposalApproval("ses_crash", completion.proposal.id);
  await controller.recordApproval("ses_crash", completion.proposal.id, completionBegun.request);
  await store.commitTransaction({
    planID: run.id,
    proposalID: completion.proposal.id,
    approvalID: (await store.findApprovalForProposal(run.id, completion.proposal.id)).id,
  });
  run = await store.getRun(run.id);
}

async function commitInitialDag(initialSection = "plan-memory") {
  // A REAL initial decomposition commit (DAG + run.sections + activeWork),
  // leaving the run checkpoint-ready.
  const decomposition = await controller.prepareSectionDecomposition("ses_crash", {
    sections: [
      { key: "runtime-integration", title: "Runtime Integration", objective: "bind to OpenCode" },
      { key: "plan-memory", title: "Plan Memory", objective: "durable state", dependsOn: ["runtime-integration"] },
    ],
    initialSection,
  });
  const dagBegun = await controller.beginProposalApproval("ses_crash", decomposition.proposal.id);
  await controller.recordApproval("ses_crash", decomposition.proposal.id, dagBegun.request);
  await store.commitTransaction({
    planID: run.id,
    proposalID: decomposition.proposal.id,
    approvalID: (await store.findApprovalForProposal(run.id, decomposition.proposal.id)).id,
  });
  run = await store.getRun(run.id);
}

const CHAIN_DECOMPOSITION = {
  sections: [
    { key: "runtime", title: "Runtime Integration", objective: "bind to OpenCode" },
    { key: "plan-memory", title: "Plan Memory", objective: "durable state", dependsOn: ["runtime"] },
    { key: "context", title: "Context Assembly", objective: "deterministic context", dependsOn: ["plan-memory"] },
  ],
  initialSection: "runtime",
};

function checkpointDraft(sectionID) {
  return {
    problem: `Planning problem for ${sectionID}`,
    design: `Design for ${sectionID}`,
    interfaces: [{ name: `I${sectionID}`, description: "boundary" }],
    invariants: ["HEAD moves last in every publication"],
    failureModes: [],
    dependencies:
      sectionID === "SEC-001"
        ? []
        : [{ sectionID: sectionID === "SEC-002" ? "SEC-001" : "SEC-002", consumes: [] }],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: `Compact ${sectionID}`,
      contract: {
        provides: [`${sectionID.toLowerCase()}-capability`],
        requires: [],
        invariants: ["HEAD moves last in every publication"],
        interfaces: [{ name: `I${sectionID}` }],
        decisions: [],
      },
    },
  };
}

async function commitActiveCheckpoint() {
  const checkpoint = await controller.prepareSectionCheckpoint("ses_crash", checkpointDraft(run.activeWork.id));
  const begun = await controller.beginProposalApproval("ses_crash", checkpoint.proposal.id);
  await controller.recordApproval("ses_crash", checkpoint.proposal.id, begun.request);
  await store.commitTransaction({
    planID: run.id,
    proposalID: checkpoint.proposal.id,
    approvalID: (await store.findApprovalForProposal(run.id, checkpoint.proposal.id)).id,
  });
  run = await store.getRun(run.id);
}

async function commitActiveCompletion() {
  const completion = await controller.requestCompletion("ses_crash", { kind: "section" });
  const begun = await controller.beginProposalApproval("ses_crash", completion.proposal.id);
  await controller.recordApproval("ses_crash", completion.proposal.id, begun.request);
  await store.commitTransaction({
    planID: run.id,
    proposalID: completion.proposal.id,
    approvalID: (await store.findApprovalForProposal(run.id, completion.proposal.id)).id,
  });
  run = await store.getRun(run.id);
}

/** Real-flow drive: detail → chain decomposition → all three sections → synthesis. */
async function driveToSynthesis() {
  await driveToDetail();
  const decomposition = await controller.prepareSectionDecomposition("ses_crash", CHAIN_DECOMPOSITION);
  const dagBegun = await controller.beginProposalApproval("ses_crash", decomposition.proposal.id);
  await controller.recordApproval("ses_crash", decomposition.proposal.id, dagBegun.request);
  await store.commitTransaction({
    planID: run.id,
    proposalID: decomposition.proposal.id,
    approvalID: (await store.findApprovalForProposal(run.id, decomposition.proposal.id)).id,
  });
  run = await store.getRun(run.id);
  for (let index = 0; index < 3; index++) {
    await commitActiveCheckpoint();
    await commitActiveCompletion();
  }
  run = await store.getRun(run.id);
  if (run.stage !== "synthesis") {
    console.error(`PROBE-DRIVE-FAILED expected stage=synthesis, got ${run.stage}`);
    process.exit(1);
  }
}

const PROBE_MANIFEST_DRAFT = {
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
      title: "Deliver the chain",
      description: "One delivery wave over the three approved sections in dependency order.",
      sections: [
        { id: "SEC-001", revision: 1 },
        { id: "SEC-002", revision: 1 },
        { id: "SEC-003", revision: 1 },
      ],
      sources: [{ kind: "architecture" }],
    },
  ],
  limitations: [{ statement: "Evidence audit is a later phase.", sources: [{ kind: "architecture" }] }],
  unresolvedFindings: [],
};

if (mode === "section-decomposition") {
  // Phase 2D crash scenario: reach detail through a REAL completion commit,
  // then crash exactly on the atomic detail-admission publication (Section
  // DAG + run.sections + activeWork + snapshot + HEAD).
  await driveToDetail();
  prepared = await controller.prepareSectionDecomposition("ses_crash", {
    sections: [
      { key: "runtime-integration", title: "Runtime Integration", objective: "bind to OpenCode" },
      { key: "plan-memory", title: "Plan Memory", objective: "durable state", dependsOn: ["runtime-integration"] },
    ],
    initialSection: "runtime-integration",
  });
} else if (mode === "section-checkpoint") {
  // Phase 2E1 crash scenario: detail + committed DAG, then freeze the ACTIVE
  // section's first checkpoint and crash exactly on the atomic checkpoint
  // publication (SectionRevision + contract + root pointers + snapshot + HEAD).
  await driveToDetail();
  await commitInitialDag();
  prepared = await controller.prepareSectionCheckpoint("ses_crash", {
    problem: "Planning state must survive restarts",
    design: "Append-only document with atomic rename publication",
    interfaces: [{ name: "PlanStore", description: "durable storage boundary" }],
    invariants: ["HEAD moves last in every publication"],
    failureModes: [],
    dependencies: [{ sectionID: "SEC-001", consumes: [] }],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: "Durable append-only plan memory",
      contract: {
        provides: ["durable-plan-memory"],
        requires: [],
        invariants: ["HEAD moves last in every publication"],
        interfaces: [{ name: "PlanStore" }],
        decisions: [],
      },
    },
  });
} else if (mode === "section-completion" || mode === "section-completion-final") {
  // Phase 2E2 crash scenarios: drive a 3-section chain through REAL
  // checkpoint + completion commits, then crash on the atomic
  // completion+progression publication:
  //   section-completion        → SEC-002's ORDINARY completion (next focus
  //                               SEC-003 selected in the same commit)
  //   section-completion-final  → SEC-003's LAST completion (activeWork
  //                               cleared + detail → synthesis, same commit)
  await driveToDetail();
  const decomposition = await controller.prepareSectionDecomposition("ses_crash", CHAIN_DECOMPOSITION);
  const dagBegun = await controller.beginProposalApproval("ses_crash", decomposition.proposal.id);
  await controller.recordApproval("ses_crash", decomposition.proposal.id, dagBegun.request);
  await store.commitTransaction({
    planID: run.id,
    proposalID: decomposition.proposal.id,
    approvalID: (await store.findApprovalForProposal(run.id, decomposition.proposal.id)).id,
  });
  run = await store.getRun(run.id);

  // SEC-001: checkpoint → complete → automatic focus SEC-002.
  await commitActiveCheckpoint();
  await commitActiveCompletion();
  // SEC-002: checkpoint → (ordinary mode stops here for the crash).
  await commitActiveCheckpoint();
  if (mode === "section-completion") {
    prepared = await controller.requestCompletion("ses_crash", { kind: "section" });
  } else {
    await commitActiveCompletion(); // automatic focus SEC-003
    await commitActiveCheckpoint();
    prepared = await controller.requestCompletion("ses_crash", { kind: "section" });
  }
} else if (mode === "synthesis-freeze" || mode === "synthesis-manifest") {
  // Phase 2F crash scenarios: drive the 3-section chain through REAL
  // checkpoint + completion commits into synthesis, then crash exactly on the
  // atomic DERIVED-ARTIFACT publication — no PlanCommit, no Snapshot, no HEAD
  // movement is involved in these writes (brief §56):
  //   synthesis-freeze   → the SynthesisInput freeze
  //   synthesis-manifest → the SynthesisManifest save (input frozen cleanly first)
  await driveToDetail();
  const decomposition = await controller.prepareSectionDecomposition("ses_crash", CHAIN_DECOMPOSITION);
  const dagBegun = await controller.beginProposalApproval("ses_crash", decomposition.proposal.id);
  await controller.recordApproval("ses_crash", decomposition.proposal.id, dagBegun.request);
  await store.commitTransaction({
    planID: run.id,
    proposalID: decomposition.proposal.id,
    approvalID: (await store.findApprovalForProposal(run.id, decomposition.proposal.id)).id,
  });
  run = await store.getRun(run.id);
  for (let index = 0; index < 3; index++) {
    await commitActiveCheckpoint();
    await commitActiveCompletion();
  }
  run = await store.getRun(run.id);
  if (run.stage !== "synthesis") {
    console.error(`PROBE-DRIVE-FAILED expected stage=synthesis, got ${run.stage}`);
    process.exit(1);
  }

  if (mode === "synthesis-manifest") {
    // Freeze the input cleanly (a full durable publication), then crash on
    // the manifest save.
    const { input } = await controller.beginSynthesis("ses_crash");
    run = await store.getRun(run.id);
    const draft = {
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
          title: "Deliver the chain",
          description: "One delivery wave over the three approved sections in dependency order.",
          sections: [
            { id: "SEC-001", revision: 1 },
            { id: "SEC-002", revision: 1 },
            { id: "SEC-003", revision: 1 },
          ],
          sources: [{ kind: "architecture" }],
        },
      ],
      limitations: [{ statement: "Evidence audit is a later phase.", sources: [{ kind: "architecture" }] }],
      unresolvedFindings: [],
    };
    if (crashPoint === "before-persist") store.armCrashSeam("before-persist");
    const { manifest } = await controller.submitSynthesisManifest("ses_crash", draft);
    if (crashPoint === "after-persist") {
      store.armCrashSeam("after-persist");
      process.abort();
    }
    const finalRun = await store.getRun(run.id);
    console.log(
      `PROBE-MANIFEST ${manifest.id}@${manifest.revision} INPUT=${input.id} STAGE=${finalRun?.stage}` +
        ` HEAD=${finalRun?.headCommit ?? "none"}`,
    );
    process.exit(0);
  }

  // synthesis-freeze: crash on the input freeze itself.
  if (crashPoint === "before-persist") store.armCrashSeam("before-persist");
  const { input } = await controller.beginSynthesis("ses_crash");
  if (crashPoint === "after-persist") {
    store.armCrashSeam("after-persist");
    process.abort();
  }
  const finalRun = await store.getRun(run.id);
  console.log(
    `PROBE-INPUT ${input.id} BASE=${input.baseSnapshot.id} STAGE=${finalRun?.stage}` +
      ` HEAD=${finalRun?.headCommit ?? "none"}`,
  );
  process.exit(0);
} else if (mode === "semantic-validation" || mode === "reopen") {
  // Phase 2G crash scenarios. Both reuse the Phase 2F synthesis drive, then:
  //   semantic-validation → begin_synthesis + submit manifest CLEANLY, then
  //                         run_semantic_validation with the fake validator.
  //                         before-persist: dies on the ADMISSION write — the
  //                         durable admission of a DEAD process must be
  //                         reclaimable (§32), never a wedge, never a report.
  //                         after-persist: the report is durable; abort before
  //                         the caller response — retry returns the SAME report.
  //   reopen              → full findings flow, freeze the reopen amendment,
  //                         record the user approval, then crash exactly on
  //                         the atomic reopen_section PlanCommit publication
  //                         (§63): before-persist leaves the Section approved
  //                         with a durable Approval; retry commits once.
  await driveToSynthesis();
  await controller.beginSynthesis("ses_crash");
  const { manifest } = await controller.submitSynthesisManifest("ses_crash", PROBE_MANIFEST_DRAFT);

  if (mode === "semantic-validation") {
    if (crashPoint === "before-persist") store.armCrashSeam("before-persist");
    const { report } = await controller.runSemanticValidation("ses_crash");
    if (crashPoint === "after-persist") {
      store.armCrashSeam("after-persist");
      process.abort();
    }
    const finalRun = await store.getRun(run.id);
    console.log(
      `PROBE-VALIDATION ${report.id} RESULT=${report.result} FINDINGS=${report.findings.length}` +
        ` MANIFEST=${manifest.id}@${manifest.revision} STAGE=${finalRun?.stage}` +
        ` HEAD=${finalRun?.headCommit ?? "none"}`,
    );
    process.exit(0);
  }

  // reopen mode: validation → findings report → reopen → durable approval.
  const { report } = await controller.runSemanticValidation("ses_crash");
  if (report.result !== "findings") {
    console.error(`PROBE-DRIVE-FAILED expected a findings report, got ${report.result}`);
    process.exit(1);
  }
  prepared = await controller.requestReopen("ses_crash", {
    sectionID: "SEC-002",
    findingIDs: report.findings.map((finding) => finding.id),
  });
  const begunReopen = await controller.beginProposalApproval("ses_crash", prepared.proposal.id);
  await controller.recordApproval("ses_crash", prepared.proposal.id, begunReopen.request);
  // The crash seam then sits on the atomic reopen publication (§63).
  if (crashPoint === "before-persist") store.armCrashSeam("before-persist");
  await store.commitTransaction({
    planID: run.id,
    proposalID: prepared.proposal.id,
    approvalID: (await store.findApprovalForProposal(run.id, prepared.proposal.id)).id,
  });
  if (crashPoint === "after-persist") {
    store.armCrashSeam("after-persist");
    process.abort();
  }
  const finalRun = await store.getRun(run.id);
  const sec002 = await store.getSection(run.id, "SEC-002");
  console.log(
    `PROBE-REOPEN SEC-002 STATUS=${sec002?.status} VALIDATION=${sec002?.validation}` +
      ` STAGE=${finalRun?.stage} ACTIVE=${finalRun?.activeWork?.type === "section" ? finalRun.activeWork.id : "none"}` +
      ` HEAD=${finalRun?.headCommit ?? "none"}`,
  );
  process.exit(0);
} else if (mode === "finalization") {
  // Phase 2H crash scenarios (§72). Reuses the synthesis drive to a CURRENT
  // clean validation, then walks the deterministic finalization pieces so the
  // crash seam sits exactly on a derived-artifact publication:
  //   before-persist: dies on the AUDIT publication — no audit, no candidate,
  //                   no HEAD movement; a new process retries cleanly.
  //   after-persist:  the audit published, the CANDIDATE publication completes,
  //                   then the process dies before the response — reopen sees
  //                   exactly one audit + one candidate; a retry is idempotent
  //                   (§17/§38).
  await driveToSynthesis();
  await controller.beginSynthesis("ses_crash");
  await controller.submitSynthesisManifest("ses_crash", PROBE_MANIFEST_DRAFT);
  const cleanValidator = {
    async validate() {
      return { text: JSON.stringify({ result: "clean", findings: [] }) };
    },
  };
  const finalizationController = new UltraPlanController({
    store,
    ledger: new InMemoryObservationLedger(),
    semanticValidator: cleanValidator,
    now: () => FIXED,
  });
  const { report } = await finalizationController.runSemanticValidation("ses_crash");
  if (report.result !== "clean") {
    console.error(`PROBE-DRIVE-FAILED expected a clean report, got ${report.result}`);
    process.exit(1);
  }
  const snapshot = await store.getHeadSnapshot(run.id);
  const input = await store.getLatestSynthesisInput(run.id);
  const manifest = (await store.listSynthesisManifests(run.id)).reduce((latest, candidate) =>
    candidate.revision > latest.revision ? candidate : latest,
  );
  const audit = await ultra.buildEvidenceAudit(
    store,
    { planID: run.id, snapshot, input, manifest, report },
    { id: ultra.EvidenceAuditIDs.from(1), now: FIXED },
  );
  if (crashPoint === "before-persist") store.armCrashSeam("before-persist");
  await store.saveEvidenceAudit(run.id, audit);
  const draft = ultra.assembleFinalPlanCandidate({
    identity: {
      headSnapshot: { id: snapshot.id },
      headCommit: snapshot.commit,
      architecture: input.architecture,
      synthesisInput: { id: input.id, hash: input.hash },
      synthesisManifest: { id: manifest.id, revision: manifest.revision, hash: manifest.hash },
      validationReport: { id: report.id, hash: report.hash },
      evidenceAudit: { id: audit.id, hash: audit.hash },
    },
    input,
    manifest,
  });
  if (crashPoint === "after-persist") store.armCrashSeam("after-persist");
  const { candidate } = await store.saveFinalPlanCandidate(run.id, draft);
  const finalRun = await store.getRun(run.id);
  console.log(
    `PROBE-FINALIZATION AUD=${audit.id} RESULT=${audit.result}` +
      ` CANDIDATE=${candidate.id}@${candidate.revision} STAGE=${finalRun?.stage}` +
      ` HEAD=${finalRun?.headCommit ?? "none"}`,
  );
  process.exit(0);
} else if (mode === "final-plan") {
  // Phase 2I crash scenarios (§67/§68). Drives to a CURRENT FinalPlanCandidate
  // (the sanctioned controller path — audit + candidate frozen and idempotent),
  // then prepares the exact final_plan Proposal, records the user Approval,
  // and arms the crash seam on the FINAL PLANCOMMIT publication.
  //   before-persist: dies before the durable write — zero Final Plan state;
  //                   the Proposal stays awaiting_approval with its Approval
  //                   durable, HEAD old (§67). A fresh controller's exact
  //                   retry commits (the gate remains current).
  //   after-persist:  the Final PlanCommit published (stage final + lifecycle
  //                   handoff_pending + HEAD moved in ONE publication), then
  //                   the process dies before the response (§68) — reopen
  //                   sees the exact handoff_pending state; retry is
  //                   idempotent; NO Build handoff has occurred (§38/§80).
  await driveToSynthesis();
  await controller.beginSynthesis("ses_crash");
  await controller.submitSynthesisManifest("ses_crash", PROBE_MANIFEST_DRAFT);
  const cleanValidator = {
    async validate() {
      return { text: JSON.stringify({ result: "clean", findings: [] }) };
    },
  };
  const finalPlanController = new UltraPlanController({
    store,
    ledger: new InMemoryObservationLedger(),
    semanticValidator: cleanValidator,
    now: () => FIXED,
  });
  const { report } = await finalPlanController.runSemanticValidation("ses_crash");
  if (report.result !== "clean") {
    console.error(`PROBE-DRIVE-FAILED expected a clean report, got ${report.result}`);
    process.exit(1);
  }
  const finalization = await finalPlanController.requestFinalization("ses_crash");
  if (finalization.gate.result !== "pass") {
    console.error(`PROBE-DRIVE-FAILED expected a passing gate, got ${finalization.gate.result}`);
    process.exit(1);
  }
  const prepared = await finalPlanController.prepareFinalPlan("ses_crash");
  const begun = await finalPlanController.beginProposalApproval("ses_crash", prepared.proposal.id);
  await finalPlanController.recordApproval("ses_crash", prepared.proposal.id, begun.request);
  const approval = await store.findApprovalForProposal(run.id, prepared.proposal.id);
  if (!approval) {
    console.error("PROBE-DRIVE-FAILED approval was not persisted");
    process.exit(1);
  }
  if (crashPoint === "before-persist" || crashPoint === "after-persist") {
    store.armCrashSeam(crashPoint);
  }
  await store.commitTransaction({
    planID: run.id,
    proposalID: prepared.proposal.id,
    approvalID: approval.id,
  });
  const finalRun = await store.getRun(run.id);
  console.log(
    `PROBE-FINAL-PLAN FINAL=${finalRun?.finalPlan ? `${finalRun.finalPlan.id}@${finalRun.finalPlan.revision}` : "none"}` +
      ` STAGE=${finalRun?.stage} LIFECYCLE=${finalRun?.lifecycle}` +
      ` HEAD=${finalRun?.headCommit ?? "none"}`,
  );
  process.exit(0);
} else if (mode === "handoff") {
  // Phase 2J crash windows (§89-§95). Drives the REAL flow to handoff_pending,
  // then walks the handoff workflow stepwise so a REAL process crash lands on
  // each recovery-relevant seam. The fake host is a JSON FILE shared across
  // probe invocations (env FAKE_HOST_FILE), so a NEW process can query it —
  // exactly the §43 "query the host before retry" recovery.
  //
  //   crashPoint = before-prepared   window A: no handoff artifact at all.
  //   crashPoint = after-prepared    window B: prepared persisted, host never
  //                                  contacted (§90).
  //   crashPoint = after-admission   window C: dispatch admission persisted,
  //                                  host call never began (§91).
  //   crashPoint = after-host-accept window D: host accepted the handoff, the
  //                                  delivered persist never happened (§92 —
  //                                  the critical ambiguity window).
  //   crashPoint = after-delivered   window E: delivered persisted, lifecycle
  //                                  completion never happened (§93).
  //   crashPoint = none              full coordinator recovery run; prints the
  //                                  resulting state + host dispatch count.
  const fakeHostFile = process.env.FAKE_HOST_FILE;
  if (!fakeHostFile) {
    console.error("handoff mode requires FAKE_HOST_FILE");
    process.exit(1);
  }
  const fs = await import("node:fs/promises");
  const host = {
    async load() {
      try {
        return JSON.parse(await fs.readFile(fakeHostFile, "utf8"));
      } catch {
        return { deliveries: {} };
      }
    },
    async save(data) {
      await fs.writeFile(fakeHostFile, JSON.stringify(data));
    },
    async dispatchHandoff(input) {
      const data = await this.load();
      data.deliveries ??= {};
      data.deliveries[input.deliveryKey] = {
        sessionID: input.sessionID,
        messageID: `msg_${Object.keys(data.deliveries).length + 1}`,
        ...(input.agent ? { agent: input.agent } : {}),
      };
      await this.save(data);
      return { accepted: true };
    },
    async findHandoffDelivery(input) {
      const data = await this.load();
      return data.deliveries?.[input.deliveryKey] ?? undefined;
    },
  };
  const executionRuntime = { adapter: host };

  // Recovery mode: run the coordinator against the current durable state.
  if (crashPoint === "recover") {
    const recoveryController = new UltraPlanController({
      store,
      ledger: new InMemoryObservationLedger(),
      now: () => FIXED,
      executionRuntime,
    });
    const result = await recoveryController.recoverExecutionHandoff("ses_crash");
    const finalRun = await store.getRun("PLAN-001");
    const hostData = await host.load();
    console.log(
      `PROBE-HANDOFF STATUS=${result.status}` +
        ` LIFECYCLE=${finalRun?.lifecycle}` +
        ` DISPATCHES=${Object.keys(hostData.deliveries ?? {}).length}`,
    );
    process.exit(0);
  }

  // Drive to handoff_pending (same real flow as the final-plan mode).
  await driveToSynthesis();
  await controller.beginSynthesis("ses_crash");
  await controller.submitSynthesisManifest("ses_crash", PROBE_MANIFEST_DRAFT);
  const cleanValidator = {
    async validate() {
      return { text: JSON.stringify({ result: "clean", findings: [] }) };
    },
  };
  const finalPlanController = new UltraPlanController({
    store,
    ledger: new InMemoryObservationLedger(),
    semanticValidator: cleanValidator,
    now: () => FIXED,
  });
  const { report } = await finalPlanController.runSemanticValidation("ses_crash");
  if (report.result !== "clean") {
    console.error(`PROBE-DRIVE-FAILED expected a clean report, got ${report.result}`);
    process.exit(1);
  }
  const finalization = await finalPlanController.requestFinalization("ses_crash");
  if (finalization.gate.result !== "pass") {
    console.error(`PROBE-DRIVE-FAILED expected a passing gate, got ${finalization.gate.result}`);
    process.exit(1);
  }
  const prepared = await finalPlanController.prepareFinalPlan("ses_crash");
  const begun = await finalPlanController.beginProposalApproval("ses_crash", prepared.proposal.id);
  await finalPlanController.recordApproval("ses_crash", prepared.proposal.id, begun.request);
  await store.commitTransaction({
    planID: run.id,
    proposalID: prepared.proposal.id,
    approvalID: (await store.findApprovalForProposal(run.id, prepared.proposal.id)).id,
  });

  // Stepwise handoff state with crashes on the exact windows.
  const { assembleExecutionHandoff } = ultra;
  const finalPlan = (await store.listFinalPlans(run.id))[0];
  const requiredContracts = [];
  for (const ref of finalPlan.sections) {
    const revision = await store.getSectionRevision(run.id, ref);
    if (revision) requiredContracts.push(revision.projection.contract);
  }
  if (crashPoint === "before-prepared") process.abort(); // window A
  const { handoff, deliveryKey } = assembleExecutionHandoff({
    run: await store.getRun(run.id),
    finalPlan,
    requiredContracts,
    assign: { id: "HANDOFF-001", now: FIXED },
  });
  await store.saveExecutionHandoff(run.id, handoff);
  await store.prepareHandoffDelivery(run.id, {
    handoffID: handoff.id,
    handoffHash: handoff.hash,
    sessionID: run.sessionID,
    deliveryKey,
  });
  if (crashPoint === "after-prepared") process.abort(); // window B
  await store.beginHandoffDispatch(run.id, handoff.id);
  if (crashPoint === "after-admission") process.abort(); // window C
  await host.dispatchHandoff({ sessionID: run.sessionID, deliveryKey, prompt: "probe" });
  if (crashPoint === "after-host-accept") process.abort(); // window D
  const receipt = await host.findHandoffDelivery({ sessionID: run.sessionID, deliveryKey });
  await store.recordHandoffDelivered(run.id, handoff.id, receipt);
  if (crashPoint === "after-delivered") process.abort(); // window E
  const done = await store.completeHandoffRun(run.id);
  console.log(
    `PROBE-HANDOFF-FULL LIFECYCLE=${done.lifecycle} DISPATCHES=${Object.keys((await host.load()).deliveries ?? {}).length}`,
  );
  process.exit(0);
} else if (mode === "architecture-completion") {
  // Phase 2C crash scenario: the Architecture completion commit and the
  // architecture → detail stage transition are ONE durable publication.
  controller.issueStartAdmission("ses_crash");
  run = (await controller.startOrResume("ses_crash", "Build the durable planner")).run;
  run = transition(run, "architecture");
  run = await store.saveRun(run);

  prepared = await controller.prepareProposal("ses_crash", {
    type: "architecture_completion",
    scope: { type: "architecture" },
    title: "Crash probe architecture",
    summary: "s",
    changes: [
      {
        kind: "add_architecture",
        content: {
          architecture: {
            summary: "Probe architecture",
            components: [{ name: "Core", summary: "kernel of the system" }],
            boundaries: [{ name: "Core edge", description: "everything else talks to Core" }],
            dataFlows: [{ from: "UI", to: "Core", description: "commands" }],
            principles: [{ statement: "committed memory is authoritative" }],
          },
        },
      },
      {
        kind: "add_constraint",
        content: { constraint: { statement: "single writer", source: "environment", severity: "hard" } },
      },
      { kind: "complete_architecture" },
    ],
  });
} else {
  controller.issueStartAdmission("ses_crash");
  run = (await controller.startOrResume("ses_crash")).run;
  run = transition(run, "architecture");
  run = await store.saveRun(run);
  run = transition(run, "detail");
  run = await store.saveRun(run);

  prepared = await controller.prepareProposal("ses_crash", {
    type: "design_checkpoint",
    scope: { type: "architecture" },
    title: "Crash probe proposal",
    summary: "s",
    changes: [
      { kind: "add_decision", content: { decision: { title: "Crash decision", statement: "s", rationale: "r" } } },
    ],
  });
}

const begun = await controller.beginProposalApproval("ses_crash", prepared.proposal.id);
const { approval } = await controller.recordApproval("ses_crash", prepared.proposal.id, begun.request);

if (crashPoint === "before-persist") {
  // Arm the seam, then commit: die at the durable write.
  store.armCrashSeam("before-persist");
}

const commit = await store.commitTransaction({
  planID: run.id,
  proposalID: prepared.proposal.id,
  approvalID: approval.id,
});

if (crashPoint === "after-persist") {
  // The durable rename happened; the caller never saw the result. Die HERE.
  store.armCrashSeam("after-persist");
  process.abort();
}

const finalRun = await store.getRun(run.id);
const committedRevisions = (await store.listSections(run.id)).filter(
  (section) => section.currentRevision !== undefined,
).length;
console.log(
  `PROBE-COMMITTED ${commit.id} STAGE=${finalRun?.stage}` +
    ` SECTIONS=${finalRun?.sections.length ?? 0} ACTIVE=${finalRun?.activeWork?.type === "section" ? finalRun.activeWork.id : "none"}` +
    ` REVISIONS=${committedRevisions}`,
);
process.exit(0);
