/**
 * ExecutionSupervisorContext — v0.2.0 Phase 7A (directive §18/§19).
 *
 * The DETERMINISTIC, structure-first projection a Supervisor model reasons
 * over at the start of every control turn. Rebuilt from canonical durable
 * Store state ONLY — never from conversation summary, never from hidden
 * model state (§68: destroying the conversation loses nothing). It carries a
 * COMPACT current-execution view plus the exact identity of recent
 * artifacts; deeper inspection goes through the read operations (§20), never
 * by injecting the whole Plan Memory or full history.
 *
 * Pure builder: the store owns the reads, this module owns NO policy beyond
 * the bounded recency windows below.
 */
import type { ExecutionRecoveryContext } from "./execution-recovery.js";
import { EXECUTION_SUPERVISOR_OPERATION_SPECS } from "../runtime/supervisor-tools.js";
import type { ExecutionDirective } from "./execution-directive.js";
import type { ExecutionReport } from "./execution-report.js";
import type { SupervisorAssessment } from "./supervisor-assessment.js";
import type { ExecutionCommit } from "./execution-commit.js";
import type { ExecutionStage } from "./execution-stage.js";

/** Bounded recency: the last N artifacts of each kind (§18 "recent exact"). */
export const SUPERVISOR_CONTEXT_RECENT_LIMIT = 10;

/** §22 — the Supervisor's available operations (read + control). Names only; the handler map is the authority. */
export const EXECUTION_SUPERVISOR_OPERATIONS = [
  // read
  "execution_get_state",
  "execution_get_stage",
  "execution_get_window",
  "execution_get_directive",
  "execution_get_report",
  "execution_get_commit",
  "execution_get_conflict",
  "execution_get_issue",
  "execution_read_plan_ref",
  // control
  "execution_create_stages",
  "execution_activate_stage",
  "execution_open_window",
  "execution_issue_directive",
  "execution_submit_assessment",
  "execution_create_verification_conflict",
  "execution_record_reconciliation",
  "execution_transition_replan",
  "execution_prepare_final_closure",
  "execution_complete_run",
] as const;

export type ExecutionSupervisorOperation = (typeof EXECUTION_SUPERVISOR_OPERATIONS)[number];

/** Compact identity projections — exact refs, never full records. */
export interface SupervisorContextDirectiveRef {
  id: string;
  revision: number;
  hash: string;
  kind: string;
  objective: string;
  candidateEffect: string;
  baseCandidateRevision: number;
}

export interface SupervisorContextReportRef {
  id: string;
  attemptID: string;
  result: string;
  candidateMutation: string;
  findingCount: number;
  blockerCount: number;
}

export interface SupervisorContextAssessmentRef {
  id: string;
  disposition: string;
  acceptanceScope: string;
  candidateRevision: number;
}

export interface SupervisorContextCommitRef {
  id: string;
  windowID: string;
  candidateRevision: number;
  stageCompleted: boolean;
  satisfiedObligations: string[];
}

/** §18 — the deterministic Supervisor context for ONE control turn. */
export interface ExecutionSupervisorContext {
  /** §65 — the compact protocol rules (mirrored in the prompt; data, not prose). */
  protocolRules: string[];
  executionRun: {
    id: string;
    lifecycle: string;
    /** Current record revision — the CAS baseline for the turn's mutations. */
    revision: number;
    finalPlan: { id: string; revision: number };
    acceptedHead?: string;
    currentAcceptedState: ExecutionRecoveryContext["currentAcceptedState"];
  };
  finalPlanIdentity: { id: string; revision: number; hash: string; goal: string };
  /** The full store-decorated recovery projection (§65/§66/§54 fields included). */
  recovery: ExecutionRecoveryContext;
  recent: {
    directives: SupervisorContextDirectiveRef[];
    reports: SupervisorContextReportRef[];
    assessments: SupervisorContextAssessmentRef[];
    commits: SupervisorContextCommitRef[];
  };
  /**
   * §88 — the EXACT operation contracts (name, description, mutability, and
   * the args shape) so the model never guesses argument names.
   */
  availableOperations: readonly {
    name: ExecutionSupervisorOperation;
    description: string;
    readonly: boolean;
    args: Record<string, string>;
  }[];
  /**
   * §88 — the LIVE CAS baselines for this turn's authoritative operations,
   * read from the same snapshot as the context (fresh when the turn starts).
   */
  casHints: {
    runRevision: number;
    stageID?: string;
    stageRevision?: number;
    windowID?: string;
    windowRevision?: number;
    /** The open Window's monotonic candidate counter — the EXACT value submit_assessment binds. */
    candidateRevision?: number;
  };
  /**
   * §88 (Phase 8 live-hardening) — the run's Stage decomposition with EXACT
   * ids and record revisions, so the model can CAS-activate a pending Stage
   * (or prepare final closure) without guessing ids or revisions, and never
   * re-creates a decomposition that already exists. completionObligations
   * carries the EXACT obligation ids the Stage's verification coverage and
   * acceptance assessments must cite.
   */
  stages?: readonly {
    id: string;
    kind: string;
    status: string;
    revision: number;
    title: string;
    completionObligations: readonly { id: string; description: string }[];
  }[];
  /** §88 — the exact Directive draft contract, surfaced inline. */
  directiveDraftContract: {
    requiredFields: string[];
    kind: string[];
    candidateEffect: string[];
    verification_only_fields: Record<string, string>;
    planRefs_shape: Record<string, string>[];
    capabilityEnvelope_fields: string[];
    note: string;
    worked_example: Record<string, unknown>;
    verification_envelope_note: string;
    verification_worked_example: Record<string, unknown>;
  };
  /** §88 (Phase 8 live-hardening) — the exact SupervisorAssessment draft contract. */
  assessmentDraftContract: {
    requiredFields: string[];
    disposition: string[];
    acceptanceScope: string[];
    note: string;
    decision_rules: string[];
    worked_example: Record<string, unknown>;
  };
}

export interface AssembleExecutionSupervisorContextInput {
  recovery: ExecutionRecoveryContext;
  /** The ExecutionRun's current record revision (CAS baseline). */
  runRevision: number;
  /** §88 — the live Stage/Window CAS baselines when a Stage/Window is open. */
  cas?: { stageID?: string; stageRevision?: number; windowID?: string; windowRevision?: number; candidateRevision?: number };
  /** §88 (Phase 8) — the run's Stage decomposition (exact ids + revisions). */
  stages?: readonly ExecutionStage[];
  finalPlanIdentity: { id: string; revision: number; hash: string; goal: string };
  directives: ExecutionDirective[];
  reports: ExecutionReport[];
  assessments: SupervisorAssessment[];
  commits: ExecutionCommit[];
}

/** §65 — the read/direct/judge boundary, as data. */
export const EXECUTION_PROTOCOL_RULES = [
  "You are the Execution Supervisor: you read, reason, direct, and judge.",
  "You never edit repository files and never run shell/tests directly — Workers do.",
  "Direct work only through exact execution operations (Directives); never invoke a Worker yourself.",
  "The FinalPlan outranks every Directive; Workers may settle local non-normative choices.",
  "If normative authority is insufficient, submit a request_replan assessment.",
  "Never infer success from Worker prose — only durable Reports and Assessments are evidence.",
  "Never bypass verification, conflict, reconciliation, or completion gates — Core owns every acceptance.",
] as const;

/**
 * Build the context from canonical records. Pure — bounded recency, no
 * derivation beyond identity projection.
 */
export function assembleExecutionSupervisorContext(input: AssembleExecutionSupervisorContextInput): ExecutionSupervisorContext {
  const run = input.recovery;
  const last = <T>(items: T[]): T[] => items.slice(-SUPERVISOR_CONTEXT_RECENT_LIMIT);
  return {
    protocolRules: [...EXECUTION_PROTOCOL_RULES],
    executionRun: {
      id: run.executionRunID,
      lifecycle: run.lifecycle,
      revision: input.runRevision,
      finalPlan: { id: run.finalPlan.id, revision: run.finalPlan.revision },
      ...(run.acceptedHead !== undefined ? { acceptedHead: run.acceptedHead } : {}),
      currentAcceptedState: run.currentAcceptedState,
    },
    finalPlanIdentity: input.finalPlanIdentity,
    recovery: run,
    recent: {
      directives: last(input.directives).map((directive) => ({
        id: directive.id,
        revision: directive.revision,
        hash: directive.hash,
        kind: directive.kind,
        objective: directive.objective,
        candidateEffect: directive.candidateEffect,
        baseCandidateRevision: directive.baseCandidateRevision,
      })),
      reports: last(input.reports).map((report) => ({
        id: report.id,
        attemptID: report.attemptID,
        result: report.result,
        candidateMutation: report.candidateMutation,
        findingCount: report.findings.length,
        blockerCount: report.blockers.length,
      })),
      assessments: last(input.assessments).map((assessment) => ({
        id: assessment.id,
        disposition: assessment.disposition,
        acceptanceScope: assessment.acceptanceScope,
        candidateRevision: assessment.candidateRevision,
      })),
      commits: last(input.commits).map((commit) => ({
        id: commit.id,
        windowID: commit.windowID,
        candidateRevision: commit.candidateRevision,
        stageCompleted: commit.stageCompleted,
        satisfiedObligations: [...commit.satisfiedObligations] as string[],
      })),
    },
    casHints: {
      runRevision: input.runRevision,
      ...(input.cas?.stageID !== undefined ? { stageID: input.cas.stageID } : {}),
      ...(input.cas?.stageRevision !== undefined ? { stageRevision: input.cas.stageRevision } : {}),
      ...(input.cas?.windowID !== undefined ? { windowID: input.cas.windowID } : {}),
      ...(input.cas?.windowRevision !== undefined ? { windowRevision: input.cas.windowRevision } : {}),
      ...(input.cas?.candidateRevision !== undefined ? { candidateRevision: input.cas.candidateRevision } : {}),
    },
    ...(input.stages !== undefined
      ? {
          stages: input.stages.map((stage) => ({
            id: stage.id,
            // Additive-family default (§33): an absent kind is an ordinary Stage.
            kind: stage.kind ?? "ordinary",
            status: stage.status,
            revision: stage.revision,
            title: stage.title,
            completionObligations: (stage.completionObligations ?? []).map((obligation) => ({
              id: obligation.id,
              description: obligation.description,
            })),
          })),
        }
      : {}),
    availableOperations: EXECUTION_SUPERVISOR_OPERATION_SPECS.map((spec) => ({ name: spec.name, description: spec.description, readonly: spec.readonly, args: { ...spec.args } })),
    // §88 — the EXACT directive draft contract, inline, so the model never
    // guesses field names or vocabularies when authoring a Directive.
    directiveDraftContract: {
      requiredFields: ["kind", "objective", "planRefs", "expectedExecutionScope", "capabilityEnvelope", "candidateEffect", "invariants", "requiredActions", "forbiddenActions", "validationRequirements", "deliverables", "stopConditions", "reportContract", "body"],
      kind: ["implementation", "verification", "inspection"],
      candidateEffect: ["may_mutate", "non_mutating"],
      verification_only_fields: { verificationPurpose: "acceptance | conflict_resolution | reconciliation_inspection", coverage: "verificationCoverage.obligationRefs = the EXACT completionObligations[].id strings from the stages list; the same exact ids go into assessment draft.coveredObligations" },
      planRefs_shape: [
        { kind: "final_plan", id: "FinalPlan id string (FINAL-001)", revision: "number" },
        { kind: "section_revision", id: "Section id string (SEC-001)", revision: "number" },
        { kind: "decision", id: "Decision id string (DEC-001)", revision: "number" },
        { kind: "constraint", id: "Constraint id string (CON-001)", revision: "number" },
        { kind: "implementation_step", order: "1-based order number" },
      ],
      capabilityEnvelope_fields: ["repositoryRead", "repositoryWrite", "commandExecution", "networkAccess", "dependencyMutation", "gitCommit", "gitPush", "externalServiceMutation"],
      note: "The envelope may only NARROW the trusted ceiling in your context; verification Directives are non_mutating and must declare verificationCoverage.obligationRefs for the stage's obligations.",
      worked_example: {
        tool: "execution_issue_directive",
        args: {
          stageID: "<casHints.stageID>",
          windowID: "<casHints.windowID>",
          expectedRunRevision: "<casHints.runRevision>",
          expectedStageRevision: "<casHints.stageRevision>",
          expectedWindowRevision: "<casHints.windowRevision>",
          draft: {
            kind: "implementation",
            objective: "<what the Worker must do>",
            planRefs: [{ kind: "implementation_step", order: 1 }],
            expectedExecutionScope: {},
            capabilityEnvelope: { repositoryRead: true, repositoryWrite: true, commandExecution: false, networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false },
            candidateEffect: "may_mutate",
            invariants: [],
            requiredActions: [],
            forbiddenActions: [],
            validationRequirements: [],
            deliverables: ["a one-line change"],
            stopConditions: [],
            reportContract: "report every action and every file changed",
            body: "<exact instructions for the Worker>",
          },
        },
      },
      verification_envelope_note: "Tailor the verification envelope to the OBLIGATIONS being verified: grant exactly what verifying them requires (e.g. commandExecution when an obligation requires running a validation command). Verification stays non_mutating — no repositoryWrite.",
      verification_worked_example: {
        tool: "execution_issue_directive",
        args: {
          stageID: "<casHints.stageID>",
          windowID: "<casHints.windowID>",
          expectedRunRevision: "<casHints.runRevision>",
          expectedStageRevision: "<casHints.stageRevision>",
          expectedWindowRevision: "<casHints.windowRevision>",
          draft: {
            kind: "verification",
            verificationPurpose: "acceptance",
            verificationCoverage: { obligationRefs: ["<EXACT completionObligations[].id strings from the stages list>"] },
            objective: "<what the independent verifier must check>",
            planRefs: [{ kind: "final_plan", id: "<finalPlanIdentity.id>", revision: "<finalPlanIdentity.revision>" }],
            expectedExecutionScope: {},
            capabilityEnvelope: { repositoryRead: true, repositoryWrite: false, commandExecution: "<true ONLY when an obligation requires running a validation command>", networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false },
            candidateEffect: "non_mutating",
            invariants: [],
            requiredActions: [],
            forbiddenActions: [],
            validationRequirements: [],
            deliverables: [],
            stopConditions: [],
            reportContract: "report exactly what you verified and observed",
            body: "<exact verification instructions>",
          },
        },
      },
    },
    // §88 (Phase 8 live-hardening) — the EXACT assessment draft contract: the
    // model never guesses field names, vocabularies, or id formats.
    assessmentDraftContract: {
      requiredFields: ["reportRefs", "planRefs", "coveredObligations", "acceptanceScope", "disposition", "rationale"],
      disposition: ["accept", "rework", "need_more_verification", "blocked", "request_replan"],
      acceptanceScope: ["window", "stage"],
      note: "reportRefs = the EXACT durable Report ids you evaluated (e.g. [\"RPT-002\"]). coveredObligations = the EXACT completionObligations[].id strings from the stages list. There is NO findings field — findings live in Reports. window scope accepts the current candidate; stage scope additionally requests Stage closure.",
      decision_rules: [
        "disposition accept is REFUSED by Core unless every covered obligation has qualifying fresh verifier coverage AND no blocking finding/negative report exists on the current candidate — do not attempt accept when one exists.",
        "A blocking finding, a failed/blocked verifier report, or a defective candidate requires disposition rework: issue a NEW implementation Directive in the SAME window that corrects the exact defect (e.g. remove duplicated lines), then re-verify with a FRESH verification Directive (the earlier assessment is invalidated by the raised candidate).",
        "Insufficient verification evidence → need_more_verification with another verification Directive. Insufficient normative authority → request_replan. Never accept against a known defect.",
      ],
      worked_example: {
        tool: "execution_submit_assessment",
        args: {
          stageID: "<casHints.stageID>",
          windowID: "<casHints.windowID>",
          candidateRevision: "<casHints.candidateRevision>",
          draft: {
            reportRefs: ["<the durable Report ids you evaluated>"],
            planRefs: [{ kind: "final_plan", id: "<finalPlanIdentity.id>", revision: "<finalPlanIdentity.revision>" }],
            coveredObligations: ["<the exact obligation ids covered, e.g. OBS-001>"],
            acceptanceScope: "stage",
            disposition: "accept",
            rationale: "<why the evidence satisfies the covered obligations>",
          },
        },
      },
    },
  };
}

/**
 * Deterministic compact render for the model-facing turn input (§19): one
 * JSON block. Insertion order is fixed by the builder, so the render is
 * deterministic for identical store state.
 */
export function renderExecutionSupervisorContext(context: ExecutionSupervisorContext): string {
  return JSON.stringify(context);
}
