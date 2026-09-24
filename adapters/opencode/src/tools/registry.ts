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
import { PREPARED_CHANGE_KINDS } from "../core/controller.js";
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
    .enum(["architecture", "section", "decision", "constraint", "question", "conflict", "evidence", "proposal", "snapshot", "commit", "final_plan"])
    .describe("Kind of memory object being referenced"),
  id: tool.schema.string().optional().describe("Artifact id (e.g. SEC-001, DEC-014, Q-007)"),
  revision: tool.schema.number().optional().describe("Exact revision — required for decisions; never resolved to latest"),
};

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
        "Read-only access to committed Plan Memory (spec §20). Reads an artifact by exact " +
        "reference, the current run summary, or the dependency contracts of a section. " +
        "Never mutates state; explicit revisions are never silently resolved to latest.",
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

    ultraplan_request_completion: tool({
      description:
        "Request completion of a section: prepares a section_completion proposal declaring the " +
        "section's committed design complete. Requires the section to exist and all dependencies to be approved.",
      args: {
        sectionID: tool.schema.string().describe("Section id (e.g. SEC-001)"),
      },
      async execute(args, context: ToolContext) {
        try {
          const prepared = await controller.requestCompletion(context.sessionID, { sectionID: args.sectionID });
          return {
            title: `Completion requested for ${args.sectionID}`,
            output: `section_completion proposal ${prepared.proposal.id} prepared (hash ${prepared.hash}). Awaiting USER approval.`,
            metadata: { proposalID: prepared.proposal.id, sectionID: args.sectionID },
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
            // the permission string and metadata.
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
            ].join("\n"),
            metadata: {
              commitID: result.commit.id,
              snapshotID: result.commit.resultingSnapshot,
              proposalID: result.commit.proposalID,
              approvalID: result.commit.approvalID,
              status: "approved",
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
        "Request reopening an approved section or decision because later work invalidated it. " +
        "Prepares an amendment proposal; approved design is never silently edited.",
      args: {
        kind: tool.schema.enum(["section", "decision"]).describe("What to reopen"),
        id: tool.schema.string().describe("Artifact id (e.g. SEC-003)"),
        revision: tool.schema.number().optional().describe("Exact revision being amended, if known"),
      },
      async execute(args, context: ToolContext) {
        try {
          const prepared = await controller.requestReopen(context.sessionID, {
            ref: { kind: args.kind, id: args.id, ...(args.revision !== undefined ? { revision: args.revision } : {}) },
          });
          return {
            title: `Reopen requested for ${args.id}`,
            output: `amendment proposal ${prepared.proposal.id} prepared to reopen ${args.kind} ${args.id}. Awaiting USER approval.`,
            metadata: { proposalID: prepared.proposal.id, target: args.id },
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
        "Request the synthesis → final gate. The Harness runs the deterministic finalization " +
        "predicate: architecture approved, all sections approved and valid, zero blocking " +
        "questions/conflicts, critical evidence fresh. Blocked requests fail with the exact failures.",
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
  };

  return tools;
}
