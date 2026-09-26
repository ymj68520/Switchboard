/**
 * Live-host fixture seam (Phase 7/8 live validation only).
 *
 * Phase 7 mode (default): prepares a legitimate awaiting_approval Proposal on
 * the CURRENT active run of the host-managed store, using the same
 * application services the runtime itself uses. It never fabricates
 * authorization: it only exercises the domain's own prepare path.
 *
 * Phase 8 mode (PHASE_PLAN_LIVE_FIXTURE_MODE=phase8): additionally commits
 * the prepared checkpoint through the Phase 6 engine using the TEST-ONLY
 * authorization factory (makeTestUserAuthorization — the sanctioned fixture
 * seam, never exported by any production surface), so the live run carries a
 * real HEAD commit/snapshot with a hard constraint for compaction-recovery
 * validation, then leaves a second proposal awaiting approval.
 *
 * The test is inert unless PHASE_PLAN_LIVE_STORE points at the live plugin
 * data root, so the normal suite skips it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { createPlanCommitEngine } from "../src/application/plan-commit-engine.js";
import { createProposalService } from "../src/application/proposal-service.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { createStoreContextSource } from "../src/application/context-read-model.js";
import { assembleContext } from "../src/context/assembler.js";
import { buildRecoveryCapsule } from "../src/context/capsule.js";
import { getHeadSnapshotRecord } from "../src/store/plan-memory.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { systemStoreClock } from "../src/store/clock.js";
import { makeTestUserAuthorization } from "./proposal-helpers.js";

const liveRoot = process.env.PHASE_PLAN_LIVE_STORE;
const tag = process.env.PHASE_PLAN_LIVE_FIXTURE_TAG ?? "1";
const phase8 = process.env.PHASE_PLAN_LIVE_FIXTURE_MODE === "phase8";
const phase12 = process.env.PHASE_PLAN_LIVE_FIXTURE_MODE === "phase12";
const phase13 = process.env.PHASE_PLAN_LIVE_FIXTURE_MODE === "phase13";
const phase13drift = process.env.PHASE_PLAN_LIVE_FIXTURE_MODE === "phase13-drift";
const phase10 = process.env.PHASE_PLAN_LIVE_FIXTURE_MODE === "phase10";
const phase10Revise = process.env.PHASE_PLAN_LIVE_FIXTURE_MODE === "phase10-revise";
const d = liveRoot === undefined ? describe.skip : describe;

d("live fixture (guarded by PHASE_PLAN_LIVE_STORE)", () => {
  it("prepares one awaiting_approval proposal on the current active run", async () => {
    expect(liveRoot).toBeDefined();
    expect(fs.existsSync(path.join(liveRoot!, "store", "phase-plan.sqlite3"))).toBe(true);

    const clock = systemStoreClock();
    const store: PlanStore = await initializePlanStore({ pluginDataRoot: liveRoot! });
    try {
      const current = store.withRead((tx) =>
        tx
          .prepare(
            `SELECT b.session_id AS sessionId, b.run_id AS runId, b.generation AS generation,
                    r.workspace_id AS workspaceId, r.stage AS stage, r.revision AS revision
             FROM session_bindings b JOIN planning_runs r ON r.run_id = b.run_id
             WHERE b.state = 'attached' AND r.lifecycle = 'active'
             ORDER BY b.updated_at DESC LIMIT 1`,
          )
          .get(),
      ) as
        | { sessionId: string; runId: string; generation: number; workspaceId: string; stage: string; revision: number }
        | undefined;
      expect(current).toBeDefined();

      const runs = createPlanningRunService(store, clock);
      let revision = current!.revision;
      if (current!.stage === "discovery") {
        const transitioned = runs.transitionRun({
          runId: current!.runId,
          workspaceId: current!.workspaceId,
          sessionId: current!.sessionId,
          bindingGeneration: current!.generation,
          expectedRevision: revision,
          event: "DISCOVERY_COMPLETE",
        });
        revision = transitioned.revision;
      }

      const proposals = createProposalService(store, clock);
      const prepare = (changes: Parameters<typeof proposals.prepareProposal>[0]["changes"], title: string) =>
        proposals.prepareProposal({
          runId: current!.runId,
          workspaceId: current!.workspaceId,
          sessionId: current!.sessionId,
          bindingGeneration: current!.generation,
          expectedRunRevision: revision,
          type: "design_checkpoint",
          scope: { kind: "architecture" },
          title,
          summary: "Prepared by the live-host validation fixture.",
          changes,
        });

      if (phase10 || phase10Revise) {
        // Phase 10 §68/§69 fixture: prepare (or revise) a ProposalCanonicalV2
        // whose exact requiredEvidence is the live-promoted critical Evidence
        // revision — the gate then runs inside the REAL approve_proposal.
        const evidenceRef = JSON.parse(process.env.PHASE_PLAN_LIVE_EVIDENCE_REF!) as {
          evidenceId: string;
          revision: number;
        };
        expect(evidenceRef.evidenceId).toMatch(/^ev_/);
        const changes = [
          {
            op: "ADD_DECISION" as const,
            content: {
              title: `Live Phase 10 gate decision ${phase10Revise ? "r2" : "r1"} ${tag}`,
              statement: "Decision frozen against the exact evidence revision named in requiredEvidence.",
              rationale: "phase 10 live gate validation",
              alternatives: ["none"],
              consequences: ["commit blocked unless critical evidence is fresh"],
              scope: "validation",
              supportingRefs: [],
            },
            compactProjection: `live-gate-${phase10Revise ? "r2" : "r1"}-${tag}`,
          },
        ];
        const proposalService = createProposalService(store, clock);
        let prepared;
        if (phase10Revise) {
          const awaiting = store.withRead(
            (tx) =>
              tx
                .prepare(
                  "SELECT proposal_id AS proposalId, revision AS revision FROM proposal_states WHERE run_id = ? AND status = 'awaiting_approval' LIMIT 1",
                )
                .get(current!.runId),
          ) as { proposalId: string; revision: number } | undefined;
          expect(awaiting).toBeDefined();
          prepared = proposalService.reviseProposal({
            runId: current!.runId,
            workspaceId: current!.workspaceId,
            sessionId: current!.sessionId,
            bindingGeneration: current!.generation,
            expectedRunRevision: revision,
            proposalId: awaiting!.proposalId,
            type: "design_checkpoint",
            scope: { kind: "architecture" },
            title: `Live Phase 10 gate proposal (revised) ${tag}`,
            summary: "Revised by the live fixture to reference the fresh replacement evidence revision.",
            changes,
            requiredEvidence: [evidenceRef],
          });
        } else {
          prepared = proposalService.prepareProposal({
            runId: current!.runId,
            workspaceId: current!.workspaceId,
            sessionId: current!.sessionId,
            bindingGeneration: current!.generation,
            expectedRunRevision: revision,
            type: "design_checkpoint",
            scope: { kind: "architecture" },
            title: `Live Phase 10 gate proposal ${tag}`,
            summary: "Prepared by the live fixture against the exact promoted evidence revision.",
            changes,
            requiredEvidence: [evidenceRef],
          });
        }
        console.log(
          `LIVE_FIXTURE ${JSON.stringify({
            mode: phase10 ? "phase10" : "phase10-revise",
            runId: current!.runId,
            proposalId: prepared.proposal.proposalId,
            proposalRevision: prepared.proposal.revision,
            proposalHash: prepared.proposal.proposalHash,
            requiredEvidence: [evidenceRef],
          })}`,
        );
        expect(prepared.proposal.proposalId).toBeTruthy();
        return;
      }

      if (phase12 || phase13 || phase13drift) {
        // Phase 12 §100 fixture: drive the live run through the REAL domain
        // path (Discovery bridge → architecture → detail → section
        // completions) until the LAST completion freezes the SynthesisInput
        // and advances the run to stage synthesis. Test authorization only.
        const engine = createPlanCommitEngine(store, clock);
        const sectionWorkflow = await import("../src/application/section-workflow-service.js");
        const commit = (proposal: { proposalId: string; proposalId2?: never; revision: number; proposalHash: string }) => {
          const result = engine.commitAuthorizedProposal({
            runId: current!.runId,
            workspaceId: current!.workspaceId,
            sessionId: current!.sessionId,
            bindingGeneration: current!.generation,
            authorization: {
              authorizationRequestId: `live-phase12-${proposal.proposalId}-${proposal.revision}`,
              proposalId: proposal.proposalId,
              proposalRevision: proposal.revision,
              proposalHash: proposal.proposalHash,
            },
          });
          revision = result.runRevision ?? revision;
          return result;
        };
        const prepare = (input: Parameters<typeof proposals.prepareProposal>[0]) => proposals.prepareProposal(input);

        let evidenceRef: { evidenceId: string; revision: number } | null = null;
        // Phase 13 drift RESUME: the run already sits at synthesis (an earlier
        // drift attempt drove it there before the evidence existed). The design
        // drive below is skipped; the reopen path rebuilds the world.
        const resumeStageRow = store.withRead(
          (tx) => tx.prepare("SELECT stage AS s FROM planning_runs WHERE run_id = ?").get(current!.runId) as { s: string },
        );
        const driftResume = phase13drift && resumeStageRow.s === "synthesis";
        let sectionIds: string[] = [];
        if (driftResume) {
          const headRow = store.withRead(
            (tx) =>
              tx.prepare("SELECT head_snapshot_id AS s FROM plan_heads WHERE run_id = ?").get(current!.runId) as { s: string },
          );
          sectionIds = (
            store.withRead(
              (tx) =>
                tx
                  .prepare("SELECT artifact_id AS id FROM snapshot_members WHERE snapshot_id = ? AND kind = 'section' ORDER BY artifact_id")
                  .all(headRow.s) as Array<{ id: string }>,
            )
          ).map((row) => row.id);
        }
        if (!driftResume) {
        // Discovery → Architecture: the Phase 11 §24 atomic prepare bridge.
        const archContent = {
          summary: "Phase 12 live architecture",
          components: ["PlanningHarness"],
          boundaries: ["plugin data dir"],
          dataFlows: [],
          principles: [],
          unresolvedQuestionRefs: [],
          decisionRefs: [],
        };
        const archCheckpoint = prepare({
          runId: current!.runId,
          workspaceId: current!.workspaceId,
          sessionId: current!.sessionId,
          bindingGeneration: current!.generation,
          expectedRunRevision: revision,
          type: "design_checkpoint",
          scope: { kind: "architecture" },
          title: "Phase 12 live architecture checkpoint",
          summary: "live fixture architecture",
          changes: [{ op: "SET_ARCHITECTURE_REVISION" as const, target: null, content: archContent, compactProjection: "ARCH-live@1" }],
        });
        commit(archCheckpoint.proposal);
        const archCompletion = prepare({
          runId: current!.runId,
          workspaceId: current!.workspaceId,
          sessionId: current!.sessionId,
          bindingGeneration: current!.generation,
          expectedRunRevision: revision,
          type: "architecture_completion",
          scope: { kind: "architecture" },
          title: "Phase 12 live architecture completion",
          summary: "architecture is stable",
          changes: [],
        });
        commit(archCompletion.proposal);

        // Phase 13 drift mode: a critical fingerprint Evidence revision over a
        // dedicated workspace file, promoted BEFORE the design DAG and named in
        // its requiredEvidence so it enters the frozen input's
        // relevantEvidence (Phase 13 §21/§105).
        let evidenceRef: { evidenceId: string; revision: number } | null = null;
        if (phase13drift) {
          const workspace = (await import("../src/store/repositories.js")).getWorkspaceById(store, current!.workspaceId)!;
          const driftPath = path.join(workspace.canonicalRoot, "phase-plan-live-drift.txt");
          fs.writeFileSync(driftPath, "LIVE DRIFT SOURCE v1\n", "utf8");
          const { captureObservation } = await import("../src/observations/capture.js");
          const { createBlobStore } = await import("../src/store/blob-store.js");
          const blobs = createBlobStore(path.join(liveRoot!, "blobs"));
          const captured = await captureObservation(
            {
              store,
              clock,
              runId: current!.runId,
              workspace: workspace as never,
              blobs,
            },
            {
              sessionId: current!.sessionId,
              toolName: "Read",
              toolUseId: `live-drift-obs-${tag}`,
              toolInput: { file_path: driftPath },
              toolResponse: { type: "text", file: { filePath: "phase-plan-live-drift.txt", content: "LIVE DRIFT SOURCE v1\n" } },
              cwd: workspace.canonicalRoot,
            },
          );
          if (captured.status !== "captured") throw new Error(`drift observation failed: ${captured.status}`);
          const observationId = (captured as { status: "captured"; observation: { observationId: string } }).observation.observationId;
          const evidenceService = (await import("../src/application/evidence-service.js")).createEvidenceService(store, blobs, clock);
          const promoted = evidenceService.promoteEvidence({
            runId: current!.runId,
            workspaceId: current!.workspaceId,
            request: {
              claim: "the live drift source declares its frozen content",
              kind: "source_fact",
              scope: { type: "global" },
              confidence: "direct",
              criticality: "critical",
              observationRefs: [observationId],
              derivedFrom: [],
            },
            operationId: `live:promote-drift-${tag}`,
          });
          evidenceRef = { evidenceId: promoted.evidence.evidenceId, revision: promoted.evidence.revision };
        }

        // Detail: one two-section DAG (independent sections).
        const sectionContent = (title: string) => ({
          title,
          objective: `${title} objective`,
          design: `${title} design`,
          interfaces: [],
          invariants: [],
          failureModes: [],
          dependencies: [],
          decisionRefs: [],
          openQuestionRefs: [],
          impactRefs: [],
          contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
        });
        const dag = prepare({
          runId: current!.runId,
          workspaceId: current!.workspaceId,
          sessionId: current!.sessionId,
          bindingGeneration: current!.generation,
          expectedRunRevision: revision,
          type: "design_checkpoint",
          scope: { kind: "detail" },
          title: "Phase 12 live section DAG",
          summary: "two sections",
          ...(evidenceRef !== null ? { requiredEvidence: [evidenceRef] } : {}),
          changes: (["Alpha", "Beta"] as const).map((title) => ({
            op: "SET_SECTION_REVISION" as const,
            target: null,
            content: sectionContent(`Live ${title}`),
            compactProjection: `section:${title}`,
          })),
        });
        commit(dag.proposal);
        sectionIds = [...new Set(dag.candidateRefs.filter((ref) => ref.kind === "section").map((ref) => ref.id))].sort();

        // Select + complete each section; the LAST completion reaches
        // DETAIL_COMPLETE and freezes the SynthesisInput (§18).
        for (const sectionId of sectionIds) {
          sectionWorkflow.createSectionWorkflowService(store, clock).selectSection({
            runId: current!.runId,
            workspaceId: current!.workspaceId,
            sessionId: current!.sessionId,
            bindingGeneration: current!.generation,
            expectedRunRevision: revision,
            sectionId,
          });
          const afterSelect = store.withRead((tx) => tx.prepare("SELECT revision AS r FROM planning_runs WHERE run_id = ?").get(current!.runId) as { r: number });
          revision = afterSelect.r;
          const completion = prepare({
            runId: current!.runId,
            workspaceId: current!.workspaceId,
            sessionId: current!.sessionId,
            bindingGeneration: current!.generation,
            expectedRunRevision: revision,
            type: "section_completion",
            scope: { kind: "section", sectionId },
            title: `Complete ${sectionId}`,
            summary: "live phase 12 completion",
            changes: [{ op: "COMPLETE_SECTION" as const, sectionId, compactProjection: `complete:${sectionId}@1` }],
          });
          commit(completion.proposal);
        }

        }
        // Phase 13 drift RESUME: the run already sits at synthesis (an earlier
        // drift attempt drove it there before promoting the evidence). Reopen
        // to detail, promote the critical fingerprint evidence, contribute it
        // through a real committed decision proposal, and re-complete both
        // Sections — DETAIL_COMPLETE then freezes a NEW input whose scope
        // contains the evidence (Phase 13 §21/§71 flow).
        if (phase13drift) {
          const stageRow = store.withRead((tx) => tx.prepare("SELECT stage AS s, revision AS r FROM planning_runs WHERE run_id = ?").get(current!.runId) as { s: string; r: number });
          if (stageRow.s === "synthesis") {
            const synthesisService = (await import("../src/application/synthesis-service.js")).createSynthesisService(store, clock);
            const reopened = synthesisService.requestReopen({
              runId: current!.runId,
              workspaceId: current!.workspaceId,
              sessionId: current!.sessionId,
              bindingGeneration: current!.generation,
              target: "detail",
              reason: "phase13 drift fixture: reopen to bring critical evidence into scope",
              findingIds: [],
              requestId: `fixture:reopen-${tag}`,
              callerAgent: null,
            });
            revision = reopened.runRevision;

            const workspace = (await import("../src/store/repositories.js")).getWorkspaceById(store, current!.workspaceId)!;
            const driftPath = path.join(workspace.canonicalRoot, "phase-plan-live-drift.txt");
            fs.writeFileSync(driftPath, "LIVE DRIFT SOURCE v1\n", "utf8");
            const { captureObservation } = await import("../src/observations/capture.js");
            const { createBlobStore } = await import("../src/store/blob-store.js");
            const blobs = createBlobStore(path.join(liveRoot!, "blobs"));
            const captured = await captureObservation(
              { store, clock, runId: current!.runId, workspace: workspace as never, blobs },
              {
                sessionId: current!.sessionId,
                toolName: "Read",
                toolUseId: `live-drift-obs2-${tag}`,
                toolInput: { file_path: driftPath },
                toolResponse: { type: "text", file: { filePath: "phase-plan-live-drift.txt", content: "LIVE DRIFT SOURCE v1\n" } },
                cwd: workspace.canonicalRoot,
              },
            );
            if (captured.status !== "captured") throw new Error(`drift observation failed: ${captured.status}`);
            const observationId = (captured as { status: "captured"; observation: { observationId: string } }).observation.observationId;
            const evidenceService = (await import("../src/application/evidence-service.js")).createEvidenceService(store, blobs, clock);
            const promoted = evidenceService.promoteEvidence({
              runId: current!.runId,
              workspaceId: current!.workspaceId,
              request: {
                claim: "the live drift source declares its frozen content",
                kind: "source_fact",
                scope: { type: "global" },
                confidence: "direct",
                criticality: "critical",
                observationRefs: [observationId],
                derivedFrom: [],
              },
              operationId: `live:promote-drift2-${tag}`,
            });
            evidenceRef = { evidenceId: promoted.evidence.evidenceId, revision: promoted.evidence.revision };

            // A real committed decision whose requiredEvidence is the exact
            // fresh evidence revision (§21 contributing proposal).
            const decisionCheckpoint = prepare({
              runId: current!.runId,
              workspaceId: current!.workspaceId,
              sessionId: current!.sessionId,
              bindingGeneration: current!.generation,
              expectedRunRevision: revision,
              type: "design_checkpoint",
              scope: { kind: "detail" },
              title: `Live drift decision ${tag}`,
              summary: "decision anchored to the fresh critical evidence",
              changes: [
                {
                  op: "ADD_DECISION" as const,
                  content: {
                    title: "Live drift decision",
                    statement: "The drift source content is authoritative for this plan.",
                    rationale: "phase 13 live drift setup",
                    alternatives: ["none"],
                    consequences: ["finalization revalidates this evidence at commit time"],
                    scope: "validation",
                    supportingRefs: [],
                  },
                  compactProjection: `live-drift-decision-${tag}`,
                },
              ],
              requiredEvidence: [evidenceRef],
            });
            commit(decisionCheckpoint.proposal);

            // Re-complete both Sections (they are needs_review after reopen).
            for (const sectionId of sectionIds) {
              sectionWorkflow.createSectionWorkflowService(store, clock).selectSection({
                runId: current!.runId,
                workspaceId: current!.workspaceId,
                sessionId: current!.sessionId,
                bindingGeneration: current!.generation,
                expectedRunRevision: revision,
                sectionId,
              });
              const afterSelect2 = store.withRead((tx) => tx.prepare("SELECT revision AS r FROM planning_runs WHERE run_id = ?").get(current!.runId) as { r: number });
              revision = afterSelect2.r;
              const recompletion = prepare({
                runId: current!.runId,
                workspaceId: current!.workspaceId,
                sessionId: current!.sessionId,
                bindingGeneration: current!.generation,
                expectedRunRevision: revision,
                type: "section_completion",
                scope: { kind: "section", sectionId },
                title: `Re-complete ${sectionId}`,
                summary: "live phase 13 drift re-completion",
                changes: [{ op: "COMPLETE_SECTION" as const, sectionId, compactProjection: `recomplete:${sectionId}@1` }],
              });
              commit(recompletion.proposal);
            }
          } else {
            throw new Error(`phase13-drift expects the run at synthesis for the resume path (run is at '${stageRow.s}')`);
          }
        }

        const finalRun = store.withRead((tx) => tx.prepare("SELECT stage AS s, revision AS r FROM planning_runs WHERE run_id = ?").get(current!.runId) as { s: string; r: number });
        const input = store.withRead((tx) =>
          tx.prepare("SELECT input_id AS inputId, input_hash AS inputHash, input_seq AS seq FROM synthesis_inputs WHERE run_id = ? ORDER BY input_seq DESC LIMIT 1").get(current!.runId),
        ) as { inputId: string; inputHash: string; seq: number } | undefined;
        expect(finalRun.s).toBe("synthesis");
        expect(input).toBeDefined();

        // Phase 13 modes: submit the manifest + the [clean] validation report
        // through the REAL services (the validator attestation is a sanctioned
        // fixture fact), leaving the run at stage validation with a clean
        // report — the exact Phase 13 §103 preparation state.
        let manifestId: string | undefined;
        let manifestHash: string | undefined;
        let reportId: string | undefined;
        if (phase13 || phase13drift) {
          const sectionRefs = sectionIds.map((id) => {
            const rev = store.withRead((tx) =>
              tx.prepare("SELECT revision AS r FROM snapshot_members WHERE snapshot_id = (SELECT head_snapshot_id FROM plan_heads WHERE run_id = ?) AND kind = 'section' AND artifact_id = ?").get(current!.runId, id),
            ) as { r: number };
            return { kind: "section" as const, id, revision: rev.r };
          });
          const synthesis = (await import("../src/application/synthesis-service.js")).createSynthesisService(store, clock);
          const manifestPayload = {
            version: 1 as const,
            inputId: input!.inputId,
            inputHash: input!.inputHash,
            crossSectionLinks: [
              { statement: "Live Alpha and Beta share the approved boundary", supportingRefs: sectionRefs },
            ],
            implementationOrder: [
              { stepId: "step-1", title: "Implement Alpha", description: "build alpha", dependsOn: [], supportingRefs: [sectionRefs[0]!] },
              { stepId: "step-2", title: "Implement Beta", description: "build beta after alpha", dependsOn: ["step-1"], supportingRefs: [sectionRefs[1]!] },
            ],
            limitations: [
              { statement: "Runtime behavior is bounded by the committed constraints", supportingRefs: sectionRefs },
            ],
            unresolvedFindings: [],
          };
          const synthesisService = synthesis;
          const accepted = synthesisService.submitSynthesis({
            runId: current!.runId,
            workspaceId: current!.workspaceId,
            sessionId: current!.sessionId,
            bindingGeneration: current!.generation,
            permissionMode: "plan",
            inputId: input!.inputId,
            inputHash: input!.inputHash,
            manifest: manifestPayload,
            requestId: `fixture:synthesis-${tag}`,
            callerAgent: null,
          });
          manifestId = accepted.manifestId;
          manifestHash = accepted.manifestHash;
          const report = synthesisService.submitValidation({
            runId: current!.runId,
            workspaceId: current!.workspaceId,
            sessionId: current!.sessionId,
            bindingGeneration: current!.generation,
            manifestId: accepted.manifestId,
            manifestHash: accepted.manifestHash,
            inputId: input!.inputId,
            inputHash: input!.inputHash,
            findings: [
              { kind: "clean" as const, summary: "The manifest is a faithful derivation.", detail: "Live fixture clean report.", subjectRefs: [], supportingRefs: [] },
            ],
            requestId: `fixture:validation-${tag}`,
            callerAgent: { agentId: `live-validator-${tag}`, agentType: "phase-plan:validator" },
          });
          expect(report.isClean).toBe(true);
          reportId = report.reportId;
          if (phase13drift) {
            // The SERVICE-level request_finalization freezes the candidate
            // while the evidence is fresh; the real host later Allows the
            // approval over drifted source and the commit-time gate denies
            // (Phase 13 §105, real host, service-frozen candidate).
            const finalization = (await import("../src/application/finalization-service.js")).createFinalizationService(store, clock);
            const frozen = finalization.requestFinalization({
              runId: current!.runId,
              workspaceId: current!.workspaceId,
              sessionId: current!.sessionId,
              bindingGeneration: current!.generation,
              requestId: `fixture:finalize-${tag}`,
              callerAgent: null,
            });
            const workspace2 = (await import("../src/store/repositories.js")).getWorkspaceById(store, current!.workspaceId)!;
            fs.writeFileSync(path.join(workspace2.canonicalRoot, "phase-plan-live-drift.txt"), "LIVE DRIFT SOURCE v2 — drifted\\n", "utf8");
            const finalRun2 = store.withRead((tx) => tx.prepare("SELECT stage AS s, revision AS r FROM planning_runs WHERE run_id = ?").get(current!.runId) as { s: string; r: number });
            console.log(
              `LIVE_FIXTURE ${JSON.stringify({
                mode: "phase13-drift",
                runId: current!.runId,
                stage: finalRun2.s,
                runRevision: finalRun2.r,
                candidateId: frozen.candidateId,
                candidateHash: frozen.candidateHash,
                proposalId: frozen.proposalId,
                proposalRevision: frozen.proposalRevision,
                proposalHash: frozen.proposalHash,
                evidence: evidenceRef,
                driftFile: "phase-plan-live-drift.txt",
              })}`,
            );
            return;
          }
        }

        const context = assembleContext(createStoreContextSource(store), current!.runId);
        if (phase12) {
          console.log(
            `LIVE_FIXTURE ${JSON.stringify({
              mode: "phase12",
              runId: current!.runId,
              stage: finalRun.s,
              runRevision: finalRun.r,
              inputId: input!.inputId,
              inputHash: input!.inputHash,
              inputSeq: input!.seq,
              sectionIds,
              epoch: context.epoch,
              capsule: buildRecoveryCapsule(context).text,
            })}`,
          );
          return;
        }
        console.log(
          `LIVE_FIXTURE ${JSON.stringify({
            mode: "phase13",
            runId: current!.runId,
            stage: finalRun.s,
            runRevision: finalRun.r,
            inputId: input!.inputId,
            inputHash: input!.inputHash,
            inputSeq: input!.seq,
            manifestId,
            manifestHash,
            reportId,
            sectionIds,
            epoch: context.epoch,
            capsule: buildRecoveryCapsule(context).text,
          })}`,
        );
        return;
      }

      if (phase8) {
        // Phase 8 §58 fixture: one COMMITTED hard constraint (engine commit
        // via the TEST-ONLY authorization factory), then one AWAITING
        // proposal — the exact state the Recovery Capsule must reconstruct
        // after real compaction.
        const checkpoint = prepare(
          [
            {
              op: "ADD_CONSTRAINT",
              content: {
                source: "user",
                statement: `Live Phase 8 compaction validation constraint ${tag}`,
                severity: "hard",
                status: "active",
              },
              compactProjection: `live-constraint-${tag}`,
            },
          ],
          `Live compaction constraint checkpoint ${tag}`,
        );
        const engine = createPlanCommitEngine(store, clock);
        const committed = engine.commitAuthorizedProposal({
          runId: current!.runId,
          workspaceId: current!.workspaceId,
          sessionId: current!.sessionId,
          bindingGeneration: current!.generation,
          authorization: makeTestUserAuthorization({
            proposalId: checkpoint.proposal.proposalId,
            proposalRevision: checkpoint.proposal.revision,
            proposalHash: checkpoint.proposal.proposalHash,
          }),
        });
        revision = committed.runRevision ?? revision;

        const awaiting = prepare(
          [
            {
              op: "ADD_DECISION",
              content: {
                title: `Live compaction awaiting decision ${tag}`,
                statement: "Decision content prepared by the live-host validation fixture.",
                rationale: "leave an awaiting proposal visible to the recovery capsule",
                alternatives: ["no-op"],
                consequences: ["visible in working.awaitingProposal only"],
                scope: "validation",
                supportingRefs: [],
              },
              compactProjection: `live-awaiting-${tag}`,
            },
          ],
          `Live compaction awaiting proposal ${tag}`,
        );

        const source = createStoreContextSource(store);
        const context = assembleContext(source, current!.runId);
        const capsule = buildRecoveryCapsule(context);
        const headRefs = getHeadSnapshotRecord(store, current!.runId);
        const constraintRef = headRefs?.refs.find((ref) => ref.kind === "constraint") ?? null;
        console.log(
          `LIVE_FIXTURE ${JSON.stringify({
            mode: "phase8",
            runId: current!.runId,
            commitId: committed.commitId,
            snapshotId: committed.snapshotId,
            constraintRef,
            epoch: context.epoch,
            awaiting: {
              proposalId: awaiting.proposal.proposalId,
              proposalRevision: awaiting.proposal.revision,
              proposalHash: awaiting.proposal.proposalHash,
            },
            capsule: capsule.text,
          })}`,
        );
        expect(committed.commitId).toBeTruthy();
        expect(awaiting.proposal.proposalId).toBeTruthy();
        return;
      }

      const prepared = prepare(
        [
          {
            op: "ADD_DECISION",
            content: {
              title: `Live validation decision ${tag}`,
              statement: "Decision content prepared by the live-host validation fixture.",
              rationale: "exercise the formal approval bridge end to end",
              alternatives: ["no-op"],
              consequences: ["one approval, one commit, one snapshot when allowed"],
              scope: "validation",
              supportingRefs: [],
            },
            compactProjection: `live-validation-${tag}`,
          },
        ],
        `Live-host validation checkpoint ${tag}`,
      );

      console.log(
        `LIVE_FIXTURE ${JSON.stringify({
          mode: "phase7",
          runId: current!.runId,
          proposalId: prepared.proposal.proposalId,
          proposalRevision: prepared.proposal.revision,
          proposalHash: prepared.proposal.proposalHash,
        })}`,
      );
      expect(prepared.proposal.proposalId).toBeTruthy();
    } finally {
      store.close();
    }
  });
});
