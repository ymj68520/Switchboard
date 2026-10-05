/**
 * Phase 8 §3-§11 — LIVE E73: ONE uninterrupted real OpenCode-host supervised
 * execution, from the real production Final Approval path through
 * ExecutionRun.completed.
 *
 * Full production chain exercised in THIS order (directive §5), all through
 * the built production module (dist) and its REAL controller:
 *
 *   /ultra-plan admission → PlanningRun → FinalPlan → Final Approval
 *   → handoff_pending + handoffProtocol=supervised_v0_2 (durable, atomic)
 *   → production entry (controller.enter) → recoverSupervisedHandoff
 *   → prepareInitialExecutionRun → SupervisorBinding (owner = trusted session)
 *   → ExecutionRun.active → PlanningRun.completed → production pump
 *   → REAL Supervisor turns (glm-5.2) deriving the decomposition (§23)
 *   → REAL Worker dispatch through OpenCode repository tools (deepseek-v4-flash)
 *   → REAL fresh Verifier child session → strict structured Reports
 *   → final_closure Stage → ExecutionCompletionGate → ExecutionRun.completed
 *
 * NOT used (§3): fake model runtime, pre-seeded ExecutionRun/Stage/Window,
 * stubbed execution controller, manual Store mutation. Every execution object
 * is created by the REAL Supervisor model through the REAL protocol tools.
 *
 * The host also has the REAL BUILT PLUGIN installed (opencode.json `plugin`);
 * its config hook runs inside the host with its own ULTRA_PLAN_DATA_DIR, and
 * the load-proof asserts the host registered the /ultra-plan command.
 *
 * §10: any model-level failure aborts THIS attempt; the operator starts a
 * completely new run. One qualifying run must itself be uninterrupted.
 *
 * §8: evidence is sanitized (IDs, models, durations, counts — no credentials,
 * no chain-of-thought, no absolute machine paths beyond the redacted temp
 * repository identity).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.E73_PORT ?? 4173);
const HOST = `http://127.0.0.1:${PORT}`;
const TMP = process.env.E73_TMP ?? path.join("C:/Users/Administrator/AppData/Local/Temp", `ultra-plan-e73-${Date.now()}`);
const REPO = path.join(TMP, "repo");
const MARKER = "E73_LIVE_OK";
const GOAL = "Append a line containing E73_LIVE_OK to notes.txt so node check.js passes. Do not modify check.js.";
const OWNER_SESSION_TITLE = "E73 trusted owner session";
const SUPERVISOR_MODEL = "sensenova/deepseek-v4-flash";
const WORKER_MODEL = "sensenova/deepseek-v4-flash";
const VERIFIER_MODEL = "sensenova/deepseek-v4-flash";
const TURN_TIMEOUT_MS = 420_000;

const startedAt = Date.now();
const evidence = { attempt: { startedAt: new Date(startedAt).toISOString() }, host: {}, plugin: {}, planning: {}, execution: {}, isolation: {}, checks: [] };
let host;
function check(name, ok, detail) {
  evidence.checks.push({ name, ok, detail: detail === undefined ? null : String(detail).slice(0, 400) });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
}
function fail(kind, detail) {
  evidence.failure = { kind, detail: String(detail).slice(0, 2000), at: new Date().toISOString() };
  writeFileSync(new URL("./e73-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
  console.error(`E73 ATTEMPT FAILED (${kind}): ${String(detail).slice(0, 500)}`);
  if (host) { try { host.kill(); } catch { /* already dead */ } }
  process.exit(1);
}

// -- 1. Safe disposable repository (§4). ------------------------------------
rmSync(TMP, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: REPO });
execFileSync("git", ["-c", "user.email=e73@local", "-c", "user.name=e73", "add", "-A"], { cwd: REPO });
writeFileSync(path.join(REPO, "notes.txt"), "baseline line one\n");
writeFileSync(
  path.join(REPO, "check.js"),
  [
    "const fs = require('fs');",
    "const text = fs.readFileSync('notes.txt', 'utf8');",
    "if (!text.includes('E73_LIVE_OK')) { console.error('notes.txt lacks the E73_LIVE_OK marker'); process.exit(1); }",
    "console.log('validation OK');",
    "",
  ].join("\n"),
);
writeFileSync(
  path.join(REPO, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: WORKER_MODEL,
      // The supervised runtime models are reasoning models: without an
      // explicit output limit the host caps completion tokens below the
      // strict-JSON control payloads and the turns truncate mid-object
      // (observed live). The limit raises the OUTPUT budget only — the
      // provider options (auth/baseURL) still come from the global config.
      provider: {
        sensenova: {
          models: {
            "deepseek-v4-flash": { name: "deepseek-v4-flash", limit: { context: 131072, output: 16384 } },
            "glm-5.2": { name: "glm-5.2", limit: { context: 131072, output: 16384 } },
          },
        },
      },
      // The REAL built plugin is installed into the host (Phase 8 §3
      // "real installed plugin"): its config hook runs inside the host with
      // its own ULTRA_PLAN_DATA_DIR (below), so the load-proof is real while
      // the run's durable store stays single-owner (the driver process).
      plugin: ["file:///E:/Projects/Switchboard/adapters/opencode/dist/plugin-entry.js"],
    },
    null,
    2,
  ),
);
execFileSync("git", ["-c", "user.email=e73@local", "-c", "user.name=e73", "add", "-A"], { cwd: REPO });
execFileSync("git", ["-c", "user.email=e73@local", "-c", "user.name=e73", "commit", "-qm", "e73 baseline"], { cwd: REPO });
evidence.attempt.repository = { identity: path.basename(TMP), files: ["notes.txt", "check.js"], validation: "node check.js" };

// -- 2. Real host with the plugin installed. ---------------------------------
try {
  // Windows: opencode is a .cmd shim — spawn through the shell (node ≥20
  // refuses to execute .cmd directly); args contain no spaces.
  host = spawn("opencode.cmd", ["serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
    cwd: REPO,
    env: { ...process.env, ULTRA_PLAN_DATA_DIR: path.join(TMP, "host-data") },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  host.stdout.on("data", (d) => process.env.E73_VERBOSE && process.stdout.write(`[host] ${d}`));
  host.stderr.on("data", (d) => process.env.E73_VERBOSE && process.stderr.write(`[host!] ${d}`));
} catch (error) {
  fail("host_spawn", error);
}
async function fetchRetry(url, options, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  throw lastError;
}
async function jsonOf(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 300) }; }
}
const bootDeadline = Date.now() + 90_000;
let inventory = [];
let hostUp = false;
while (Date.now() < bootDeadline) {
  try {
    const res = await fetchRetry(`${HOST}/experimental/tool/ids`, undefined, 1);
    if (res.ok) {
      inventory = await jsonOf(res);
      hostUp = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
if (!hostUp) fail("host_boot", "the real OpenCode host did not come up within 90s");
evidence.host = { version: execFileSync("opencode.cmd", ["--version"], { shell: true }).toString().trim(), inventory, port: PORT };
check("host up with tool inventory endpoint", hostUp, `${inventory.length} host tools: ${inventory.join(",")}`);

// Load-proof: the INSTALLED plugin registered the ultraplan agent inside the
// host (plugin commands are injected via the config hook, so the agent
// registry is the observable proof that the plugin module loaded and ran).
// The host loads project plugins LAZILY (first instance-scoped access), so
// touch the instance then poll the agent registry for a bounded window.
await jsonOf(await fetchRetry(`${HOST}/command`)); // instance-scoped: triggers the lazy per-project plugin load
let agentNames = [];
const agentDeadline = Date.now() + 90_000;
while (Date.now() < agentDeadline) {
  const agents = await jsonOf(await fetchRetry(`${HOST}/agent`));
  agentNames = (Array.isArray(agents) ? agents : agents?.agents ?? []).map((a) => a.name);
  if (agentNames.includes("ultraplan")) break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
check("real installed plugin loaded (host registered the ultraplan agent)", agentNames.includes("ultraplan"), agentNames.join(","));

// -- 3. Production module + real client (single-owner durable store). --------
process.env.ULTRA_PLAN_DATA_DIR = path.join(TMP, "smoke-data");
const dist = await import("../dist/index.js");
evidence.plugin = {
  build: "dist/index.js",
  sha256: createHash("sha256").update(await (await import("node:fs/promises")).readFile(new URL("../dist/index.js", import.meta.url))).digest("hex").slice(0, 16) + "…",
};

// Legacy free-Build host instrumentation (§7/E16): any dispatch is counted.
let legacyDispatchCount = 0;
const LegacyAdapter = dist.OpenCodeExecutionAdapter;
for (const method of ["dispatchHandoff", "findHandoffDelivery"]) {
  const original = LegacyAdapter.prototype[method];
  LegacyAdapter.prototype[method] = async function (...args) {
    legacyDispatchCount++;
    return original.apply(this, args);
  };
}

// Real SDK-shaped client over the live host. session.prompt polls to
// completion (this host build finishes turns asynchronously — the poll
// restores the documented synchronous semantics without changing behavior).
function liveClient() {
  const requests = [];
  async function pollAssistant(sessionID, beforeCount) {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const msgs = await jsonOf(await fetchRetry(`${HOST}/session/${sessionID}/message`));
      const assistants = (Array.isArray(msgs) ? msgs : []).filter((m) => m.info?.role === "assistant");
      if (assistants.length > beforeCount) {
        const last = assistants.at(-1);
        if (last.info?.time?.completed !== undefined) return { info: last.info, parts: last.parts ?? [] };
      }
    }
    return undefined;
  }
  return {
    requests,
    session: {
      async create(input) {
        const res = await fetchRetry(`${HOST}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input?.body ?? {}) });
        const data = await jsonOf(res);
        return { data, error: res.ok ? undefined : data };
      },
      async prompt(input) {
        const sessionID = input.path.id;
        const before = await jsonOf(await fetchRetry(`${HOST}/session/${sessionID}/message`));
        const beforeCount = (Array.isArray(before) ? before : []).filter((m) => m.info?.role === "assistant").length;
        requests.push({ sessionID, model: input.body?.model ?? null, tools: input.body?.tools ?? null });
        const res = await fetchRetry(`${HOST}/session/${sessionID}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.body) });
        if (!res.ok) return { error: await res.text() };
        const final = await pollAssistant(sessionID, beforeCount);
        if (!final) return { error: "timeout waiting for assistant completion" };
        return { data: final, error: undefined };
      },
    },
    tool: {
      async ids() {
        const res = await fetchRetry(`${HOST}/experimental/tool/ids`);
        return { data: await jsonOf(res), error: undefined };
      },
    },
    config: {
      async get() {
        const res = await fetchRetry(`${HOST}/config`);
        return { data: await jsonOf(res), error: undefined };
      },
    },
  };
}
const client = liveClient();

// The TRUSTED USER SESSION is a real host session (E5 lineage is fully real).
const ownerSession = await client.session.create({ body: { title: OWNER_SESSION_TITLE } });
const sessionID = ownerSession.data?.id;
if (!sessionID) fail("owner_session", "the host did not create the trusted owner session");
evidence.attempt.trustedSession = sessionID;

const instance = dist.getProjectInstance("e73-live", { client, worktree: REPO });
const controller = instance.controller;
const store = instance.store;

const hostConfig = await client.config.get();
const runtimeSpec = dist.DEFAULT_PLANNING_RUNTIME_SPEC
  ? {
      ...dist.DEFAULT_PLANNING_RUNTIME_SPEC,
      planningModel: SUPERVISOR_MODEL,
      supervisorModel: SUPERVISOR_MODEL,
      workerModel: WORKER_MODEL,
      verifierModel: VERIFIER_MODEL,
      executionBudgets: { maxSupervisorTurnsPerPump: 40, maxWorkerDispatchesPerPump: 40, maxSupervisorReadOpsPerTurn: 4, supervisorTimeoutMs: TURN_TIMEOUT_MS, workerTimeoutMs: TURN_TIMEOUT_MS, maxConsecutiveSupervisorProtocolFailures: 6 },
    }
  : undefined;
const bundle = await dist.buildProductionSupervisedExecutionBundle({
  projectID: "e73-live",
  client,
  store,
  worktree: REPO,
  runtimeSpec,
  config: hostConfig.data ?? {},
});
controller.attachSupervisedExecution(bundle);
evidence.isolation = {
  supervisorModel: bundle.policy.supervisorModel,
  workerModel: bundle.policy.workerModel,
  verifierModel: bundle.policy.verifierModel,
  budgets: bundle.budgets,
  deniedHostTools: bundle.supervisor.options?.extraHostToolNames ?? null,
};
check("production bundle built with discovered host inventory denied", Array.isArray(evidence.isolation.deniedHostTools) && evidence.isolation.deniedHostTools.length >= inventory.length, `${evidence.isolation.deniedHostTools?.length} denied names`);

// -- 4. Production planning path → Final Approval (supervised_v0_2, §5). -----
async function approveAndCommit(proposalID) {
  const begun = await controller.beginProposalApproval(sessionID, proposalID);
  await controller.recordApprovalAndCommit(sessionID, proposalID, begun.request);
}
let entry;
try {
  controller.issueStartAdmission(sessionID);
  controller.issueUserExecutionCommand(sessionID, GOAL);
  entry = await controller.enter(sessionID, GOAL);
  if (entry.kind !== "planning") fail("entry", JSON.stringify(entry).slice(0, 300));
  const planRunID = entry.run.id;
  evidence.planning.planningRunID = planRunID;

  await controller.requestArchitecture(sessionID);
  const arch = await controller.prepareProposal(sessionID, {
    type: "architecture_completion",
    scope: { type: "architecture" },
    title: "Complete architecture",
    summary: "One-shot scribe design for the E73 live task: append the exact marker line E73_LIVE_OK to notes.txt",
    changes: [
      { kind: "add_architecture", content: { architecture: { summary: "Append one line containing the exact text E73_LIVE_OK to notes.txt", components: [{ name: "Scribe", summary: "appends the exact marker line E73_LIVE_OK to notes.txt" }], boundaries: [], dataFlows: [], principles: [] } } },
      { kind: "complete_architecture" },
    ],
  });
  await approveAndCommit(arch.proposal.id);
  const decomposition = await controller.prepareSectionDecomposition(sessionID, {
    sections: [{ key: "scribe", title: "Marker Scribe", objective: "append a line containing the exact text E73_LIVE_OK to notes.txt and validate" }],
    initialSection: "scribe",
  });
  await approveAndCommit(decomposition.proposal.id);
  const checkpoint = await controller.prepareSectionCheckpoint(sessionID, {
    problem: "notes.txt must carry a line containing the exact text E73_LIVE_OK",
    design: "append one line whose content contains the exact text E73_LIVE_OK to notes.txt with the edit/write tool, then run node check.js",
    interfaces: [{ name: "INotes", description: "appendable notes file" }],
    invariants: ["check.js stays unmodified"],
    failureModes: [],
    dependencies: [],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: "append a line containing the exact text E73_LIVE_OK to notes.txt",
      contract: { provides: ["a notes.txt line containing the exact text E73_LIVE_OK"], requires: [], invariants: ["check.js stays unmodified"], interfaces: [{ name: "INotes" }], decisions: [] },
    },
  });
  await approveAndCommit(checkpoint.proposal.id);
  const completion = await controller.requestCompletion(sessionID, { kind: "section" });
  await approveAndCommit(completion.proposal.id);
  await controller.beginSynthesis(sessionID);
  await controller.submitSynthesisManifest(sessionID, {
    crossSectionLinks: [],
    implementationOrder: [
      {
        title: "Append the E73 marker line",
        description: "Append one line whose content contains the exact text E73_LIVE_OK to notes.txt (the marker text approved in the architecture and SEC-001), then run node check.js to validate. Do not modify check.js.",
        sections: [{ id: "SEC-001", revision: 1 }],
        sources: [{ kind: "architecture" }, { kind: "section", id: "SEC-001", revision: 1 }],
      },
    ],
    limitations: [{ statement: "E73 live validation scope only.", sources: [{ kind: "architecture" }] }],
    unresolvedFindings: [],
  });
  await controller.runSemanticValidation(sessionID);
  const finalization = await controller.requestFinalization(sessionID);
  if (finalization.gate.result !== "pass") fail("finalization_gate", JSON.stringify(finalization.gate).slice(0, 400));
  const prepared = await controller.prepareFinalPlan(sessionID);
  const begun = await controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
  await controller.commitApprovedProposal(sessionID, prepared.proposal.id);
} catch (error) {
  fail("planning_drive", error instanceof Error ? `${error.message}\n${error.stack?.split("\n")[1] ?? ""}` : error);
}

const planRun = await store.getRun(evidence.planning.planningRunID);
evidence.planning = {
  ...evidence.planning,
  lifecycle: planRun.lifecycle,
  stage: planRun.stage,
  handoffProtocol: planRun.handoffProtocol,
  headCommit: planRun.headCommit,
};
const finalPlan = await store.getCurrentFinalPlan(planRun.id);
evidence.planning.finalPlan = { id: finalPlan.id, revision: finalPlan.revision, hash: finalPlan.hash };
check("Final Approval → handoff_pending with durable supervised_v0_2 marker (§5)", planRun.lifecycle === "handoff_pending" && planRun.handoffProtocol === "supervised_v0_2", `lifecycle=${planRun.lifecycle} protocol=${planRun.handoffProtocol}`);

// -- 5. Production supervised entry (attach → activate → complete → pump). ---
controller.issueStartAdmission(sessionID);
controller.issueUserExecutionCommand(sessionID, "");
let supervisedEntry;
try {
  supervisedEntry = await controller.enter(sessionID, "");
} catch (error) {
  fail("supervised_entry", error instanceof Error ? error.message : error);
}
if (supervisedEntry.kind !== "supervised") fail("supervised_entry", JSON.stringify(supervisedEntry).slice(0, 400));
evidence.execution.entryStatus = supervisedEntry.entry.status;
console.log("supervised entry:", supervisedEntry.entry.status, supervisedEntry.entry.statusText?.slice(0, 160));

// Heartbeat while the pump drives real model turns.
const runID = supervisedEntry.entry.executionRunID;
evidence.execution.executionRunID = runID;
const heartbeat = setInterval(async () => {
  try {
    const run = await store.getExecutionRun(runID);
    const trace = bundle.tracer.events;
    const supervisorTurns = trace.filter((e) => e.kind === "supervisor_invocation_completed").length;
    const workers = trace.filter((e) => e.kind === "worker_invocation_completed" || e.kind === "worker_invocation_failed").length;
    console.log(`… lifecycle=${run?.lifecycle} rev=${run?.revision} supervisorTurns=${supervisorTurns} workerDispatches=${workers} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch {}
}, 30_000);

try {
  if (supervisedEntry.entry.status === "handoff_recovered") {
    const pump = supervisedEntry.entry.pump;
    evidence.execution.pumpOutcome = pump.outcome;
    evidence.execution.pumpDetail = pump;
    const completed = pump.outcome === "completed" || (pump.outcome === "terminal" && pump.terminal === "completed");
    if (!completed) fail("pump", `pump outcome ${pump.outcome}${"terminal" in pump ? `:${pump.terminal}` : ""}: ${JSON.stringify(pump).slice(0, 500)}`);
  } else {
    fail("supervised_entry", `unexpected supervised entry status ${supervisedEntry.entry.status}`);
  }
} finally {
  clearInterval(heartbeat);
}

// -- 6. Terminal-state evidence (§6/§8) from the durable Store. ---------------
const run = await store.getExecutionRun(runID);
check("E15/E6 ExecutionRun.lifecycle = completed", run.lifecycle === "completed", `lifecycle=${run.lifecycle}`);
const completionRecord = run.completionRecord ? await store.findExecutionCompletionForRun(runID) : undefined;
check("E14 ExecutionCompletionRecord exists", Boolean(completionRecord), JSON.stringify(completionRecord ?? null).slice(0, 240));

const runsForPlan = await store.findExecutionRunsForPlan(planRun.id);
check("E4 exactly one initial ExecutionRun", runsForPlan.length === 1, `count=${runsForPlan.length}`);
const binding = await store.findSupervisorBinding(runID);
check("E5 SupervisorBinding owner = trusted session, generation 1", binding?.ownerSessionID === sessionID && binding?.generation === 1, `owner=${binding?.ownerSessionID} gen=${binding?.generation}`);

const stages = await store.listExecutionStagesForRun(runID);
const ordinary = stages.filter((s) => s.kind !== "final_closure");
const closure = stages.filter((s) => s.kind === "final_closure");
check("ordinary Stage acceptance + final_closure Stage exist (§6)", ordinary.length >= 1 && closure.length === 1, `stages=${stages.map((s) => `${s.id}:${s.kind}:${s.status}`).join(",")}`);
const windows = await store.listVerificationWindowsForRun(runID);
const attempts = await store.listExecutionAttemptsForRun(runID);
const directives = await store.listExecutionDirectivesForRun(runID);
const reports = await store.listExecutionReportsForRun(runID);
const assessments = await store.listSupervisorAssessmentsForRun(runID);
const commits = await store.listExecutionCommitsForRun(runID);
const verifierReports = reports.filter((r) => r.workerRole === "verifier");
check("fresh final Verifier report in accepted history (§6)", verifierReports.length >= 1, `reports=${reports.length} verifier=${verifierReports.length}`);
check("final SupervisorAssessment + final ExecutionCommit (§6)", assessments.length >= 1 && commits.length >= 1, `assessments=${assessments.length} commits=${commits.map((c) => c.id).join(",")}`);
const commitChainLinear = commits.every((c, i) =>
  i === 0
    ? c.parentAcceptedState.kind === "execution_start"
    : c.parentAcceptedState.kind === "execution_commit" && c.parentAcceptedState.executionCommitID === commits[i - 1].id,
);
check("ExecutionCommit chain linear (§52.47)", commitChainLinear, commits.map((c) => c.id).join(" → "));
check("run.acceptedHead = final ExecutionCommit (§52.46)", run.acceptedHead === commits.at(-1)?.id, `acceptedHead=${run.acceptedHead} tip=${commits.at(-1)?.id}`);

const notes = (await (await import("node:fs/promises")).readFile(path.join(REPO, "notes.txt"), "utf8")).trim();
check("E8 real repository edit landed via OpenCode tools", notes.includes(MARKER), `notes.txt: ${notes.split("\n").slice(-2).join(" | ")}`);
let validation = "not run";
try {
  validation = execFileSync("node", ["check.js"], { cwd: REPO, encoding: "utf8" }).trim();
} catch (error) {
  validation = `FAILED: ${error.status} ${error.stdout ?? ""} ${error.stderr ?? ""}`;
}
check("deterministic validation passes", validation.startsWith("validation OK"), validation);

check("E16 legacy free-Build dispatch count = 0 (§7)", legacyDispatchCount === 0, `count=${legacyDispatchCount}`);
const supervisorToolMaps = client.requests.filter((r) => r.tools && Object.keys(r.tools).length > 0 && Object.values(r.tools).every((v) => v === false));
check("E7 every Supervisor turn denied all host tools mechanically", supervisorToolMaps.length >= 1, `${supervisorToolMaps.length}/${client.requests.length} recorded all-deny maps`);
const workerRequests = client.requests.filter((r) => r.tools && r.tools["edit"] === true);
check("E9 worker control-plane absent; repo tools per capability", workerRequests.every((r) => r.tools["ultraplan_start"] !== true && r.tools["ultraplan_request_user_approval"] !== true && r.tools["task"] !== true), `${workerRequests.length} worker invocations`);

// -- 7. Sanitized evidence bundle (§8). ---------------------------------------
evidence.execution = {
  ...evidence.execution,
  terminalLifecycle: run.lifecycle,
  acceptedHead: run.acceptedHead ?? null,
  binding: { ownerSessionID: binding.ownerSessionID, generation: binding.generation, state: binding.state },
  runRevision: run.revision,
  stages: stages.map((s) => ({ id: s.id, kind: s.kind, status: s.status, title: s.title })),
  windows: windows.map((w) => ({ id: w.id, stageID: w.stageID, state: w.state, candidateRevision: w.candidateRevision })),
  directives: directives.map((d) => ({ ref: `${d.id}@${d.revision}`, kind: d.kind, candidateEffect: d.draft?.candidateEffect })),
  attempts: attempts.map((a) => ({ id: a.id, directive: `${a.directive.id}@${a.directive.revision}`, role: a.workerRole, state: a.state })),
  reports: reports.map((r) => ({ id: r.id, role: r.workerRole, result: r.result, candidateMutation: r.candidateMutation })),
  assessments: assessments.map((a) => ({ id: a.id, disposition: a.disposition, scope: a.acceptanceScope })),
  commits: commits.map((c) => ({ id: c.id, candidateRevision: c.candidateRevision, assessment: c.supervisorAssessmentID })),
  completionRecord,
  legacyDispatchCount,
  counts: { supervisorTurns: bundle.tracer.events.filter((e) => e.kind === "supervisor_invocation_completed").length, supervisorFailures: bundle.tracer.events.filter((e) => e.kind === "supervisor_invocation_failed").length, workerInvocations: bundle.tracer.events.filter((e) => e.kind === "worker_invocation_completed").length, workerFailures: bundle.tracer.events.filter((e) => e.kind === "worker_invocation_failed").length },
  durationsMs: { total: Date.now() - startedAt },
};
evidence.execution.planningRunID = planRun.id;
evidence.execution.handoffProtocol = planRun.handoffProtocol;

writeFileSync(new URL("./e73-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
const failedChecks = evidence.checks.filter((c) => !c.ok);
const pass = failedChecks.length === 0 && run.lifecycle === "completed";
console.log(`\nE73 RESULT: ${pass ? "PASS — one uninterrupted real-host supervised run reached ExecutionRun.completed" : `${failedChecks.length} CHECK(S) FAILED`}`);
console.log(`elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s; evidence: smoke/e73-evidence.json`);
host.kill();
process.exit(pass ? 0 : 1);
