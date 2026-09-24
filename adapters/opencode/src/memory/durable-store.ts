/**
 * DurablePlanStore — Phase 2B2.
 *
 * The durable implementation of the PlanStore boundary. It INHERITS the
 * Phase 2B1 transaction engine (validation, staging, change application,
 * publication order, idempotency) so the two stores cannot diverge
 * semantically — the durable subclass adds exactly three things:
 *
 * 1. STRUCTURED PERSISTENCE (memory/document.ts): one versioned JSON document
 *    per project holding Plan Memory as id-keyed records. The document is
 *    validated FAIL-CLOSED on every load (schema version gate, reference
 *    integrity, proposal hash recompute) — never repaired, never downgraded.
 *
 * 2. ATOMIC PUBLICATION: every mutation runs under an exclusive lock and ends
 *    by writing the whole document to a temp file (fsync) and RENAMING it over
 *    the store file. The rename is the commit point: a crash before it leaves
 *    the previous state byte-identical; a crash after it leaves exactly one
 *    committed transaction (recoverable through idempotent retry). This maps
 *    the 2B1 `publishTransaction` seam onto one durable atomic operation —
 *    inherited publish runs in memory under the lock, then the document is
 *    durably published before the lock is released.
 *
 * 3. CROSS-INSTANCE WRITER SERIALIZATION: an O_EXCL lock file (bounded retry,
 *    stale-lock theft) plus RELOAD-FROM-DISK INSIDE THE LOCK before every
 *    mutation. Two writers can never both validate the same HEAD and publish
 *    divergent commits: writer B reloads under the lock and fails
 *    `head_snapshot_mismatch` against the new durable HEAD. Reads may be
 *    per-instance cached; the write path is the authority.
 *
 * Chosen over SQLite because the Phase 2B2 backend gate proved `node:sqlite`
 * does NOT exist inside the real OpenCode host (Bun runtime), while
 * `bun:sqlite` has no Node 22 equivalent for the test environment — one
 * implementation over `node:fs` works identically in both. Evidence:
 * scripts/backend-gate.mjs output in the Phase 2B2 report.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname } from "node:path";

import { UltraPlanError } from "../core/errors.js";
import type {
  ApprovalID,
  CommitID,
  PlanID,
  ProposalID,
  SectionID,
} from "../core/ids.js";
import type { Timestamp } from "../core/refs.js";
import type { Approval, PlanCommit, Proposal } from "../transaction/types.js";
import type { Section } from "../core/types.js";
import {
  freshStoreDocument,
  validateStoreDocument,
  type StoreDocument,
} from "./document.js";
import { InMemoryPlanStore } from "./store.js";
import type { PlanEventDetail } from "./events.js";
import type { Snapshot } from "./snapshots.js";

export type DurableCrashPoint = "before-persist" | "after-persist";

export interface DurableStoreOptions {
  /** Bounded wait for the exclusive writer lock (default 4s). */
  lockTimeoutMs?: number;
  /** A lock file older than this is considered abandoned and stolen (default 15s). */
  staleLockMs?: number;
}

export class DurablePlanStore extends InMemoryPlanStore {
  private readonly filePath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  /** TEST-ONLY crash seam; unarmed in production (see armCrashSeam). */
  private crashPoint: DurableCrashPoint | undefined;
  private lockDepth = 0;
  private closed = false;

  constructor(
    filePath: string,
    options: DurableStoreOptions & { now?: () => Timestamp } = {},
  ) {
    super(options.now);
    this.filePath = filePath;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 4_000;
    this.staleLockMs = options.staleLockMs ?? 15_000;
  }

  /**
   * TEST-ONLY (brief §30): arm the crash seam at the durable commit point.
   * "before-persist" aborts before the durable write of the NEXT publication;
   * "after-persist" aborts after the atomic rename but before the caller
   * response. Production code must never call this.
   */
  armCrashSeam(point: DurableCrashPoint): void {
    this.crashPoint = point;
  }

  /** Disarm the crash seam. */
  disarmCrashSeam(): void {
    this.crashPoint = undefined;
  }

  private opened = false;

  /**
   * Deterministic open: create fresh, or load + validate + hydrate.
   * Synchronous and FAIL-CLOSED — callers (plugin startup) get the store
   * error immediately instead of a silent fallback.
   */
  open(): void {
    if (this.opened) return;
    // Flag FIRST: open() is synchronous, but re-entering it through a read's
    // ensureOpen() mid-mutation would re-hydrate from disk and wipe
    // un-persisted in-memory state.
    this.opened = true;
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      this.writeDocumentAtomic(freshStoreDocument());
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      throw new UltraPlanError("store_corrupt", `Durable store cannot be read: ${String(error)}`, {
        filePath: this.filePath,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new UltraPlanError("store_corrupt", `Durable store is not valid JSON: ${String(error)}`, {
        filePath: this.filePath,
      });
    }
    validateStoreDocument(parsed);
    this.hydrateDocument(parsed);
  }

  /** Release the store; called from the plugin dispose hook / tests. */
  close(): void {
    this.closed = true;
  }

  private ensureOpen(): Promise<void> {
    this.open();
    return Promise.resolve();
  }

  private assertOpenForWrites(): void {
    if (this.closed) {
      throw new UltraPlanError("store_corrupt", "Durable store is closed", { filePath: this.filePath });
    }
  }

  // -- Locking + durable publication ----------------------------------------

  private lockPath(): string {
    return `${this.filePath}.lock`;
  }

  private async acquireLock(): Promise<() => void> {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = openSync(this.lockPath(), "wx");
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            unlinkSync(this.lockPath());
          } catch {
            /* already gone */
          }
        };
      } catch {
        // Lock exists: steal it when clearly abandoned, else bounded wait.
        try {
          const raw = readFileSync(this.lockPath(), "utf8");
          const info = JSON.parse(raw) as { at?: number };
          if (typeof info.at !== "number" || Date.now() - info.at > this.staleLockMs) {
            unlinkSync(this.lockPath());
            continue;
          }
        } catch {
          /* vanished between stat and read — retry */
        }
        if (Date.now() > deadline) {
          throw new UltraPlanError(
            "store_busy",
            "Durable store is locked by another writer (bounded wait exhausted); retry the operation",
            { filePath: this.filePath },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  /**
   * Serialize every mutating operation: reload authoritative state from disk
   * INSIDE the lock (revalidation binds to durable HEAD, brief §14), run the
   * inherited Phase 2B1 mutation, then publish the document atomically.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lockDepth > 0) return fn(); // nested internal call (e.g. events)
    this.assertOpenForWrites();
    await this.ensureOpen();
    const release = await this.acquireLock();
    this.lockDepth++;
    try {
      // Rehydrate from disk: another instance may have moved HEAD meanwhile.
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreDocument;
      validateStoreDocument(parsed);
      this.hydrateDocument(parsed);
      const result = await fn();
      this.persistLocked();
      return result;
    } finally {
      this.lockDepth--;
      release();
    }
  }

  private serializeDocument(): StoreDocument {
    const doc = freshStoreDocument();
    for (const [id, run] of this.runs) doc.runs[id] = run;
    doc.runOrder = [...this.runOrder];
    for (const [id, list] of this.events) doc.events[id] = list;
    doc.commitByProposal = Object.fromEntries(this.commitByProposal);
    const committedFamily = (planID: string) => {
      const existing = doc.committed[planID] ?? {
        architectures: {},
        sections: {},
        sectionRevisions: {},
        decisions: {},
      };
      doc.committed[planID] = existing;
      return existing;
    };
    for (const [planID, registry] of this.architectures) {
      committedFamily(planID).architectures = Object.fromEntries(registry.byKey);
    }
    for (const [planID, map] of this.sections) {
      committedFamily(planID).sections = Object.fromEntries(map);
    }
    for (const [planID, registry] of this.sectionRevisions) {
      committedFamily(planID).sectionRevisions = Object.fromEntries(registry.byKey);
    }
    for (const [planID, registry] of this.decisions) {
      committedFamily(planID).decisions = Object.fromEntries(registry.byKey);
    }
    for (const [planID, map] of this.proposals) doc.proposals[planID] = Object.fromEntries(map);
    for (const [planID, map] of this.approvals) doc.approvals[planID] = Object.fromEntries(map);
    for (const [planID, map] of this.commits) doc.commits[planID] = Object.fromEntries(map);
    for (const [planID, map] of this.snapshots) doc.snapshots[planID] = Object.fromEntries(map);
    for (const [planID, registry] of this.evidence) doc.evidence[planID] = Object.fromEntries(registry.byKey);
    return doc;
  }

  private hydrateDocument(doc: StoreDocument): void {
    this.runs.clear();
    for (const [id, run] of Object.entries(doc.runs)) this.runs.set(id as PlanID, run);
    this.runOrder.length = 0;
    for (const id of doc.runOrder) this.runOrder.push(id as PlanID);
    this.events.clear();
    for (const [id, list] of Object.entries(doc.events)) this.events.set(id as PlanID, list);
    this.architectures.clear();
    this.sections.clear();
    this.sectionRevisions.clear();
    this.decisions.clear();
    for (const [planID, family] of Object.entries(doc.committed)) {
      this.architectures.set(planID as PlanID, registryFromRecords(family.architectures));
      const sections = new Map<SectionID, Section>();
      for (const [id, section] of Object.entries(family.sections)) {
        sections.set(id as SectionID, section);
      }
      this.sections.set(planID as PlanID, sections);
      this.sectionRevisions.set(planID as PlanID, registryFromRecords(family.sectionRevisions));
      this.decisions.set(planID as PlanID, registryFromRecords(family.decisions));
    }
    this.proposals.clear();
    for (const [planID, family] of Object.entries(doc.proposals)) {
      this.proposals.set(planID as PlanID, new Map(Object.entries(family) as [ProposalID, Proposal][]));
    }
    this.approvals.clear();
    for (const [planID, family] of Object.entries(doc.approvals)) {
      this.approvals.set(planID as PlanID, new Map(Object.entries(family) as [ApprovalID, Approval][]));
    }
    this.commits.clear();
    for (const [planID, family] of Object.entries(doc.commits)) {
      this.commits.set(planID as PlanID, new Map(Object.entries(family) as [CommitID, PlanCommit][]));
    }
    this.commitByProposal.clear();
    for (const [key, commitID] of Object.entries(doc.commitByProposal)) {
      this.commitByProposal.set(key, commitID as CommitID);
    }
    this.snapshots.clear();
    for (const [planID, family] of Object.entries(doc.snapshots)) {
      this.snapshots.set(planID as PlanID, new Map(Object.entries(family) as [string, Snapshot][]));
    }
    this.evidence.clear();
    for (const [planID, family] of Object.entries(doc.evidence)) {
      this.evidence.set(planID as PlanID, registryFromRecords(family));
    }
  }

  /**
   * The durable commit point: serialize → temp file → fsync → RENAME. Crash
   * before the rename leaves the previous state byte-identical; the rename is
   * atomic, so no partially written state is ever observable.
   */
  private writeDocumentAtomic(doc: StoreDocument): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(doc));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // ATOMIC COMMIT POINT: the rename swaps the entire durable state at once.
    renameSync(tmp, this.filePath);
  }

  private persistLocked(): void {
    const doc = this.serializeDocument();
    // TEST-ONLY crash seam (brief §30): abort exactly at the durable commit
    // point. Never set `crashPoint` outside fault-injection tests.
    if (this.crashPoint === "before-persist") process.abort();
    this.writeDocumentAtomic(doc);
    if (this.crashPoint === "after-persist") process.abort();
  }

  // -- Mutating operations (locked + durable) --------------------------------

  override async createRun(run: Parameters<InMemoryPlanStore["createRun"]>[0]) {
    return this.withLock(() => super.createRun(run));
  }

  override async saveRun(run: Parameters<InMemoryPlanStore["saveRun"]>[0]) {
    return this.withLock(() => super.saveRun(run));
  }

  override async appendEvent(planID: Parameters<InMemoryPlanStore["appendEvent"]>[0], detail: PlanEventDetail) {
    return this.withLock(() => super.appendEvent(planID, detail));
  }

  override async putEvidence(
    planID: Parameters<InMemoryPlanStore["putEvidence"]>[0],
    evidence: Parameters<InMemoryPlanStore["putEvidence"]>[1],
  ): Promise<void> {
    return this.withLock(() => super.putEvidence(planID, evidence));
  }

  override async saveProposal(
    planID: Parameters<InMemoryPlanStore["saveProposal"]>[0],
    proposal: Parameters<InMemoryPlanStore["saveProposal"]>[1],
  ) {
    return this.withLock(() => super.saveProposal(planID, proposal));
  }

  override async transitionProposalStatus(
    planID: Parameters<InMemoryPlanStore["transitionProposalStatus"]>[0],
    proposalID: Parameters<InMemoryPlanStore["transitionProposalStatus"]>[1],
    from: Parameters<InMemoryPlanStore["transitionProposalStatus"]>[2],
    to: Parameters<InMemoryPlanStore["transitionProposalStatus"]>[3],
  ) {
    return this.withLock(() => super.transitionProposalStatus(planID, proposalID, from, to));
  }

  override async saveApproval(
    planID: Parameters<InMemoryPlanStore["saveApproval"]>[0],
    approval: Parameters<InMemoryPlanStore["saveApproval"]>[1],
  ) {
    return this.withLock(() => super.saveApproval(planID, approval));
  }

  override async commitTransaction(
    input: Parameters<InMemoryPlanStore["commitTransaction"]>[0],
  ): ReturnType<InMemoryPlanStore["commitTransaction"]> {
    return this.withLock(() => super.commitTransaction(input));
  }

  /** TEST/FIXTURE ONLY (see base class). Wrapped so seeding is durable. */
  override seedCommittedState(
    planID: Parameters<InMemoryPlanStore["seedCommittedState"]>[0],
    seed: Parameters<InMemoryPlanStore["seedCommittedState"]>[1],
  ): void {
    // Both parameters are part of the base signature; the durable variant
    // refuses to run synchronously because it could not persist the seed.
    void planID;
    void seed;
    throw new UltraPlanError(
      "store_busy",
      "seedCommittedState is synchronous on the base class; use seedCommittedStateAsync on DurablePlanStore",
    );
  }

  /** Durable variant of the test-only seeding seam. */
  async seedCommittedStateAsync(
    planID: Parameters<InMemoryPlanStore["seedCommittedState"]>[0],
    seed: Parameters<InMemoryPlanStore["seedCommittedState"]>[1],
  ): Promise<void> {
    await this.withLock(async () => {
      super.seedCommittedState(planID, seed);
    });
  }

  // -- Reads (lazy open; may be per-instance cached across instances) --------

  override async findActiveRunBySession(sessionID: string) {
    await this.ensureOpen();
    return super.findActiveRunBySession(sessionID);
  }

  override async findLatestRunBySession(sessionID: string) {
    await this.ensureOpen();
    return super.findLatestRunBySession(sessionID);
  }

  override async getRun(planID: Parameters<InMemoryPlanStore["getRun"]>[0]) {
    await this.ensureOpen();
    return super.getRun(planID);
  }

  override async nextPlanSequence(): Promise<number> {
    await this.ensureOpen();
    return super.nextPlanSequence();
  }

  override async listEvents(planID: Parameters<InMemoryPlanStore["listEvents"]>[0]) {
    await this.ensureOpen();
    return super.listEvents(planID);
  }

  override async getHeadSnapshot(planID: Parameters<InMemoryPlanStore["getHeadSnapshot"]>[0]) {
    await this.ensureOpen();
    return super.getHeadSnapshot(planID);
  }

  override async getArchitecture(planID: Parameters<InMemoryPlanStore["getArchitecture"]>[0], revision?: number) {
    await this.ensureOpen();
    return super.getArchitecture(planID, revision);
  }

  override async getSection(planID: Parameters<InMemoryPlanStore["getSection"]>[0], sectionID: Parameters<InMemoryPlanStore["getSection"]>[1]) {
    await this.ensureOpen();
    return super.getSection(planID, sectionID);
  }

  override async listSections(planID: Parameters<InMemoryPlanStore["listSections"]>[0]) {
    await this.ensureOpen();
    return super.listSections(planID);
  }

  override async getSectionRevision(planID: Parameters<InMemoryPlanStore["getSectionRevision"]>[0], ref: Parameters<InMemoryPlanStore["getSectionRevision"]>[1]) {
    await this.ensureOpen();
    return super.getSectionRevision(planID, ref);
  }

  override async getDecision(planID: Parameters<InMemoryPlanStore["getDecision"]>[0], ref: Parameters<InMemoryPlanStore["getDecision"]>[1]) {
    await this.ensureOpen();
    return super.getDecision(planID, ref);
  }

  override async listDecisions(planID: Parameters<InMemoryPlanStore["listDecisions"]>[0]) {
    await this.ensureOpen();
    return super.listDecisions(planID);
  }

  override async getProposal(planID: Parameters<InMemoryPlanStore["getProposal"]>[0], proposalID: Parameters<InMemoryPlanStore["getProposal"]>[1]) {
    await this.ensureOpen();
    return super.getProposal(planID, proposalID);
  }

  override async getCommit(planID: Parameters<InMemoryPlanStore["getCommit"]>[0], commitID: Parameters<InMemoryPlanStore["getCommit"]>[1]) {
    await this.ensureOpen();
    return super.getCommit(planID, commitID);
  }

  override async listCommits(planID: Parameters<InMemoryPlanStore["listCommits"]>[0]) {
    await this.ensureOpen();
    return super.listCommits(planID);
  }

  override async getApproval(planID: Parameters<InMemoryPlanStore["getApproval"]>[0], approvalID: Parameters<InMemoryPlanStore["getApproval"]>[1]) {
    await this.ensureOpen();
    return super.getApproval(planID, approvalID);
  }

  override async findApprovalForProposal(planID: Parameters<InMemoryPlanStore["findApprovalForProposal"]>[0], proposalID: Parameters<InMemoryPlanStore["findApprovalForProposal"]>[1]) {
    await this.ensureOpen();
    return super.findApprovalForProposal(planID, proposalID);
  }

  override async listApprovals(planID: Parameters<InMemoryPlanStore["listApprovals"]>[0]) {
    await this.ensureOpen();
    return super.listApprovals(planID);
  }

  override async listEvidence(planID: Parameters<InMemoryPlanStore["listEvidence"]>[0]) {
    await this.ensureOpen();
    return super.listEvidence(planID);
  }

  override async getEvidence(planID: Parameters<InMemoryPlanStore["getEvidence"]>[0], ref: Parameters<InMemoryPlanStore["getEvidence"]>[1]) {
    await this.ensureOpen();
    return super.getEvidence(planID, ref);
  }
}

/** Rebuild a revision registry from `ID@REV`-keyed durable records. */
function registryFromRecords<T>(records: Record<string, T>): {
  byKey: Map<string, T>;
  latest: Map<string, T>;
  highest: Map<string, number>;
} {
  const byKey = new Map<string, T>();
  const latest = new Map<string, T>();
  const highest = new Map<string, number>();
  for (const [key, record] of Object.entries(records)) {
    byKey.set(key, record);
    const cut = key.lastIndexOf("@");
    const id = key.slice(0, cut);
    const revision = Number(key.slice(cut + 1));
    const current = highest.get(id);
    if (current === undefined || revision > current) {
      highest.set(id, revision);
      latest.set(id, record);
    }
  }
  return { byKey, latest, highest };
}
