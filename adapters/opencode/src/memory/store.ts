/**
 * Storage boundary for Plan Memory — spec §12 + Phase 1 brief §6.
 *
 * The boundary is deliberately narrow:
 *
 * - Committed Plan Memory (architecture/section/decision revisions, proposals,
 *   commits, snapshots) is READ-ONLY here. Its single mutation path is
 *   `commitTransaction`, which in Phase 2 will verify proposal, approval,
 *   snapshot, dependencies, constraints, conflicts, and evidence before
 *   applying anything (spec §9.4). A generic `save*` mutation API is
 *   intentionally absent so later phases never grow around an unsafe
 *   repository abstraction.
 * - The PlanningRun header (stage/lifecycle/activeWork/goal/questions/
 *   conflicts/constraints) is working state and mutates via `saveRun`; the
 *   commit-gated fields are protected by an invariant check inside saveRun.
 * - Evidence is a separate trust domain (spec §21/§25): immutable revisions
 *   that do NOT require approval, hence an explicit narrow `putEvidence`.
 *
 * Async signatures from day one so the durable Phase 2 store drops in without
 * an interface migration. InMemoryPlanStore exists for tests and for the Phase
 * 1 vertical slice; production persistence is a later-phase deliverable.
 */
import {
  assertCommittedRunFieldsUnchanged,
  assertRevisionMonotonic,
} from "../core/invariants.js";
import type {
  ApprovalID,
  CommitID,
  PlanID,
  ProposalID,
  SectionID,
} from "../core/ids.js";
import { isActiveRun } from "../core/state-machine.js";
import { UltraPlanError } from "../core/errors.js";
import type {
  Architecture,
  Decision,
  PlanningRun,
  Section,
  SectionRevision,
} from "../core/types.js";
import type { DecisionRef, SectionRevisionRef, Timestamp } from "../core/refs.js";
import type { PlanCommit, Proposal } from "../transaction/types.js";
import type { Evidence } from "../repository/evidence.js";
import type { PlanEvent, PlanEventDetail } from "./events.js";
import type { Snapshot } from "./snapshots.js";

export interface CommitTransactionInput {
  planID: PlanID;
  /** The approved proposal revision (must be `awaiting_approval` → verified). */
  proposalID: ProposalID;
  approvalID: ApprovalID;
  parentCommit: CommitID | null;
}

export interface PlanStore {
  // -- PlanningRun ----------------------------------------------------------
  /** The run blocking the session, if any (active or handoff_pending). */
  findActiveRunBySession(sessionID: string): Promise<PlanningRun | undefined>;
  getRun(planID: PlanID): Promise<PlanningRun | undefined>;
  /** Next monotonically increasing plan sequence number (PLAN-001, ...). */
  nextPlanSequence(): Promise<number>;
  /**
   * Create a run. Throws `multiple_active_runs` if the session already has an
   * active run — the controller checks first, the store enforces the
   * invariant.
   */
  createRun(run: PlanningRun): Promise<PlanningRun>;
  /**
   * Persist a run-header mutation. Bumps `revision` and `updatedAt`.
   * Throws `commit_gated_run_field` if a commit-gated field changed — those
   * advance only through commitTransaction.
   */
  saveRun(run: PlanningRun): Promise<PlanningRun>;

  // -- Event log ------------------------------------------------------------
  appendEvent(planID: PlanID, detail: PlanEventDetail): Promise<PlanEvent>;
  listEvents(planID: PlanID): Promise<PlanEvent[]>;

  // -- Committed Plan Memory (read-only outside commitTransaction) -----------
  getHeadSnapshot(planID: PlanID): Promise<Snapshot | undefined>;
  getArchitecture(planID: PlanID, revision?: number): Promise<Architecture | undefined>;
  getSection(planID: PlanID, sectionID: SectionID): Promise<Section | undefined>;
  listSections(planID: PlanID): Promise<Section[]>;
  getSectionRevision(planID: PlanID, ref: SectionRevisionRef): Promise<SectionRevision | undefined>;
  getDecision(planID: PlanID, ref: DecisionRef): Promise<Decision | undefined>;
  getProposal(planID: PlanID, proposalID: ProposalID): Promise<Proposal | undefined>;

  // -- Repository Evidence (separate trust domain) ---------------------------
  /**
   * Record an immutable Evidence revision. Throws `duplicate_revision` /
   * `non_monotonic_revision` on violations. Does not require user approval
   * (spec §25).
   */
  putEvidence(planID: PlanID, evidence: Evidence): Promise<void>;
  /** Newest revision of each evidence record for the run. */
  listEvidence(planID: PlanID): Promise<Evidence[]>;

  // -- The only committed-memory mutation path (Phase 2 engine) --------------
  /**
   * Proposal → Approval → PlanCommit. Verifies run active, proposal
   * awaiting approval, proposal hash matches approval, base snapshot,
   * dependencies, hard constraints, conflicts, and required evidence; then
   * applies changes, creates immutable revisions, appends events, creates the
   * Snapshot + PlanCommit, and moves HEAD (spec §9.4).
   *
   * Phase 1 throws `phase_boundary` — implementing this is the Phase 2
   * transaction engine.
   */
  commitTransaction(input: CommitTransactionInput): Promise<PlanCommit>;
}

interface RevisionRegistry<T> {
  readonly byKey: Map<string, T>;
  readonly latest: Map<string, T>;
  readonly highest: Map<string, number>;
}

function createRegistry<T>(): RevisionRegistry<T> {
  return { byKey: new Map(), latest: new Map(), highest: new Map() };
}

function revisionKey(id: string, revision: number): string {
  return `${id}@${revision}`;
}

export class InMemoryPlanStore implements PlanStore {
  private readonly now: () => Timestamp;
  private readonly runs = new Map<PlanID, PlanningRun>();
  private readonly events = new Map<PlanID, PlanEvent[]>();
  private readonly architectures = new Map<PlanID, RevisionRegistry<Architecture>>();
  private readonly sections = new Map<PlanID, Map<SectionID, Section>>();
  private readonly sectionRevisions = new Map<PlanID, RevisionRegistry<SectionRevision>>();
  private readonly decisions = new Map<PlanID, RevisionRegistry<Decision>>();
  private readonly proposals = new Map<PlanID, Map<ProposalID, Proposal>>();
  private readonly snapshots = new Map<PlanID, Map<string, Snapshot>>();
  private readonly evidence = new Map<PlanID, RevisionRegistry<Evidence>>();

  constructor(now: () => Timestamp = () => new Date().toISOString()) {
    this.now = now;
  }

  async findActiveRunBySession(sessionID: string): Promise<PlanningRun | undefined> {
    for (const run of this.runs.values()) {
      if (run.sessionID === sessionID && isActiveRun(run)) return run;
    }
    return undefined;
  }

  async getRun(planID: PlanID): Promise<PlanningRun | undefined> {
    return this.runs.get(planID);
  }

  async nextPlanSequence(): Promise<number> {
    return this.runs.size + 1;
  }

  async createRun(run: PlanningRun): Promise<PlanningRun> {
    if (this.runs.has(run.id)) {
      throw new UltraPlanError("duplicate_plan_id", `PlanningRun ${run.id} already exists`, {
        planID: run.id,
      });
    }
    const active = await this.findActiveRunBySession(run.sessionID);
    if (active) {
      throw new UltraPlanError(
        "multiple_active_runs",
        `Session ${run.sessionID} already has an active PlanningRun (${active.id})`,
        { sessionID: run.sessionID, activePlanID: active.id },
      );
    }
    this.runs.set(run.id, run);
    return run;
  }

  async saveRun(run: PlanningRun): Promise<PlanningRun> {
    const before = this.runs.get(run.id);
    if (!before) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${run.id} does not exist`, {
        planID: run.id,
      });
    }
    assertCommittedRunFieldsUnchanged(before, run);
    const saved: PlanningRun = {
      ...run,
      revision: before.revision + 1,
      updatedAt: this.now(),
    };
    this.runs.set(run.id, saved);
    if (before.stage !== saved.stage) {
      await this.appendEvent(saved.id, {
        type: "run.stage_changed",
        from: before.stage,
        to: saved.stage,
      });
    }
    if (before.lifecycle !== saved.lifecycle) {
      await this.appendEvent(saved.id, {
        type: "run.lifecycle_changed",
        from: before.lifecycle,
        to: saved.lifecycle,
      });
    }
    return saved;
  }

  async appendEvent(planID: PlanID, detail: PlanEventDetail): Promise<PlanEvent> {
    const list = this.events.get(planID) ?? [];
    const event: PlanEvent = {
      seq: list.length + 1,
      planID,
      at: this.now(),
      detail,
    };
    list.push(event);
    this.events.set(planID, list);
    return event;
  }

  async listEvents(planID: PlanID): Promise<PlanEvent[]> {
    return [...(this.events.get(planID) ?? [])];
  }

  async getHeadSnapshot(planID: PlanID): Promise<Snapshot | undefined> {
    const run = this.runs.get(planID);
    if (!run?.headSnapshot) return undefined;
    return this.snapshots.get(planID)?.get(run.headSnapshot);
  }

  async getArchitecture(planID: PlanID, revision?: number): Promise<Architecture | undefined> {
    const registry = this.architectures.get(planID);
    if (!registry) return undefined;
    if (revision !== undefined) return registry.byKey.get(revisionKey("ARCH", revision));
    const highest = Math.max(...registry.highest.values(), 0);
    return highest === 0 ? undefined : registry.byKey.get(revisionKey("ARCH", highest));
  }

  async getSection(planID: PlanID, sectionID: SectionID): Promise<Section | undefined> {
    return this.sections.get(planID)?.get(sectionID);
  }

  async listSections(planID: PlanID): Promise<Section[]> {
    return [...(this.sections.get(planID)?.values() ?? [])];
  }

  async getSectionRevision(
    planID: PlanID,
    ref: SectionRevisionRef,
  ): Promise<SectionRevision | undefined> {
    return this.sectionRevisions.get(planID)?.byKey.get(revisionKey(ref.id, ref.revision));
  }

  async getDecision(planID: PlanID, ref: DecisionRef): Promise<Decision | undefined> {
    return this.decisions.get(planID)?.byKey.get(revisionKey(ref.id, ref.revision));
  }

  async getProposal(planID: PlanID, proposalID: ProposalID): Promise<Proposal | undefined> {
    return this.proposals.get(planID)?.get(proposalID);
  }

  async putEvidence(planID: PlanID, evidence: Evidence): Promise<void> {
    let registry = this.evidence.get(planID);
    if (!registry) {
      registry = createRegistry<Evidence>();
      this.evidence.set(planID, registry);
    }
    const key = revisionKey(evidence.id, evidence.revision);
    if (registry.byKey.has(key)) {
      throw new UltraPlanError(
        "duplicate_revision",
        `Evidence ${evidence.id}@${evidence.revision} already exists; revisions are immutable`,
        { evidenceID: evidence.id, revision: evidence.revision },
      );
    }
    assertRevisionMonotonic(registry.highest.get(evidence.id), evidence.revision, `evidence ${evidence.id}`);
    registry.byKey.set(key, evidence);
    registry.latest.set(evidence.id, evidence);
    registry.highest.set(evidence.id, evidence.revision);
  }

  async listEvidence(planID: PlanID): Promise<Evidence[]> {
    return [...(this.evidence.get(planID)?.latest.values() ?? [])];
  }

  async commitTransaction(): Promise<PlanCommit> {
    throw new UltraPlanError(
      "phase_boundary",
      "commitTransaction is the Phase 2 transaction engine (Proposal → Approval → PlanCommit); committed Plan Memory is immutable until then",
    );
  }
}
