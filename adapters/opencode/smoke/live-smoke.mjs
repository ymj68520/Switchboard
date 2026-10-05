/**
 * Phase 7B §83-§89 — LIVE OpenCode host staging smoke.
 *
 * Drives the REAL production runtime (OpenCodeSupervisorAdapter +
 * OpenCodeWorkerAdapter + ExecutionOrchestrator) against a REAL headless
 * OpenCode host (opencode serve 1.18.11) with a REAL model
 * (sensenova/sensenova-6.8-flash-lite) inside a SAFE temporary git repository.
 *
 * Proves: real client.session.create/prompt, real per-call model selection,
 * real per-call tool isolation (E74 supervisor repo-tools absent / E75 worker
 * control-plane absent), real repository edit, real strict WorkerReportPayload
 * → durable ExecutionReport (E77), real Supervisor structured control output
 * → exact registered operation (E78), fresh Verifier child session (E76).
 *
 * Bounded: every wait has a deadline; no unbounded retries. The Stage/Window
 * bootstrap is deterministic (store-level) so the live-model interaction is
 * bounded to the protocol calls under test; the §23 derivation-by-Supervisor
 * property is proven by the deterministic E2E suite.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import {
  InMemoryPlanStore,
  UltraPlanController,
  OpenCodeSupervisorAdapter,
  OpenCodeWorkerAdapter,
  ExecutionOrchestrator,
  resolveExecutionModelPolicy,
  executionInitialHandoffKey,
} from "../dist/index.js";

const HOST = "http://127.0.0.1:4100";
const REPO = "C:/Users/Administrator/AppData/Local/Temp/ultra-plan-smoke";
const POLICY_BINDING = "sensenova/sensenova-6.8-flash-lite";
const TURN_TIMEOUT_MS = 420_000;

const evidence = { checks: [], sessions: [], requests: [] };
function check(name, ok, detail) {
  evidence.checks.push({ name, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// -- A real SDK-shaped client over the live host, with bounded completion polling
// (this host build accepts the turn and finishes it asynchronously; the poll
// restores the synchronous semantics the 1.18.32 SDK documents).
function liveClient() {
  async function json(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
  }
  // The host occasionally resets keep-alive connections under long polls —
  // bounded retry (3 attempts) keeps the smoke deterministic about TIME, not
  // about model behavior.
  async function fetchRetry(url, options) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetch(url, options);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
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
  return {
    session: {
      async create(input) {
        const res = await fetchRetry(`${HOST}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input?.body ?? {}),
        });
        const data = await json(res);
        if (data?.id) evidence.sessions.push({ sessionID: data.id, parentID: input?.body?.parentID ?? null });
        return { data, error: res.ok ? undefined : data };
      },
      async prompt(input) {
        const sessionID = input.path.id;
        const before = await json(await fetchRetry(`${HOST}/session/${sessionID}/message`));
        const beforeCount = (Array.isArray(before) ? before : []).filter((m) => m.info?.role === "assistant").length;
        evidence.requests.push({ sessionID, model: input.body?.model ?? null, tools: input.body?.tools ?? null, agent: input.body?.agent ?? null });
        const res = await fetchRetry(`${HOST}/session/${sessionID}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.body),
        });
        if (!res.ok) return { error: await res.text() };
        const final = await pollAssistant(sessionID, beforeCount);
        if (!final) return { error: "timeout waiting for assistant completion" };
        return { data: final, error: undefined };
      },
    },
  };
}

// -- The deterministic planning drive to a supervised-ACTIVE execution state.
async function buildSupervisedState() {
  const store = new InMemoryPlanStore();
  const controller = new UltraPlanController({
    store,
    semanticValidator: { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } },
  });
  const sessionID = "ses_live_smoke";
  controller.issueStartAdmission(sessionID);
  await controller.startOrResume(sessionID, "Live smoke: append a smoke line to note.txt");
  await controller.requestArchitecture(sessionID);
  const archCompletion = await controller.prepareProposal(sessionID, {
    type: "architecture_completion",
    scope: { type: "architecture" },
    title: "Complete architecture",
    summary: "s",
    changes: [
      { kind: "add_architecture", content: { architecture: { summary: "Append smoke lines", components: [{ name: "Scribe", summary: "appends lines" }], boundaries: [], dataFlows: [], principles: [] } } },
      { kind: "complete_architecture" },
    ],
  });
  const archBegun = await controller.beginProposalApproval(sessionID, archCompletion.proposal.id);
  await controller.recordApprovalAndCommit(sessionID, archCompletion.proposal.id, archBegun.request);
  const decomposition = await controller.prepareSectionDecomposition(sessionID, {
    sections: [{ key: "scribe", title: "Scribe", objective: "append the smoke line" }],
    initialSection: "scribe",
  });
  const dagBegun = await controller.beginProposalApproval(sessionID, decomposition.proposal.id);
  await controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
  const checkpoint = await controller.prepareSectionCheckpoint(sessionID, {
    problem: "append the line",
    design: "use the edit tool on note.txt",
    interfaces: [{ name: "INote", description: "appends" }],
    invariants: [],
    failureModes: [],
    dependencies: [],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: "append smoke line",
      contract: { provides: ["smoke-line"], requires: [], invariants: [], interfaces: [{ name: "INote" }], decisions: [] },
    },
  });
  const checkpointBegun = await controller.beginProposalApproval(sessionID, checkpoint.proposal.id);
  await controller.recordApprovalAndCommit(sessionID, checkpoint.proposal.id, checkpointBegun.request);
  const completion = await controller.requestCompletion(sessionID, { kind: "section" });
  const completionBegun = await controller.beginProposalApproval(sessionID, completion.proposal.id);
  await controller.recordApprovalAndCommit(sessionID, completion.proposal.id, completionBegun.request);
  await controller.beginSynthesis(sessionID);
  await controller.submitSynthesisManifest(sessionID, {
    crossSectionLinks: [],
    implementationOrder: [
      {
        title: "Append the smoke line",
        description: "One delivery wave appending the smoke line to note.txt.",
        sections: [{ id: "SEC-001", revision: 1 }],
        sources: [{ kind: "architecture" }],
      },
    ],
    limitations: [{ statement: "Smoke scope only.", sources: [{ kind: "architecture" }] }],
    unresolvedFindings: [],
  });
  await controller.runSemanticValidation(sessionID);
  const finalization = await controller.requestFinalization(sessionID);
  if (finalization.gate.result !== "pass") throw new Error(`gate ${finalization.gate.result}`);
  const prepared = await controller.prepareFinalPlan(sessionID);
  const begun = await controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
  await controller.commitApprovedProposal(sessionID, prepared.proposal.id);
  const planRun = await store.findLatestRunBySession(sessionID);
  const finalPlan = await store.getCurrentFinalPlan(planRun.id);
  const workspace = { key: "opencode-project:live-smoke" };
  const head = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();
  const { run } = await store.prepareInitialExecutionRun({
    planID: planRun.id,
    finalPlan: { id: finalPlan.id, revision: finalPlan.revision },
    finalPlanHash: finalPlan.hash,
    workspace,
    executionStartBaseline: { workspaceFingerprint: `git:live-smoke@${head}`, vcs: { type: "git", commit: head, branch: "main" } },
    initialHandoffKey: executionInitialHandoffKey(planRun.id, { id: finalPlan.id, revision: finalPlan.revision }),
  });
  await store.attachExecutionSupervisor({ executionRunID: run.id, sessionID, workspace });
  const active = await store.activateSupervisedExecutionRun({
    executionRunID: run.id, sessionID, workspace, generation: 1, runRevision: run.revision, finalPlan: run.finalPlan,
  });
  await store.completePlanningRunForSupervisedHandoff(planRun.id);
  // Deterministic Stage/Window bootstrap (see header note) so the live-model
  // interaction is bounded to the protocol calls under test.
  const [stage] = await store.createExecutionStages({
    executionRunID: active.id,
    sessionID, workspace, generation: 1,
    drafts: [{
      title: "Smoke stage",
      objective: "append the smoke line to note.txt",
      planRefs: [{ kind: "implementation_step", order: 1 }],
      completionObligations: [{ description: "note.txt carries the smoke line", planRefs: [{ kind: "implementation_step", order: 1 }] }],
    }],
  });
  const activated = await store.activateExecutionStage({
    executionRunID: active.id, stageID: stage.id, sessionID, workspace, generation: 1,
    expectedRunRevision: active.revision, expectedStageRevision: stage.revision,
  });
  await store.openVerificationWindow({
    executionRunID: active.id, stageID: stage.id, sessionID, workspace, generation: 1,
    expectedRunRevision: activated.run.revision, expectedStageRevision: activated.stage.revision,
  });
  return { store, executionRunID: active.id, stageID: stage.id, sessionID, workspace };
}

// -- Main.
const { store, executionRunID, stageID, sessionID, workspace } = await buildSupervisedState();
console.log(`supervised state ready: ${executionRunID} stage ${stageID}`);
const client = liveClient();
const policy = resolveExecutionModelPolicy({
  commandName: "ultra-plan", agentName: "ultraplan",
  supervisorModel: POLICY_BINDING, workerModel: POLICY_BINDING, verifierModel: POLICY_BINDING,
});
const trustedCeiling = { repositoryRead: true, repositoryWrite: true, commandExecution: true, networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false };
const supervisor = new OpenCodeSupervisorAdapter({
  client, store, policy, trustedCeiling, timeoutMs: TURN_TIMEOUT_MS, maxReadRounds: 4,
});
const worker = new OpenCodeWorkerAdapter({ client, policy, hostCeiling: trustedCeiling, timeoutMs: TURN_TIMEOUT_MS });
const orchestrator = new ExecutionOrchestrator({ store, supervisor, worker, policy, workspace, trustedCeiling });

// -- E74/E78: ONE real Supervisor turn issues the implementation Directive.
console.log("supervisor turn 1 (issue implementation directive)…");
const turn1 = await supervisor.runExecutionSupervisorTurn({ executionRunID, trustedAuthority: { sessionID, workspace, generation: 1 } });
console.log("supervisor outcome 1:", JSON.stringify(turn1).slice(0, 300));
check("E78 supervisor strict control output → exact registered operation", turn1.outcome === "directive_issued", JSON.stringify(turn1).slice(0, 160));

if (turn1.outcome === "directive_issued") {
  console.log("dispatching worker through the real orchestrator…");
  const dispatch = await orchestrator.dispatchIssuedDirective({
    executionRunID, directive: turn1.directive, sessionID, generation: 1,
  });
  console.log("dispatch:", dispatch.kind, dispatch.kind === "reported" ? `report=${dispatch.report.id} result=${dispatch.report.result}` : "");
  check("E77 strict WorkerReportPayload → durable ExecutionReport", dispatch.kind === "reported",
    dispatch.kind === "reported" ? `report ${dispatch.report.id} result=${dispatch.report.result}` : JSON.stringify(dispatch).slice(0, 200));

  const note = readFileSync(`${REPO}/note.txt`, "utf8");
  check("real repository edit landed", note.includes("smoke"), note.split("\n").filter(Boolean).slice(-2).join(" | "));

  console.log("supervisor turn 2 (issue verification directive)…");
  const turn2 = await supervisor.runExecutionSupervisorTurn({ executionRunID, trustedAuthority: { sessionID, workspace, generation: 1 } });
  console.log("supervisor outcome 2:", JSON.stringify(turn2).slice(0, 300));
  if (turn2.outcome === "directive_issued") {
    const verify = await orchestrator.dispatchIssuedDirective({ executionRunID, directive: turn2.directive, sessionID, generation: 1 });
    check("E76 fresh Verifier child session + strict verification report", verify.kind === "reported",
      verify.kind === "reported" ? `report ${verify.report.id} role=${verify.report.workerRole}` : JSON.stringify(verify).slice(0, 160));
  } else if (turn2.outcome === "blocked_runtime" && (turn2.reason ?? "").includes("reconciliation_required")) {
    // The frozen P0 gate fired LIVE: a side-effecting indeterminate Attempt
    // blocks verification until reconciliation — recorded as positive evidence.
    check("frozen reconciliation gate fires live after an indeterminate may_mutate attempt", true, turn2.reason);
    check("E76 fresh Verifier child session + strict verification report", false, "live model could not complete a full worker turn (see E77) — LIVE EXIT GATE PENDING per directive §89");
  } else {
    check("E76 fresh Verifier child session + strict verification report", false, JSON.stringify(turn2).slice(0, 160));
  }
} else {
  check("E77 strict WorkerReportPayload → durable ExecutionReport", false, "turn 1 did not issue a directive");
  check("real repository edit landed", false, "turn 1 did not issue a directive");
  check("E76 fresh Verifier child session + strict verification report", false, "turn 1 did not issue a directive");
}

// -- Isolation evidence from the RECORDED per-call tool maps.
const supervisorTools = evidence.requests[0]?.tools ?? {};
check("E74 supervisor repository/shell tools mechanically absent", Object.keys(supervisorTools).length > 0 && Object.values(supervisorTools).every((value) => value === false), JSON.stringify(supervisorTools).slice(0, 240));
const workerTools = evidence.requests[1]?.tools ?? {};
check("E75 worker repo tools per capability; control-plane tools absent", workerTools["edit"] === true && workerTools["ultraplan_start"] !== true && workerTools["ultraplan_request_user_approval"] !== true, JSON.stringify(workerTools).slice(0, 260));
check("fresh child session per invocation (E76 lineage)", evidence.sessions.length >= 3, `${evidence.sessions.length} sessions: ${JSON.stringify(evidence.sessions.map((s) => ({ parent: s.parentID }))).slice(0, 120)}`);

writeFileSync(new URL("./smoke-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
const failed = evidence.checks.filter((c) => !c.ok);
console.log(`\nSMOKE RESULT: ${failed.length === 0 ? "ALL CHECKS PASS" : `${failed.length} CHECK(S) FAILED`}`);
process.exit(failed.length === 0 ? 0 : 1);
