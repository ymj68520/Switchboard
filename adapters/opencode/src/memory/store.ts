/**
 * Storage boundary for Plan Memory — spec §12 + Phase 2B1 transaction engine.
 *
 * The boundary is deliberately narrow:
 *
 * - Committed Plan Memory (architecture/section/decision revisions, approvals,
 *   commits, snapshots) is READ-ONLY through this interface. Its single
 *   mutation path is `commitTransaction`, which validates the entire
 *   transaction (proposal, approval, base snapshot, dependencies, conflicts,
 *   evidence, resulting state) against a STAGED clone and publishes atomically
 *   (spec §9.4). A generic `save*` mutation API is intentionally absent.
 * - The PlanningRun header (stage/lifecycle/activeWork/goal/questions/
 *   conflicts/constraints) is working state and mutates via `saveRun`; the
 *   commit-gated fields are protected by an invariant check inside saveRun and
 *   are advanced ONLY by the transaction engine.
 * - Evidence is a separate trust domain (spec §21/§25): immutable revisions
 *   that do NOT require approval, hence the explicit narrow `putEvidence`.
 * - Approvals are immutable authorization records: no update method exists.
 *   An exact duplicate delivery returns the existing record (idempotent);
 *   a conflicting one is rejected.
 *
 * ATOMICITY MODEL (in-memory, single-threaded): commitTransaction gathers all
 * inputs with awaits, then runs validate → stage-on-clones → validate-staged →
 * publish as ONE synchronous block. JavaScript cannot interleave it, so a
 * failure before publication leaves every byte of state — registries, run
 * header, events, snapshot chain, commits, HEAD, proposal status — exactly
 * unchanged. `publishTransaction` is the single protected publication seam
 * (subclass/override point for fault-injection tests).
 *
 * Async signatures stay so the durable Phase 2B2 store drops in without an
 * interface migration.
 */
import {
  assertAcyclicSections,
  assertCommittedRunFieldsUnchanged,
  assertRevisionMonotonic,
  assertSectionCanComplete,
  propagateNeedsReview,
} from "../core/invariants.js";
import type {
  ApprovalID,
  CommitID,
  PlanID,
  ProposalID,
  QuestionID,
  SectionID,
} from "../core/ids.js";
import { CommitIDs, SnapshotIDs } from "../core/ids.js";
import { isActiveRun } from "../core/state-machine.js";
import { UltraPlanError } from "../core/errors.js";
import type {
  Architecture,
  Decision,
  OpenQuestion,
  PlanningRun,
  Section,
  SectionRevision,
} from "../core/types.js";
import type {
  ArchitectureRef,
  DecisionRef,
  EvidenceRef,
  MemoryRef,
  SectionRevisionRef,
  Timestamp,
} from "../core/refs.js";
import { computeProposalHash } from "../transaction/hash.js";
import type {
  Approval,
  ApprovedDecision,
  CommittedChange,
  PlanCommit,
  Proposal,
  ProposalChange,
} from "../transaction/types.js";
import type { Evidence } from "../repository/evidence.js";
import type { PlanEvent, PlanEventDetail } from "./events.js";
import type { Snapshot, SnapshotState } from "./snapshots.js";

export interface CommitTransactionInput {
  planID: PlanID;
  /** The proposal being committed; must be `awaiting_approval` with an exact Approval. */
  proposalID: ProposalID;
  approvalID: ApprovalID;
  // parentCommit is DERIVED from the run's current HEAD by the engine — the
  // caller can never supply (or falsify) commit-chain structure.
}

export interface PlanStore {
  // -- PlanningRun ----------------------------------------------------------
  /** The run blocking the session, if any (active or handoff_pending). */
  findActiveRunBySession(sessionID: string): Promise<PlanningRun | undefined>;
  /** Most recent run for the session regardless of lifecycle (for reads). */
  findLatestRunBySession(sessionID: string): Promise<PlanningRun | undefined>;
  getRun(planID: PlanID): Promise<PlanningRun | undefined>;
  /** Next monotonically increasing plan sequence number (PLAN-001, ...). */
  nextPlanSequence(): Promise<number>;
  /**
   * Create a run. Throws `multiple_active_runs` if the session already has an
   * active run — the controller checks first, the store enforces the
   * invariant. Also materializes the initial HEAD snapshot (commit=null) so
   * proposals always have a base to bind to.
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
  /** Newest revision of each committed decision (read-only). */
  listDecisions(planID: PlanID): Promise<Decision[]>;
  getProposal(planID: PlanID, proposalID: ProposalID): Promise<Proposal | undefined>;
  getCommit(planID: PlanID, commitID: CommitID): Promise<PlanCommit | undefined>;
  listCommits(planID: PlanID): Promise<PlanCommit[]>;

  // -- Approval records (immutable; no update method exists) -----------------
  /**
   * Persist a user approval. Idempotent for the exact same proposal binding
   * (returns the existing record); a conflicting authorization for an
   * already-approved proposal, or a reused approval id, is rejected.
   */
  saveApproval(planID: PlanID, approval: Approval): Promise<Approval>;
  getApproval(planID: PlanID, approvalID: ApprovalID): Promise<Approval | undefined>;
  /** The (single) authorization for a proposal, if one was recorded. */
  findApprovalForProposal(planID: PlanID, proposalID: ProposalID): Promise<Approval | undefined>;
  listApprovals(planID: PlanID): Promise<Approval[]>;

  // -- Repository Evidence (separate trust domain) ---------------------------
  /**
   * Record an immutable Evidence revision. Throws `duplicate_revision` /
   * `non_monotonic_revision` on violations. Does not require user approval
   * (spec §25).
   */
  putEvidence(planID: PlanID, evidence: Evidence): Promise<void>;
  /** Newest revision of each evidence record for the run. */
  listEvidence(planID: PlanID): Promise<Evidence[]>;
  /**
   * Exact-revision evidence read. With `ref.revision` set, a missing revision
   * is an error-free miss (callers surface `unknown_reference`); without it,
   * the newest revision is returned.
   */
  getEvidence(planID: PlanID, ref: EvidenceRef): Promise<Evidence | undefined>;

  // -- Proposal intent (Harness-assigned; frozen at creation in Phase 2A) ----
  /**
   * Persist a proposal. Proposals are content-addressed intent records: an id
   * may never be reused with different content (`proposal_immutable`).
   */
  saveProposal(planID: PlanID, proposal: Proposal): Promise<Proposal>;
  listProposals(planID: PlanID): Promise<Proposal[]>;
  /**
   * Harness-controlled lifecycle transition (`ready → awaiting_approval`,
   * `awaiting_approval → rejected`, `awaiting_approval → approved` by the
   * engine). ONLY the status field may change; wrong current status is
   * `proposal_status_invalid`.
   */
  transitionProposalStatus(
    planID: PlanID,
    proposalID: ProposalID,
    from: Proposal["status"],
    to: Proposal["status"],
  ): Promise<Proposal>;

  // -- The only committed-memory mutation path (Phase 2B1 engine) ------------
  /**
   * Proposal → Approval → PlanCommit (spec §9.4). Validates the FULL
   * transaction — run active, proposal awaiting approval, approval binding
   * exact, hash recomputes, base snapshot matches HEAD (createdFrom), change
   * targets resolve, conflicts, evidence — against a STAGED clone of committed
   * state, then publishes atomically: immutable revisions, question effects,
   * events, Snapshot, PlanCommit, proposal → approved, HEAD movement.
   *
   * Failure at ANY point before publication leaves committed Plan Memory,
   * HEAD, events, and proposal status exactly unchanged; the Approval remains
   * valid for retry. Repeating an already-successful exact transaction returns
   * the existing PlanCommit (idempotent).
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

function cloneRegistry<T>(registry: RevisionRegistry<T>): RevisionRegistry<T> {
  return {
    byKey: new Map(registry.byKey),
    latest: new Map(registry.latest),
    highest: new Map(registry.highest),
  };
}

function revisionKey(id: string, revision: number): string {
  return `${id}@${revision}`;
}

/** A single deterministic transaction-validation failure. */
export interface TransactionFailure {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

/** Committed state the transaction engine stages and publishes together. */
interface StagedState {
  architectures: RevisionRegistry<Architecture>;
  sections: Map<SectionID, Section>;
  sectionRevisions: RevisionRegistry<SectionRevision>;
  decisions: RevisionRegistry<Decision>;
  openQuestions: OpenQuestion[];
  runArchitecture: ArchitectureRef | undefined;
  runSections: SectionRefMirror[];
  runDecisions: DecisionRef[];
  committedChanges: CommittedChange[];
  revised: { kind: "decision" | "section_revision" | "architecture" | "question"; id: string; revision: number }[];
  resolvedQuestions: QuestionID[];
}

interface SectionRefMirror {
  id: SectionID;
}

function emptyRegistryOr<T>(map: Map<PlanID, RevisionRegistry<T>>, planID: PlanID): RevisionRegistry<T> {
  return map.get(planID) ?? createRegistry<T>();
}

export class InMemoryPlanStore implements PlanStore {
  // State fields are protected (not private) so the DurablePlanStore subclass
  // can hydrate them from durable storage without duplicating engine logic.
  /** Debug/test identity of this store instance. */
  readonly instanceId = Math.random().toString(36).slice(2, 8);
  protected readonly now: () => Timestamp;
  protected readonly runs = new Map<PlanID, PlanningRun>();
  protected readonly runOrder: PlanID[] = [];
  protected readonly events = new Map<PlanID, PlanEvent[]>();
  protected readonly architectures = new Map<PlanID, RevisionRegistry<Architecture>>();
  protected readonly sections = new Map<PlanID, Map<SectionID, Section>>();
  protected readonly sectionRevisions = new Map<PlanID, RevisionRegistry<SectionRevision>>();
  protected readonly decisions = new Map<PlanID, RevisionRegistry<Decision>>();
  protected readonly proposals = new Map<PlanID, Map<ProposalID, Proposal>>();
  protected readonly approvals = new Map<PlanID, Map<ApprovalID, Approval>>();
  protected readonly commits = new Map<PlanID, Map<CommitID, PlanCommit>>();
  /** proposalID → commitID, per plan: the idempotency + already-committed index. */
  protected readonly commitByProposal = new Map<string, CommitID>();
  protected readonly snapshots = new Map<PlanID, Map<string, Snapshot>>();
  protected readonly evidence = new Map<PlanID, RevisionRegistry<Evidence>>();

  constructor(now: () => Timestamp = () => new Date().toISOString()) {
    this.now = now;
    (this.approvals as unknown as { mapTag: string }).mapTag = `MAP-${this.instanceId}`;
  }

  async findActiveRunBySession(sessionID: string): Promise<PlanningRun | undefined> {
    for (const run of this.runs.values()) {
      if (run.sessionID === sessionID && isActiveRun(run)) return run;
    }
    return undefined;
  }

  async findLatestRunBySession(sessionID: string): Promise<PlanningRun | undefined> {
    for (let i = this.runOrder.length - 1; i >= 0; i--) {
      const id = this.runOrder[i];
      const run = id === undefined ? undefined : this.runs.get(id);
      if (run?.sessionID === sessionID) return run;
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
    // Initial HEAD snapshot (no commit yet) so every proposal has a base to
    // bind to (spec §9.1 createdFrom, §10).
    const snapshotID = SnapshotIDs.from(1);
    const snapshot: Snapshot = {
      id: snapshotID,
      planID: run.id,
      commit: null,
      state: {
        sectionRevisions: {},
        decisionRevisions: {},
        constraintIDs: [],
        openQuestionIDs: run.openQuestions.map((q) => q.id),
      },
      createdAt: this.now(),
    };
    const snapshots = new Map<string, Snapshot>();
    snapshots.set(snapshot.id, snapshot);
    this.snapshots.set(run.id, snapshots);

    const stored: PlanningRun = { ...run, headSnapshot: snapshotID };
    this.runs.set(run.id, stored);
    this.runOrder.push(run.id);
    return stored;
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

  async listDecisions(planID: PlanID): Promise<Decision[]> {
    return [...(this.decisions.get(planID)?.latest.values() ?? [])];
  }

  async getProposal(planID: PlanID, proposalID: ProposalID): Promise<Proposal | undefined> {
    return this.proposals.get(planID)?.get(proposalID);
  }

  async getCommit(planID: PlanID, commitID: CommitID): Promise<PlanCommit | undefined> {
    return this.commits.get(planID)?.get(commitID);
  }

  async listCommits(planID: PlanID): Promise<PlanCommit[]> {
    return [...(this.commits.get(planID)?.values() ?? [])];
  }

  async saveApproval(planID: PlanID, approval: Approval): Promise<Approval> {
    let registry = this.approvals.get(planID);
    if (!registry) {
      registry = new Map<ApprovalID, Approval>();
      this.approvals.set(planID, registry);
    }
    if (registry.has(approval.id)) {
      const existing = registry.get(approval.id) as Approval;
      if (approvalEquals(existing, approval)) return existing;
      throw new UltraPlanError(
        "approval_mismatch",
        `Approval id ${approval.id} is already bound to a different authorization; approval records are immutable`,
        { approvalID: approval.id },
      );
    }
    const existingForProposal = await this.findApprovalForProposal(planID, approval.proposalID);
    if (existingForProposal) {
      if (approvalEquals(existingForProposal, approval)) return existingForProposal;
      throw new UltraPlanError(
        "approval_mismatch",
        `Proposal ${approval.proposalID} already has a conflicting authorization; one proposal has exactly one approval`,
        { proposalID: approval.proposalID },
      );
    }
    registry.set(approval.id, approval);
    await this.appendEvent(planID, {
      type: "approval.recorded",
      approvalID: approval.id,
      proposalID: approval.proposalID,
      proposalHash: approval.proposalHash,
    });
    return approval;
  }

  async getApproval(planID: PlanID, approvalID: ApprovalID): Promise<Approval | undefined> {
    return this.approvals.get(planID)?.get(approvalID);
  }

  async findApprovalForProposal(planID: PlanID, proposalID: ProposalID): Promise<Approval | undefined> {
    for (const approval of this.approvals.get(planID)?.values() ?? []) {
      if (approval.proposalID === proposalID) return approval;
    }
    return undefined;
  }

  async listApprovals(planID: PlanID): Promise<Approval[]> {
    return [...(this.approvals.get(planID)?.values() ?? [])];
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

  async getEvidence(planID: PlanID, ref: EvidenceRef): Promise<Evidence | undefined> {
    const registry = this.evidence.get(planID);
    if (!registry) return undefined;
    if (ref.revision !== undefined) {
      return registry.byKey.get(revisionKey(ref.id, ref.revision));
    }
    return registry.latest.get(ref.id);
  }

  async saveProposal(planID: PlanID, proposal: Proposal): Promise<Proposal> {
    let registry = this.proposals.get(planID);
    if (!registry) {
      registry = new Map<ProposalID, Proposal>();
      this.proposals.set(planID, registry);
    }
    if (registry.has(proposal.id)) {
      throw new UltraPlanError(
        "proposal_immutable",
        `Proposal ${proposal.id} already exists; proposals are frozen intent records — supersede with a new proposal instead`,
        { proposalID: proposal.id },
      );
    }
    registry.set(proposal.id, proposal);
    return proposal;
  }

  async listProposals(planID: PlanID): Promise<Proposal[]> {
    return [...(this.proposals.get(planID)?.values() ?? [])];
  }

  async transitionProposalStatus(
    planID: PlanID,
    proposalID: ProposalID,
    from: Proposal["status"],
    to: Proposal["status"],
  ): Promise<Proposal> {
    const existing = await this.getProposal(planID, proposalID);
    if (!existing) {
      throw new UltraPlanError("unknown_reference", `Proposal ${proposalID} does not exist`, {
        proposalID,
      });
    }
    if (existing.status !== from) {
      throw new UltraPlanError(
        "proposal_status_invalid",
        `Proposal ${proposalID} is ${existing.status}, expected ${from}`,
        { proposalID, actual: existing.status, expected: from },
      );
    }
    const updated: Proposal = { ...existing, status: to };
    this.proposals.get(planID)?.set(proposalID, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Transaction engine (Phase 2B1) — the single committed-memory authority
  // -------------------------------------------------------------------------

  async commitTransaction(input: CommitTransactionInput): Promise<PlanCommit> {
    // Async gather phase — after this, validation → staging → publication run
    // synchronously and cannot be interleaved (in-memory atomicity).
    const run = await this.getRun(input.planID);
    if (!run) {
      throw new UltraPlanError("run_not_found", `PlanningRun ${input.planID} does not exist`, {
        planID: input.planID,
      });
    }
    const proposal = await this.getProposal(input.planID, input.proposalID);
    if (!proposal) {
      throw new UltraPlanError(
        "unknown_reference",
        `Proposal ${input.proposalID} does not exist in run ${input.planID}`,
        { proposalID: input.proposalID },
      );
    }
    const approval = await this.getApproval(input.planID, input.approvalID);
    if (!approval) {
      throw new UltraPlanError(
        "approval_not_found",
        `Approval ${input.approvalID} does not exist in run ${input.planID}`,
        { approvalID: input.approvalID },
      );
    }

    return this.executeTransaction(run, proposal, approval);
  }

  /**
   * Synchronous validate → stage → validate-staged → publish. Any throw leaves
   * state untouched (nothing has been written until publishTransaction).
   */
  private executeTransaction(run: PlanningRun, proposal: Proposal, approval: Approval): PlanCommit {
    // -- Idempotent replay (spec §22 / brief §22) -----------------------------
    const existingCommitID = this.commitByProposal.get(`${run.id}:${proposal.id}`);
    if (existingCommitID !== undefined) {
      const existing = this.commits.get(run.id)?.get(existingCommitID);
      if (existing && existing.approvalID === approval.id) {
        return existing; // exact retry → the same PlanCommit, zero duplicates
      }
      throw new UltraPlanError(
        "already_committed",
        `Proposal ${proposal.id} was already committed with a different approval`,
        { proposalID: proposal.id, committedWith: existing?.approvalID },
      );
    }

    // -- Full validation BEFORE any mutation ----------------------------------
    const failures: TransactionFailure[] = [];
    const addFailure = (code: string, message: string, detail?: Record<string, unknown>): void => {
      failures.push({ code, message, detail });
    };

    if (run.lifecycle !== "active") {
      addFailure(
        "run_not_active",
        `PlanningRun ${run.id} is ${run.lifecycle}; commits require an active run`,
        { lifecycle: run.lifecycle },
      );
    }
    if (proposal.status !== "awaiting_approval") {
      addFailure(
        "proposal_not_awaiting_approval",
        `Proposal ${proposal.id} is ${proposal.status}; only an awaiting_approval proposal can commit`,
        { status: proposal.status },
      );
    }
    if (
      approval.proposalID !== proposal.id ||
      approval.proposalRevision !== proposal.revision ||
      approval.proposalHash !== proposal.hash
    ) {
      addFailure("approval_binding_mismatch", "Approval does not bind the exact proposal revision/hash", {
        approval: { proposalID: approval.proposalID, proposalRevision: approval.proposalRevision },
        proposal: { proposalID: proposal.id, proposalRevision: proposal.revision },
      });
    }
    if (approval.actor !== "user") {
      addFailure("approval_binding_mismatch", "Approval actor must be the user", { actor: approval.actor });
    }
    if (computeProposalHash(proposal) !== proposal.hash) {
      addFailure("proposal_hash_mismatch", "Proposal content no longer recomputes to its frozen hash", {
        proposalID: proposal.id,
      });
    }
    if (proposal.createdFrom.id !== run.headSnapshot) {
      addFailure(
        "head_snapshot_mismatch",
        `Proposal base ${proposal.createdFrom.id} is stale: run HEAD is ${run.headSnapshot}; supersede the proposal and re-approve`,
        { createdFrom: proposal.createdFrom.id, headSnapshot: run.headSnapshot },
      );
    }

    // Stage on clones; apply each change; collect per-change failures.
    const staged: StagedState = {
      architectures: cloneRegistry(emptyRegistryOr(this.architectures, run.id)),
      sections: new Map(this.sections.get(run.id) ?? []),
      sectionRevisions: cloneRegistry(emptyRegistryOr(this.sectionRevisions, run.id)),
      decisions: cloneRegistry(emptyRegistryOr(this.decisions, run.id)),
      openQuestions: run.openQuestions.map((q) => ({ ...q })),
      runArchitecture: run.architecture,
      runSections: run.sections.map((ref) => ({ id: ref.id })),
      runDecisions: [...run.decisions],
      committedChanges: [],
      revised: [],
      resolvedQuestions: [],
    };

    for (const change of proposal.changes) {
      this.stageChange(staged, change, addFailure);
    }

    // Resulting-state validation.
    try {
      assertAcyclicSections([...staged.sections.values()]);
    } catch (error) {
      addFailure("section_dependency_cycle", error instanceof Error ? error.message : String(error));
    }

    // Blocking-conflict intersection (conservative: a blocking conflict with no
    // refs is treated as run-global; §15).
    const changedTargets = staged.committedChanges
      .map((change) => change.ref)
      .filter((ref): ref is MemoryRef => ref !== undefined);
    for (const conflict of run.conflicts) {
      if (conflict.status !== "open" || conflict.severity !== "blocking") continue;
      const intersects =
        conflict.refs.length === 0 ||
        conflict.refs.some((ref) => changedTargets.some((target) => refTargetsMatch(ref, target)));
      if (intersects) {
        addFailure(
          "conflict_blocking",
          `Open blocking conflict ${conflict.id} affects this transaction: ${conflict.description}`,
          { conflictID: conflict.id },
        );
      }
    }

    // Critical evidence referenced by committed objects must be fresh (§16).
    for (const change of proposal.changes) {
      const decisions: ApprovedDecision[] =
        change.kind === "add_decision" || change.kind === "amend_decision" ? [change.decision] : [];
      for (const decision of decisions) {
        for (const ref of decision.evidence ?? []) {
          const evidence = this.evidence.get(run.id)?.latest.get(ref.id);
          if (!evidence) {
            addFailure("unknown_reference", `Evidence ${ref.id} referenced by ${decision.id} does not exist`, {
              evidenceID: ref.id,
            });
            continue;
          }
          if (evidence.criticality === "critical" && !(evidence.status === "active" && evidence.freshness === "fresh")) {
            addFailure(
              "evidence_not_fresh",
              `Critical evidence ${evidence.id} is ${evidence.freshness}/${evidence.status}; commit blocked`,
              { evidenceID: evidence.id, freshness: evidence.freshness, status: evidence.status },
            );
          }
        }
      }
    }

    if (failures.length > 0) {
      // Nothing has been written — staged clones are discarded.
      throw new UltraPlanError(
        "transaction_validation_failed",
        `Transaction validation failed: ${failures.map((f) => f.code).join(", ")}`,
        { failures },
      );
    }

    // -- Publication (synchronous; HEAD last) ---------------------------------
    const stagedRun: PlanningRun = {
      ...run,
      openQuestions: staged.openQuestions,
      architecture: staged.runArchitecture,
      sections: staged.runSections.map((mirror) => ({ id: mirror.id })),
      decisions: staged.runDecisions,
    };
    return this.publishTransaction(run, stagedRun, staged, proposal, approval);
  }

  /** Stage one approved change onto the cloned state. */
  private stageChange(
    staged: StagedState,
    change: ProposalChange,
    addFailure: (code: string, message: string, detail?: Record<string, unknown>) => void,
  ): void {
    switch (change.kind) {
      case "add_decision": {
        const decision = change.decision;
        if (staged.decisions.latest.has(decision.id)) {
          addFailure("change_invalid", `Decision ${decision.id} already exists; add_decision requires a fresh id`, {
            decisionID: decision.id,
          });
          return;
        }
        this.stagePutRevision(staged.decisions, decision.id, decision.revision, decision, "decision", addFailure);
        if (!staged.runDecisions.some((ref) => ref.id === decision.id)) {
          staged.runDecisions.push({ id: decision.id, revision: decision.revision });
        }
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "decision", id: decision.id, revision: decision.revision },
          resultingRevision: decision.revision,
        });
        staged.revised.push({ kind: "decision", id: decision.id, revision: decision.revision });
        return;
      }
      case "amend_decision": {
        const prior = staged.decisions.byKey.get(revisionKey(change.supersedes.id, change.supersedes.revision));
        if (!prior) {
          addFailure("unknown_reference", `Amend target ${change.supersedes.id}@${change.supersedes.revision} does not exist`);
          return;
        }
        if (change.decision.id !== change.supersedes.id) {
          addFailure("change_invalid", "amend_decision must keep the same decision id", {
            decisionID: change.decision.id,
          });
          return;
        }
        if (change.decision.revision !== change.supersedes.revision + 1) {
          addFailure("change_invalid", `amend_decision revision must be ${change.supersedes.revision + 1}`, {
            decisionID: change.decision.id,
            revision: change.decision.revision,
          });
          return;
        }
        void prior;
        this.stagePutRevision(staged.decisions, change.decision.id, change.decision.revision, change.decision, "decision", addFailure);
        const index = staged.runDecisions.findIndex((ref) => ref.id === change.decision.id);
        if (index >= 0) staged.runDecisions[index] = { id: change.decision.id, revision: change.decision.revision };
        else staged.runDecisions.push({ id: change.decision.id, revision: change.decision.revision });
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "decision", id: change.decision.id, revision: change.decision.revision },
          resultingRevision: change.decision.revision,
        });
        staged.revised.push({ kind: "decision", id: change.decision.id, revision: change.decision.revision });
        return;
      }
      case "amend_section": {
        const prior = staged.sectionRevisions.byKey.get(
          revisionKey(change.supersedes.id, change.supersedes.revision),
        );
        if (!prior) {
          addFailure("unknown_reference", `Amend target ${change.supersedes.id}@${change.supersedes.revision} does not exist`);
          return;
        }
        const revision = change.revision;
        if (revision.sectionID !== change.supersedes.id || revision.revision !== change.supersedes.revision + 1) {
          addFailure("change_invalid", "amend_section must target the same section at supersedes.revision + 1", {
            sectionID: revision.sectionID,
            revision: revision.revision,
          });
          return;
        }
        this.stagePutRevision(staged.sectionRevisions, revision.sectionID, revision.revision, revision, "section_revision", addFailure);
        const section = staged.sections.get(revision.sectionID);
        if (!section) {
          addFailure("unknown_reference", `Section ${revision.sectionID} is not committed`);
          return;
        }
        // Atomic reopen semantics (§13): an amendment to an APPROVED section
        // reopens it in the SAME commit; old approved revisions are preserved.
        const updated: Section = {
          ...section,
          currentRevision: revision.revision,
          ...(section.status === "approved" ? { status: "reopened" as const } : {}),
        };
        staged.sections.set(revision.sectionID, updated);
        // Downstream needs_review propagation (already-tested semantics).
        const all = [...staged.sections.values()];
        const propagated = propagateNeedsReview(all, [revision.sectionID]);
        for (const next of propagated) staged.sections.set(next.id, next);
        if (!staged.runSections.some((mirror) => mirror.id === revision.sectionID)) {
          staged.runSections.push({ id: revision.sectionID });
        }
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "section", id: revision.sectionID, revision: revision.revision },
          resultingRevision: revision.revision,
        });
        staged.revised.push({ kind: "section_revision", id: revision.sectionID, revision: revision.revision });
        return;
      }
      case "raise_question": {
        const question = change.question;
        if (staged.openQuestions.some((q) => q.id === question.id)) {
          addFailure("change_invalid", `Question ${question.id} already exists; raise_question requires a fresh id`, {
            questionID: question.id,
          });
          return;
        }
        staged.openQuestions.push(question);
        staged.committedChanges.push({ kind: change.kind, ref: { kind: "question", id: question.id } });
        staged.revised.push({ kind: "question", id: question.id, revision: 1 });
        return;
      }
      case "resolve_question": {
        const resolution = change.resolution;
        const question = staged.openQuestions.find((q) => q.id === resolution.questionID);
        if (!question) {
          addFailure("unknown_reference", `Question ${resolution.questionID} does not exist`);
          return;
        }
        if (question.status === "resolved") {
          addFailure("change_invalid", `Question ${resolution.questionID} is already resolved`);
          return;
        }
        question.status = "resolved";
        question.resolution = resolution.resolution;
        question.resolvedBy = resolution.resolvedBy;
        staged.resolvedQuestions.push(resolution.questionID);
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "question", id: resolution.questionID },
        });
        return;
      }
      case "complete_architecture": {
        const architecture = staged.architectures.byKey.get(
          revisionKey("ARCH", change.target.revision),
        );
        if (!architecture) {
          addFailure("unknown_reference", `Architecture ${change.target.revision} does not exist`);
          return;
        }
        staged.architectures.byKey.set(revisionKey("ARCH", change.target.revision), {
          ...architecture,
          status: "approved",
        });
        staged.architectures.latest.set("ARCH", { ...architecture, status: "approved" });
        staged.runArchitecture = { id: "ARCH", revision: change.target.revision };
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "architecture", revision: change.target.revision },
          resultingRevision: change.target.revision,
        });
        staged.revised.push({ kind: "architecture", id: "ARCH", revision: change.target.revision });
        return;
      }
      case "complete_section": {
        const target = change.target;
        const revisionRecord = staged.sectionRevisions.byKey.get(revisionKey(target.id, target.revision));
        if (!revisionRecord) {
          addFailure("unknown_reference", `Section revision ${target.id}@${target.revision} does not exist`);
          return;
        }
        const section = staged.sections.get(target.id);
        if (!section) {
          addFailure("unknown_reference", `Section ${target.id} is not committed`);
          return;
        }
        try {
          assertSectionCanComplete([...staged.sections.values()], target.id);
        } catch (error) {
          addFailure("dependency_incomplete", error instanceof Error ? error.message : String(error), {
            sectionID: target.id,
          });
          return;
        }
        staged.sections.set(target.id, {
          ...section,
          status: "approved",
          approvedRevision: target.revision,
        });
        if (!staged.runSections.some((mirror) => mirror.id === target.id)) {
          staged.runSections.push({ id: target.id });
        }
        staged.committedChanges.push({
          kind: change.kind,
          ref: { kind: "section", id: target.id, revision: target.revision },
          resultingRevision: target.revision,
        });
        return;
      }
    }
  }

  /** Put an immutable revision into a staged registry (monotonic + immutable). */
  private stagePutRevision<T>(
    registry: RevisionRegistry<T>,
    id: string,
    revision: number,
    record: T,
    what: string,
    addFailure: (code: string, message: string, detail?: Record<string, unknown>) => void,
  ): void {
    const key = revisionKey(id, revision);
    if (registry.byKey.has(key)) {
      addFailure("change_invalid", `${what} ${id}@${revision} already exists; revisions are immutable`);
      return;
    }
    const highest = registry.highest.get(id);
    if (highest !== undefined && revision !== highest + 1) {
      addFailure(
        "change_invalid",
        `${what} ${id}: revision ${revision} does not follow highest existing revision ${highest}`,
        { id, revision, highest },
      );
      return;
    }
    registry.byKey.set(key, record);
    registry.latest.set(id, record);
    registry.highest.set(id, revision);
  }

  /**
   * The single publication seam. Everything is validated; this writes staged
   * state atomically (one synchronous block) and moves HEAD last. Protected
   * so fault-injection tests can fail here and prove zero partial mutation.
   */
  protected publishTransaction(
    beforeRun: PlanningRun,
    stagedRun: PlanningRun,
    staged: StagedState,
    proposal: Proposal,
    approval: Approval,
  ): PlanCommit {
    const planID = beforeRun.id;
    const at = this.now();

    // 1. Immutable artifact revisions + question effects.
    this.architectures.set(planID, staged.architectures);
    this.sections.set(planID, staged.sections);
    this.sectionRevisions.set(planID, staged.sectionRevisions);
    this.decisions.set(planID, staged.decisions);

    // 2. Run header (working + commit-gated pointer fields; engine authority).
    const updatedRun: PlanningRun = {
      ...stagedRun,
      revision: beforeRun.revision + 1,
      updatedAt: at,
    };
    this.runs.set(planID, updatedRun);

    // 3. Events with clear audit meaning.
    for (const revised of staged.revised) {
      void this.appendEvent(planID, { type: "artifact.revised", ...revised });
    }
    for (const questionID of staged.resolvedQuestions) {
      const question = staged.openQuestions.find((q) => q.id === questionID);
      if (question?.resolution) {
        void this.appendEvent(planID, {
          type: "question.resolved",
          questionID,
          resolution: question.resolution,
        });
      }
    }

    // 4. Snapshot of the POST-commit state.
    const snapshotSeq = (this.snapshots.get(planID)?.size ?? 0) + 1;
    const snapshotID = SnapshotIDs.from(snapshotSeq);
    const sectionRevisionsState: SnapshotState["sectionRevisions"] = {};
    for (const section of staged.sections.values()) {
      if (section.currentRevision !== undefined) {
        sectionRevisionsState[section.id] = section.currentRevision;
      }
    }
    const decisionRevisionsState: SnapshotState["decisionRevisions"] = {};
    for (const decision of staged.decisions.latest.values()) {
      decisionRevisionsState[decision.id] = decision.revision;
    }
    const snapshot: Snapshot = {
      id: snapshotID,
      planID,
      commit: null, // patched to the commit id below before publication ends
      state: {
        architectureRevision: staged.runArchitecture?.revision,
        sectionRevisions: sectionRevisionsState,
        decisionRevisions: decisionRevisionsState,
        constraintIDs: stagedRun.constraints.filter((c) => c.status === "active").map((c) => c.id),
        openQuestionIDs: staged.openQuestions.filter((q) => q.status === "open").map((q) => q.id),
      },
      createdAt: at,
    };
    const snapshots = this.snapshots.get(planID) ?? new Map<string, Snapshot>();
    snapshots.set(snapshotID, snapshot);
    this.snapshots.set(planID, snapshots);

    // 5. PlanCommit + linear chain index.
    const commitSeq = (this.commits.get(planID)?.size ?? 0) + 1;
    const commitID = CommitIDs.from(commitSeq);
    const commit: PlanCommit = {
      id: commitID,
      proposalID: proposal.id,
      approvalID: approval.id,
      parentCommit: beforeRun.headCommit ?? null,
      changes: staged.committedChanges,
      resultingSnapshot: snapshotID,
      createdAt: at,
    };
    const commits = this.commits.get(planID) ?? new Map<CommitID, PlanCommit>();
    commits.set(commitID, commit);
    this.commits.set(planID, commits);
    this.commitByProposal.set(`${planID}:${proposal.id}`, commitID);
    snapshot.commit = commitID;

    // 6. Proposal → approved (same atomic transaction).
    this.proposals.get(planID)?.set(proposal.id, { ...proposal, status: "approved" });

    // 7. Events that reference the commit, then HEAD last.
    void this.appendEvent(planID, {
      type: "transaction.committed",
      commitID,
      proposalID: proposal.id,
      approvalID: approval.id,
      snapshotID,
    });
    void this.appendEvent(planID, { type: "head.moved", from: beforeRun.headCommit ?? null, to: commitID });
    this.runs.set(planID, { ...updatedRun, headCommit: commitID, headSnapshot: snapshotID });

    return commit;
  }

  /**
   * TEST/FIXTURE ONLY — exists on the concrete in-memory class, NOT on the
   * PlanStore interface. Seeds synthetic committed artifacts so transaction
   * semantics can be exercised before the architecture/section workflows land
   * (they are later-phase work). Production code must never call this.
   */
  seedCommittedState(
    planID: PlanID,
    seed: {
      architecture?: Architecture;
      sections?: Section[];
      sectionRevisions?: SectionRevision[];
      decisions?: Decision[];
    },
  ): void {
    const { architecture, sections = [], sectionRevisions = [], decisions = [] } = seed;
    if (architecture) {
      const registry = emptyRegistryOr(this.architectures, planID);
      registry.byKey.set(revisionKey("ARCH", architecture.revision), architecture);
      registry.latest.set("ARCH", architecture);
      registry.highest.set("ARCH", architecture.revision);
      this.architectures.set(planID, registry);
    }
    if (sections.length > 0 || sectionRevisions.length > 0) {
      const map = this.sections.get(planID) ?? new Map<SectionID, Section>();
      for (const section of sections) map.set(section.id, section);
      this.sections.set(planID, map);
    }
    if (sectionRevisions.length > 0) {
      const registry = emptyRegistryOr(this.sectionRevisions, planID);
      for (const revision of sectionRevisions) {
        registry.byKey.set(revisionKey(revision.sectionID, revision.revision), revision);
        registry.latest.set(revision.sectionID, revision);
        registry.highest.set(revision.sectionID, revision.revision);
      }
      this.sectionRevisions.set(planID, registry);
    }
    if (decisions.length > 0) {
      const registry = emptyRegistryOr(this.decisions, planID);
      for (const decision of decisions) {
        registry.byKey.set(revisionKey(decision.id, decision.revision), decision);
        registry.latest.set(decision.id, decision);
        registry.highest.set(decision.id, decision.revision);
      }
      this.decisions.set(planID, registry);
    }
    // Mirror committed refs into the run header (as prior commits would have).
    const run = this.runs.get(planID);
    if (run) {
      const archRef = architecture ? { id: "ARCH" as const, revision: architecture.revision } : undefined;
      this.runs.set(planID, {
        ...run,
        ...(archRef ? { architecture: archRef } : {}),
        sections: [
          ...run.sections,
          ...sections.filter((s) => !run.sections.some((ref) => ref.id === s.id)).map((s) => ({ id: s.id })),
        ],
        decisions: [
          ...run.decisions,
          ...decisions
            .filter((d) => !run.decisions.some((ref) => ref.id === d.id))
            .map((d) => ({ id: d.id, revision: d.revision })),
        ],
      });
    }
  }
}

/** Conservative target intersection: same kind, and same id where the kind carries one. */
function refTargetsMatch(a: MemoryRef, b: MemoryRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "architecture":
      return true;
    case "section":
      return b.kind === "section" && b.id === a.id;
    case "decision":
      return b.kind === "decision" && b.id === a.id;
    case "question":
      return b.kind === "question" && b.id === a.id;
    case "constraint":
      return b.kind === "constraint" && b.id === a.id;
    case "conflict":
      return b.kind === "conflict" && b.id === a.id;
    case "evidence":
      return b.kind === "evidence" && b.id === a.id;
    case "proposal":
      return b.kind === "proposal" && b.id === a.id;
    case "snapshot":
      return b.kind === "snapshot" && b.id === a.id;
    case "commit":
      return b.kind === "commit" && b.id === a.id;
    case "final_plan":
      return b.kind === "final_plan" && b.id === a.id;
  }
}

function approvalEquals(a: Approval, b: Approval): boolean {
  return (
    a.proposalID === b.proposalID &&
    a.proposalRevision === b.proposalRevision &&
    a.proposalHash === b.proposalHash &&
    a.actor === b.actor
  );
}
