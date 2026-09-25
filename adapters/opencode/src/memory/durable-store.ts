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
 *    `head_snapshot_mismatch` against the new durable HEAD. Out-of-lock reads
 *    also REFRESH FROM DISK (Phase 2D §42): allocation-critical reads must see
 *    the latest durable state so a second instance cannot freeze an id another
 *    instance already took.
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

  /**
   * Phase 2D §42 narrow stale-read fix: reads that feed authoritative
   * allocation (proposal/approval/section id sequences, scope resolution) must
   * see the latest durable state, not this instance's cache — otherwise a
   * second writer instance could allocate an id another instance already
   * froze. The document is one small file, so re-reading on every out-of-lock
   * read is cheap and safe (the atomic rename never exposes partial content).
   * NEVER refreshes inside the writer lock (lockDepth > 0): there, memory IS
   * the authoritative state, and re-hydrating from disk mid-mutation would
   * wipe un-persisted changes (the Phase 2B2 open()-flag lesson).
   */
  private refreshFromDisk(): void {
    if (this.lockDepth > 0 || this.closed) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreDocument;
      validateStoreDocument(parsed);
      this.hydrateDocument(parsed);
    } catch {
      /* missing/unreadable file — keep the current cache; open() handles creation */
    }
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
    // Phase 2F derived synthesis artifacts (additive families).
    for (const [planID, map] of this.synthesisInputs) doc.synthesisInputs![planID] = Object.fromEntries(map);
    for (const [planID, map] of this.synthesisManifests) doc.synthesisManifests![planID] = Object.fromEntries(map);
    // Phase 2G semantic validation (additive families).
    for (const [planID, map] of this.validationReports) doc.validationReports![planID] = Object.fromEntries(map);
    for (const [planID, map] of this.validationAdmissions) doc.validationAdmissions![planID] = Object.fromEntries(map);
    // Phase 2H finalization (additive families).
    for (const [planID, map] of this.evidenceAudits) doc.evidenceAudits![planID] = Object.fromEntries(map);
    for (const [planID, map] of this.finalPlanCandidates) doc.finalPlanCandidates![planID] = Object.fromEntries(map);
    // Phase 2I committed FinalPlans (additive family).
    for (const [planID, map] of this.finalPlans) doc.finalPlans![planID] = Object.fromEntries(map);
    // Phase 2J runtime handoff (additive families).
    for (const [planID, map] of this.executionHandoffs) doc.executionHandoffs![planID] = Object.fromEntries(map);
    for (const [planID, map] of this.handoffDeliveries) doc.handoffDeliveries![planID] = Object.fromEntries(map);
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
    this.synthesisInputs.clear();
    for (const [planID, family] of Object.entries(doc.synthesisInputs ?? {})) {
      this.synthesisInputs.set(
        planID as PlanID,
        new Map(Object.entries(family) as [import("../core/ids.js").SynthesisInputID, import("../synthesis/types.js").SynthesisInput][]),
      );
    }
    this.synthesisManifests.clear();
    for (const [planID, family] of Object.entries(doc.synthesisManifests ?? {})) {
      this.synthesisManifests.set(
        planID as PlanID,
        new Map(Object.entries(family) as [string, import("../synthesis/types.js").SynthesisManifest][]),
      );
    }
    this.validationReports.clear();
    for (const [planID, family] of Object.entries(doc.validationReports ?? {})) {
      this.validationReports.set(
        planID as PlanID,
        new Map(Object.entries(family) as [import("../core/ids.js").ValidationReportID, import("../validation/types.js").ValidationReport][]),
      );
    }
    this.validationAdmissions.clear();
    for (const [planID, family] of Object.entries(doc.validationAdmissions ?? {})) {
      this.validationAdmissions.set(
        planID as PlanID,
        new Map(Object.entries(family) as [string, import("../validation/types.js").SemanticValidationAdmission][]),
      );
    }
    this.evidenceAudits.clear();
    for (const [planID, family] of Object.entries(doc.evidenceAudits ?? {})) {
      this.evidenceAudits.set(
        planID as PlanID,
        new Map(Object.entries(family) as [import("../core/ids.js").EvidenceAuditID, import("../finalization/types.js").EvidenceAuditSnapshot][]),
      );
    }
    this.finalPlanCandidates.clear();
    for (const [planID, family] of Object.entries(doc.finalPlanCandidates ?? {})) {
      this.finalPlanCandidates.set(
        planID as PlanID,
        new Map(Object.entries(family) as [string, import("../finalization/types.js").FinalPlanCandidate][]),
      );
    }
    this.finalPlans.clear();
    for (const [planID, family] of Object.entries(doc.finalPlans ?? {})) {
      this.finalPlans.set(
        planID as PlanID,
        new Map(Object.entries(family) as [string, import("../core/types.js").FinalPlan][]),
      );
    }
    this.executionHandoffs.clear();
    for (const [planID, family] of Object.entries(doc.executionHandoffs ?? {})) {
      this.executionHandoffs.set(
        planID as PlanID,
        new Map(Object.entries(family) as [import("../core/ids.js").HandoffID, import("../handoff/types.js").ExecutionHandoff][]),
      );
    }
    this.handoffDeliveries.clear();
    for (const [planID, family] of Object.entries(doc.handoffDeliveries ?? {})) {
      this.handoffDeliveries.set(
        planID as PlanID,
        new Map(Object.entries(family) as [import("../core/ids.js").HandoffID, import("../handoff/types.js").HandoffDelivery][]),
      );
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

  // Phase 2E2: the workflow-focus transition revalidates the expected focus
  // INSIDE the lock (after rehydration) — a stale cross-instance transition
  // fails closed with stale_active_work, never last-writer-wins.
  override async transitionActiveWork(
    planID: Parameters<InMemoryPlanStore["transitionActiveWork"]>[0],
    expected: Parameters<InMemoryPlanStore["transitionActiveWork"]>[1],
    next: Parameters<InMemoryPlanStore["transitionActiveWork"]>[2],
  ) {
    return this.withLock(() => super.transitionActiveWork(planID, expected, next));
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

  // Phase 2F: derived-artifact writes go through the same locked durable
  // publication as every other mutation (no PlanCommit/HEAD involvement);
  // freeze/manifest revalidation then runs under the write lock after
  // rehydration, which makes cross-instance races serialize into ONE
  // canonical input / non-colliding manifest revisions (brief §55).
  override async freezeSynthesisInput(
    planID: Parameters<InMemoryPlanStore["freezeSynthesisInput"]>[0],
    payload: Parameters<InMemoryPlanStore["freezeSynthesisInput"]>[1],
  ) {
    return this.withLock(() => super.freezeSynthesisInput(planID, payload));
  }

  override async saveSynthesisManifest(
    planID: Parameters<InMemoryPlanStore["saveSynthesisManifest"]>[0],
    draft: Parameters<InMemoryPlanStore["saveSynthesisManifest"]>[1],
  ) {
    return this.withLock(() => super.saveSynthesisManifest(planID, draft));
  }

  // Phase 2G: report persistence and the single-flight admission all run under
  // the same locked durable publication — the admission registers/releases
  // under the lock (never held across the model call itself), and the report
  // save revalidates identity + anti-laundering in-lock after rehydration, so
  // two instances converge on ONE report (brief §30/§31/§64).
  override async saveValidationReport(
    planID: Parameters<InMemoryPlanStore["saveValidationReport"]>[0],
    report: Parameters<InMemoryPlanStore["saveValidationReport"]>[1],
  ): ReturnType<InMemoryPlanStore["saveValidationReport"]> {
    return this.withLock(() => super.saveValidationReport(planID, report));
  }

  override async admitSemanticValidation(
    planID: Parameters<InMemoryPlanStore["admitSemanticValidation"]>[0],
    identity: Parameters<InMemoryPlanStore["admitSemanticValidation"]>[1],
    options: Parameters<InMemoryPlanStore["admitSemanticValidation"]>[2],
  ): ReturnType<InMemoryPlanStore["admitSemanticValidation"]> {
    return this.withLock(() => super.admitSemanticValidation(planID, identity, options));
  }

  override async releaseSemanticValidation(
    planID: Parameters<InMemoryPlanStore["releaseSemanticValidation"]>[0],
    identityKey: Parameters<InMemoryPlanStore["releaseSemanticValidation"]>[1],
  ): Promise<void> {
    return this.withLock(() => super.releaseSemanticValidation(planID, identityKey));
  }

  // Phase 2H: the audit/candidate saves run under the same locked durable
  // publication — every §48/§49/§50/§68/§69 currency revalidation executes
  // in-lock AFTER rehydration, so a racing evidence write or live blocker
  // fails `finalization_stale` instead of freezing a diverged candidate.
  override async saveEvidenceAudit(
    planID: Parameters<InMemoryPlanStore["saveEvidenceAudit"]>[0],
    audit: Parameters<InMemoryPlanStore["saveEvidenceAudit"]>[1],
  ): ReturnType<InMemoryPlanStore["saveEvidenceAudit"]> {
    return this.withLock(() => super.saveEvidenceAudit(planID, audit));
  }

  override async saveFinalPlanCandidate(
    planID: Parameters<InMemoryPlanStore["saveFinalPlanCandidate"]>[0],
    candidate: Parameters<InMemoryPlanStore["saveFinalPlanCandidate"]>[1],
  ): ReturnType<InMemoryPlanStore["saveFinalPlanCandidate"]> {
    return this.withLock(() => super.saveFinalPlanCandidate(planID, candidate));
  }

  // -- Phase 2J runtime handoff mutations (locked + durable) -------------------
  // Every handoff workflow transition runs under the write lock AFTER
  // rehydration, so two instances converge on one dispatch admission and the
  // lifecycle completion preconditions bind to durable state (§119/§121). The
  // runtime adapter call itself happens OUTSIDE these locks (§40 — the
  // coordinator never holds the store lock across the host call).

  override async saveExecutionHandoff(
    planID: Parameters<InMemoryPlanStore["saveExecutionHandoff"]>[0],
    handoff: Parameters<InMemoryPlanStore["saveExecutionHandoff"]>[1],
  ): ReturnType<InMemoryPlanStore["saveExecutionHandoff"]> {
    return this.withLock(() => super.saveExecutionHandoff(planID, handoff));
  }

  override async prepareHandoffDelivery(
    planID: Parameters<InMemoryPlanStore["prepareHandoffDelivery"]>[0],
    input: Parameters<InMemoryPlanStore["prepareHandoffDelivery"]>[1],
  ): ReturnType<InMemoryPlanStore["prepareHandoffDelivery"]> {
    return this.withLock(() => super.prepareHandoffDelivery(planID, input));
  }

  override async beginHandoffDispatch(
    planID: Parameters<InMemoryPlanStore["beginHandoffDispatch"]>[0],
    handoffID: Parameters<InMemoryPlanStore["beginHandoffDispatch"]>[1],
  ): ReturnType<InMemoryPlanStore["beginHandoffDispatch"]> {
    return this.withLock(() => super.beginHandoffDispatch(planID, handoffID));
  }

  override async reclaimHandoffDispatch(
    planID: Parameters<InMemoryPlanStore["reclaimHandoffDispatch"]>[0],
    handoffID: Parameters<InMemoryPlanStore["reclaimHandoffDispatch"]>[1],
  ): ReturnType<InMemoryPlanStore["reclaimHandoffDispatch"]> {
    return this.withLock(() => super.reclaimHandoffDispatch(planID, handoffID));
  }

  override async recordHandoffDelivered(
    planID: Parameters<InMemoryPlanStore["recordHandoffDelivered"]>[0],
    handoffID: Parameters<InMemoryPlanStore["recordHandoffDelivered"]>[1],
    receipt: Parameters<InMemoryPlanStore["recordHandoffDelivered"]>[2],
  ): ReturnType<InMemoryPlanStore["recordHandoffDelivered"]> {
    return this.withLock(() => super.recordHandoffDelivered(planID, handoffID, receipt));
  }

  override async completeHandoffRun(
    planID: Parameters<InMemoryPlanStore["completeHandoffRun"]>[0],
  ): ReturnType<InMemoryPlanStore["completeHandoffRun"]> {
    return this.withLock(() => super.completeHandoffRun(planID));
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

  // -- Reads (lazy open + refresh-from-disk: allocation-critical reads must
  //    see the latest durable state across instances; suppressed in-lock) ----

  override async findActiveRunBySession(sessionID: string) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findActiveRunBySession(sessionID);
  }

  override async findLatestRunBySession(sessionID: string) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findLatestRunBySession(sessionID);
  }

  override async getRun(planID: Parameters<InMemoryPlanStore["getRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getRun(planID);
  }

  override async nextPlanSequence(): Promise<number> {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.nextPlanSequence();
  }

  override async listEvents(planID: Parameters<InMemoryPlanStore["listEvents"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listEvents(planID);
  }

  override async getHeadSnapshot(planID: Parameters<InMemoryPlanStore["getHeadSnapshot"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getHeadSnapshot(planID);
  }

  override async getArchitecture(planID: Parameters<InMemoryPlanStore["getArchitecture"]>[0], revision?: number) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getArchitecture(planID, revision);
  }

  override async getSection(planID: Parameters<InMemoryPlanStore["getSection"]>[0], sectionID: Parameters<InMemoryPlanStore["getSection"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getSection(planID, sectionID);
  }

  override async listSections(planID: Parameters<InMemoryPlanStore["listSections"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listSections(planID);
  }

  override async getSectionRevision(planID: Parameters<InMemoryPlanStore["getSectionRevision"]>[0], ref: Parameters<InMemoryPlanStore["getSectionRevision"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getSectionRevision(planID, ref);
  }

  override async getDecision(planID: Parameters<InMemoryPlanStore["getDecision"]>[0], ref: Parameters<InMemoryPlanStore["getDecision"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getDecision(planID, ref);
  }

  override async listDecisions(planID: Parameters<InMemoryPlanStore["listDecisions"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listDecisions(planID);
  }

  override async getProposal(planID: Parameters<InMemoryPlanStore["getProposal"]>[0], proposalID: Parameters<InMemoryPlanStore["getProposal"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getProposal(planID, proposalID);
  }

  override async getCommit(planID: Parameters<InMemoryPlanStore["getCommit"]>[0], commitID: Parameters<InMemoryPlanStore["getCommit"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getCommit(planID, commitID);
  }

  override async listCommits(planID: Parameters<InMemoryPlanStore["listCommits"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listCommits(planID);
  }

  override async listProposals(planID: Parameters<InMemoryPlanStore["listProposals"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listProposals(planID);
  }

  override async getApproval(planID: Parameters<InMemoryPlanStore["getApproval"]>[0], approvalID: Parameters<InMemoryPlanStore["getApproval"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getApproval(planID, approvalID);
  }

  override async findApprovalForProposal(planID: Parameters<InMemoryPlanStore["findApprovalForProposal"]>[0], proposalID: Parameters<InMemoryPlanStore["findApprovalForProposal"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findApprovalForProposal(planID, proposalID);
  }

  override async listApprovals(planID: Parameters<InMemoryPlanStore["listApprovals"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listApprovals(planID);
  }

  override async listEvidence(planID: Parameters<InMemoryPlanStore["listEvidence"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listEvidence(planID);
  }

  override async getEvidence(planID: Parameters<InMemoryPlanStore["getEvidence"]>[0], ref: Parameters<InMemoryPlanStore["getEvidence"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getEvidence(planID, ref);
  }

  // -- Phase 2F derived-artifact reads (refresh-from-disk: another instance's
  //    frozen input/manifest must be visible immediately) --------------------

  override async getSynthesisInput(planID: Parameters<InMemoryPlanStore["getSynthesisInput"]>[0], inputID: Parameters<InMemoryPlanStore["getSynthesisInput"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getSynthesisInput(planID, inputID);
  }

  override async listSynthesisInputs(planID: Parameters<InMemoryPlanStore["listSynthesisInputs"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listSynthesisInputs(planID);
  }

  override async getLatestSynthesisInput(planID: Parameters<InMemoryPlanStore["getLatestSynthesisInput"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getLatestSynthesisInput(planID);
  }

  override async getSynthesisManifest(
    planID: Parameters<InMemoryPlanStore["getSynthesisManifest"]>[0],
    manifestID: Parameters<InMemoryPlanStore["getSynthesisManifest"]>[1],
    revision?: Parameters<InMemoryPlanStore["getSynthesisManifest"]>[2],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getSynthesisManifest(planID, manifestID, revision);
  }

  override async getLatestSynthesisManifest(planID: Parameters<InMemoryPlanStore["getLatestSynthesisManifest"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getLatestSynthesisManifest(planID);
  }

  override async listSynthesisManifests(planID: Parameters<InMemoryPlanStore["listSynthesisManifests"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listSynthesisManifests(planID);
  }

  // -- Phase 2G semantic-validation reads (refresh-from-disk) -----------------

  override async getValidationReport(
    planID: Parameters<InMemoryPlanStore["getValidationReport"]>[0],
    reportID: Parameters<InMemoryPlanStore["getValidationReport"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getValidationReport(planID, reportID);
  }

  override async getCurrentValidationReport(planID: Parameters<InMemoryPlanStore["getCurrentValidationReport"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getCurrentValidationReport(planID);
  }

  override async listValidationReports(planID: Parameters<InMemoryPlanStore["listValidationReports"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listValidationReports(planID);
  }

  override async findValidationReportByIdentity(
    planID: Parameters<InMemoryPlanStore["findValidationReportByIdentity"]>[0],
    identity: Parameters<InMemoryPlanStore["findValidationReportByIdentity"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findValidationReportByIdentity(planID, identity);
  }

  override async getSemanticValidationAdmission(
    planID: Parameters<InMemoryPlanStore["getSemanticValidationAdmission"]>[0],
    identityKey: Parameters<InMemoryPlanStore["getSemanticValidationAdmission"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getSemanticValidationAdmission(planID, identityKey);
  }

  // -- Phase 2H finalization reads (refresh-from-disk) -------------------------

  override async getEvidenceAudit(
    planID: Parameters<InMemoryPlanStore["getEvidenceAudit"]>[0],
    auditID: Parameters<InMemoryPlanStore["getEvidenceAudit"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getEvidenceAudit(planID, auditID);
  }

  override async getCurrentEvidenceAudit(planID: Parameters<InMemoryPlanStore["getCurrentEvidenceAudit"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getCurrentEvidenceAudit(planID);
  }

  override async listEvidenceAudits(planID: Parameters<InMemoryPlanStore["listEvidenceAudits"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listEvidenceAudits(planID);
  }

  override async findEvidenceAuditByIdentity(
    planID: Parameters<InMemoryPlanStore["findEvidenceAuditByIdentity"]>[0],
    identity: Parameters<InMemoryPlanStore["findEvidenceAuditByIdentity"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findEvidenceAuditByIdentity(planID, identity);
  }

  override async getFinalPlanCandidate(
    planID: Parameters<InMemoryPlanStore["getFinalPlanCandidate"]>[0],
    candidateID: Parameters<InMemoryPlanStore["getFinalPlanCandidate"]>[1],
    revision?: Parameters<InMemoryPlanStore["getFinalPlanCandidate"]>[2],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getFinalPlanCandidate(planID, candidateID, revision);
  }

  override async getCurrentFinalPlanCandidate(planID: Parameters<InMemoryPlanStore["getCurrentFinalPlanCandidate"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getCurrentFinalPlanCandidate(planID);
  }

  override async listFinalPlanCandidates(planID: Parameters<InMemoryPlanStore["listFinalPlanCandidates"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listFinalPlanCandidates(planID);
  }

  override async findFinalPlanCandidateByIdentity(
    planID: Parameters<InMemoryPlanStore["findFinalPlanCandidateByIdentity"]>[0],
    identity: Parameters<InMemoryPlanStore["findFinalPlanCandidateByIdentity"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findFinalPlanCandidateByIdentity(planID, identity);
  }

  // -- Phase 2I committed-FinalPlan reads (refresh-from-disk) -----------------

  override async getFinalPlan(
    planID: Parameters<InMemoryPlanStore["getFinalPlan"]>[0],
    finalPlanID: Parameters<InMemoryPlanStore["getFinalPlan"]>[1],
    revision?: Parameters<InMemoryPlanStore["getFinalPlan"]>[2],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getFinalPlan(planID, finalPlanID, revision);
  }

  override async getCurrentFinalPlan(planID: Parameters<InMemoryPlanStore["getCurrentFinalPlan"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getCurrentFinalPlan(planID);
  }

  override async listFinalPlans(planID: Parameters<InMemoryPlanStore["listFinalPlans"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listFinalPlans(planID);
  }

  // -- Phase 2J runtime handoff reads (refresh-from-disk) ----------------------

  override async getExecutionHandoff(
    planID: Parameters<InMemoryPlanStore["getExecutionHandoff"]>[0],
    handoffID: Parameters<InMemoryPlanStore["getExecutionHandoff"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getExecutionHandoff(planID, handoffID);
  }

  override async findExecutionHandoffForPlan(planID: Parameters<InMemoryPlanStore["findExecutionHandoffForPlan"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findExecutionHandoffForPlan(planID);
  }

  override async getHandoffDelivery(planID: Parameters<InMemoryPlanStore["getHandoffDelivery"]>[0], handoffID: Parameters<InMemoryPlanStore["getHandoffDelivery"]>[1]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getHandoffDelivery(planID, handoffID);
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
