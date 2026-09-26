/**
 * Phase 12 test helpers — synthesis/validation fixtures.
 *
 * A SynthesisFixture is a run frozen at stage synthesis with a real frozen
 * SynthesisInput (created by the REAL engine path: the last section
 * completion that reached DETAIL_COMPLETE built it in the same transaction).
 */
import * as path from "node:path";

import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { createBlobStore } from "../src/store/blob-store.js";
import { getLatestSynthesisInputInTx } from "../src/store/synthesis.js";
import { createSectionWorkflowService } from "../src/application/section-workflow-service.js";
import { executePhasePlanTool, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { loadHostSecret } from "../src/host/secret.js";
import {
  buildHostContextEnvelopeV2,
  encodeHostContextTokenV2,
  businessInputHashOf,
} from "../src/host/host-context.js";
import { makeProposalFixture, type ProposalFixture } from "./proposal-helpers.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";
import { commitPrepared } from "./context-helpers.js";
import {
  dagChanges,
  driveToDetail,
  withCounterServices,
  type DetailFixture,
} from "./phase11-helpers.js";
import { completeSectionVia } from "./section-workflow.test.js";
import { hostToken } from "./context-helpers.js";
import { getWorkspaceById, type WorkspaceRecord } from "../src/store/repositories.js";
import { createEvidenceService } from "../src/application/evidence-service.js";
import type { BlobStore } from "../src/store/blob-store.js";

export type { DetailFixture };

let captureIdCounter = 0;

/** Observation/Evidence machinery bound to ANY proposal-rooted fixture. */
export function observationDepsFor(f: ProposalFixture & { root?: string }) {
  const root = f.root ?? makeTempPluginDataRoot("phase-plan-obs-");
  const workspace = getWorkspaceById(f.store, f.workspaceId);
  if (workspace === null) throw new Error("bound workspace missing from the catalog");
  const blobs: BlobStore = createBlobStore(path.join(root, "blobs"));
  return {
    store: f.store,
    clock: {
      nowIso: () => new Date(0).toISOString(),
      newId: () => `obs${(captureIdCounter += 1)}`,
    },
    runId: f.runId,
    workspace: workspace as WorkspaceRecord,
    blobs,
    workspaceRoot: workspace.canonicalRoot,
  };
}

/**
 * Promote one critical source_fact over a freshly captured observation of
 * `relativePath` (written under the fixture workspace root with `content`).
 */
export async function promoteCriticalSource(
  f: ProposalFixture & { root?: string; workspaceRoot?: string },
  relativePath: string,
  content: string,
  operationId: string,
): Promise<{ evidenceId: string; revision: number }> {
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const { captureObservation } = await import("../src/observations/capture.js");
  // Fingerprints resolve against the registered workspace root (§13).
  const workspace = getWorkspaceById(f.store, f.workspaceId);
  if (workspace === null) throw new Error("bound workspace missing from the catalog");
  const workspaceRoot = f.workspaceRoot ?? workspace.canonicalRoot;
  const absolute = nodePath.join(workspaceRoot, relativePath);
  fs.mkdirSync(nodePath.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  const deps = observationDepsFor(f);
  const outcome = await captureObservation(deps, {
    sessionId: f.sessionId,
    toolName: "Read",
    toolUseId: `call_${operationId.replace(/[^a-z0-9]/gi, "")}`,
    toolInput: { file_path: absolute },
    toolResponse: { type: "text", file: { filePath: relativePath, content } },
    cwd: workspaceRoot,
  });
  if (outcome.status !== "captured") throw new Error(`observation capture failed: ${outcome.status}`);
  const observationId = (outcome as { status: "captured"; observation: { observationId: string } }).observation.observationId;
  const service = createEvidenceService(f.store, deps.blobs, {
    nowIso: () => new Date(0).toISOString(),
    newId: (() => {
      let n = 0;
      return () => `evp${(n += 1)}`;
    })(),
  });
  const result = service.promoteEvidence({
    runId: f.runId,
    workspaceId: f.workspaceId,
    request: {
      claim: `source ${relativePath} declares its frozen content`,
      kind: "source_fact",
      scope: { type: "global" },
      confidence: "direct",
      criticality: "critical",
      observationRefs: [observationId],
      derivedFrom: [],
    },
    operationId,
  });
  return { evidenceId: result.evidence.evidenceId, revision: result.evidence.revision };
}

export function inputOf(f: DetailFixture): { inputId: string; inputHash: string } {
  return f.store.withRead((tx) => {
    const input = getLatestSynthesisInputInTx(tx, f.runId);
    if (input === null) throw new Error("no synthesis input exists");
    return { inputId: input.inputId, inputHash: input.inputHash };
  });
}

let selectClock = 0;

/** Select through the real service; keeps the fixture's run-revision fence current. */
export function selectSection(f: DetailFixture, sectionId: string): void {
  const run = getPlanningRunRecord(f.store, f.runId);
  if (run === null) throw new Error("fixture run vanished");
  createSectionWorkflowService(f.store, {
    nowIso: () => new Date().toISOString(),
    newId: () => `sel-${(selectClock += 1)}`,
  }).selectSection({
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    expectedRunRevision: run.revision,
    sectionId,
  });
  const after = getPlanningRunRecord(f.store, f.runId);
  if (after !== null) (f as { runRevision: number }).runRevision = after.revision;
}

/** A run at stage synthesis with a frozen SynthesisInput over a 2-section DAG. */
export interface SynthesisFixture extends DetailFixture {
  inputId: string;
  inputHash: string;
  sectionIds: string[];
}

/** Drive a fresh fixture to DETAIL, then complete every section → synthesis. */
export async function makeSynthesisFixture(sessionId = "S1"): Promise<SynthesisFixture> {
  const root = makeTempPluginDataRoot("phase-plan-synthesis-");
  const base = await makeProposalFixture(root, { sessionId });
  const fixture = withCounterServices(base);
  driveToDetail(fixture);
  const prepared = fixture.proposals.prepareProposal({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    expectedRunRevision: fixture.runRevision,
    type: "design_checkpoint",
    scope: { kind: "detail" },
    title: "Initial section DAG",
    summary: "two independent sections",
    changes: dagChanges([{ title: "Alpha" }, { title: "Beta" }]),
  });
  commitPrepared(fixture, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
  const sectionIds = [...new Set(prepared.candidateRefs.filter((ref) => ref.kind === "section").map((ref) => ref.id))].sort();

  const close = () => {
    fixture.store.close();
    removeTempPluginDataRoot(root);
  };
  const wrapped = { ...fixture, root, close } as SynthesisFixture;
  for (const sectionId of sectionIds) {
    selectSection(wrapped, sectionId);
    completeSectionVia(wrapped, sectionId, 1);
  }
  const input = inputOf(wrapped);
  wrapped.inputId = input.inputId;
  wrapped.inputHash = input.inputHash;
  wrapped.sectionIds = sectionIds;
  const run = getPlanningRunRecord(wrapped.store, wrapped.runId);
  if (run === null || run.stage !== "synthesis") throw new Error("fixture did not reach synthesis");
  return wrapped;
}

/**
 * A synthesis fixture whose frozen input contains ONE critical fingerprint
 * evidence ref (required by the introducing DAG proposal). `evidenceRelative`
 * is the workspace-relative source path — mutate it to simulate drift.
 */
export interface EvidenceSynthesisFixture extends SynthesisFixture {
  evidenceId: string;
  evidenceRevision: number;
  workspaceRoot: string;
}

export async function makeEvidenceSynthesisFixture(sessionId = "S1"): Promise<EvidenceSynthesisFixture> {
  const root = makeTempPluginDataRoot("phase-plan-syn-ev-");
  const base = await makeProposalFixture(root, { sessionId });
  const fixture = withCounterServices(base);
  const close = () => {
    fixture.store.close();
    removeTempPluginDataRoot(root);
  };
  const f = { ...fixture, root, close } as EvidenceSynthesisFixture;
  driveToDetail(f);
  const { getWorkspaceById } = await import("../src/store/repositories.js");
  const workspaceRoot = getWorkspaceById(f.store, f.workspaceId)!.canonicalRoot;
  f.workspaceRoot = workspaceRoot;
  const promoted = await promoteCriticalSource(f, "src/syn-ev.txt", "SYN EVIDENCE SOURCE v1\n", "promote:syn-ev-1");
  f.evidenceId = promoted.evidenceId;
  f.evidenceRevision = promoted.revision;
  const prepared = f.proposals.prepareProposal({
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    expectedRunRevision: f.runRevision,
    type: "design_checkpoint",
    scope: { kind: "detail" },
    title: "Initial section DAG",
    summary: "two independent sections",
    changes: dagChanges([{ title: "Alpha" }, { title: "Beta" }]),
    requiredEvidence: [{ evidenceId: promoted.evidenceId, revision: promoted.revision }],
  });
  commitPrepared(f, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
  const sectionIds = [...new Set(prepared.candidateRefs.filter((ref) => ref.kind === "section").map((ref) => ref.id))].sort();
  for (const sectionId of sectionIds) {
    selectSection(f, sectionId);
    completeSectionVia(f, sectionId, 1);
  }
  const input = inputOf(f);
  f.inputId = input.inputId;
  f.inputHash = input.inputHash;
  f.sectionIds = sectionIds;
  const run = getPlanningRunRecord(f.store, f.runId);
  if (run === null || run.stage !== "synthesis") throw new Error("fixture did not reach synthesis");
  return f;
}

/** Signed V1 host token (main-session call). */
export const mainToken = hostToken;/** Signed V2 host token with optional agent attestation (Phase 12 §6). */
export function hostTokenV2(
  secret: Buffer,
  logical: string,
  businessInput: Record<string, unknown>,
  ids: { sessionId: string; workspaceId: string; runId?: string; generation?: number },
  options: { permissionMode?: string; toolUseId?: string; agent?: { agentId?: string; agentType?: string } } = {},
): string {
  return encodeHostContextTokenV2(
    secret,
    buildHostContextEnvelopeV2({
      sessionId: ids.sessionId,
      promptId: "PROMPT-1",
      workspaceId: ids.workspaceId,
      ...(ids.runId === undefined ? {} : { runId: ids.runId }),
      ...(ids.generation === undefined ? {} : { bindingGeneration: ids.generation }),
      permissionMode: options.permissionMode ?? "plan",
      toolUseId: options.toolUseId ?? "TU-P12",
      toolName: `mcp__plugin_phase-plan_phase-plan__${logical}`,
      businessInputHash: businessInputHashOf(businessInput),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    }),
  );
}

/** A minimal legal manifest for the fixture's frozen input. */
export function minimalManifest(f: SynthesisFixture, inputId?: string, inputHash?: string) {
  const sectionRefs = f.sectionIds.map((id) => ({ kind: "section" as const, id, revision: 1 }));
  return {
    version: 1 as const,
    inputId: inputId ?? f.inputId,
    inputHash: inputHash ?? f.inputHash,
    crossSectionLinks: [
      { statement: "Alpha and Beta share the approved boundary", supportingRefs: sectionRefs },
    ],
    implementationOrder: [
      { stepId: "step-1", title: "Implement Alpha", description: "build alpha", dependsOn: [], supportingRefs: [sectionRefs[0]] },
      { stepId: "step-2", title: "Implement Beta", description: "build beta after alpha", dependsOn: ["step-1"], supportingRefs: [sectionRefs[1]] },
    ],
    limitations: [
      { statement: "Runtime behavior is bounded by the committed constraints", supportingRefs: sectionRefs },
    ],
    unresolvedFindings: [],
  };
}

/** MCP tool context over a fixture with a root. */
export function toolContextOf(f: ProposalFixture & { root?: string }): PhasePlanToolContext {
  const root = f.root ?? makeTempPluginDataRoot("phase-plan-ctx-");
  return {
    store: f.store,
    secret: loadHostSecret(root).key,
    clock: {
      nowIso: () => new Date().toISOString(),
      newId: (() => {
        let i = 0;
        return () => `tc-${(i += 1)}`;
      })(),
    },
    blobs: createBlobStore(path.join(root, "blobs")),
  };
}

/** submit_synthesis through the MCP handler with a signed main-session V1 token. */
export function callSubmitSynthesis(
  ctx: PhasePlanToolContext,
  f: SynthesisFixture,
  manifest: ReturnType<typeof minimalManifest>,
  options: { toolUseId?: string; permissionMode?: string } = {},
) {
  const ids = { sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, generation: f.generation };
  const business = {
    input_id: manifest.inputId,
    input_hash: manifest.inputHash,
    cross_section_links: manifest.crossSectionLinks,
    implementation_order: manifest.implementationOrder,
    limitations: manifest.limitations,
    unresolved_findings: manifest.unresolvedFindings,
  };
  const token = hostToken(ctx.secret, "submit_synthesis", business, ids, {
    permissionMode: options.permissionMode ?? "plan",
    toolUseId: options.toolUseId ?? "TU-SYN-1",
  });
  return executePhasePlanTool(ctx, "submit_synthesis", { ...business, _hostContext: token }) as {
    status: string;
    idempotent: boolean;
    manifest_id: string;
    manifest_hash: string;
    stage: string;
    run_revision: number;
  };
}

/** The validator attestation the real host would inject for phase-plan:validator. */
export const VALIDATOR_AGENT = { agentId: "agent_probe_1", agentType: "phase-plan:validator" } as const;

/** submit_validation through the MCP handler with a signed V2 validator token. */
export function callSubmitValidation(
  ctx: PhasePlanToolContext,
  f: SynthesisFixture,
  args: { manifest_id: string; manifest_hash: string; findings: unknown[] },
  options: { toolUseId?: string; agent?: { agentId?: string; agentType?: string }; inputId?: string; inputHash?: string } = {},
) {
  const ids = { sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, generation: f.generation };
  const business = {
    manifest_id: args.manifest_id,
    manifest_hash: args.manifest_hash,
    input_id: options.inputId ?? f.inputId,
    input_hash: options.inputHash ?? f.inputHash,
    findings: args.findings,
  };
  const token = hostTokenV2(ctx.secret, "submit_validation", business, ids, {
    permissionMode: "plan",
    toolUseId: options.toolUseId ?? "TU-VAL-1",
    // No default: callers pass the validator attestation explicitly so a
    // plain (agent-less) V2 token models the main-session impersonation case.
    agent: options.agent,
  });
  return executePhasePlanTool(ctx, "submit_validation", { ...business, _hostContext: token }) as {
    status: string;
    idempotent: boolean;
    report_id: string;
    report_hash: string;
    is_clean: boolean;
    finding_ids: string[];
  };
}

/** request_reopen through the MCP handler with a signed V2 token. */
export function callRequestReopen(
  ctx: PhasePlanToolContext,
  f: SynthesisFixture,
  args: { target: "detail" | "architecture"; reason: string; finding_ids?: string[] },
  options: { toolUseId?: string; agent?: { agentId?: string; agentType?: string } } = {},
) {
  const ids = { sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, generation: f.generation };
  const business = { target: args.target, reason: args.reason, ...(args.finding_ids ? { finding_ids: args.finding_ids } : {}) };
  const token = hostTokenV2(ctx.secret, "request_reopen", business, ids, {
    permissionMode: "plan",
    toolUseId: options.toolUseId ?? "TU-REO-1",
    agent: options.agent,
  });
  return executePhasePlanTool(ctx, "request_reopen", { ...business, _hostContext: token }) as {
    status: string;
    stage: string;
    run_revision: number;
    review_event: string;
    sections_needing_review: string[];
  };
}
