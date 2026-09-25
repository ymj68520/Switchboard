/**
 * Evidence Audit construction (Phase 2H brief §6-§17) — deterministic
 * assembly from the store; NO model call anywhere.
 *
 * REACHABILITY (brief §7): exactly the relationships the domain represents —
 *   HEAD snapshot → approved design anchors (exact Architecture revision via
 *   `basedOn`, exact approved SectionRevisions via their `decisions` lists,
 *   and the snapshot's own committed-decision bindings) → exact Decision
 *   revisions → their `evidence` refs. The repository is never scanned;
 *   Evidence never cited by a reachable committed Decision is ignored.
 *
 * EXACT REVISIONS (brief §8): a pinned ref (EVD-017@2) is audited at @2 —
 * never silently rebased to a newer revision. An unpinned ref resolves to the
 * record's current newest revision (the domain's own resolution rule, the
 * same one the SynthesisInput freeze used). When a referenced revision is not
 * the record's newest, the entry reports `latestRevision` and flags
 * `evidence_revision_mismatch` — fail-closed, never a silent rebase.
 *
 * SYNTHESIS-vs-CURRENT (brief §9): the audit cross-checks every Evidence
 * state frozen into the SynthesisInput against the record's CURRENT newest
 * revision. Any material difference is recorded as
 * `synthesis_evidence_stale`; the GATE (not the audit) classifies it as a
 * STALE finalization rather than a semantic blocker (brief §28).
 *
 * One entry per evidence record: when several reachable decisions cite the
 * same record, the first citation in canonical decision order resolves the
 * audited revision (identical to the freeze-time rule) and every citation is
 * preserved in `reachableFrom` (brief §67: deduplicated, reasons preserved).
 */
import type { PlanStore } from "../memory/store.js";
import type { Snapshot } from "../memory/snapshots.js";
import { UltraPlanError } from "../core/errors.js";
import type { DecisionRef, EvidenceRef, Timestamp } from "../core/refs.js";
import type { EvidenceAuditID, PlanID } from "../core/ids.js";
import { DecisionIDs, EvidenceIDs } from "../core/ids.js";
import type { Decision, SectionRevision, Architecture } from "../core/types.js";
import type { Evidence } from "../repository/evidence.js";
import type { FrozenEvidenceState, SynthesisInput, SynthesisManifest } from "../synthesis/types.js";
import type { ValidationReport } from "../validation/types.js";
import {
  computeEvidenceAuditHash,
  computeEvidenceStateHash,
  evidenceFingerprintInputs,
} from "./hash.js";
import {
  EVIDENCE_AUDIT_BLOCKER_CODES,
  type EvidenceAuditBlocker,
  type EvidenceAuditBlockerCode,
  type EvidenceAuditCounts,
  type EvidenceAuditEntry,
  type EvidenceAuditSnapshot,
  type EvidenceReachability,
  type EvidenceReachabilityAnchor,
} from "./types.js";

/** One resolved reachable evidence citation. */
export interface CollectedEvidence {
  evidence: Evidence;
  /** The exact revision the approving design references (pinned) or resolves to (unpinned). */
  referencedRevision: number;
  /** The record's current newest revision (>= referencedRevision). */
  latestRevision: number;
  reachableFrom: EvidenceReachability[];
}

/** A reachable decision citation that does NOT resolve — fail-closed input for evidence_missing. */
export interface MissingEvidenceCitation {
  ref: EvidenceRef;
  decision: DecisionRef;
}

export interface CollectedReachableEvidence {
  entries: CollectedEvidence[];
  missing: MissingEvidenceCitation[];
}

/**
 * The store-independent inputs of the reachability traversal: the design
 * anchors and the exact committed Decision records HEAD binds. The ASYNC
 * store path resolves them through the PlanStore boundary; the transaction
 * engine (Phase 2I) resolves the identical records synchronously from its
 * registries — the engine must never await inside its atomic section.
 */
export interface ReachabilityRecords {
  architecture: Architecture | undefined;
  /** Exact approved SectionRevision records for the snapshot roots, canonical order. */
  sectionRevisions: SectionRevision[];
  /** Exact Decision records HEAD binds, canonical (id-sorted) order. */
  decisions: Decision[];
}

/** Per-(ref-key) resolution handed to the pure traversal core. */
export interface ResolvedEvidenceCitation {
  evidence?: Evidence;
  latestRevision?: number;
}

/**
 * The PURE sync traversal core (brief §7/§8/§67): anchors from the exact
 * Architecture `basedOn` + approved SectionRevision `decisions` + the HEAD
 * snapshot's own decision bindings; decisions in canonical id order; pinned
 * refs audited at their exact revision, unpinned at the record's current
 * newest; deduplicated by record id with EVERY citation path preserved.
 * `resolve(ref)` returns `{ evidence, latestRevision }` or an unresolved
 * marker for a missing citation.
 */
export function collectReachableEvidenceFrom(
  records: ReachabilityRecords,
  snapshot: Snapshot,
  resolve: (ref: EvidenceRef) => ResolvedEvidenceCitation,
): CollectedReachableEvidence {
  const anchorByDecision = new Map<string, EvidenceReachabilityAnchor[]>();
  const addAnchor = (decisionID: string, anchor: EvidenceReachabilityAnchor): void => {
    const list = anchorByDecision.get(decisionID);
    if (list) list.push(anchor);
    else anchorByDecision.set(decisionID, [anchor]);
  };
  if (records.architecture) {
    for (const decisionID of records.architecture.basedOn) addAnchor(decisionID, { kind: "architecture" });
  }
  for (const revision of records.sectionRevisions) {
    for (const decisionID of revision.decisions) {
      addAnchor(decisionID, { kind: "section", id: revision.sectionID, revision: revision.revision });
    }
  }

  const byId = new Map<string, CollectedEvidence>();
  const missing: MissingEvidenceCitation[] = [];

  for (const decision of records.decisions) {
    const anchors: EvidenceReachabilityAnchor[] = anchorByDecision.get(decision.id) ?? [{ kind: "head_snapshot" }];
    for (const ref of decision.evidence ?? []) {
      const resolved = resolve(ref);
      if (!resolved || !resolved.evidence) {
        missing.push({ ref, decision: { id: decision.id, revision: decision.revision } });
        continue;
      }
      const evidence = resolved.evidence;
      const existing = byId.get(evidence.id);
      if (existing) {
        // Duplicate reachability: preserve every citation path (brief §67).
        if (
          !existing.reachableFrom.some(
            (r) => r.decision.id === decision.id && r.decision.revision === decision.revision,
          )
        ) {
          existing.reachableFrom.push({ decision: { id: decision.id, revision: decision.revision }, anchors });
        }
        continue;
      }
      byId.set(evidence.id, {
        evidence,
        referencedRevision: evidence.revision,
        latestRevision: resolved.latestRevision ?? evidence.revision,
        reachableFrom: [{ decision: { id: decision.id, revision: decision.revision }, anchors }],
      });
    }
  }

  return { entries: [...byId.values()], missing };
}

/** Resolve the traversal's store-bound records through the async PlanStore boundary. */
export async function resolveReachabilityRecords(
  store: PlanStore,
  planID: PlanID,
  snapshot: Snapshot,
): Promise<ReachabilityRecords> {
  const architecture =
    snapshot.state.architectureRevision !== undefined
      ? ((await store.getArchitecture(planID, snapshot.state.architectureRevision)) ?? undefined)
      : undefined;
  const sectionRevisions: SectionRevision[] = [];
  for (const root of snapshot.state.sectionRoots ?? []) {
    if (root.approvedRevision === undefined) continue;
    const revision = await store.getSectionRevision(planID, { id: root.id, revision: root.approvedRevision });
    if (revision) sectionRevisions.push(revision);
  }
  const decisions: Decision[] = [];
  for (const entry of Object.entries(snapshot.state.decisionRevisions)) {
    const [rawID, revision] = entry;
    const decision = await store.getDecision(planID, { id: DecisionIDs.cast(rawID), revision });
    if (decision) decisions.push(decision);
  }
  decisions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { architecture, sectionRevisions, decisions };
}

/** Citation-ref key for eager resolution maps. */
function evidenceRefKey(ref: EvidenceRef): string {
  return ref.revision !== undefined ? `${ref.id}@${ref.revision}` : `${ref.id}@latest`;
}

/**
 * Traverse the CURRENT approved design (exact HEAD snapshot) and collect every
 * structurally reachable Evidence record with its reachability reasons.
 * Deterministic: canonical decision order (by id), canonical anchor order.
 */
export async function collectReachableEvidence(
  store: PlanStore,
  planID: PlanID,
  snapshot: Snapshot,
): Promise<CollectedReachableEvidence> {
  const records = await resolveReachabilityRecords(store, planID, snapshot);
  // Eagerly resolve every DISTINCT citation ref (canonical decision order), so
  // the pure core above runs unchanged over the async store boundary.
  const resolved = new Map<string, ResolvedEvidenceCitation>();
  for (const decision of records.decisions) {
    for (const ref of decision.evidence ?? []) {
      const key = evidenceRefKey(ref);
      if (resolved.has(key)) continue;
      const evidence = await store.getEvidence(planID, ref);
      if (!evidence) {
        resolved.set(key, {});
        continue;
      }
      const latest = await store.getEvidence(planID, { id: evidence.id });
      resolved.set(key, { evidence, latestRevision: latest?.revision ?? evidence.revision });
    }
  }
  return collectReachableEvidenceFrom(records, snapshot, (ref) => resolved.get(evidenceRefKey(ref)) ?? {});
}

/** Per-entry rule outcome (brief §11). Informational never flags; exactness applies to all. */
export function evaluateEvidenceEntryRules(entry: CollectedEvidence): {
  verdict: "pass" | "flagged";
  blockers: EvidenceAuditBlockerCode[];
} {
  const blockers: EvidenceAuditBlockerCode[] = [];
  const { evidence } = entry;
  if (evidence.status === "invalidated") blockers.push("evidence_invalidated");
  else if (evidence.status === "stale") blockers.push("evidence_stale");
  else if (evidence.freshness !== "fresh") {
    if (evidence.criticality === "critical") blockers.push("critical_not_fresh");
    else if (evidence.criticality === "supporting") blockers.push("supporting_needs_validation");
  }
  if (evidence.criticality === "critical" && evidence.confidence === "uncertain") blockers.push("critical_uncertain");
  if (entry.referencedRevision !== entry.latestRevision) blockers.push("evidence_revision_mismatch");
  return { verdict: blockers.length > 0 ? "flagged" : "pass", blockers };
}

/**
 * Build the audit ENTRIES (rules + fingerprint inputs, brief §10/§11) from the
 * collected traversal. Entries carry everything the evidenceStateHash covers.
 */
export function buildAuditEntries(collected: CollectedReachableEvidence): EvidenceAuditEntry[] {
  return collected.entries.map((item) => {
    const evaluated = evaluateEvidenceEntryRules(item);
    return {
      ref: { id: EvidenceIDs.cast(item.evidence.id), revision: item.referencedRevision },
      latestRevision: item.latestRevision,
      confidence: item.evidence.confidence,
      criticality: item.evidence.criticality,
      freshness: item.evidence.freshness,
      status: item.evidence.status,
      ...evidenceFingerprintInputs(item.evidence),
      reachableFrom: item.reachableFrom,
      verdict: evaluated.verdict,
      blockers: evaluated.blockers,
    };
  });
}

/**
 * Recompute the reachable Evidence state fingerprint from the CURRENT store
 * (brief §10/§26) without building a full audit — the currency re-check used
 * by the gate's callers and the store's candidate-save revalidation (§48).
 */
export async function computeCurrentEvidenceStateHash(
  store: PlanStore,
  planID: PlanID,
  snapshot: Snapshot,
): Promise<{ hash: string; collected: CollectedReachableEvidence; entries: EvidenceAuditEntry[] }> {
  const collected = await collectReachableEvidence(store, planID, snapshot);
  const entries = buildAuditEntries(collected);
  return { hash: computeEvidenceStateHash(entries), collected, entries };
}

/**
 * Synchronous fingerprint recompute over an ALREADY-RESOLVED traversal — the
 * transaction engine's second-gate path (Phase 2I §25/§26), which must recheck
 * the evidence term inside its atomic section without awaiting. Callers build
 * `records` from their own registries and resolve citations synchronously; the
 * entry rules and hash inputs are the exact same pure functions the async path
 * uses (no second mapping to drift).
 */
export function computeEvidenceStateHashFromRecords(
  records: ReachabilityRecords,
  snapshot: Snapshot,
  resolve: (ref: EvidenceRef) => ResolvedEvidenceCitation,
): { hash: string; collected: CollectedReachableEvidence; entries: EvidenceAuditEntry[] } {
  const collected = collectReachableEvidenceFrom(records, snapshot, resolve);
  const entries = buildAuditEntries(collected);
  return { hash: computeEvidenceStateHash(entries), collected, entries };
}

/** Diagnostic tallies over the audited entries (brief §14). Deterministic; re-verified on load. */
export function computeEvidenceAuditCounts(entries: readonly EvidenceAuditEntry[]): EvidenceAuditCounts {
  const counts: EvidenceAuditCounts = {
    freshCritical: 0,
    freshSupporting: 0,
    informational: 0,
    needsValidation: 0,
    stale: 0,
    invalidated: 0,
    criticalUncertain: 0,
  };
  for (const entry of entries) {
    if (entry.freshness === "needs_validation") counts.needsValidation++;
    if (entry.freshness === "stale" || entry.status === "stale") counts.stale++;
    if (entry.status === "invalidated") counts.invalidated++;
    switch (entry.criticality) {
      case "informational":
        counts.informational++;
        break;
      case "critical":
        if (entry.confidence === "uncertain") counts.criticalUncertain++;
        if (entry.status === "active" && entry.freshness === "fresh" && entry.confidence !== "uncertain") {
          counts.freshCritical++;
        }
        break;
      case "supporting":
        if (entry.status === "active" && entry.freshness === "fresh") counts.freshSupporting++;
        break;
    }
  }
  return counts;
}

/**
 * Build (not persist) the EvidenceAuditSnapshot for the exact current
 * authoritative state. The caller assigns id/createdAt via `assign`; the
 * store's save method revalidates everything under the lock (brief §48).
 */
export async function buildEvidenceAudit(
  store: PlanStore,
  deps: {
    planID: PlanID;
    snapshot: Snapshot;
    input: SynthesisInput;
    manifest: SynthesisManifest;
    report: ValidationReport;
  },
  assign: { id: EvidenceAuditID; now: Timestamp },
): Promise<EvidenceAuditSnapshot> {
  const { planID, snapshot, input, manifest, report } = deps;
  const { hash: evidenceStateHash, collected } = await computeCurrentEvidenceStateHash(store, planID, snapshot);
  const entries = buildAuditEntries(collected);

  const blockers: EvidenceAuditBlocker[] = [];
  for (const entry of entries) {
    for (const code of entry.blockers) {
      blockers.push(
        code === "evidence_revision_mismatch"
          ? {
              code,
              evidence: { id: entry.ref.id, revision: entry.ref.revision },
              detail: `referenced @${entry.ref.revision}, record is at @${entry.latestRevision}`,
            }
          : { code, evidence: { id: entry.ref.id, revision: entry.ref.revision } },
      );
    }
  }
  for (const missingCitation of collected.missing) {
    blockers.push({
      code: "evidence_missing",
      ...(missingCitation.ref.revision !== undefined
        ? { evidence: { id: EvidenceIDs.cast(missingCitation.ref.id), revision: missingCitation.ref.revision } }
        : { evidence: { id: EvidenceIDs.cast(missingCitation.ref.id) } }),
      detail: `cited by ${missingCitation.decision.id}@${missingCitation.decision.revision}`,
    });
  }

  // Brief §9: frozen synthesis state vs the CURRENT authoritative record
  // state, for every relevant (frozen) ref. Material difference = the record
  // has a NEWEST revision other than the one synthesis consumed, the frozen
  // record vanished from the reachable set, or (defensively) the frozen
  // fields no longer match the resolved revision's immutable fields.
  const entryByID = new Map(entries.map((entry) => [entry.ref.id, entry]));
  for (const frozen of input.evidence as readonly FrozenEvidenceState[]) {
    const current = entryByID.get(frozen.id);
    if (!current) {
      blockers.push({
        code: "synthesis_evidence_stale",
        evidence: { id: frozen.id, revision: frozen.revision },
        detail: `${frozen.id}@${frozen.revision} was consumed by synthesis but is no longer reachable`,
      });
      continue;
    }
    if (current.latestRevision !== frozen.revision) {
      blockers.push({
        code: "synthesis_evidence_stale",
        evidence: { id: frozen.id, revision: frozen.revision },
        detail: `synthesis consumed ${frozen.id}@${frozen.revision}; the record is now at @${current.latestRevision}`,
      });
      continue;
    }
    if (
      current.confidence !== frozen.confidence ||
      current.criticality !== frozen.criticality ||
      current.freshness !== frozen.freshness ||
      current.status !== frozen.status
    ) {
      blockers.push({
        code: "synthesis_evidence_stale",
        evidence: { id: frozen.id, revision: frozen.revision },
        detail: `${frozen.id}@${frozen.revision} state changed since synthesis froze it`,
      });
    }
  }

  const counts = computeEvidenceAuditCounts(entries);
  const result: EvidenceAuditSnapshot["result"] = blockers.length === 0 ? "pass" : "blocked";
  const payload = {
    planID,
    headSnapshot: { id: snapshot.id },
    headCommit: snapshot.commit,
    synthesisInput: { id: input.id, hash: input.hash },
    synthesisManifest: { id: manifest.id, revision: manifest.revision, hash: manifest.hash },
    validationReport: { id: report.id, hash: report.hash },
    entries,
    counts,
    result,
    blockers,
    evidenceStateHash,
  };
  const hash = computeEvidenceAuditHash(payload);
  return { ...payload, id: assign.id, createdAt: assign.now, hash };
}

/** Save/load-time guard: every blocker code must be in the frozen vocabulary. */
export function isEvidenceAuditBlockerCode(value: unknown): value is EvidenceAuditBlockerCode {
  return typeof value === "string" && (EVIDENCE_AUDIT_BLOCKER_CODES as readonly string[]).includes(value);
}

/** Exported for the store's identity-keyed idempotency lookup. */
export function evidenceAuditIdentity(
  audit: Pick<
    EvidenceAuditSnapshot,
    "headSnapshot" | "synthesisInput" | "synthesisManifest" | "validationReport" | "evidenceStateHash"
  >,
): { headSnapshot: string; inputHash: string; manifestHash: string; reportHash: string; evidenceStateHash: string } {
  return {
    headSnapshot: audit.headSnapshot.id,
    inputHash: audit.synthesisInput.hash,
    manifestHash: audit.synthesisManifest.hash,
    reportHash: audit.validationReport.hash,
    evidenceStateHash: audit.evidenceStateHash,
  };
}

/**
 * Integrity guard shared by the store save path and durable-load validation
 * (brief §62): counts recompute from entries, result/blockers/verdicts agree,
 * every blocker code is in the closed vocabulary, and the evidenceStateHash
 * recomputes from the entries' fingerprint inputs. Structural only —
 * cross-record mirror checks (input/manifest/report existence + hashes,
 * per-entry resolution against the evidence family, live fingerprint
 * currency) live with the caller, which has family access.
 */
export function assertEvidenceAuditInternallyConsistent(audit: EvidenceAuditSnapshot): void {
  const recomputed = computeEvidenceAuditCounts(audit.entries);
  if (stableCountsEqual(recomputed, audit.counts) === false) {
    throw new UltraPlanError("invalid_scope", `Evidence audit ${audit.id} counts are inconsistent with its entries`, {
      auditID: audit.id,
    });
  }
  if (audit.result === "pass" && (audit.blockers.length > 0 || audit.entries.some((entry) => entry.verdict !== "pass"))) {
    throw new UltraPlanError("invalid_scope", `Evidence audit ${audit.id} passes but carries blockers`, { auditID: audit.id });
  }
  if (audit.result === "blocked" && audit.blockers.length === 0) {
    throw new UltraPlanError("invalid_scope", `Evidence audit ${audit.id} is blocked without blockers`, { auditID: audit.id });
  }
  for (const entry of audit.entries) {
    if ((entry.verdict === "flagged") !== (entry.blockers.length > 0)) {
      throw new UltraPlanError(
        "invalid_scope",
        `Evidence audit ${audit.id} entry ${entry.ref.id}@${entry.ref.revision} verdict/blockers disagree`,
        { auditID: audit.id },
      );
    }
    for (const code of entry.blockers) {
      if (!isEvidenceAuditBlockerCode(code)) {
        throw new UltraPlanError(
          "invalid_scope",
          `Evidence audit ${audit.id} entry carries unknown blocker code ${String(code)}`,
          { auditID: audit.id },
        );
      }
    }
    if (entry.latestRevision < entry.ref.revision) {
      throw new UltraPlanError(
        "invalid_scope",
        `Evidence audit ${audit.id} entry ${entry.ref.id} claims latest @${entry.latestRevision} before the referenced @${entry.ref.revision}`,
        { auditID: audit.id },
      );
    }
  }
  for (const blocker of audit.blockers) {
    if (!isEvidenceAuditBlockerCode(blocker.code)) {
      throw new UltraPlanError(
        "invalid_scope",
        `Evidence audit ${audit.id} carries unknown blocker code ${String(blocker.code)}`,
        { auditID: audit.id },
      );
    }
  }
  if (computeEvidenceStateHash(audit.entries) !== audit.evidenceStateHash) {
    throw new UltraPlanError(
      "invalid_scope",
      `Evidence audit ${audit.id} evidenceStateHash does not recompute from its entries`,
      { auditID: audit.id },
    );
  }
}

function stableCountsEqual(a: EvidenceAuditCounts, b: EvidenceAuditCounts): boolean {
  return (
    a.freshCritical === b.freshCritical &&
    a.freshSupporting === b.freshSupporting &&
    a.informational === b.informational &&
    a.needsValidation === b.needsValidation &&
    a.stale === b.stale &&
    a.invalidated === b.invalidated &&
    a.criticalUncertain === b.criticalUncertain
  );
}
