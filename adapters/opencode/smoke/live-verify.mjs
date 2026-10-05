/**
 * Phase 7B §83-§89 — targeted LIVE check for E76: the FRESH VERIFIER.
 *
 * Rebuilds the deterministic supervised state, issues a verification
 * Directive (deterministic, at the store level), and dispatches it through
 * the REAL ExecutionOrchestrator → REAL OpenCodeWorkerAdapter → REAL host →
 * REAL model, proving: fresh verifier child session (lineage parent = the
 * trusted user session), verifier protocol prompt, strict payload → durable
 * ExecutionReport with workerRole=verifier.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const HOST = "http://127.0.0.1:4100";
const REPO = "C:/Users/Administrator/AppData/Local/Temp/ultra-plan-smoke";
const POLICY_BINDING = "sensenova/sensenova-6.8-flash-lite";
const TURN_TIMEOUT_MS = 420_000;

const { InMemoryPlanStore, UltraPlanController, OpenCodeWorkerAdapter, ExecutionOrchestrator, resolveExecutionModelPolicy, executionInitialHandoffKey } =
  await import("../dist/index.js");

function liveClient() {
  async function json(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
  }
  async function fetchRetry(url, options) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await fetch(url, options); } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 1000)); }
    }
    throw lastError;
  }
  async function pollAssistant(sessionID, beforeCount) {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const msgs = await json(await fetchRetry(`${HOST}/session/${sessionID}/message`));
      const assistants = (Array.isArray(msgs) ? msgs : []).filter((m) => m.info?.role === "assistant");
      if (assistants.length > beforeCount) {
        const last = assistants.at(-1);
        if (last.info?.time?.completed !== undefined) return { info: last.info, parts: last.parts ?? [] };
      }
    }
    return undefined;
  }
  const sessions = [];
  const requests = [];
  return {
    sessions, requests,
    session: {
      async create(input) {
        const res = await fetchRetry(`${HOST}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input?.body ?? {}) });
        const data = await json(res);
        if (data?.id) sessions.push({ sessionID: data.id, parentID: input?.body?.parentID ?? null });
        return { data, error: res.ok ? undefined : data };
      },
      async prompt(input) {
        const sessionID = input.path.id;
        const before = await json(await fetchRetry(`${HOST}/session/${sessionID}/message`));
        const beforeCount = (Array.isArray(before) ? before : []).filter((m) => m.info?.role === "assistant").length;
        requests.push({ sessionID, tools: input.body?.tools ?? null });
        const res = await fetchRetry(`${HOST}/session/${sessionID}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.body) });
        if (!res.ok) return { error: await res.text() };
        const final = await pollAssistant(sessionID, beforeCount);
        if (!final) return { error: "timeout waiting for assistant completion" };
        return { data: final, error: undefined };
      },
    },
  };
}

async function buildReadyState() {
  const store = new InMemoryPlanStore();
  const controller = new UltraPlanController({
    store,
    semanticValidator: { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } },
  });
  const sessionID = "ses_live_verify";
  controller.issueStartAdmission(sessionID);
  await controller.startOrResume(sessionID, "Live verify smoke");
  await controller.requestArchitecture(sessionID);
  const arch = await controller.prepareProposal(sessionID, {
    type: "architecture_completion", scope: { type: "architecture" }, title: "Complete architecture", summary: "s",
    changes: [
      { kind: "add_architecture", content: { architecture: { summary: "Append smoke lines", components: [{ name: "Scribe", summary: "appends" }], boundaries: [], dataFlows: [], principles: [] } } },
      { kind: "complete_architecture" },
    ],
  });
  const b1 = await controller.beginProposalApproval(sessionID, arch.proposal.id);
  await controller.recordApprovalAndCommit(sessionID, arch.proposal.id, b1.request);
  const decomp = await controller.prepareSectionDecomposition(sessionID, { sections: [{ key: "scribe", title: "Scribe", objective: "append the smoke line" }], initialSection: "scribe" });
  const b2 = await controller.beginProposalApproval(sessionID, decomp.proposal.id);
  await controller.recordApprovalAndCommit(sessionID, decomp.proposal.id, b2.request);
  const checkpoint = await controller.prepareSectionCheckpoint(sessionID, {
    problem: "append the line", design: "edit note.txt", interfaces: [{ name: "INote", description: "appends" }],
    invariants: [], failureModes: [], dependencies: [], decisions: [], openQuestions: [], impacts: [],
    projection: { compact: "append smoke line", contract: { provides: ["smoke-line"], requires: [], invariants: [], interfaces: [{ name: "INote" }], decisions: [] } },
  });
  const b3 = await controller.beginProposalApproval(sessionID, checkpoint.proposal.id);
  await controller.recordApprovalAndCommit(sessionID, checkpoint.proposal.id, b3.request);
  const completion = await controller.requestCompletion(sessionID, { kind: "section" });
  const b4 = await controller.beginProposalApproval(sessionID, completion.proposal.id);
  await controller.recordApprovalAndCommit(sessionID, completion.proposal.id, b4.request);
  await controller.beginSynthesis(sessionID);
  await controller.submitSynthesisManifest(sessionID, {
    crossSectionLinks: [],
    implementationOrder: [{ title: "Append the smoke line", description: "one wave", sections: [{ id: "SEC-001", revision: 1 }], sources: [{ kind: "architecture" }] }],
    limitations: [{ statement: "Smoke scope only.", sources: [{ kind: "architecture" }] }],
    unresolvedFindings: [],
  });
  await controller.runSemanticValidation(sessionID);
  const finalization = await controller.requestFinalization(sessionID);
  if (finalization.gate.result !== "pass") throw new Error("gate");
  const prepared = await controller.prepareFinalPlan(sessionID);
  const b5 = await controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await controller.recordApproval(sessionID, prepared.proposal.id, b5.request);
  await controller.commitApprovedProposal(sessionID, prepared.proposal.id);
  const planRun = await store.findLatestRunBySession(sessionID);
  const finalPlan = await store.getCurrentFinalPlan(planRun.id);
  const workspace = { key: "opencode-project:live-smoke" };
  const { run } = await store.prepareInitialExecutionRun({
    planID: planRun.id,
    finalPlan: { id: finalPlan.id, revision: finalPlan.revision },
    finalPlanHash: finalPlan.hash,
    workspace,
    executionStartBaseline: { workspaceFingerprint: `git:live-smoke@${execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim()}` },
    initialHandoffKey: executionInitialHandoffKey(planRun.id, { id: finalPlan.id, revision: finalPlan.revision }),
  });
  await store.attachExecutionSupervisor({ executionRunID: run.id, sessionID, workspace });
  const active = await store.activateSupervisedExecutionRun({ executionRunID: run.id, sessionID, workspace, generation: 1, runRevision: run.revision, finalPlan: run.finalPlan });
  await store.completePlanningRunForSupervisedHandoff(planRun.id);
  const [stage] = await store.createExecutionStages({
    executionRunID: active.id, sessionID, workspace, generation: 1,
    drafts: [{ title: "Smoke stage", objective: "append the smoke line", planRefs: [{ kind: "implementation_step", order: 1 }], completionObligations: [{ description: "note.txt carries the smoke line", planRefs: [{ kind: "implementation_step", order: 1 }] }] }],
  });
  const activated = await store.activateExecutionStage({ executionRunID: active.id, stageID: stage.id, sessionID, workspace, generation: 1, expectedRunRevision: active.revision, expectedStageRevision: stage.revision });
  const { window, run: openRun } = await store.openVerificationWindow({ executionRunID: active.id, stageID: stage.id, sessionID, workspace, generation: 1, expectedRunRevision: activated.run.revision, expectedStageRevision: activated.stage.revision });
  const obligation = (await store.getExecutionStage(stage.id)).completionObligations[0].id;
  const directive = await store.issueExecutionDirective({
    executionRunID: active.id, stageID: stage.id, windowID: window.id, sessionID, workspace, generation: 1,
    ceiling: { repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false },
    expectedRunRevision: openRun.revision, expectedStageRevision: activated.stage.revision, expectedWindowRevision: window.revision,
    draft: {
      kind: "verification",
      objective: "Verify note.txt carries the smoke line",
      planRefs: [{ kind: "implementation_step", order: 1 }],
      expectedExecutionScope: {},
      capabilityEnvelope: { repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false },
      candidateEffect: "non_mutating",
      invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [],
      reportContract: "report every file examined",
      body: "Read note.txt in the repository root and verify it contains a line mentioning smoke. Report result=completed when verified.",
      verificationCoverage: { obligationRefs: [obligation] },
    },
  });
  return { store, executionRunID: active.id, directive: { id: directive.id, revision: directive.revision, hash: directive.hash }, sessionID, workspace };
}

const { store, executionRunID, directive, sessionID, workspace } = await buildReadyState();
console.log("verification directive ready:", directive.id, "@", directive.revision);
const client = liveClient();
const policy = resolveExecutionModelPolicy({ commandName: "ultra-plan", agentName: "ultraplan", supervisorModel: POLICY_BINDING, workerModel: POLICY_BINDING, verifierModel: POLICY_BINDING });
const ceiling = { repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false };
const worker = new OpenCodeWorkerAdapter({ client, policy, hostCeiling: ceiling, timeoutMs: TURN_TIMEOUT_MS, extraHostToolNames: ["question", "ask"] });
const orchestrator = new ExecutionOrchestrator({ store, supervisor: { async runExecutionSupervisorTurn() { throw new Error("not used"); } }, worker, policy, workspace, trustedCeiling: ceiling });
const dispatch = await orchestrator.dispatchIssuedDirective({ executionRunID, directive, sessionID, generation: 1 });
console.log("dispatch:", dispatch.kind, dispatch.kind === "reported" ? `report=${dispatch.report.id} role=${dispatch.report.workerRole} result=${dispatch.report.result}` : JSON.stringify(dispatch).slice(0, 200));
const verdict = {
  freshVerifierChildSession: client.sessions.length === 1 && client.sessions[0].parentID === sessionID,
  verifierToolMap: client.requests[0]?.tools ?? null,
  report: dispatch.kind === "reported" ? { id: dispatch.report.id, role: dispatch.report.workerRole, result: dispatch.report.result } : dispatch.kind,
};
console.log(JSON.stringify(verdict, null, 2));
writeFileSync(new URL("./verify-evidence.json", import.meta.url), JSON.stringify(verdict, null, 2));
process.exit(dispatch.kind === "reported" && dispatch.report.workerRole === "verifier" ? 0 : 1);
