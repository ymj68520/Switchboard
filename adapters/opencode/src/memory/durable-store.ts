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
    // v0.2.0 Phase 1 ExecutionRun foundation (additive families).
    doc.executionRuns = Object.fromEntries(this.executionRuns);
    doc.executionRunByHandoffKey = Object.fromEntries(this.executionRunByHandoffKey);
    // v0.2.0 Phase 2 SupervisorBinding foundation (additive family).
    doc.supervisorBindings = Object.fromEntries(this.supervisorBindings);
    // v0.2.0 Phase 3 structural layer (additive families).
    doc.executionStages = Object.fromEntries(this.executionStages);
    doc.verificationWindows = Object.fromEntries(this.verificationWindows);
    // v0.2.0 Phase 4 worker protocol (additive families).
    doc.executionDirectives = Object.fromEntries(this.executionDirectives);
    doc.executionAttempts = Object.fromEntries(this.executionAttempts);
    doc.executionReports = Object.fromEntries(this.executionReports);
    doc.executionAttemptByDirective = Object.fromEntries(this.executionAttemptByDirective);
    // v0.2.0 Phase 5 acceptance layer (additive families).
    doc.supervisorAssessments = Object.fromEntries(this.supervisorAssessments);
    doc.executionCommits = Object.fromEntries(this.executionCommits);
    doc.executionCommitByWindow = Object.fromEntries(this.executionCommitByWindow);
    doc.executionCommitByAssessment = Object.fromEntries(this.executionCommitByAssessment);
    // v0.2.0 Phase 6A escalation control plane (additive families).
    doc.executionIssues = Object.fromEntries(this.executionIssues);
    doc.issueByExecutionRun = Object.fromEntries(this.issueByExecutionRun);
    doc.verificationConflicts = Object.fromEntries(this.verificationConflicts);
    doc.attemptReconciliations = Object.fromEntries(this.attemptReconciliations);
    doc.reconciliationByAttempt = Object.fromEntries(this.reconciliationByAttempt);
    // v0.2.0 Phase 6B final closure (additive families).
    doc.executionCompletions = Object.fromEntries(this.executionCompletions);
    doc.completionByExecutionRun = Object.fromEntries(this.completionByExecutionRun);
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
    this.executionRuns.clear();
    for (const [executionRunID, executionRun] of Object.entries(doc.executionRuns ?? {})) {
      this.executionRuns.set(executionRunID as import("../core/ids.js").ExecutionRunID, executionRun);
    }
    this.executionRunByHandoffKey.clear();
    for (const [indexKey, executionRunID] of Object.entries(doc.executionRunByHandoffKey ?? {})) {
      this.executionRunByHandoffKey.set(indexKey, executionRunID as import("../core/ids.js").ExecutionRunID);
    }
    this.supervisorBindings.clear();
    for (const [executionRunID, binding] of Object.entries(doc.supervisorBindings ?? {})) {
      this.supervisorBindings.set(executionRunID as import("../core/ids.js").ExecutionRunID, binding);
    }
    this.executionStages.clear();
    for (const [stageID, stage] of Object.entries(doc.executionStages ?? {})) {
      this.executionStages.set(stageID as import("../core/ids.js").ExecutionStageID, stage);
    }
    this.verificationWindows.clear();
    for (const [windowID, window] of Object.entries(doc.verificationWindows ?? {})) {
      this.verificationWindows.set(windowID as import("../core/ids.js").VerificationWindowID, window);
    }
    this.executionDirectives.clear();
    for (const [key, directive] of Object.entries(doc.executionDirectives ?? {})) {
      this.executionDirectives.set(key, directive);
    }
    this.executionAttempts.clear();
    for (const [attemptID, attempt] of Object.entries(doc.executionAttempts ?? {})) {
      this.executionAttempts.set(attemptID as import("../core/ids.js").ExecutionAttemptID, attempt);
    }
    this.executionReports.clear();
    for (const [reportID, report] of Object.entries(doc.executionReports ?? {})) {
      this.executionReports.set(reportID as import("../core/ids.js").ExecutionReportID, report);
    }
    this.executionAttemptByDirective.clear();
    for (const [indexKey, attemptID] of Object.entries(doc.executionAttemptByDirective ?? {})) {
      this.executionAttemptByDirective.set(indexKey, attemptID as import("../core/ids.js").ExecutionAttemptID);
    }
    this.supervisorAssessments.clear();
    for (const [assessmentID, assessment] of Object.entries(doc.supervisorAssessments ?? {})) {
      this.supervisorAssessments.set(assessmentID as import("../core/ids.js").SupervisorAssessmentID, assessment);
    }
    this.executionCommits.clear();
    for (const [commitID, commit] of Object.entries(doc.executionCommits ?? {})) {
      this.executionCommits.set(commitID as import("../core/ids.js").ExecutionCommitID, commit);
    }
    this.executionCommitByWindow.clear();
    for (const [windowID, commitID] of Object.entries(doc.executionCommitByWindow ?? {})) {
      this.executionCommitByWindow.set(windowID as import("../core/ids.js").VerificationWindowID, commitID as import("../core/ids.js").ExecutionCommitID);
    }
    this.executionCommitByAssessment.clear();
    for (const [assessmentID, commitID] of Object.entries(doc.executionCommitByAssessment ?? {})) {
      this.executionCommitByAssessment.set(assessmentID as import("../core/ids.js").SupervisorAssessmentID, commitID as import("../core/ids.js").ExecutionCommitID);
    }
    this.executionIssues.clear();
    for (const [issueID, issue] of Object.entries(doc.executionIssues ?? {})) {
      this.executionIssues.set(issueID as import("../core/ids.js").ExecutionIssueID, issue);
    }
    this.issueByExecutionRun.clear();
    for (const [executionRunID, issueID] of Object.entries(doc.issueByExecutionRun ?? {})) {
      this.issueByExecutionRun.set(executionRunID as import("../core/ids.js").ExecutionRunID, issueID as import("../core/ids.js").ExecutionIssueID);
    }
    this.verificationConflicts.clear();
    for (const [conflictID, conflict] of Object.entries(doc.verificationConflicts ?? {})) {
      this.verificationConflicts.set(conflictID as import("../core/ids.js").VerificationConflictID, conflict);
    }
    this.attemptReconciliations.clear();
    for (const [reconciliationID, reconciliation] of Object.entries(doc.attemptReconciliations ?? {})) {
      this.attemptReconciliations.set(reconciliationID as import("../core/ids.js").AttemptReconciliationID, reconciliation);
    }
    this.reconciliationByAttempt.clear();
    for (const [attemptID, reconciliationID] of Object.entries(doc.reconciliationByAttempt ?? {})) {
      this.reconciliationByAttempt.set(attemptID as import("../core/ids.js").ExecutionAttemptID, reconciliationID as import("../core/ids.js").AttemptReconciliationID);
    }
    this.executionCompletions.clear();
    for (const [completionID, record] of Object.entries(doc.executionCompletions ?? {})) {
      this.executionCompletions.set(completionID as import("../core/ids.js").ExecutionCompletionID, record);
    }
    this.completionByExecutionRun.clear();
    for (const [executionRunID, completionID] of Object.entries(doc.completionByExecutionRun ?? {})) {
      this.completionByExecutionRun.set(executionRunID as import("../core/ids.js").ExecutionRunID, completionID as import("../core/ids.js").ExecutionCompletionID);
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

  /** Phase 7B §15 — durable supervised handoff completion: under the write lock like every mutation. */
  override async completePlanningRunForSupervisedHandoff(
    planID: Parameters<InMemoryPlanStore["completePlanningRunForSupervisedHandoff"]>[0],
  ): ReturnType<InMemoryPlanStore["completePlanningRunForSupervisedHandoff"]> {
    return this.withLock(() => super.completePlanningRunForSupervisedHandoff(planID));
  }

  /** R1a §16: durable abort — under the write lock like every mutation. */
  override async abortRun(
    planID: Parameters<InMemoryPlanStore["abortRun"]>[0],
  ): ReturnType<InMemoryPlanStore["abortRun"]> {
    return this.withLock(() => super.abortRun(planID));
  }

  // -- v0.2.0 Phase 1 ExecutionRun mutations (locked + durable) ----------------
  // Every lifecycle transition and the initial-handoff preparation run under
  // the write lock AFTER rehydration, so concurrent/retried handoff
  // preparation converges on ONE run (the handoff-identity index is checked
  // against durable state in-lock) and every transition's CAS/bind checks
  // bind to durable state.

  override async prepareInitialExecutionRun(
    input: Parameters<InMemoryPlanStore["prepareInitialExecutionRun"]>[0],
  ): ReturnType<InMemoryPlanStore["prepareInitialExecutionRun"]> {
    return this.withLock(() => super.prepareInitialExecutionRun(input));
  }

  override async activateExecutionRun(
    executionRunID: Parameters<InMemoryPlanStore["activateExecutionRun"]>[0],
    expected: Parameters<InMemoryPlanStore["activateExecutionRun"]>[1],
  ): ReturnType<InMemoryPlanStore["activateExecutionRun"]> {
    return this.withLock(() => super.activateExecutionRun(executionRunID, expected));
  }

  // Phase 6A: the replan transition (issue + terminal lifecycle change) is ONE
  // locked durable mutation — a crash between the issue and the transition can
  // never be observed, and a retry short-circuits on the issue id.
  override async transitionExecutionRunToReplanRequired(
    input: Parameters<InMemoryPlanStore["transitionExecutionRunToReplanRequired"]>[0],
  ): ReturnType<InMemoryPlanStore["transitionExecutionRunToReplanRequired"]> {
    return this.withLock(() => super.transitionExecutionRunToReplanRequired(input));
  }

  // -- v0.2.0 Phase 6B final-closure mutations (locked + durable) --------------
  // Closure preparation (uniqueness race → ONE final_closure Stage) and the
  // ExecutionCompletionGate (record + terminal transition in one publication)
  // run under the write lock AFTER rehydration.

  override async prepareFinalClosureStage(
    input: Parameters<InMemoryPlanStore["prepareFinalClosureStage"]>[0],
  ): ReturnType<InMemoryPlanStore["prepareFinalClosureStage"]> {
    return this.withLock(() => super.prepareFinalClosureStage(input));
  }

  override async completeExecutionRunThroughGate(
    input: Parameters<InMemoryPlanStore["completeExecutionRunThroughGate"]>[0],
  ): ReturnType<InMemoryPlanStore["completeExecutionRunThroughGate"]> {
    return this.withLock(() => super.completeExecutionRunThroughGate(input));
  }

  override async abortExecutionRun(
    executionRunID: Parameters<InMemoryPlanStore["abortExecutionRun"]>[0],
    expected: Parameters<InMemoryPlanStore["abortExecutionRun"]>[1],
  ): ReturnType<InMemoryPlanStore["abortExecutionRun"]> {
    return this.withLock(() => super.abortExecutionRun(executionRunID, expected));
  }

  // -- v0.2.0 Phase 2 SupervisorBinding mutations (locked + durable) -----------
  // Attach/detach/takeover and supervised activation run under the write lock
  // AFTER rehydration, so concurrent attach/takeover attempts on one backing
  // document serialize into ONE current writable owner and every fencing CAS
  // binds to durable state (directive §28).

  override async attachExecutionSupervisor(
    input: Parameters<InMemoryPlanStore["attachExecutionSupervisor"]>[0],
  ): ReturnType<InMemoryPlanStore["attachExecutionSupervisor"]> {
    return this.withLock(() => super.attachExecutionSupervisor(input));
  }

  override async detachExecutionSupervisor(
    input: Parameters<InMemoryPlanStore["detachExecutionSupervisor"]>[0],
  ): ReturnType<InMemoryPlanStore["detachExecutionSupervisor"]> {
    return this.withLock(() => super.detachExecutionSupervisor(input));
  }

  override async takeoverExecutionSupervisor(
    input: Parameters<InMemoryPlanStore["takeoverExecutionSupervisor"]>[0],
  ): ReturnType<InMemoryPlanStore["takeoverExecutionSupervisor"]> {
    return this.withLock(() => super.takeoverExecutionSupervisor(input));
  }

  override async authorizeExecutionSupervisor(
    executionRunID: Parameters<InMemoryPlanStore["authorizeExecutionSupervisor"]>[0],
    authority: Parameters<InMemoryPlanStore["authorizeExecutionSupervisor"]>[1],
  ): ReturnType<InMemoryPlanStore["authorizeExecutionSupervisor"]> {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.authorizeExecutionSupervisor(executionRunID, authority);
  }

  override async activateSupervisedExecutionRun(
    input: Parameters<InMemoryPlanStore["activateSupervisedExecutionRun"]>[0],
  ): ReturnType<InMemoryPlanStore["activateSupervisedExecutionRun"]> {
    return this.withLock(() => super.activateSupervisedExecutionRun(input));
  }

  // -- v0.2.0 Phase 3 structural-layer mutations (locked + durable) ------------
  // Stage creation/activation/supersession, window opening, and candidate
  // advancement run under the write lock AFTER rehydration, so concurrent
  // Stage activations and Window openings on one backing document serialize
  // into at most one active Stage / one open Window (directive §46/§49).

  override async createExecutionStages(
    input: Parameters<InMemoryPlanStore["createExecutionStages"]>[0],
  ): ReturnType<InMemoryPlanStore["createExecutionStages"]> {
    return this.withLock(() => super.createExecutionStages(input));
  }

  override async activateExecutionStage(
    input: Parameters<InMemoryPlanStore["activateExecutionStage"]>[0],
  ): ReturnType<InMemoryPlanStore["activateExecutionStage"]> {
    return this.withLock(() => super.activateExecutionStage(input));
  }

  override async supersedeExecutionStage(
    input: Parameters<InMemoryPlanStore["supersedeExecutionStage"]>[0],
  ): ReturnType<InMemoryPlanStore["supersedeExecutionStage"]> {
    return this.withLock(() => super.supersedeExecutionStage(input));
  }

  override async openVerificationWindow(
    input: Parameters<InMemoryPlanStore["openVerificationWindow"]>[0],
  ): ReturnType<InMemoryPlanStore["openVerificationWindow"]> {
    return this.withLock(() => super.openVerificationWindow(input));
  }

  override async advanceCandidateRevision(
    input: Parameters<InMemoryPlanStore["advanceCandidateRevision"]>[0],
  ): ReturnType<InMemoryPlanStore["advanceCandidateRevision"]> {
    return this.withLock(() => super.advanceCandidateRevision(input));
  }

  // -- v0.2.0 Phase 4 worker-protocol mutations (locked + durable) -------------
  // Issuance/start/indeterminate/submit all run under the write lock AFTER
  // rehydration, so concurrent attempt starts and concurrent report
  // submissions on one backing document serialize into ONE winner with the
  // candidate advance atomic inside the report transaction (directive
  // sections 65-67).

  override async issueExecutionDirective(
    input: Parameters<InMemoryPlanStore["issueExecutionDirective"]>[0],
  ): ReturnType<InMemoryPlanStore["issueExecutionDirective"]> {
    return this.withLock(() => super.issueExecutionDirective(input));
  }

  override async startExecutionAttempt(
    input: Parameters<InMemoryPlanStore["startExecutionAttempt"]>[0],
  ): ReturnType<InMemoryPlanStore["startExecutionAttempt"]> {
    return this.withLock(() => super.startExecutionAttempt(input));
  }

  override async markExecutionAttemptIndeterminate(
    input: Parameters<InMemoryPlanStore["markExecutionAttemptIndeterminate"]>[0],
  ): ReturnType<InMemoryPlanStore["markExecutionAttemptIndeterminate"]> {
    return this.withLock(() => super.markExecutionAttemptIndeterminate(input));
  }

  override async submitExecutionReport(
    input: Parameters<InMemoryPlanStore["submitExecutionReport"]>[0],
  ): ReturnType<InMemoryPlanStore["submitExecutionReport"]> {
    return this.withLock(() => super.submitExecutionReport(input));
  }

  // -- v0.2.0 Phase 5 acceptance mutations (locked + durable) ------------------
  // The accept transaction runs under the write lock AFTER rehydration, so
  // two instances racing to accept the SAME window serialize into exactly
  // ONE ExecutionCommit with the loser failing closed (directive SS75).

  override async submitSupervisorAssessment(
    input: Parameters<InMemoryPlanStore["submitSupervisorAssessment"]>[0],
  ): ReturnType<InMemoryPlanStore["submitSupervisorAssessment"]> {
    return this.withLock(() => super.submitSupervisorAssessment(input));
  }

  // -- v0.2.0 Phase 6A escalation mutations (locked + durable) -----------------
  // Conflict creation and reconciliation recording run under the write lock
  // AFTER rehydration, so two instances racing to create the same conflict or
  // resolve the same unresolved set serialize into ONE winner with a
  // deterministic stale/already-reconciled loser error (§57).

  override async createVerificationConflict(
    input: Parameters<InMemoryPlanStore["createVerificationConflict"]>[0],
  ): ReturnType<InMemoryPlanStore["createVerificationConflict"]> {
    return this.withLock(() => super.createVerificationConflict(input));
  }

  override async recordAttemptReconciliation(
    input: Parameters<InMemoryPlanStore["recordAttemptReconciliation"]>[0],
  ): ReturnType<InMemoryPlanStore["recordAttemptReconciliation"]> {
    return this.withLock(() => super.recordAttemptReconciliation(input));
  }

  /** TEST/FIXTURE ONLY (see base class). Wrapped so seeding is durable. */
  override seedExecutionStages(
    executionRunID: Parameters<InMemoryPlanStore["seedExecutionStages"]>[0],
    stages: Parameters<InMemoryPlanStore["seedExecutionStages"]>[1],
  ): void {
    void executionRunID;
    void stages;
    throw new UltraPlanError(
      "store_busy",
      "seedExecutionStages is synchronous on the base class; use seedExecutionStagesAsync on DurablePlanStore",
    );
  }

  /** Durable variant of the test-only seeding seam. */
  async seedExecutionStagesAsync(
    executionRunID: Parameters<InMemoryPlanStore["seedExecutionStages"]>[0],
    stages: Parameters<InMemoryPlanStore["seedExecutionStages"]>[1],
  ): Promise<void> {
    await this.withLock(async () => {
      super.seedExecutionStages(executionRunID, stages);
    });
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

  // -- v0.2.0 Phase 1 ExecutionRun reads (refresh-from-disk: recovery and
  //    handoff-identity lookups must see another instance's prepared run) ----

  override async getExecutionRun(executionRunID: Parameters<InMemoryPlanStore["getExecutionRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getExecutionRun(executionRunID);
  }

  override async findInitialExecutionRun(
    planID: Parameters<InMemoryPlanStore["findInitialExecutionRun"]>[0],
    initialHandoffKey: Parameters<InMemoryPlanStore["findInitialExecutionRun"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findInitialExecutionRun(planID, initialHandoffKey);
  }

  override async listExecutionRunsForPlan(planID: Parameters<InMemoryPlanStore["listExecutionRunsForPlan"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listExecutionRunsForPlan(planID);
  }

  override async listExecutionRunsForFinalPlan(
    planID: Parameters<InMemoryPlanStore["listExecutionRunsForFinalPlan"]>[0],
    ref: Parameters<InMemoryPlanStore["listExecutionRunsForFinalPlan"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listExecutionRunsForFinalPlan(planID, ref);
  }

  override async listRecoverableExecutionRuns(
    workspace: Parameters<InMemoryPlanStore["listRecoverableExecutionRuns"]>[0],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listRecoverableExecutionRuns(workspace);
  }

  // -- Phase 7B supervised handoff recovery reads (refresh-from-disk) --------

  override async findExecutionRunsForPlan(planID: Parameters<InMemoryPlanStore["findExecutionRunsForPlan"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findExecutionRunsForPlan(planID);
  }

  // -- v0.2.0 Phase 2 SupervisorBinding / recovery reads (refresh-from-disk) --

  override async findSupervisorBinding(executionRunID: Parameters<InMemoryPlanStore["findSupervisorBinding"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findSupervisorBinding(executionRunID);
  }

  override async listOpenExecutionRuns() {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listOpenExecutionRuns();
  }

  override async buildExecutionRecoveryContext(
    executionRunID: Parameters<InMemoryPlanStore["buildExecutionRecoveryContext"]>[0],
    viewer: Parameters<InMemoryPlanStore["buildExecutionRecoveryContext"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.buildExecutionRecoveryContext(executionRunID, viewer);
  }

  // -- v0.2.0 Phase 3 structural-layer reads (refresh-from-disk) --------------

  override async getExecutionStage(stageID: Parameters<InMemoryPlanStore["getExecutionStage"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getExecutionStage(stageID);
  }

  override async listExecutionStagesForRun(executionRunID: Parameters<InMemoryPlanStore["listExecutionStagesForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listExecutionStagesForRun(executionRunID);
  }

  override async getVerificationWindow(windowID: Parameters<InMemoryPlanStore["getVerificationWindow"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getVerificationWindow(windowID);
  }

  override async listVerificationWindowsForRun(executionRunID: Parameters<InMemoryPlanStore["listVerificationWindowsForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listVerificationWindowsForRun(executionRunID);
  }

  override async findOpenVerificationWindow(executionRunID: Parameters<InMemoryPlanStore["findOpenVerificationWindow"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findOpenVerificationWindow(executionRunID);
  }

  // -- v0.2.0 Phase 4 worker-protocol reads (refresh-from-disk) ----------------

  override async getExecutionDirective(
    directiveID: Parameters<InMemoryPlanStore["getExecutionDirective"]>[0],
    revision?: Parameters<InMemoryPlanStore["getExecutionDirective"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getExecutionDirective(directiveID, revision);
  }

  override async listExecutionDirectivesForRun(executionRunID: Parameters<InMemoryPlanStore["listExecutionDirectivesForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listExecutionDirectivesForRun(executionRunID);
  }

  override async getExecutionAttempt(attemptID: Parameters<InMemoryPlanStore["getExecutionAttempt"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getExecutionAttempt(attemptID);
  }

  override async findExecutionAttemptForDirective(
    executionRunID: Parameters<InMemoryPlanStore["findExecutionAttemptForDirective"]>[0],
    directive: Parameters<InMemoryPlanStore["findExecutionAttemptForDirective"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findExecutionAttemptForDirective(executionRunID, directive);
  }

  override async findRunningExecutionAttempt(executionRunID: Parameters<InMemoryPlanStore["findRunningExecutionAttempt"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findRunningExecutionAttempt(executionRunID);
  }

  override async listExecutionAttemptsForRun(executionRunID: Parameters<InMemoryPlanStore["listExecutionAttemptsForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listExecutionAttemptsForRun(executionRunID);
  }

  override async getExecutionReport(reportID: Parameters<InMemoryPlanStore["getExecutionReport"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getExecutionReport(reportID);
  }

  override async findExecutionReportForAttempt(attemptID: Parameters<InMemoryPlanStore["findExecutionReportForAttempt"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findExecutionReportForAttempt(attemptID);
  }

  override async listExecutionReportsForRun(executionRunID: Parameters<InMemoryPlanStore["listExecutionReportsForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listExecutionReportsForRun(executionRunID);
  }

  // -- v0.2.0 Phase 5 acceptance reads (refresh-from-disk) ---------------------

  override async getSupervisorAssessment(assessmentID: Parameters<InMemoryPlanStore["getSupervisorAssessment"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getSupervisorAssessment(assessmentID);
  }

  override async listSupervisorAssessmentsForRun(executionRunID: Parameters<InMemoryPlanStore["listSupervisorAssessmentsForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listSupervisorAssessmentsForRun(executionRunID);
  }

  override async getExecutionCommit(commitID: Parameters<InMemoryPlanStore["getExecutionCommit"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getExecutionCommit(commitID);
  }

  override async findAcceptedHeadCommit(executionRunID: Parameters<InMemoryPlanStore["findAcceptedHeadCommit"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findAcceptedHeadCommit(executionRunID);
  }

  override async findExecutionCommitForWindow(windowID: Parameters<InMemoryPlanStore["findExecutionCommitForWindow"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findExecutionCommitForWindow(windowID);
  }

  override async listExecutionCommitsForRun(executionRunID: Parameters<InMemoryPlanStore["listExecutionCommitsForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listExecutionCommitsForRun(executionRunID);
  }

  override async acceptedStageObligations(
    executionRunID: Parameters<InMemoryPlanStore["acceptedStageObligations"]>[0],
    stageID: Parameters<InMemoryPlanStore["acceptedStageObligations"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.acceptedStageObligations(executionRunID, stageID);
  }

  // -- v0.2.0 Phase 6A escalation reads (refresh-from-disk) --------------------

  override async getExecutionIssue(issueID: Parameters<InMemoryPlanStore["getExecutionIssue"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getExecutionIssue(issueID);
  }

  override async findExecutionIssueForRun(executionRunID: Parameters<InMemoryPlanStore["findExecutionIssueForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findExecutionIssueForRun(executionRunID);
  }

  override async buildExecutionIssueReplanContext(issueID: Parameters<InMemoryPlanStore["buildExecutionIssueReplanContext"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.buildExecutionIssueReplanContext(issueID);
  }

  override async getVerificationConflict(conflictID: Parameters<InMemoryPlanStore["getVerificationConflict"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getVerificationConflict(conflictID);
  }

  override async listVerificationConflictsForRun(executionRunID: Parameters<InMemoryPlanStore["listVerificationConflictsForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listVerificationConflictsForRun(executionRunID);
  }

  override async unresolvedIndeterminateAttempts(
    executionRunID: Parameters<InMemoryPlanStore["unresolvedIndeterminateAttempts"]>[0],
    windowID: Parameters<InMemoryPlanStore["unresolvedIndeterminateAttempts"]>[1],
  ) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.unresolvedIndeterminateAttempts(executionRunID, windowID);
  }

  override async getAttemptReconciliation(reconciliationID: Parameters<InMemoryPlanStore["getAttemptReconciliation"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getAttemptReconciliation(reconciliationID);
  }

  override async listAttemptReconciliationsForRun(executionRunID: Parameters<InMemoryPlanStore["listAttemptReconciliationsForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.listAttemptReconciliationsForRun(executionRunID);
  }

  // -- v0.2.0 Phase 6B final-closure reads (refresh-from-disk) ------------------

  override async isExecutionReadyForFinalClosure(executionRunID: Parameters<InMemoryPlanStore["isExecutionReadyForFinalClosure"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.isExecutionReadyForFinalClosure(executionRunID);
  }

  override async getExecutionCompletion(completionID: Parameters<InMemoryPlanStore["getExecutionCompletion"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.getExecutionCompletion(completionID);
  }

  override async findExecutionCompletionForRun(executionRunID: Parameters<InMemoryPlanStore["findExecutionCompletionForRun"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.findExecutionCompletionForRun(executionRunID);
  }

  /**
   * R2 brief §5 — the snapshot-consistent context read boundary: ONE refresh
   * of the atomically-published document, then every family read comes from
   * that single hydrated state (the per-read refreshes of the ordinary read
   * API are deliberately NOT used here, so a concurrent PlanCommit can never
   * split one assembly across two HEADs). No writer lock is held.
   */
  override async capturePlanningContextState(planID: Parameters<InMemoryPlanStore["capturePlanningContextState"]>[0]) {
    await this.ensureOpen();
    this.refreshFromDisk();
    return super.capturePlanningContextState(planID);
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
