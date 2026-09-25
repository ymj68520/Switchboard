/**
 * L0 Planning Protocol — the deterministic protocol fragment injected into
 * planning-model context (frozen architecture §14 L0, Phase 2A brief §11).
 *
 * Rendered from static structured configuration plus the current capability
 * set. Never model-generated. Compact by design; token budgeting and the full
 * L1-L5 assembly are later phases.
 */
import { ULTRA_PLAN_CAPABILITIES, getCapabilities, type UltraPlanCapability } from "../core/capabilities.js";
import type { PlanningRun } from "../core/types.js";

const RULES: readonly string[] = [
  "You are operating inside the Ultra Plan planning harness for OpenCode.",
  "OpenCode owns the conversation, session, model inference, repository tools, and execution. Ultra Plan owns planning workflow, committed planning state, approvals, context construction, and repository evidence.",
  "COMMITTED MEMORY is authoritative and versioned. Your working discussion is NOT committed memory.",
  "Approved revisions are immutable. Changing approved design requires a reopen/amendment through a proposal.",
  "Only an explicit USER approval can authorize a Proposal. You can never approve your own work.",
  "Only the Harness transaction engine can commit a Proposal into committed memory. There is no tool for that.",
  "Your available operations are capability-limited to the current run state (listed below). Calling an unauthorized operation fails deterministically.",
  "Repository claims must be grounded: promote observations you actually made into Evidence; direct evidence requires source provenance.",
  "During synthesis you may only project and organize approved design; you may not introduce new unapproved architectural facts.",
  "Final handoff to execution is Harness-controlled and requires explicit Final Plan approval. You can never trigger it.",
];

function describeCapabilities(capabilities: ReadonlySet<UltraPlanCapability>): string {
  const lines = ["Available operations in the current state:"];
  for (const capability of ULTRA_PLAN_CAPABILITIES) {
    lines.push(`- [${capabilities.has(capability) ? "x" : " "}] ${capability}`);
  }
  return lines.join("\n");
}

/**
 * Stage-specific workflow guidance (Phase 2C/2D briefs §28/§34). Deterministic
 * fragments selected by the run's structured state — never model-generated,
 * never a dump of planning memory (the L1-L5 Context Assembler is later work).
 * The detail stage has two structured substates: decomposition-needed
 * (sections empty) and section-ready (DAG committed, activeWork set).
 */
const STAGE_GUIDANCE: Partial<Record<PlanningRun["stage"], readonly string[]>> = {
  discovery: [
    "DISCOVERY GOAL: understand the task and repository well enough to start top-level architecture.",
    "Explore the repository with OpenCode's tools; promote important observations into Evidence.",
    "Record genuine questions about the design space; propose candidate resolutions.",
    "Do not design detailed sections now — that belongs to later stages.",
    "When discovery is sufficient, call ultraplan_request_architecture; the Harness performs the transition.",
  ],
  architecture: [
    "ARCHITECTURE GOAL: produce a coherent TOP-LEVEL system architecture.",
    "Focus on: components, boundaries, major data flows, architectural principles, durable decisions, committed constraints, and important unresolved questions.",
    "Do NOT perform detailed Section design yet — decomposition starts only after architecture completion.",
    "Working discussion is not Architecture. The only path to committed ARCH@n is: prepare an exact architecture proposal -> the USER approves it -> the Harness commits it atomically.",
    "When the top-level design is ready, freeze it into a Proposal (ultraplan_prepare_proposal or ultraplan_request_completion with kind=architecture) and request user approval. Architecture completion transitions the run to detail in the SAME commit.",
  ],
  // Phase 2F §45 + Phase 2G: real Synthesis guidance. Deterministic fragments
  // over the run's derived-artifact state (input / manifest identity,
  // staleness, validation result) — never model-generated, never a planning
  // memory dump.
  synthesis: [
    "SYNTHESIS — all required Sections have completed Detail planning.",
    "AUTHORITY: only approved Plan Memory and the frozen SynthesisInput are normative inputs.",
    "You MAY: organize approved design; connect approved contracts/interfaces; derive implementation order; normalize terminology; record limitations; identify missing or inconsistent design.",
    "You MUST: attach exact provenance to every derived statement; preserve approved facts exactly; use the stable compact/contract projections; record gaps rather than filling them with new design.",
    "You MUST NOT: invent new architecture or Section design; create new Decisions/Constraints/interfaces; claim semantic validation passed, evidence audited, or the plan final — you may only REQUEST validation and finalization; the Harness decides.",
    "If new normative design is required, record a finding (or raise a question/conflict) — do not fill the gap here.",
  ],
};

/**
 * Phase 2F §46 + Phase 2G §58 + Phase 2H §58: synthesis substate lines
 * appended to the static guidance. The validation/finalization fragments are
 * pinned verbatim by tests.
 */
function synthesisStateGuidance(synthesis: PlanningProtocolInput["synthesis"]): readonly string[] {
  if (!synthesis?.inputID) {
    return [
      "The SynthesisInput is not frozen yet. Call ultraplan_begin_synthesis: the Harness validates entry, freezes the exact HEAD-anchored input, and returns the synthesis capsule.",
      "Submit derived output with ultraplan_submit_synthesis_manifest ONLY after the input exists.",
    ];
  }
  const frozenLines = [
    `Frozen SynthesisInput: ${synthesis.inputID} (base ${synthesis.baseSnapshot ?? "unknown"}, hash ${synthesis.inputHash?.slice(0, 16) ?? "unknown"}).`,
    ...(synthesis.stale
      ? [
          "The frozen SynthesisInput is STALE (HEAD moved past its base snapshot). It remains readable for audit, but a current Manifest cannot be submitted against it.",
        ]
      : []),
  ];
  const manifestLines = synthesis.manifestRef
    ? [
        `Current SynthesisManifest: ${synthesis.manifestRef} (hash ${synthesis.manifestHash?.slice(0, 16) ?? "unknown"}).`,
      ]
    : [
        "No SynthesisManifest yet. Submit derived output with ultraplan_submit_synthesis_manifest: cross-section links (each citing ≥2 distinct Sections), the implementation order (covering every approved Section, respecting Section dependencies), limitations, and findings — every statement with exact source provenance.",
      ];
  // Phase 2H §58 + Phase 2I §86: the validation/finalization/final-boundary
  // fragments — verbatim per state. A current final Proposal supersedes the
  // candidate-ready fragment (the boundary has advanced one step).
  const finalProposalLines = synthesis.finalProposal
    ? synthesis.finalProposal.status === "ready"
      ? [
          "The exact Final Plan Proposal is frozen.",
          "Request explicit user approval.",
          "User approval authorizes only this exact Proposal.",
        ]
      : [
          "Await the formal user decision.",
          "Do not reinterpret normal conversation as approval.",
        ]
    : [];
  const finalizationLines = synthesis.finalProposal
    ? []
    : !synthesis.manifestRef
    ? []
    : synthesis.validationResult === "findings"
      ? [
          "Semantic validation found blocking issues.",
          "Inspect the immutable ValidationReport.",
          "If approved design must change, request sanctioned Section reopen for an exact affected Section (ultraplan_request_reopen with the report's finding ids).",
          "Do not edit approved design from Synthesis.",
        ]
      : synthesis.validationResult === "clean"
        ? synthesis.finalization?.state === "passed"
          ? [
              "A current FinalPlanCandidate exists.",
              "You may prepare the formal Final Plan Proposal.",
              "The Finalization Gate will be rerun.",
              "Do not alter approved design.",
            ]
          : synthesis.finalization?.state === "blocked"
            ? [
                "Finalization is blocked.",
                "Inspect the exact machine blockers.",
                "Do not claim the plan is final.",
                "Resolve through normal planning/evidence workflows.",
              ]
            : [
                "Semantic validation is clean.",
                "You may request deterministic finalization.",
                "Finalization will independently verify:",
                "- current HEAD / synthesis identity",
                "- approved + valid Sections",
                "- live blocking Questions/Conflicts",
                "- current reachable Evidence audit",
                "You cannot bypass these checks.",
              ]
        : [
            "The current SynthesisManifest is structurally valid but has not received semantic validation.",
            "Request semantic validation.",
            "Do not self-declare the Manifest clean.",
          ];
  return [
    ...frozenLines,
    ...manifestLines,
    ...finalizationLines,
    ...finalProposalLines,
    ...(synthesis.blockerCount && synthesis.blockerCount > 0
      ? [`${synthesis.blockerCount} open blocker(s) exist; they do not block synthesis and may be cited by findings.`]
      : []),
  ];
}

function detailGuidance(
  run: PlanningRun,
  activeSection: PlanningProtocolInput["activeSection"],
): readonly string[] {
  if (run.sections.length === 0) {
    return [
      "DETAIL — CURRENT OBJECTIVE: decompose the approved Architecture into the project-specific Section DAG.",
      "Define coherent design scopes, their dependencies, their objectives, and the initial focus.",
      "Do NOT perform full Section design yet — roots only, no SectionRevision content.",
      "Submit the ENTIRE initial decomposition as ONE proposal (ultraplan_prepare_section_decomposition); it becomes the committed DAG after explicit USER approval.",
    ];
  }
  const focus = activeSection
    ? `Active section: ${activeSection.id} — ${activeSection.title} (${activeSection.objective})`
    : run.activeWork?.type === "section"
      ? `Active section: ${run.activeWork.id}`
      : "No active work focus is set.";
  const dependencyLines = activeSection
    ? [
        activeSection.dependencies.length > 0
          ? `Direct dependencies: ${activeSection.dependencies.join(", ")}.`
          : "The active section has no direct dependencies.",
        // §31: expose whether each direct dependency has an approved contract
        // — without implementing the Context Assembler.
        ...(activeSection.dependencyContracts && activeSection.dependencyContracts.length > 0
          ? [
              `Dependency contracts: ${activeSection.dependencyContracts
                .map((dep) =>
                  dep.revision !== undefined
                    ? `${dep.id}@${dep.revision} approved`
                    : dep.approved
                      ? `${dep.id} approved (no contract binding)`
                      : `${dep.id} no contract yet`,
                )
                .join("; ")}.`,
            ]
          : []),
        activeSection.validation === "needs_review"
          ? "Validation: needs_review — commit a revalidated checkpoint against the current dependency contracts to restore validity."
          : "Validation: valid.",
      ]
    : [];
  const checkpointLines = activeSection?.currentRevision
    ? [
        `Current approved checkpoint: ${activeSection.id}@${activeSection.currentRevision} (validation ${activeSection.validation}). A new checkpoint freezes immutable revision ${activeSection.currentRevision + 1}; previous revisions remain immutable and readable.`,
        // Phase 2E2 §37: completion guidance — ready vs blocked, both honest
        // about what completion will verify.
        ...(activeSection.completionBlocked
          ? [
              `Do not request completion as if it can bypass blockers (${activeSection.completionBlocked}).`,
              "You may switch focus to another Section with ultraplan_request_section_focus (discussion order != completion order).",
            ]
          : [
              "Current Section has an approved checkpoint. You may request Section completion (ultraplan_request_completion, kind=section).",
              "Completion will: verify Section.validation == valid; verify all required dependency Sections are approved; bind the exact current approved revision; require explicit user approval.",
            ]),
        "You may switch focus to another Section with ultraplan_request_section_focus.",
      ]
    : ["The active section has no approved revision yet; the first checkpoint freezes revision 1."];
  return [
    "DETAIL — the Section DAG is committed; the workflow is SECTION DESIGN of the active section.",
    focus,
    ...dependencyLines,
    ...checkpointLines,
    "Produce: a precise problem definition, concrete design, interfaces, invariants, failure modes, dependency usage, relevant committed decisions and open questions, a stable compact projection, and the dependency-facing SectionContract.",
    "You may discuss and checkpoint a Section before dependencies are complete, but a missing dependency contract marks it needs_review.",
    "Do NOT claim the Section is complete: a checkpoint approval is NOT Section completion — approvedRevision means the latest approved checkpoint, never completion.",
    "When a coherent design checkpoint is ready: ultraplan_prepare_section_checkpoint (it targets the active section).",
    "Do not redesign the committed DAG: structural changes require an amendment proposal.",
  ];
}

export interface PlanningProtocolInput {
  run: PlanningRun | undefined;
  /**
   * Phase 2D/2E1: the committed Section root under `run.activeWork`, resolved
   * by the caller from Plan Memory (the protocol itself stays store-free).
   * `currentRevision`/`validation` pick the revisionless vs checkpointed
   * substate; `dependencyContracts` reports each direct dependency's approved
   * contract (revision present) or its explicit absence.
   */
  /**
   * Phase 2J §72: the compact execution capsule refs for a COMPLETED run,
   * resolved by the caller — never reactivates planning L0.
   */
  execution?: {
    finalPlanRef?: string;
    handoffRef?: string;
  };
  activeSection?: {
    id: string;
    title: string;
    objective: string;
    dependencies: readonly string[];
    currentRevision?: number;
    validation: "valid" | "needs_review";
    /**
     * Per direct dependency: contract availability (revision present) and
     * whether the dependency Section is approved (Phase 2E2 completion
     * guidance). `approved` is absent only for legacy callers.
     */
    dependencyContracts?: readonly { id: string; revision?: number; approved?: boolean }[];
    /**
     * Phase 2E2 §37: the first deterministic completion blocker when
     * completion is not ready (e.g. "dependency SEC-001 not approved",
     * "validation needs_review"). Undefined = completion-ready.
     */
    completionBlocked?: string;
  };
  /**
   * Phase 2F §46 + Phase 2G + Phase 2H: the minimal synthesis projection
   * resolved by the caller — current input identity/base/hash, current
   * manifest ref/hash, staleness, the open blocker count, the CURRENT
   * semantic-validation result (present only for a report bound to the
   * current identity), and the deterministic finalization state (Phase 2H
   * §58) with the candidate ref/currency when one exists.
   */
  synthesis?: {
    inputID?: string;
    baseSnapshot?: string;
    inputHash?: string;
    manifestRef?: string;
    manifestHash?: string;
    stale?: boolean;
    validationResult?: "findings" | "clean";
    finalization?: {
      state: "unavailable" | "not_run" | "blocked" | "passed";
      candidate?: { ref: string; current: boolean };
    };
    /**
     * Phase 2I §86: the current final_plan Proposal (ready/awaiting) when one
     * binds the current candidate — it selects the final-boundary guidance.
     */
    finalProposal?: { ref: string; status: "ready" | "awaiting_approval" };
    blockerCount?: number;
  };
}

export function renderPlanningProtocol(input: PlanningProtocolInput): string {
  // Phase 2F §43 + Phase 2G §34 + Phase 2H §53: the synthesis checklist
  // resolves the substate from the caller-resolved artifact state (no-input →
  // input/manifest-ready → validation-findings/clean → candidate-ready).
  const capabilities = getCapabilities(
    input.run,
    input.run?.stage === "synthesis"
      ? {
          synthesis: {
            hasInput: !!input.synthesis?.inputID,
            hasManifest: !!input.synthesis?.manifestRef,
            ...(input.synthesis?.validationResult
              ? { report: { result: input.synthesis.validationResult } }
              : {}),
            ...(input.synthesis?.finalization?.candidate
              ? { candidate: { current: input.synthesis.finalization.candidate.current } }
              : {}),
            ...(input.synthesis?.finalProposal
              ? { finalProposal: { status: input.synthesis.finalProposal.status, current: true } }
              : {}),
          },
        }
      : {},
  );
  const state = input.run
    ? `Current run: ${input.run.id} (lifecycle=${input.run.lifecycle}, stage=${input.run.stage})`
    : "No active planning run in this session.";
  const run = input.run;
  // Phase 2I §86: the handoff_pending boundary fragment — planning mutation is
  // closed and the runtime Build handoff has NOT completed (Phase 2J's work).
  const lifecycleLines =
    run?.lifecycle === "handoff_pending"
      ? ["The Final Plan is approved and committed.", "The run is handoff_pending.", "Do not modify planning state.", "The Harness is recovering/completing the runtime Build handoff."]
      : [];
  // Phase 2J §72: a completed run's context is a compact execution capsule —
  // never reactivated planning instructions.
  const completedLines =
    run?.lifecycle === "completed"
      ? [
          "Ultra Plan planning is complete.",
          ...(input.execution?.finalPlanRef ? [`Approved Final Plan: ${input.execution.finalPlanRef}`] : []),
          ...(input.execution?.handoffRef ? [`Execution handoff: ${input.execution.handoffRef} delivered`] : []),
          "Plan Memory is available READ-ONLY.",
          "The execution runtime owns implementation progress.",
        ]
      : [];
  const guidance = run
    ? run.stage === "detail"
      ? detailGuidance(run, input.activeSection)
      : run.stage === "synthesis"
        ? [...(STAGE_GUIDANCE.synthesis ?? []), ...synthesisStateGuidance(input.synthesis)]
        : (STAGE_GUIDANCE[run.stage] ?? [])
    : [];

  return [
    "=== ULTRA PLAN PROTOCOL (L0) ===",
    ...RULES.map((rule, index) => `${index + 1}. ${rule}`),
    "",
    state,
    "",
    ...(guidance.length > 0 ? [...guidance, ""] : []),
    ...(lifecycleLines.length > 0 ? [...lifecycleLines, ""] : []),
    ...(completedLines.length > 0 ? [...completedLines, ""] : []),
    describeCapabilities(capabilities),
    "=== END ULTRA PLAN PROTOCOL ===",
  ].join("\n");
}
