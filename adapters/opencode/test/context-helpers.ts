/**
 * R2 context-architecture fixtures (brief §97/§98).
 *
 * Builds ONE dense deterministic planning state over a real InMemoryPlanStore:
 * PLAN-001 with a goal, hard+soft constraints, ARCH@2, an active SEC-004 with
 * a direct (SEC-005) and transitive (SEC-006) dependency and a downstream
 * (SEC-007), section + inherited decisions, blocking/non-blocking questions,
 * blocking/warning/resolved conflicts, P0/P1/P2/P3-reachable Evidence (plus a
 * structurally-unlinked lookalike), and a current ready Proposal. Every test
 * assembles from `capturePlanningContextState` only — never from conversation
 * history.
 */
import type { InMemoryPlanStore, PlanningContextState, Proposal } from "../src/index.js";
import {
  ConstraintIDs,
  DecisionIDs,
  EvidenceIDs,
  PlanIDs,
  ProposalIDs,
  QuestionIDs,
  ConflictIDs,
  SectionIDs,
  SnapshotIDs,
} from "../src/index.js";
import type { Decision, DecisionID, PlanningRun, Section, SectionID, SectionRevision } from "../src/index.js";
import { DurablePlanStore } from "../src/index.js";
import type { Evidence } from "../src/repository/evidence.js";
import { evidence as evidenceFixture } from "./helpers.js";
import { computeProposalHash } from "../src/transaction/hash.js";

/** Capture the coherent context view, failing the test when the plan is absent. */
export async function capturePlanningContextStateOrThrow(
  store: InMemoryPlanStore,
  planID: ReturnType<typeof PlanIDs.cast>,
): Promise<PlanningContextState> {
  const state = await store.capturePlanningContextState(planID);
  if (!state) throw new Error(`plan ${planID} not found in store`);
  return state;
}

/**
 * Re-read the STORED run (createRun assigns headSnapshot/revision onto the
 * stored record, not the caller's object).
 */
export async function storedRun(store: InMemoryPlanStore, planID = PLAN): Promise<PlanningRun> {
  const run = await store.getRun(planID);
  if (!run) throw new Error(`plan ${planID} not found`);
  return run;
}

/**
 * Test-only header mutation seam: mirrors what sanctioned commits write
 * (activeWork/sections are commit-gated; production can never saveRun them).
 */
export async function seedRunHeader(store: InMemoryPlanStore, header: PlanningRun): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).runs.set(header.id, header);
}

export const PLAN = PlanIDs.cast("PLAN-901");
export const SESSION = "session-context";

function sectionFixture(init: { id: SectionID } & Partial<Section>): Section {
  return {
    title: `Section ${init.id}`,
    objective: `Design ${init.id}`,
    dependencies: [],
    status: "pending",
    validation: "valid",
    ...init,
  };
}

function decisionFixture(init: { id: DecisionID; revision: number } & Partial<Decision>): Decision {
  return {
    title: `Decision ${init.id}`,
    status: "approved",
    statement: `${init.id} statement`,
    rationale: `${init.id} rationale`,
    scope: {},
    approvedAt: "2026-09-26T00:00:00.000Z",
    ...init,
  };
}

function revisionFixture(init: { sectionID: SectionID; revision: number } & Partial<SectionRevision>): SectionRevision {
  const { projection, ...rest } = init;
  const compact = projection?.compact ?? `Compact projection of ${init.sectionID}@${init.revision}`;
  const contract = {
    sectionID: init.sectionID,
    revision: init.revision,
    provides: [] as string[],
    requires: [] as string[],
    invariants: [] as string[],
    interfaces: [] as { name: string; providedBy?: SectionID }[],
    decisions: [] as { id: DecisionID; revision: number }[],
    ...(projection?.contract ?? {}),
  };
  return {
    status: "approved",
    problem: `Problem of ${init.sectionID}`,
    design: `Design of ${init.sectionID}@${init.revision}`,
    interfaces: [],
    invariants: [],
    failureModes: [],
    dependencies: [],
    decisions: [],
    openQuestions: [],
    impacts: [],
    createdAt: "2026-09-26T00:00:00.000Z",
    ...rest,
    projection: { compact, contract },
  };
}

export function evidenceRecord(
  id: string,
  init: Partial<Evidence> & { scope: Evidence["scope"] },
): Evidence {
  return evidenceFixture({ id: EvidenceIDs.cast(id), ...init });
}

export interface RichFixture {
  run: PlanningRun;
}

/**
 * Seed the full R2 §98-style state. Layout:
 *
 *   SEC-004 (active, @2)  depends on  SEC-005
 *   SEC-005 (approved @1) depends on  SEC-006
 *   SEC-006 (approved @1) depends on  —          (transitive dependency of SEC-004)
 *   SEC-007 (pending)     depends on  SEC-004   (downstream of SEC-004)
 *
 *   DEC-001@1 (architecture-basedOn, evidence EVD-003)
 *   DEC-002@2 (SEC-004 revision decision, evidence EVD-001)
 *   DEC-003@1 (SEC-005 contract decision)
 *   DEC-004@1 (SEC-006 contract decision — transitive inherited)
 *   DEC-005@1 (structurally unrelated section — never in scope)
 *
 *   Q-001 blocking (SEC-004)  Q-002 non-blocking + candidate resolution (SEC-004)
 *   Q-003 blocking (ARCH)     Q-004 non-blocking (SEC-005 — not active scope)
 *   Q-005 non-blocking (ARCH — not active scope in section work)
 *
 *   CONF-001 blocking (SEC-004)  CONF-002 warning (SEC-004)
 *   CONF-003 RESOLVED (SEC-005)  CONF-004 warning with no matching refs
 *
 *   EVD-001 (decision DEC-002) EVD-002 (section SEC-005) EVD-003 (architecture)
 *   EVD-004 (run) EVD-005 (decision DEC-005 — UNLINKED lookalike)
 *   EVD-006 (section SEC-004) EVD-007 (section SEC-004, STALE)
 *   PROP-901 ready current Proposal
 */
export async function seedRichPlanningState(store: InMemoryPlanStore, options: { proposalStatus?: "ready" | "awaiting_approval" } = {}): Promise<RichFixture> {
  const run: PlanningRun = {
    id: PLAN,
    sessionID: SESSION,
    lifecycle: "active",
    stage: "detail",
    revision: 1,
    activeWork: { type: "section", id: SectionIDs.cast("SEC-004") },
    goal: { statement: "Build a deterministic planning context pipeline" },
    constraints: [
      {
        id: ConstraintIDs.cast("CON-001"),
        source: "user",
        statement: "Context assembly must be deterministic",
        severity: "hard",
        status: "active",
      },
      {
        id: ConstraintIDs.cast("CON-002"),
        source: "runtime",
        statement: "Prefer compact projections when possible",
        severity: "soft",
        status: "active",
      },
    ],
    architecture: { id: "ARCH", revision: 2 },
    sections: [
      { id: SectionIDs.cast("SEC-004") },
      { id: SectionIDs.cast("SEC-005") },
      { id: SectionIDs.cast("SEC-006") },
      { id: SectionIDs.cast("SEC-007") },
    ],
    decisions: [
      { id: DecisionIDs.cast("DEC-001"), revision: 1 },
      { id: DecisionIDs.cast("DEC-002"), revision: 2 },
      { id: DecisionIDs.cast("DEC-003"), revision: 1 },
      { id: DecisionIDs.cast("DEC-004"), revision: 1 },
      { id: DecisionIDs.cast("DEC-005"), revision: 1 },
    ],
    sectionDecompositionArchitecture: { id: "ARCH", revision: 2 },
    openQuestions: [
      {
        id: QuestionIDs.cast("Q-001"),
        question: "How should budget overflow behave for required content?",
        blocking: true,
        scope: { id: SectionIDs.cast("SEC-004") },
        status: "open",
      },
      {
        id: QuestionIDs.cast("Q-002"),
        question: "Should soft constraints render at summary level?",
        blocking: false,
        scope: { id: SectionIDs.cast("SEC-004") },
        status: "open",
        proposedResolution: { text: "Yes, at summary with identity minimum", proposedAt: "2026-09-26T00:00:00.000Z" },
      },
      {
        id: QuestionIDs.cast("Q-003"),
        question: "Is the two-layer retrieval split stable across stages?",
        blocking: true,
        scope: { id: "ARCH" as const, revision: 2 },
        status: "open",
      },
      {
        id: QuestionIDs.cast("Q-004"),
        question: "Dependency-local question outside the active scope",
        blocking: false,
        scope: { id: SectionIDs.cast("SEC-005") },
        status: "open",
      },
      {
        id: QuestionIDs.cast("Q-005"),
        question: "Architecture question outside the active scope",
        blocking: false,
        scope: { id: "ARCH" as const, revision: 2 },
        status: "open",
      },
    ],
    conflicts: [
      {
        id: ConflictIDs.cast("CONF-001"),
        type: "section",
        refs: [{ kind: "section", id: SectionIDs.cast("SEC-004") }],
        description: "SEC-004 recovery semantics contradict the approved checkpoint",
        severity: "blocking",
        status: "open",
      },
      {
        id: ConflictIDs.cast("CONF-002"),
        type: "interface",
        refs: [{ kind: "section", id: SectionIDs.cast("SEC-004") }],
        description: "Worker interface naming drifts from the contract",
        severity: "warning",
        status: "open",
      },
      {
        id: ConflictIDs.cast("CONF-003"),
        type: "decision",
        refs: [{ kind: "section", id: SectionIDs.cast("SEC-005") }],
        description: "Resolved historical conflict about SEC-005 provisioning",
        severity: "blocking",
        // Durable-safe fixture ordering: the conflict is marked resolved (with
        // its resolution binding) only AFTER the committed decision family is
        // seeded — the R1 load validation rightly refuses a resolved conflict
        // whose bound decision does not exist yet.
        status: "open",
      },
      {
        id: ConflictIDs.cast("CONF-004"),
        type: "constraint",
        refs: [],
        description: "Warning conflict with no represented scope relationship",
        severity: "warning",
        status: "open",
      },
    ],
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
  await store.createRun(run);

  const architecture = {
    id: "ARCH" as const,
    revision: 2,
    status: "approved" as const,
    summary: "Layered context architecture",
    components: [
      { name: "Assembler", summary: "Deterministic context compiler" },
      { name: "BudgetManager", summary: "P0-P3 priority budget" },
    ],
    boundaries: [{ name: "StoreBoundary", description: "Read-only projection over the durable store" }],
    dataFlows: [{ from: "Store", to: "Renderer", description: "Projected fragments" }],
    principles: [{ statement: "Structure over similarity" }],
    unresolved: [],
    basedOn: [DecisionIDs.cast("DEC-001")],
  };

  const decisions: Decision[] = [
    decisionFixture({ id: DecisionIDs.cast("DEC-001"), revision: 1, scope: { architecture: true }, evidence: [{ id: EvidenceIDs.cast("EVD-003"), revision: 1 }] }),
    decisionFixture({
      id: DecisionIDs.cast("DEC-002"),
      revision: 2,
      scope: { sections: [SectionIDs.cast("SEC-004")] },
      statement: "Budget degradation switches projection levels",
      evidence: [{ id: EvidenceIDs.cast("EVD-001"), revision: 1 }],
    }),
    decisionFixture({ id: DecisionIDs.cast("DEC-003"), revision: 1, scope: { sections: [SectionIDs.cast("SEC-005")] } }),
    decisionFixture({ id: DecisionIDs.cast("DEC-004"), revision: 1, scope: { sections: [SectionIDs.cast("SEC-006")] } }),
    decisionFixture({ id: DecisionIDs.cast("DEC-005"), revision: 1, scope: { sections: [SectionIDs.cast("SEC-900")] } }),
  ];

  const sections: Section[] = [
    sectionFixture({
      id: SectionIDs.cast("SEC-004"),
      title: "Context Assembly",
      objective: "Assemble deterministic planning context",
      dependencies: [SectionIDs.cast("SEC-005")],
      status: "active",
      validation: "valid",
      currentRevision: 2,
      approvedRevision: 2,
    }),
    sectionFixture({
      id: SectionIDs.cast("SEC-005"),
      title: "Retrieval",
      objective: "Structural retrieval over Plan Memory",
      dependencies: [SectionIDs.cast("SEC-006")],
      status: "approved",
      validation: "valid",
      currentRevision: 1,
      approvedRevision: 1,
    }),
    sectionFixture({
      id: SectionIDs.cast("SEC-006"),
      title: "Projection Registry",
      objective: "Deterministic projection levels",
      dependencies: [],
      status: "approved",
      validation: "valid",
      currentRevision: 1,
      approvedRevision: 1,
    }),
    sectionFixture({
      id: SectionIDs.cast("SEC-007"),
      title: "Observability",
      objective: "ContextTrace diagnostics",
      dependencies: [SectionIDs.cast("SEC-004")],
      status: "pending",
      validation: "valid",
    }),
  ];

  const revisions: SectionRevision[] = [
    revisionFixture({
      sectionID: SectionIDs.cast("SEC-004"),
      revision: 2,
      problem: "How does the model see committed state deterministically?",
      design: "Layered assembly with structural retrieval and a P0-P3 budget",
      interfaces: [{ name: "Worker", description: "Assembly worker", signature: "assemble(state): RenderedContext" }],
      invariants: ["P0 never dropped"],
      dependencies: [{ sectionID: SectionIDs.cast("SEC-005"), consumes: ["Retrieval"], contractRevision: 1 }],
      decisions: [DecisionIDs.cast("DEC-002")],
      openQuestions: [QuestionIDs.cast("Q-001")],
      impacts: [SectionIDs.cast("SEC-007")],
    }),
    revisionFixture({
      sectionID: SectionIDs.cast("SEC-005"),
      revision: 1,
      interfaces: [{ name: "Retrieval", description: "Structural retrieval port" }],
      dependencies: [],
      decisions: [DecisionIDs.cast("DEC-003")],
    }),
    revisionFixture({
      sectionID: SectionIDs.cast("SEC-006"),
      revision: 1,
      dependencies: [{ sectionID: SectionIDs.cast("SEC-005"), consumes: ["Retrieval"], contractRevision: 1 }],
      decisions: [DecisionIDs.cast("DEC-004")],
    }),
  ];
  // Attach exact contracts (the harness freezes these at checkpoint approval).
  const retrievalContract = {
    sectionID: SectionIDs.cast("SEC-005"),
    revision: 1,
    provides: ["Retrieval"],
    requires: [],
    invariants: ["Retrieval is structural"],
    interfaces: [{ name: "Retrieval", providedBy: SectionIDs.cast("SEC-005") as SectionID | undefined }],
    decisions: [{ id: DecisionIDs.cast("DEC-003"), revision: 1 }],
  };
  const projectionContract = {
    sectionID: SectionIDs.cast("SEC-006"),
    revision: 1,
    provides: ["Projections"],
    requires: ["Retrieval"],
    invariants: ["Projections are deterministic"],
    interfaces: [],
    decisions: [{ id: DecisionIDs.cast("DEC-004"), revision: 1 }],
  };
  const activeContract = {
    sectionID: SectionIDs.cast("SEC-004"),
    revision: 2,
    provides: ["AssembledContext"],
    requires: ["Retrieval"],
    invariants: [],
    interfaces: [],
    decisions: [{ id: DecisionIDs.cast("DEC-002"), revision: 2 }],
  };
  for (const revision of revisions) {
    if (revision.sectionID === "SEC-005") revision.projection.contract = retrievalContract;
    if (revision.sectionID === "SEC-006") revision.projection.contract = projectionContract;
    if (revision.sectionID === "SEC-004") revision.projection.contract = activeContract;
  }

  if (store instanceof DurablePlanStore) {
    await store.seedCommittedStateAsync(PLAN, { architecture, sections, sectionRevisions: revisions, decisions });
  } else {
    store.seedCommittedState(PLAN, { architecture, sections, sectionRevisions: revisions, decisions });
  }

  // Now the committed families exist: mark CONF-003 resolved with its exact
  // remediation binding (conflicts are working state; saveRun performs this).
  const stored = await store.getRun(PLAN);
  if (stored) {
    await store.saveRun({
      ...stored,
      conflicts: stored.conflicts.map((conflict) =>
        conflict.id === "CONF-003"
          ? {
              ...conflict,
              status: "resolved" as const,
              resolution: {
                action: "amend_decision" as const,
                ref: { kind: "decision" as const, id: DecisionIDs.cast("DEC-003"), revision: 1 },
              },
            }
          : conflict,
      ),
    });
  }

  const evidenceRecords: Evidence[] = [
    evidenceRecord("EVD-001", {
      scope: { kind: "decision", decisionID: DecisionIDs.cast("DEC-002") },
      claim: "Budget degradation must switch projection levels deterministically",
      criticality: "critical",
    }),
    evidenceRecord("EVD-002", { scope: { kind: "section", sectionID: SectionIDs.cast("SEC-005") }, claim: "Retrieval walks structural relationships" }),
    evidenceRecord("EVD-003", { scope: { kind: "architecture" }, claim: "Layered split verified in the runtime" }),
    evidenceRecord("EVD-004", { scope: { kind: "run" }, claim: "Run-scope supplementary observation" }),
    // Structurally UNLINKED lookalike: textually similar to the active scope,
    // but no represented relationship to it (brief §85).
    evidenceRecord("EVD-005", {
      scope: { kind: "decision", decisionID: DecisionIDs.cast("DEC-005") },
      claim: "Budget degradation must switch projection levels deterministically (lookalike)",
    }),
    evidenceRecord("EVD-006", { scope: { kind: "section", sectionID: SectionIDs.cast("SEC-004") }, claim: "Active-scope repository observation" }),
    evidenceRecord("EVD-007", {
      scope: { kind: "section", sectionID: SectionIDs.cast("SEC-004") },
      claim: "Stale active-scope observation",
      freshness: "stale",
    }),
  ];
  for (const record of evidenceRecords) {
    await store.putEvidence(PLAN, record);
  }

  const proposal: Proposal = {
    id: ProposalIDs.cast("PROP-901"),
    type: "design_checkpoint",
    scope: { id: SectionIDs.cast("SEC-004") },
    revision: 1,
    status: options.proposalStatus ?? "ready",
    title: "Checkpoint SEC-004@3",
    summary: "Revised assembly flow",
    changes: [],
    dependencies: [],
    impact: { affectedSections: [SectionIDs.cast("SEC-004")], affectedDecisions: [] },
    createdFrom: { id: SnapshotIDs.cast("SNAP-001") },
  };
  // The durable load recomputes proposal hashes — the fixture must bind the
  // real canonical hash, exactly as the Harness does at freeze.
  proposal.hash = computeProposalHash(proposal);
  await store.saveProposal(PLAN, proposal);

  return { run };
}
