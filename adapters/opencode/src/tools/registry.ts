/**
 * Ultra Plan tool registry — Phase 2A.
 *
 * Creates every model-visible tool from the frozen contract registry
 * (tools/contracts.ts). Tools are thin transport adapters: they validate
 * nothing themselves, they route through UltraPlanController.authorizeTool
 * (capability matrix) and the controller's semantic operations, and they
 * return structured results with machine-readable error codes.
 *
 * Deliberately ABSENT from this registry (user/Harness authority, see the
 * agent protocol document): ultraplan_approve, ultraplan_commit,
 * ultraplan_force_stage, ultraplan_complete_run, ultraplan_plan_exit.
 */
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";

import { isUltraPlanError } from "../core/errors.js";
import type { UltraPlanController } from "../core/controller.js";
import { PREPARED_CHANGE_KINDS, type SectionCheckpointInput } from "../core/controller.js";
import { renderProposalForApproval } from "../memory/approval-view.js";
import { ULTRA_PLAN_START_TOOL, createUltraPlanStartTool } from "./ultra-plan.js";

/** Structured error surface for the model: code in output + metadata. */
function asToolResult(error: unknown): { title: string; output: string; metadata: Record<string, unknown> } | undefined {
  if (!isUltraPlanError(error)) return undefined;
  return {
    title: `Ultra Plan ${error.code}`,
    output: `ERROR [${error.code}] ${error.message}`,
    metadata: { errorCode: error.code, ...(error.detail ? { detail: error.detail } : {}) },
  };
}

const flatRefShape = {
  kind: tool.schema
    .enum(["architecture", "section", "decision", "constraint", "question", "conflict", "evidence", "proposal", "snapshot", "commit", "final_plan", "synthesis_input", "synthesis_manifest", "validation_report", "evidence_audit", "final_plan_candidate", "execution_handoff"])
    .describe("Kind of memory object being referenced"),
  id: tool.schema.string().optional().describe("Artifact id (e.g. SEC-001, DEC-014, Q-007)"),
  revision: tool.schema.number().optional().describe("Exact revision — required for decisions; never resolved to latest"),
};

/** Flat exact source ref for derived synthesis statements (Phase 2F). */
const sourceRefShape = tool.schema.object({
  kind: tool.schema
    .enum(["architecture", "section", "decision", "constraint", "question", "conflict", "evidence"])
    .describe("Source kind inside the frozen SynthesisInput"),
  id: tool.schema.string().optional().describe("Artifact id (SEC-001, DEC-014, CON-001, Q-001, CONF-001, EVD-001)"),
  revision: tool.schema
    .number()
    .optional()
    .describe("Exact revision — REQUIRED for section/decision/evidence sources"),
});

export function createUltraPlanTools(controller: UltraPlanController): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {
    [ULTRA_PLAN_START_TOOL]: createUltraPlanStartTool(controller),

    ultraplan_status: tool({
      description:
        "Report the deterministic Ultra Plan status block for the current session " +
        "(rendered from structured state, never generated prose).",
      args: {},
      async execute(_args, context: ToolContext) {
        const report = await controller.statusReport(context.sessionID);
        return {
          title: report.run ? `Ultra Plan ${report.run.id} status` : "Ultra Plan status",
          output: report.statusText,
          metadata: {
            planID: report.run?.id,
            lifecycle: report.run?.lifecycle,
            stage: report.run?.stage,
          },
        };
      },
    }),

    plan_memory: tool({
      description:
        "Read-only access to committed Plan Memory (spec §20) and derived synthesis/validation artifacts " +
        "(Phases 2F/2G). Reads an artifact by exact reference, the current run summary, or the dependency " +
        "contracts of a section. kind=synthesis_input reads a frozen input by exact id; kind=synthesis_manifest " +
        "reads a manifest by id (+ optional exact revision — historical revisions are never resolved to latest); " +
        "kind=validation_report reads a semantic-validation report by exact id. Never mutates state.",
      args: {
        kind: flatRefShape.kind.optional(),
        id: flatRefShape.id.optional(),
        revision: flatRefShape.revision.optional(),
        dependenciesOf: tool.schema
          .string()
          .optional()
          .describe("Section id — returns the section plus its dependency contracts"),
      },
      async execute(args, context: ToolContext) {
        try {
          const result = await controller.readMemory(context.sessionID, {
            ...(args.kind
              ? {
                  ref: {
                    kind: args.kind,
                    ...(args.id ? { id: args.id } : {}),
                    ...(args.revision !== undefined ? { revision: args.revision } : {}),
                  },
                }
              : {}),
            ...(args.dependenciesOf ? { dependenciesOf: args.dependenciesOf } : {}),
          });
          return {
            title: `Ultra Plan memory (${result.artifacts.length} artifact(s))`,
            output: JSON.stringify(result, null, 2),
            metadata: { planID: result.planID, headSnapshot: result.headSnapshot },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_record_question: tool({
      description:
        "Record an open question about the design. Blocking questions prevent finalization. " +
        "Working-state operation; the question is not committed design.",
      args: {
        question: tool.schema.string().describe("The question, stated concretely"),
        blocking: tool.schema.boolean().default(false).describe("Does this block finalization?"),
        scopeType: tool.schema.enum(["architecture", "section"]).describe("Scope of the question"),
        sectionID: tool.schema.string().optional().describe("Section id when scopeType=section"),
      },
      async execute(args, context: ToolContext) {
        try {
          const question = await controller.recordQuestion(context.sessionID, {
            question: args.question,
            blocking: args.blocking,
            scope: { type: args.scopeType, ...(args.sectionID ? { sectionID: args.sectionID } : {}) },
          });
          return {
            title: `Question ${question.id} recorded`,
            output: `OpenQuestion ${question.id} recorded (blocking=${String(question.blocking)}, scope=${args.scopeType === "section" ? (args.sectionID ?? "unknown section") : "architecture"}).`,
            metadata: { questionID: question.id, blocking: question.blocking },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_propose_question_resolution: tool({
      description:
        "Record a CANDIDATE resolution for one of your recorded open questions. " +
        "The question stays OPEN and keeps blocking finalization; the authoritative " +
        "resolution is applied only when a Proposal containing resolve_question is " +
        "explicitly approved by the user and committed by the Harness.",
      args: {
        questionID: tool.schema.string().describe("Question id (e.g. Q-001)"),
        resolution: tool.schema.string().describe("The candidate resolution to propose"),
      },
      async execute(args, context: ToolContext) {
        try {
          const question = await controller.proposeQuestionResolution(context.sessionID, {
            questionID: args.questionID,
            resolution: args.resolution,
          });
          return {
            title: `Candidate resolution recorded for ${question.id}`,
            output: `Candidate resolution recorded for ${question.id}. The question REMAINS ${question.status.toUpperCase()} and ${question.blocking ? "BLOCKING" : "non-blocking"} — it can only be resolved by an approved Proposal → PlanCommit.`,
            metadata: {
              questionID: question.id,
              status: question.status,
              blocking: question.blocking,
              candidateResolution: question.proposedResolution?.text,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_raise_conflict: tool({
      description:
        "Raise a conflict between design elements (decisions, constraints, sections, interfaces). " +
        "Blocking conflicts prevent finalization and must be resolved through the proposal pipeline.",
      args: {
        type: tool.schema.enum(["decision", "constraint", "section", "interface"]).describe("Conflict type"),
        description: tool.schema.string().describe("What conflicts with what, and why"),
        severity: tool.schema.enum(["warning", "blocking"]).describe("Conflict severity"),
        refs: tool.schema.array(tool.schema.object(flatRefShape)).optional().describe("Referenced memory objects"),
      },
      async execute(args, context: ToolContext) {
        try {
          const conflict = await controller.raiseConflict(context.sessionID, {
            type: args.type,
            description: args.description,
            severity: args.severity,
            refs: args.refs ?? [],
          });
          return {
            title: `Conflict ${conflict.id} raised`,
            output: `Conflict ${conflict.id} (${conflict.severity}) raised: ${conflict.description}`,
            metadata: { conflictID: conflict.id, severity: conflict.severity },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_promote_evidence: tool({
      description:
        "Promote observations you actually made in this session into Evidence. " +
        "Direct evidence REQUIRES observation ids (source provenance); derived evidence " +
        "REQUIRES upstream evidence refs; uncertain evidence is recorded as unverified and can never satisfy the freshness gate.",
      args: {
        claim: tool.schema.string().describe("The claim, stated concretely"),
        kind: tool.schema
          .enum(["file", "symbol", "interface", "dependency", "configuration", "behavior", "test", "runtime", "architecture"])
          .describe("Evidence kind"),
        criticality: tool.schema.enum(["critical", "supporting", "informational"]).describe("Criticality"),
        confidence: tool.schema.enum(["direct", "derived", "uncertain"]).describe("Confidence class"),
        scopeType: tool.schema.enum(["run", "architecture", "section", "decision"]).describe("Evidence scope"),
        scopeSectionID: tool.schema.string().optional().describe("Section id when scopeType=section"),
        scopeDecisionID: tool.schema.string().optional().describe("Decision id when scopeType=decision"),
        observationIDs: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Observation ids made in this session (REQUIRED for direct evidence)"),
        derivedFrom: tool.schema
          .array(tool.schema.object({ id: tool.schema.string(), revision: tool.schema.number().optional() }))
          .optional()
          .describe("Upstream evidence refs (REQUIRED for derived evidence)"),
      },
      async execute(args, context: ToolContext) {
        try {
          const evidence = await controller.promoteEvidence(context.sessionID, {
            claim: args.claim,
            kind: args.kind,
            criticality: args.criticality,
            confidence: args.confidence,
            scopeType: args.scopeType,
            ...(args.scopeSectionID ? { scopeSectionID: args.scopeSectionID } : {}),
            ...(args.scopeDecisionID ? { scopeDecisionID: args.scopeDecisionID } : {}),
            ...(args.observationIDs ? { observationIDs: args.observationIDs } : {}),
            ...(args.derivedFrom ? { derivedFrom: args.derivedFrom } : {}),
          });
          return {
            title: `Evidence ${evidence.id} recorded`,
            output: `Evidence ${evidence.id} [${evidence.confidence}/${evidence.criticality}/${evidence.freshness}] ${evidence.claim}`,
            metadata: { evidenceID: evidence.id, confidence: evidence.confidence, freshness: evidence.freshness },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_prepare_proposal: tool({
      description:
        "Prepare a proposal candidate (atomic approval unit). The Harness assigns the id, binds it " +
        "to the active run and HEAD snapshot, freezes the content, and computes the approval hash. " +
        "You can NEVER approve or commit it — approval is user authority, commit is Harness authority.",
      args: {
        type: tool.schema
          .enum(["design_checkpoint", "architecture_completion", "section_completion", "amendment"])
          .describe("Proposal type (final_plan is created by the synthesis workflow, not by tools)"),
        scopeType: tool.schema.enum(["architecture", "section"]).describe("Proposal scope"),
        sectionID: tool.schema.string().optional().describe("Section id when scopeType=section"),
        title: tool.schema.string().describe("Short proposal title"),
        summary: tool.schema.string().describe("What this proposal changes and why"),
        changes: tool.schema
          .array(
            tool.schema.object({
              kind: tool.schema.enum(PREPARED_CHANGE_KINDS).describe("Change kind"),
              ref: tool.schema.object(flatRefShape).optional().describe("Target artifact for amend/resolve changes"),
              content: tool.schema.unknown().optional().describe("Kind-specific payload"),
            }),
          )
          .describe("Atomic set of changes (what the user approves is exactly what gets committed)"),
      },
      async execute(args, context: ToolContext) {
        try {
          const prepared = await controller.prepareProposal(context.sessionID, {
            type: args.type,
            scope:
              args.scopeType === "section"
                ? { type: "section", sectionID: args.sectionID ?? "" }
                : { type: "architecture" },
            title: args.title,
            summary: args.summary,
            changes: args.changes,
          });
          return {
            title: `Proposal ${prepared.proposal.id} prepared`,
            output: [
              `Proposal ${prepared.proposal.id} (${prepared.proposal.type}, revision ${prepared.proposal.revision}) is READY.`,
              `Base snapshot: ${prepared.proposal.createdFrom.id}`,
              `Approval hash: ${prepared.hash}`,
              "Awaiting USER approval via the approval boundary — you cannot approve or commit it.",
            ].join("\n"),
            metadata: {
              proposalID: prepared.proposal.id,
              hash: prepared.hash,
              status: prepared.proposal.status,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_request_architecture: tool({
      description:
        "Request the transition from DISCOVERY to the ARCHITECTURE stage. Call this when repository/task " +
        "discovery is sufficient to start top-level design. The Harness validates structural readiness " +
        "(discovery stage, structured goal set) and performs the transition — you cannot set stages directly.",
      args: {},
      async execute(_args, context: ToolContext) {
        try {
          const result = await controller.requestArchitecture(context.sessionID);
          return {
            title: `Ultra Plan ${result.run.id} entered architecture`,
            output: result.statusText,
            metadata: { planID: result.run.id, stage: result.run.stage },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_request_completion: tool({
      description:
        "Request artifact completion. kind='architecture' prepares the architecture_completion proposal: the " +
        "approved top-level architecture becomes the basis for Detail decomposition and the run transitions " +
        "architecture -> detail atomically with the commit. kind='section' (Detail stage) prepares a " +
        "section_completion proposal for the ACTIVE section's exact current approved checkpoint — you supply no " +
        "revision or design content; the Harness resolves the exact target and returns precise blocker errors " +
        "(dependency_incomplete, section_needs_review, ...) when deterministic gates fail. Either way the USER " +
        "must approve the prepared proposal before anything commits.",
      args: {
        kind: tool.schema.enum(["architecture", "section"]).describe("What is being completed"),
      },
      async execute(args, context: ToolContext) {
        try {
          const prepared = await controller.requestCompletion(context.sessionID, { kind: args.kind });
          return {
            title: `Completion requested (${args.kind})`,
            output: `${prepared.proposal.type} proposal ${prepared.proposal.id} prepared (hash ${prepared.hash}). Awaiting USER approval.`,
            metadata: {
              proposalID: prepared.proposal.id,
              proposalType: prepared.proposal.type,
              kind: args.kind,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_request_section_focus: tool({
      description:
        "Request moving the workflow focus to another committed Section (Detail stage). Discussion may run " +
        "ahead of dependency completion, so you may focus pending or active sections even when they cannot yet " +
        "complete. The Harness validates deterministically and performs the durable focus transition — this is " +
        "workflow state, NOT a design Proposal and NOT user-approved; set_active_work does not exist.",
      args: {
        sectionID: tool.schema.string().describe("Target section id (e.g. SEC-002); must be pending or active"),
      },
      async execute(args, context: ToolContext) {
        try {
          const result = await controller.requestSectionFocus(context.sessionID, { sectionID: args.sectionID });
          return {
            title: `Focus moved to ${args.sectionID}`,
            output: result.statusText,
            metadata: {
              planID: result.run.id,
              stage: result.run.stage,
              activeWork: result.run.activeWork,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_prepare_section_decomposition: tool({
      description:
        "Freeze the COMPLETE initial Section DAG as one atomic proposal (Detail stage, before any sections " +
        "exist). Submit every section with a draft-local key (yours, not authoritative), title, objective, " +
        "dependsOn keys (dependencies must appear EARLIER in the list), and the initial focus key. The Harness " +
        "assigns authoritative SEC ids, resolves all edges, validates the DAG, and freezes one proposal for " +
        "USER approval. You can NEVER approve or commit it, and the initial decomposition happens exactly once.",
      args: {
        sections: tool.schema
          .array(
            tool.schema.object({
              key: tool.schema.string().describe("Draft-local key, e.g. \"plan-memory\" (never persisted as an id)"),
              title: tool.schema.string().describe("Short section title"),
              objective: tool.schema.string().describe("What this design scope must solve"),
              dependsOn: tool.schema
                .array(tool.schema.string())
                .optional()
                .describe("Draft-local keys this section depends on (must appear earlier in the array)"),
            }),
          )
          .describe("The complete initial decomposition, in canonical order"),
        initialSection: tool.schema
          .string()
          .describe("Draft-local key of the section where Detail work begins"),
      },
      async execute(args, context: ToolContext) {
        try {
          const prepared = await controller.prepareSectionDecomposition(context.sessionID, {
            sections: args.sections,
            initialSection: args.initialSection,
          });
          return {
            title: `Section decomposition ${prepared.proposal.id} prepared`,
            output: [
              `Proposal ${prepared.proposal.id} (${prepared.proposal.type}, revision ${prepared.proposal.revision}) is READY.`,
              renderProposalForApproval(prepared.proposal),
              "Awaiting USER approval via the approval boundary — you cannot approve or commit it.",
            ].join("\n"),
            metadata: {
              proposalID: prepared.proposal.id,
              hash: prepared.hash,
              status: prepared.proposal.status,
              sections: prepared.proposal.impact.affectedSections,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_prepare_section_checkpoint: tool({
      description:
        "Freeze the ACTIVE section's detailed design into the next exact SectionRevision checkpoint " +
        "Proposal (Detail stage). The target is always the run's active work — you cannot choose a " +
        "section id, revision number, or status. Record the exact dependency context (every " +
        "structural dependency, with the consumes names its approved contract provides), committed " +
        "decisions, referenced questions, and BOTH stable projections (compact + dependency-facing " +
        "contract). A dependency without an approved contract does not block the checkpoint — the " +
        "section is marked needs_review until a revalidated checkpoint lands. The user approves the " +
        "full design + projections as one payload; you can NEVER approve or commit it.",
      args: {
        problem: tool.schema.string().describe("Precise problem definition this revision solves"),
        design: tool.schema.string().describe("The concrete design of this revision"),
        interfaces: tool.schema
          .array(
            tool.schema.object({
              name: tool.schema.string(),
              description: tool.schema.string(),
              signature: tool.schema.string().optional(),
            }),
          )
          .describe("Interfaces this revision defines (names must be unique)"),
        invariants: tool.schema.array(tool.schema.string()).describe("Invariants this revision establishes"),
        failureModes: tool.schema
          .array(
            tool.schema.object({
              description: tool.schema.string(),
              mitigation: tool.schema.string().optional(),
            }),
          )
          .describe("Failure modes this revision anticipates"),
        dependencies: tool.schema
          .array(
            tool.schema.object({
              sectionID: tool.schema.string().describe("Structural dependency section (e.g. SEC-001)"),
              consumes: tool.schema
                .array(tool.schema.string())
                .describe("Names this revision consumes from the dependency's approved contract"),
            }),
          )
          .describe("The exact dependency context: every structural dependency of the section, once"),
        decisions: tool.schema
          .array(tool.schema.string())
          .describe("Committed decision ids this revision stands on (must already exist)"),
        openQuestions: tool.schema
          .array(tool.schema.string())
          .describe("Open question ids this revision references (must already exist)"),
        impacts: tool.schema
          .array(tool.schema.string())
          .describe("Committed section ids this design affects (design metadata only)"),
        compactProjection: tool.schema
          .string()
          .describe("Stable compact projection — frozen into the revision, never regenerated"),
        contract: tool.schema.object({
          provides: tool.schema.array(tool.schema.string()).describe("Names this section provides to dependents"),
          requires: tool.schema.array(tool.schema.string()).describe("Names this section requires from dependencies"),
          invariants: tool.schema
            .array(tool.schema.string())
            .describe("Contract invariants (must restate invariants of this revision)"),
          interfaces: tool.schema
            .array(
              tool.schema.object({
                name: tool.schema.string().describe("Interface name (must be defined by this revision)"),
                providedBy: tool.schema.string().optional(),
              }),
            )
            .describe("Interfaces exposed by this contract"),
          decisions: tool.schema
            .array(
              tool.schema.object({
                id: tool.schema.string().describe("Decision id (must be referenced by this revision)"),
                revision: tool.schema.number().describe("Exact committed decision revision"),
              }),
            )
            .describe("Decisions the contract cites, exactly"),
        }),
      },
      async execute(args, context: ToolContext) {
        try {
          // Transport layer: raw model strings ride in the tool args; the
          // controller validates every field and assigns the branded
          // identities (nothing authoritative is accepted from the model).
          const input = {
            problem: args.problem,
            design: args.design,
            interfaces: args.interfaces ?? [],
            invariants: args.invariants ?? [],
            failureModes: args.failureModes ?? [],
            dependencies: args.dependencies ?? [],
            decisions: args.decisions ?? [],
            openQuestions: args.openQuestions ?? [],
            impacts: args.impacts ?? [],
            projection: { compact: args.compactProjection, contract: args.contract },
          } as unknown as SectionCheckpointInput;
          const prepared = await controller.prepareSectionCheckpoint(context.sessionID, input);
          return {
            title: `Section checkpoint ${prepared.proposal.id} prepared`,
            output: [
              `Proposal ${prepared.proposal.id} (${prepared.proposal.type}, revision ${prepared.proposal.revision}) is READY.`,
              renderProposalForApproval(prepared.proposal),
              "Awaiting USER approval via the approval boundary — you cannot approve or commit it.",
            ].join("\n"),
            metadata: {
              proposalID: prepared.proposal.id,
              hash: prepared.hash,
              status: prepared.proposal.status,
              sections: prepared.proposal.impact.affectedSections,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_request_user_approval: tool({
      description:
        "Present a READY proposal to the USER for an explicit one-shot approval decision. " +
        "This tool can NEVER approve anything itself: actor='user' comes only from the real " +
        "user's confirmation. On allow, the immutable Approval is recorded and the transaction " +
        "engine commits atomically; on deny, the proposal is rejected with no commit.",
      args: {
        proposalID: tool.schema.string().describe("The READY proposal to present (e.g. PROP-001)"),
      },
      async execute(args, context: ToolContext) {
        try {
          // Harness validates capability + proposal state; ready → awaiting_approval.
          const begun = await controller.beginProposalApproval(context.sessionID, args.proposalID);
          try {
            // One-shot structured user decision point. The `always` list is
            // deliberately EMPTY — a persistent permission must never become a
            // standing approval authority. The exact proposal binding rides in
            // the permission string and metadata; the rendered view is a
            // deterministic projection of the FROZEN proposal (§19), never
            // model-generated approval prose.
            const approvalView = renderProposalForApproval(begun.proposal);
            await context.ask({
              permission: `ultraplan.approval:${begun.request.proposalID}@${begun.request.proposalRevision}:${begun.request.proposalHash.slice(0, 16)}`,
              patterns: [],
              always: [],
              metadata: {
                kind: "ultraplan.proposal-approval",
                oneShot: true,
                proposalID: begun.request.proposalID,
                proposalRevision: begun.request.proposalRevision,
                proposalHash: begun.request.proposalHash,
                proposalType: begun.proposal.type,
                title: begun.proposal.title,
                summary: begun.proposal.summary,
                approvalView,
              },
            });
          } catch (error) {
            const rejected = await controller.rejectProposal(
              context.sessionID,
              args.proposalID,
              begun.request,
            );
            const reason = error instanceof Error ? error.message : String(error);
            return {
              title: `Proposal ${rejected.id} rejected by user`,
              output: `Proposal ${rejected.id} was DENIED by the user; no Approval authorization was created and nothing was committed.`,
              metadata: { proposalID: rejected.id, status: rejected.status, denialReason: reason },
            };
          }
          const result = await controller.recordApprovalAndCommit(
            context.sessionID,
            args.proposalID,
            begun.request,
          );
          return {
            title: `Proposal ${result.commit.proposalID} approved and committed`,
            output: [
              `User APPROVED proposal ${result.commit.proposalID}.`,
              `PlanCommit ${result.commit.id} applied ${result.commit.changes.length} change(s); parent=${result.commit.parentCommit ?? "none"}.`,
              `Snapshot ${result.commit.resultingSnapshot} is the new HEAD.`,
              ...(result.run ? [`Run stage: ${result.run.stage}.`] : []),
            ].join("\n"),
            metadata: {
              commitID: result.commit.id,
              snapshotID: result.commit.resultingSnapshot,
              proposalID: result.commit.proposalID,
              approvalID: result.commit.approvalID,
              status: "approved",
              ...(result.run ? { stage: result.run.stage, architecture: result.run.architecture } : {}),
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_request_reopen: tool({
      description:
        "Request reopening an APPROVED section (the sanctioned way back to design). In SYNTHESIS: only after " +
        "semantic validation produced a FINDINGS report — name the target section and the report's finding ids " +
        "affecting it; the Harness resolves the exact revision and binds the report hash. In DETAIL: a " +
        "dependency_review of an approved but needs_review section — supply only the section id. This freezes an " +
        "amendment Proposal; the USER must approve it, and only then does a reopen_section PlanCommit set " +
        "status approved -> reopened, validation -> needs_review, active work -> the target (and stage synthesis " +
        "-> detail). You can never set Section status, stage, activeWork, validation, or revision directly, and " +
        "the approved revision stays immutable — reopen means the design must earn a NEW approved checkpoint.",
      args: {
        sectionID: tool.schema.string().describe("Target section id (e.g. SEC-002); must be approved with agreeing revision pointers"),
        findingIDs: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Semantic-validation finding ids (e.g. VF-001) from the CURRENT findings report — synthesis-stage reopens only; omit for detail-stage dependency review"),
      },
      async execute(args, context: ToolContext) {
        try {
          const prepared = await controller.requestReopen(context.sessionID, {
            sectionID: args.sectionID,
            ...(args.findingIDs && args.findingIDs.length > 0 ? { findingIDs: args.findingIDs } : {}),
          });
          return {
            title: `Reopen requested for ${args.sectionID}`,
            output: [
              `amendment proposal ${prepared.proposal.id} prepared to reopen ${args.sectionID} (hash ${prepared.hash}).`,
              renderProposalForApproval(prepared.proposal),
              "Awaiting USER approval via the approval boundary — you cannot approve or commit it.",
            ].join("\n"),
            metadata: { proposalID: prepared.proposal.id, target: args.sectionID, hash: prepared.hash },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_run_semantic_validation: tool({
      description:
        "Request SEMANTIC VALIDATION of the current synthesis output (Synthesis stage, after begin_synthesis + " +
        "submit_synthesis_manifest). You supply NOTHING: the Harness resolves the exact SynthesisInput + " +
        "SynthesisManifest pair, invokes the isolated read-only validator, strictly parses its structured " +
        "output, and persists an immutable ValidationReport. You can NEVER declare the manifest clean yourself " +
        "and no validator output can mutate committed memory. Anti-re-roll: the same exact manifest identity " +
        "always returns its existing report — to obtain another judgment the manifest must actually change. " +
        "result=findings exposes the sanctioned reopen path (ultraplan_request_reopen); result=clean does NOT " +
        "grant finalization. Nothing is committed and HEAD never moves.",
      args: {},
      async execute(_args, context: ToolContext) {
        try {
          const result = await controller.runSemanticValidation(context.sessionID);
          const report = result.report;
          return {
            title: `ValidationReport ${report.id}: ${report.result}${result.idempotent ? " (existing report returned)" : ""}`,
            output: [
              `ValidationReport ${report.id} — result: ${report.result.toUpperCase()}.`,
              `Identity: input ${report.input.id} (hash ${report.inputHash.slice(0, 16)}…) + manifest ${report.manifest.id}@${report.manifest.revision} (hash ${report.manifestHash.slice(0, 16)}…), protocol ${report.validatorProtocol}.`,
              `Findings: ${report.findings.length}.`,
              ...report.findings.map(
                (finding) => `  ${finding.id} ${finding.category} — ${finding.statement}`,
              ),
              ...(report.result === "findings"
                ? ["The synthesis output is BLOCKED. Inspect the report (plan_memory kind=validation_report) and request a sanctioned Section reopen (ultraplan_request_reopen) for an exact affected section."]
                : ["Semantic validation is clean — this proves ONLY the semantic-validation component. Finalization has NOT run and design mutation remains forbidden."]),
              "The report is an immutable derived artifact: nothing was committed, HEAD did not move, and the stage remains synthesis.",
            ].join("\n"),
            metadata: {
              reportID: report.id,
              result: report.result,
              findings: report.findings.length,
              inputID: report.input.id,
              manifestID: report.manifest.id,
              manifestRevision: report.manifest.revision,
              idempotent: result.idempotent,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_request_finalization: tool({
      description:
        "Request DETERMINISTIC FINALIZATION of the plan (Synthesis stage, after a CURRENT clean semantic validation). " +
        "You supply NOTHING — no force flags, no manifest/report/evidence references: the Harness resolves the exact " +
        "current synthesis identity, builds the immutable Evidence Audit over every reachable Evidence record, and " +
        "evaluates the deterministic Finalization Gate (no model call, no bypass). Outcomes: blocked/stale return the " +
        "exact machine blockers or staleness reasons (resolve them through normal planning/evidence workflows — never " +
        "claim the plan is final); pass freezes an immutable FinalPlanCandidate assembled from approved Plan Memory + " +
        "the validated manifest + the clean report + the passing audit. The candidate is NOT user approval, does NOT " +
        "authorize Build, never sets PlanningRun.finalPlan, never moves HEAD, and the stage REMAINS synthesis. " +
        "Idempotent: the same successful identity returns the same candidate.",
      args: {},
      async execute(_args, context: ToolContext) {
        try {
          const result = await controller.requestFinalization(context.sessionID);
          if (result.gate.result === "stale") {
            return {
              title: "Finalization stale — re-resolve from current state",
              output: [
                "Finalization is STALE: the authoritative state moved on. Nothing was frozen; re-resolve from current state.",
                ...result.gate.stale.map((entry) => `  stale: ${entry.code}${entry.detail ? ` — ${entry.detail}` : ""}`),
                ...(result.audit ? [`Evidence audit: ${result.audit.id} ${result.audit.result} (persisted for the evidence term).`] : []),
                "Do not rebase an old candidate; re-run ultraplan_request_finalization after re-resolving (a genuinely changed manifest requires a new submission).",
              ].join("\n"),
              metadata: { gate: "stale", stale: result.gate.stale.map((entry) => entry.code), ...(result.audit ? { auditID: result.audit.id } : {}) },
            };
          }
          if (result.gate.result === "blocked") {
            return {
              title: "Finalization blocked",
              output: [
                "Finalization is BLOCKED. Inspect the exact machine blockers; do not claim the plan is final.",
                ...result.gate.blockers.map((blocker) => `  blocker: ${blocker.code}${blocker.sectionID ? ` ${blocker.sectionID}` : ""}${blocker.questionIDs ? ` ${blocker.questionIDs.join(",")}` : ""}${blocker.conflictIDs ? ` ${blocker.conflictIDs.join(",")}` : ""}${blocker.detail ? ` — ${blocker.detail}` : ""}`),
                ...(result.audit ? [`Evidence audit: ${result.audit.id} ${result.audit.result} (persisted for the evidence term).`] : []),
                "Resolve through normal planning/evidence workflows; you cannot bypass these checks.",
              ].join("\n"),
              metadata: { gate: "blocked", blockers: result.gate.blockers.map((blocker) => blocker.code), ...(result.audit ? { auditID: result.audit.id } : {}) },
            };
          }
          const candidate = result.candidate!.candidate;
          return {
            title: `Finalization passed — FinalPlanCandidate ${candidate.id}@${candidate.revision}${result.candidate!.idempotent ? " (existing candidate returned)" : ""}`,
            output: [
              result.candidate!.preview,
              "",
              `Gate identity: HEAD ${result.gate.identity.headSnapshot.id} + input ${result.gate.identity.synthesisInput.id} + manifest ${result.gate.identity.synthesisManifest.id}@${result.gate.identity.synthesisManifest.revision} + report ${result.gate.identity.validationReport.id} + audit ${result.gate.identity.evidenceAudit.id}.`,
              "Nothing was committed: zero PlanCommits, zero Snapshots, HEAD unchanged, PlanningRun.finalPlan unset, stage remains synthesis.",
              "Formal Final Approval is a later workflow — this candidate is NOT user authorization and does NOT authorize Build.",
            ].join("\n"),
            metadata: {
              gate: "pass",
              candidateID: candidate.id,
              candidateRevision: candidate.revision,
              candidateHash: candidate.hash,
              auditID: candidate.evidenceAudit.id,
              idempotent: result.candidate!.idempotent,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_prepare_final_plan: tool({
      description:
        "Freeze the FORMAL FINAL PLAN PROPOSAL from the current FinalPlanCandidate (Synthesis, candidate-ready). " +
        "You supply NOTHING — no candidate/manifest/report refs, no plan content: the Harness reruns the " +
        "deterministic Finalization Gate, requires the current candidate's exact identity, projects the FinalPlan " +
        "from the candidate, Harness-assigns FINAL-###@1, and freezes a Proposal with exactly one add_final_plan " +
        "change. The Proposal is NOT approval: nothing is committed, HEAD does not move, and the stage REMAINS " +
        "synthesis until the user approves and the Final PlanCommit succeeds. Idempotent: the same current " +
        "candidate returns its existing ready/awaiting Proposal. If the candidate is stale or the gate blocks, " +
        "re-resolve through the normal workflows first — never rebase an old candidate.",
      args: {},
      async execute(_args, context: ToolContext) {
        try {
          const prepared = await controller.prepareFinalPlan(context.sessionID);
          return {
            title: `Final Proposal ${prepared.proposal.id} prepared${prepared.idempotent ? " (existing Proposal returned)" : ""}`,
            output: [
              prepared.preview,
              "",
              "The Proposal is frozen but NOT approved. Approval is USER authority via ultraplan_request_user_approval; the Harness commits only after approval AND a passing second Finalization Gate.",
            ].join("\n"),
            metadata: {
              proposalID: prepared.proposal.id,
              proposalType: prepared.proposal.type,
              hash: prepared.hash,
              status: prepared.proposal.status,
              idempotent: prepared.idempotent,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_request_synthesis: tool({
      description:
        "WITHHELD legacy gate. request_synthesis is not granted in any reachable state: the real Synthesis " +
        "workflow (ultraplan_begin_synthesis + ultraplan_submit_synthesis_manifest) must not be bypassed, and " +
        "synthesis → final is a later phase. Calling this fails deterministically.",
      args: {},
      async execute(_args, context: ToolContext) {
        try {
          const result = await controller.requestSynthesis(context.sessionID);
          return {
            title: `Ultra Plan ${result.run.id} entered final`,
            output: result.statusText,
            metadata: { planID: result.run.id, stage: result.run.stage },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_begin_synthesis: tool({
      description:
        "Freeze the SynthesisInput (Synthesis stage). You supply NO references or selections: the Harness " +
        "validates the structural entry gates and resolves EVERYTHING authoritative from the exact HEAD " +
        "Snapshot — the approved Architecture ref, every approved Section at its exact revision (canonical " +
        "order), committed decisions/constraints, frozen blocker state, and the reachable Evidence chain. " +
        "Returns the immutable input identity/hash plus a deterministic synthesis capsule. Idempotent: " +
        "calling it again at the same HEAD returns the SAME input. This never changes the stage, never " +
        "commits, and never moves HEAD.",
      args: {},
      async execute(_args, context: ToolContext) {
        try {
          const result = await controller.beginSynthesis(context.sessionID);
          return {
            title: `SynthesisInput ${result.input.id} frozen`,
            output: [
              result.capsule,
              "",
              "Reason over approved/frozen design ONLY. Submit derived output with ultraplan_submit_synthesis_manifest.",
            ].join("\n"),
            metadata: {
              inputID: result.input.id,
              baseSnapshot: result.input.baseSnapshot.id,
              hash: result.input.hash,
              sections: result.input.sections.map((section) => `${section.ref.id}@${section.ref.revision}`),
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),

    ultraplan_submit_synthesis_manifest: tool({
      description:
        "Submit derived synthesis output as the next immutable SynthesisManifest revision (Synthesis stage, " +
        "after ultraplan_begin_synthesis). You supply ONLY derived content: cross-section links (each citing " +
        "at least two DISTINCT Sections), the implementation order (covering every approved Section, " +
        "respecting Section dependencies — step numbers come from array order), limitations, and findings. " +
        "EVERY statement needs exact source provenance inside the frozen input. The Harness validates " +
        "structure (provenance, coverage, DAG order) and rejects violations deterministically; identity, " +
        "revision, input binding, and hash are Harness-assigned. Creating a manifest never approves anything, " +
        "never commits, never moves HEAD, and is structurally — not semantically — validated.",
      args: {
        crossSectionLinks: tool.schema
          .array(
            tool.schema.object({
              statement: tool.schema.string().describe("The derived connection between approved Section designs"),
              sources: tool.schema
                .array(sourceRefShape)
                .describe("Exact source refs (at least two DISTINCT Sections through exact section refs)"),
            }),
          )
          .describe("Derived connections between approved Section designs"),
        implementationOrder: tool.schema
          .array(
            tool.schema.object({
              title: tool.schema.string().describe("Step title"),
              description: tool.schema.string().describe("What this step delivers"),
              sections: tool.schema
                .array(
                  tool.schema.object({
                    id: tool.schema.string().describe("Section id (e.g. SEC-001)"),
                    revision: tool.schema.number().describe("Exact approved revision from the frozen input"),
                  }),
                )
                .describe("Sections this step implements (exact frozen revisions)"),
              sources: tool.schema.array(sourceRefShape).describe("Exact source provenance for this step"),
            }),
          )
          .describe("The derived implementation order (array order IS the step order; every approved Section must appear)"),
        limitations: tool.schema
          .array(
            tool.schema.object({
              statement: tool.schema.string().describe("The limitation (uncertainty, trade-off, missing certainty)"),
              sources: tool.schema.array(sourceRefShape).describe("Exact source provenance"),
            }),
          )
          .describe("Derived limitations of the approved design"),
        unresolvedFindings: tool.schema
          .array(
            tool.schema.object({
              category: tool.schema
                .enum(["contradiction", "missing_design", "missing_dependency", "coverage_gap"])
                .describe("Finding category"),
              statement: tool.schema.string().describe("What was discovered"),
              sources: tool.schema
                .array(sourceRefShape)
                .optional()
                .describe("Exact source refs where applicable (may cite blockers raised after the freeze)"),
            }),
          )
          .describe("Synthesis-discovered issues (a report — never a design mutation)"),
      },
      async execute(args, context: ToolContext) {
        try {
          const result = await controller.submitSynthesisManifest(context.sessionID, {
            crossSectionLinks: args.crossSectionLinks ?? [],
            implementationOrder: args.implementationOrder ?? [],
            limitations: args.limitations ?? [],
            unresolvedFindings: args.unresolvedFindings ?? [],
          });
          return {
            title: `SynthesisManifest ${result.manifest.id}@${result.manifest.revision} ${result.idempotent ? "replayed" : "saved"}`,
            output: [
              `SynthesisManifest ${result.manifest.id}@${result.manifest.revision} is STRUCTURALLY valid (provenance, coverage, Section-DAG order).${result.idempotent ? " Exact resubmission — the existing revision was returned." : ""}`,
              `Input: ${result.manifest.input.id} (hash ${result.manifest.inputHash.slice(0, 16)}…)`,
              `Hash: ${result.manifest.hash}`,
              `Cross-section links: ${result.manifest.crossSectionLinks.length}; implementation steps: ${result.manifest.implementationOrder.length}; limitations: ${result.manifest.limitations.length}; findings: ${result.manifest.unresolvedFindings.length}.`,
              "Semantic validation has NOT run; the stage remains synthesis; nothing was committed and HEAD did not move.",
            ].join("\n"),
            metadata: {
              manifestID: result.manifest.id,
              revision: result.manifest.revision,
              hash: result.manifest.hash,
              inputID: result.manifest.input.id,
              idempotent: result.idempotent,
            },
          };
        } catch (error) {
          const structured = asToolResult(error);
          if (structured) return structured;
          throw error;
        }
      },
    }),
  };

  return tools;
}
