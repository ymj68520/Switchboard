/**
 * Durable store document — persistence DTO layer (Phase 2B2 brief §8/§9/§12).
 *
 * One structured, versioned document per project holds the authoritative Plan
 * Memory as RECORDS with stable identities (not an opaque blob): every entity
 * family is keyed by its branded domain id, so identity, revision, status,
 * hash, and HEAD references remain first-class and enforceable. Structured
 * immutable content (decision bodies, section projections, proposal changes)
 * lives in validated JSON payloads — the boundary from brief §9.
 *
 * Validation is FAIL-CLOSED: `decodeStoreDocument` throws `store_corrupt` on
 * any malformed payload or broken reference, and `store_version_unsupported`
 * on a newer schema — it never repairs, deletes, or downgrades (brief §20).
 */
import { createHash } from "node:crypto";

import { UltraPlanError } from "../core/errors.js";
import type {
  Architecture,
  Decision,
  PlanningRun,
  Section,
  SectionRevision,
} from "../core/types.js";
import type { Approval, PlanCommit, Proposal } from "../transaction/types.js";
import type { Evidence } from "../repository/evidence.js";
import type { PlanEvent } from "./events.js";
import type { Snapshot } from "./snapshots.js";
import {
  computeSynthesisInputHash,
  computeSynthesisManifestHashFromRecord,
} from "../synthesis/hash.js";
import type { SynthesisInput, SynthesisManifest } from "../synthesis/types.js";
import { SYNTHESIS_FINDING_CATEGORIES } from "../synthesis/types.js";
import { computeValidationReportHashFromRecord } from "../validation/hash.js";
import { SEMANTIC_FINDING_CATEGORIES } from "../validation/types.js";
import type { SemanticValidationAdmission, SemanticValidationFinding, ValidationReport } from "../validation/types.js";
import { computeEvidenceAuditHashFromRecord, computeFinalPlanCandidateHashFromRecord } from "../finalization/hash.js";
import { computeFinalPlanHashFromContent, renderFinalPlanBody } from "../finalization/plan.js";
import { computeExecutionHandoffHashFromRecord } from "../handoff/hash.js";
import { handoffDeliveryKey } from "../handoff/types.js";
import { assertEvidenceAuditInternallyConsistent } from "../finalization/audit.js";

export const STORE_SCHEMA_VERSION = 1;

/**
 * Authoritative durable state. Record keys:
 * - committed artifacts: `ID@REVISION` (architectures use `ARCH@N`)
 * - sections: SectionID
 * - proposals/approvals/commits/snapshots: their own ids
 * - evidence: `EVD-###@REVISION`
 * - synthesis manifests: `SYN-###@REVISION` (Phase 2F)
 * - synthesis inputs: their own ids (`SYN-IN-###`)
 * Family maps are keyed per plan id.
 */
export interface StoreDocument {
  schemaVersion: number;
  runs: Record<string, PlanningRun>;
  runOrder: string[];
  events: Record<string, PlanEvent[]>;
  committed: Record<
    string,
    {
      architectures: Record<string, Architecture>;
      sections: Record<string, Section>;
      sectionRevisions: Record<string, SectionRevision>;
      decisions: Record<string, Decision>;
    }
  >;
  proposals: Record<string, Record<string, Proposal>>;
  approvals: Record<string, Record<string, Approval>>;
  commits: Record<string, Record<string, PlanCommit>>;
  /** `planID:proposalID` → commitID; the idempotency index. */
  commitByProposal: Record<string, string>;
  snapshots: Record<string, Record<string, Snapshot>>;
  evidence: Record<string, Record<string, Evidence>>;
  /**
   * Phase 2F derived synthesis artifacts — durable workflow state, NOT
   * committed Plan Memory. ADDITIVE: documents written before Phase 2F
   * legitimately lack both families; absence has the unambiguous semantics
   * "no synthesis was performed", so the schema version stays 1 (brief §39).
   */
  synthesisInputs?: Record<string, Record<string, SynthesisInput>>;
  synthesisManifests?: Record<string, Record<string, SynthesisManifest>>;
  /**
   * Phase 2G semantic validation (brief §28) — durable derived reports plus
   * the transient single-flight admission records. ADDITIVE for the same
   * reason: a pre-2G document without `validationReports` unambiguously means
   * "semantic validation has never run"; no existing family is reinterpreted,
   * so STORE_SCHEMA_VERSION stays 1. Admissions are transient machinery but
   * ride the document so a process death leaves a RECLAIMABLE (never wedging)
   * ownership record (§32) instead of invisible cross-instance drift.
   */
  validationReports?: Record<string, Record<string, ValidationReport>>;
  validationAdmissions?: Record<string, Record<string, SemanticValidationAdmission>>;
  /**
   * Phase 2H finalization (brief §61) — durable derived audit snapshots and
   * FinalPlanCandidates. ADDITIVE for the same reason as the 2F/2G families:
   * a pre-2H document without them unambiguously means "finalization has never
   * run", no existing family is reinterpreted, so STORE_SCHEMA_VERSION stays 1.
   * Malformed records fail closed (§62/§63); there is no repair.
   */
  evidenceAudits?: Record<string, Record<string, import("../finalization/types.js").EvidenceAuditSnapshot>>;
  finalPlanCandidates?: Record<string, Record<string, import("../finalization/types.js").FinalPlanCandidate>>;
  /**
   * Phase 2I committed FinalPlans — ADDITIVE like every later family: a
   * pre-2I document without `finalPlans` unambiguously means "no Final
   * PlanCommit has ever happened", no existing family is reinterpreted, and
   * STORE_SCHEMA_VERSION stays 1. These ARE committed Plan Memory (the only
   * writer is the final transaction), so load validation additionally proves
   * the run-pointer/commit/snapshot consistency (§70-§74) — fail closed.
   */
  finalPlans?: Record<string, Record<string, import("../core/types.js").FinalPlan>>;
  /**
   * Phase 2J runtime handoff (§85) — the immutable ExecutionHandoff and the
   * mutable delivery workflow record. ADDITIVE for the same reason as every
   * later family: a pre-2J document without them unambiguously means "no
   * handoff has been prepared", so STORE_SCHEMA_VERSION stays 1. Load
   * validation proves hash/projection/binding integrity (§86) and the
   * delivery state machine invariants (§87/§88/§123/§124) — fail closed.
   */
  executionHandoffs?: Record<string, Record<string, import("../handoff/types.js").ExecutionHandoff>>;
  handoffDeliveries?: Record<string, Record<string, import("../handoff/types.js").HandoffDelivery>>;
}

export function freshStoreDocument(): StoreDocument {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    runs: {},
    runOrder: [],
    events: {},
    committed: {},
    proposals: {},
    approvals: {},
    commits: {},
    commitByProposal: {},
    snapshots: {},
    evidence: {},
    synthesisInputs: {},
    synthesisManifests: {},
    validationReports: {},
    validationAdmissions: {},
    evidenceAudits: {},
    finalPlanCandidates: {},
    finalPlans: {},
    executionHandoffs: {},
    handoffDeliveries: {},
  };
}

function corrupt(message: string, detail?: Record<string, unknown>): UltraPlanError {
  return new UltraPlanError("store_corrupt", `Durable store is corrupt: ${message}`, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed durable document and its critical references. Throws
 * `store_version_unsupported` / `store_corrupt`. Invariants checked here are
 * the storage-level ones only (references, hashes, chain shape); domain
 * transaction rules remain in the transaction engine.
 */
export function validateStoreDocument(doc: unknown): asserts doc is StoreDocument {
  if (!isRecord(doc)) throw corrupt("document is not an object");
  if (typeof doc.schemaVersion !== "number") throw corrupt("missing numeric schemaVersion");
  if (doc.schemaVersion > STORE_SCHEMA_VERSION) {
    throw new UltraPlanError(
      "store_version_unsupported",
      `Durable store schema version ${doc.schemaVersion} is newer than supported version ${STORE_SCHEMA_VERSION}; upgrade the plugin — refusing to open`,
      { found: doc.schemaVersion, supported: STORE_SCHEMA_VERSION },
    );
  }
  if (doc.schemaVersion < STORE_SCHEMA_VERSION) {
    throw corrupt(`schema version ${doc.schemaVersion} is older than supported; no migration exists`, {
      found: doc.schemaVersion,
      supported: STORE_SCHEMA_VERSION,
    });
  }
  for (const family of ["runs", "events", "committed", "proposals", "approvals", "commits", "commitByProposal", "snapshots", "evidence"]) {
    if (!isRecord(doc[family as keyof StoreDocument])) throw corrupt(`missing "${family}" family`);
  }
  if (!Array.isArray(doc.runOrder)) throw corrupt("runOrder is not an array");

  const runs = doc.runs as Record<string, unknown>;
  const snapshots = doc.snapshots as Record<string, Record<string, unknown>>;
  const commits = doc.commits as Record<string, Record<string, unknown>>;
  const proposals = doc.proposals as Record<string, Record<string, unknown>>;
  const approvals = doc.approvals as Record<string, Record<string, unknown>>;

  // Runs reference existing HEAD snapshot/commit.
  for (const [planID, run] of Object.entries(runs)) {
    if (!isRecord(run)) throw corrupt(`run ${planID} is not an object`);
    const headSnapshot = run["headSnapshot"];
    if (headSnapshot !== undefined && headSnapshot !== null) {
      const family = snapshots[planID];
      if (!isRecord(family) || !(headSnapshot as string in family)) {
        throw corrupt(`run ${planID} references missing HEAD snapshot ${String(headSnapshot)}`, {
          planID,
          headSnapshot: String(headSnapshot),
        });
      }
    }
    const headCommit = run["headCommit"];
    if (headCommit !== undefined && headCommit !== null) {
      const family = commits[planID];
      if (!isRecord(family) || !(headCommit as string in family)) {
        throw corrupt(`run ${planID} references missing HEAD commit ${String(headCommit)}`, {
          planID,
          headCommit: String(headCommit),
        });
      }
    }
  }

  // Snapshot section roots (Phase 2D, additive optional field): when present,
  // each root must be a well-shaped record. Absence is legitimate — snapshots
  // created before decomposition-carrying commits simply have no section
  // roots, and absence is never backfilled.
  for (const [planID, family] of Object.entries(snapshots)) {
    if (!isRecord(family)) throw corrupt(`snapshot family ${planID} is not an object`);
    for (const [snapshotID, snapshot] of Object.entries(family)) {
      if (!isRecord(snapshot)) throw corrupt(`snapshot ${snapshotID} is not an object`);
      const state = snapshot["state"];
      if (!isRecord(state)) continue; // deeper shape stays with the domain layer
      const roots = state["sectionRoots"];
      if (roots === undefined) continue;
      if (!Array.isArray(roots)) {
        throw corrupt(`snapshot ${snapshotID} has a malformed sectionRoots field`, { planID, snapshotID });
      }
      for (const root of roots) {
        if (!isRecord(root) || typeof root["id"] !== "string") {
          throw corrupt(`snapshot ${snapshotID} has a malformed section root entry`, { planID, snapshotID });
        }
        // Phase 2E1 (additive): checkpoint pointers, when present, must be
        // positive integers. Absence stays legitimate (pre-checkpoint roots).
        for (const pointer of ["currentRevision", "approvedRevision"]) {
          const value = root[pointer];
          if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
            throw corrupt(`snapshot ${snapshotID} has a malformed section root ${pointer}`, {
              planID,
              snapshotID,
            });
          }
        }
      }
      // Phase 2E2 (additive): the workflow focus, when present, must be a
      // well-shaped section WorkRef. Absence is legitimate (pre-decomposition
      // snapshots and the final completion that cleared the focus).
      const activeWork = state["activeWork"];
      if (activeWork !== undefined) {
        if (
          !isRecord(activeWork) ||
          activeWork["type"] !== "section" ||
          typeof activeWork["id"] !== "string" ||
          activeWork["id"].length === 0
        ) {
          throw corrupt(`snapshot ${snapshotID} has a malformed activeWork field`, { planID, snapshotID });
        }
      }
    }
  }

  // Commits reference existing snapshots and existing parents.
  for (const [planID, family] of Object.entries(commits)) {
    if (!isRecord(family)) throw corrupt(`commit family ${planID} is not an object`);
    for (const [commitID, commit] of Object.entries(family)) {
      if (!isRecord(commit)) throw corrupt(`commit ${commitID} is not an object`);
      const resultingSnapshot = commit["resultingSnapshot"];
      const snapshotFamily = snapshots[planID];
      if (!isRecord(snapshotFamily) || !isRecord(snapshotFamily[resultingSnapshot as string])) {
        throw corrupt(`commit ${commitID} references missing snapshot ${String(resultingSnapshot)}`, {
          planID,
          commitID,
        });
      }
      const parent = commit["parentCommit"];
      if (parent !== null && (typeof parent !== "string" || !(parent in family))) {
        throw corrupt(`commit ${commitID} references missing parent commit ${String(parent)}`, {
          planID,
          commitID,
        });
      }
    }
  }

  // Proposal hashes must recompute (corrupt payload fails closed; brief §24).
  for (const [planID, family] of Object.entries(proposals)) {
    if (!isRecord(family)) throw corrupt(`proposal family ${planID} is not an object`);
    for (const [proposalID, proposal] of Object.entries(family)) {
      if (!isRecord(proposal)) throw corrupt(`proposal ${proposalID} is not an object`);
      const hash = proposal["hash"];
      if (typeof hash !== "string" || hash.length === 0) {
        throw corrupt(`proposal ${proposalID} is missing its approval hash`, { planID, proposalID });
      }
      if (approvalHashForDoc(proposal) !== hash) {
        throw corrupt(`proposal ${proposalID} content does not recompute to its frozen hash`, {
          planID,
          proposalID,
        });
      }
    }
  }

  // Approvals must bind to an existing proposal with matching id/revision/hash.
  for (const [planID, family] of Object.entries(approvals)) {
    if (!isRecord(family)) throw corrupt(`approval family ${planID} is not an object`);
    for (const [approvalID, approval] of Object.entries(family)) {
      if (!isRecord(approval)) throw corrupt(`approval ${approvalID} is not an object`);
      const proposalID = approval["proposalID"];
      const proposalFamily = proposals[planID];
      const proposal = isRecord(proposalFamily) ? proposalFamily[proposalID as string] : undefined;
      if (!isRecord(proposal)) {
        throw corrupt(`approval ${approvalID} references missing proposal ${String(proposalID)}`, {
          planID,
          approvalID,
        });
      }
      if (
        approval["proposalRevision"] !== proposal["revision"] ||
        approval["proposalHash"] !== proposal["hash"]
      ) {
        throw corrupt(`approval ${approvalID} is inconsistent with proposal ${String(proposalID)}`, {
          planID,
          approvalID,
        });
      }
    }
  }

  // -- Phase 2F derived synthesis artifacts (fail-closed, brief §40) ---------
  // Both families are ADDITIVE and may be absent entirely (pre-2F documents).
  // When present: stored hashes must recompute exactly (never recalculated
  // and replaced), and every cross-reference must resolve.
  const synthesisInputs = isRecord(doc.synthesisInputs) ? doc.synthesisInputs : {};
  const synthesisManifests = isRecord(doc.synthesisManifests) ? doc.synthesisManifests : {};
  const SUPPORTED_SOURCE_KINDS = ["architecture", "section", "decision", "constraint", "question", "conflict", "evidence"];

  const validSourceRef = (ref: unknown): boolean => {
    if (!isRecord(ref) || !SUPPORTED_SOURCE_KINDS.includes(ref["kind"] as string)) return false;
    switch (ref["kind"]) {
      case "architecture":
        return true;
      case "section":
      case "decision":
      case "evidence":
        return (
          typeof ref["id"] === "string" &&
          ref["id"].length > 0 &&
          typeof ref["revision"] === "number" &&
          Number.isInteger(ref["revision"]) &&
          ref["revision"] >= 1
        );
      default:
        return typeof ref["id"] === "string" && ref["id"].length > 0;
    }
  };
  const validDerivedStatements = (statements: unknown): boolean =>
    Array.isArray(statements) &&
    statements.every(
      (statement) =>
        isRecord(statement) &&
        typeof statement["statement"] === "string" &&
        statement["statement"].length > 0 &&
        Array.isArray(statement["sources"]) &&
        (statement["sources"] as unknown[]).every(validSourceRef),
    );

  for (const [planID, family] of Object.entries(synthesisInputs)) {
    if (!isRecord(family)) throw corrupt(`synthesis input family ${planID} is not an object`);
    for (const [inputID, input] of Object.entries(family)) {
      if (!isRecord(input)) throw corrupt(`synthesis input ${inputID} is not an object`);
      if (typeof input["hash"] !== "string" || input["hash"].length === 0) {
        throw corrupt(`synthesis input ${inputID} is missing its canonical hash`, { planID, inputID });
      }
      // The stored hash must recompute from the exact authority payload
      // (id/createdAt excluded by contract) — corruption fails closed.
      const payload = {
        planID: input["planID"],
        baseSnapshot: input["baseSnapshot"],
        baseCommit: input["baseCommit"],
        architecture: input["architecture"],
        sections: input["sections"],
        decisions: input["decisions"],
        constraints: input["constraints"],
        questions: input["questions"],
        conflicts: input["conflicts"],
        evidence: input["evidence"],
      };
      if (computeSynthesisInputHash(payload as Parameters<typeof computeSynthesisInputHash>[0]) !== input["hash"]) {
        throw corrupt(`synthesis input ${inputID} content does not recompute to its frozen hash`, {
          planID,
          inputID,
        });
      }
    }
  }

  for (const [planID, family] of Object.entries(synthesisManifests)) {
    if (!isRecord(family)) throw corrupt(`synthesis manifest family ${planID} is not an object`);
    /** manifest id → sorted revision list, for the chain check. */
    const revisionChains = new Map<string, number[]>();
    for (const [manifestKey, manifest] of Object.entries(family)) {
      if (!isRecord(manifest)) throw corrupt(`synthesis manifest ${manifestKey} is not an object`);
      const id = manifest["id"];
      const revision = manifest["revision"];
      if (typeof id !== "string" || id.length === 0 || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
        throw corrupt(`synthesis manifest ${manifestKey} has a malformed identity`, { planID });
      }
      if (manifestKey !== `${id}@${revision}`) {
        throw corrupt(`synthesis manifest key ${manifestKey} does not match its identity ${id}@${String(revision)}`, { planID });
      }
      const list = revisionChains.get(id) ?? [];
      list.push(revision);
      revisionChains.set(id, list);

      if (typeof manifest["hash"] !== "string" || manifest["hash"].length === 0) {
        throw corrupt(`synthesis manifest ${manifestKey} is missing its canonical hash`, { planID });
      }
      // The referenced input must exist and the manifest must mirror it
      // exactly (brief §40): baseSnapshot, architecture, and section set.
      const inputID = (manifest["input"] as Record<string, unknown> | undefined)?.["inputID"] ?? (manifest["input"] as Record<string, unknown> | undefined)?.["id"];
      const inputFamily = synthesisInputs[planID];
      const input = isRecord(inputFamily) ? inputFamily[inputID as string] : undefined;
      if (!isRecord(input)) {
        throw corrupt(`synthesis manifest ${manifestKey} references missing synthesis input ${String(inputID)}`, {
          planID,
          manifestKey,
        });
      }
      if (
        stableStringifyForDoc(manifest["baseSnapshot"]) !== stableStringifyForDoc(input["baseSnapshot"]) ||
        stableStringifyForDoc(manifest["architecture"]) !== stableStringifyForDoc(input["architecture"]) ||
        stableStringifyForDoc(manifest["sections"]) !== stableStringifyForDoc(input["sections"])
      ) {
        throw corrupt(`synthesis manifest ${manifestKey} does not mirror its synthesis input ${String(inputID)}`, {
          planID,
          manifestKey,
        });
      }
      if (manifest["inputHash"] !== input["hash"]) {
        throw corrupt(`synthesis manifest ${manifestKey} carries a mismatched inputHash`, { planID, manifestKey });
      }
      // The derived content must recompute to the frozen hash (id/revision/
      // createdAt excluded by contract).
      if (
        computeSynthesisManifestHashFromRecord({
          input: { id: inputID as never },
          baseSnapshot: manifest["baseSnapshot"] as never,
          inputHash: manifest["inputHash"] as string,
          architecture: manifest["architecture"] as never,
          sections: manifest["sections"] as never,
          crossSectionLinks: manifest["crossSectionLinks"] as never,
          implementationOrder: manifest["implementationOrder"] as never,
          limitations: manifest["limitations"] as never,
          unresolvedFindings: manifest["unresolvedFindings"] as never,
        }) !== manifest["hash"]
      ) {
        throw corrupt(`synthesis manifest ${manifestKey} content does not recompute to its frozen hash`, {
          planID,
          manifestKey,
        });
      }
      // Shape gates: derived statements + provenance ref forms.
      if (!validDerivedStatements(manifest["crossSectionLinks"])) {
        throw corrupt(`synthesis manifest ${manifestKey} has malformed crossSectionLinks`, { planID, manifestKey });
      }
      if (!validDerivedStatements(manifest["limitations"])) {
        throw corrupt(`synthesis manifest ${manifestKey} has malformed limitations`, { planID, manifestKey });
      }
      if (
        !Array.isArray(manifest["implementationOrder"]) ||
        (manifest["implementationOrder"] as unknown[]).some(
          (step, index) =>
            !isRecord(step) ||
            typeof step["title"] !== "string" ||
            typeof step["description"] !== "string" ||
            step["order"] !== index + 1 ||
            !Array.isArray(step["sections"]) ||
            !(step["sections"] as unknown[]).every(
              (ref) =>
                isRecord(ref) &&
                typeof ref["id"] === "string" &&
                typeof ref["revision"] === "number" &&
                Number.isInteger(ref["revision"]),
            ) ||
            !Array.isArray(step["sources"]) ||
            !(step["sources"] as unknown[]).every(validSourceRef),
        )
      ) {
        throw corrupt(`synthesis manifest ${manifestKey} has a malformed implementationOrder`, { planID, manifestKey });
      }
      if (
        !Array.isArray(manifest["unresolvedFindings"]) ||
        (manifest["unresolvedFindings"] as unknown[]).some(
          (finding) =>
            !isRecord(finding) ||
            typeof finding["statement"] !== "string" ||
            finding["statement"].length === 0 ||
            !SYNTHESIS_FINDING_CATEGORIES.includes(finding["category"] as never) ||
            (finding["sources"] !== undefined &&
              (!Array.isArray(finding["sources"]) || !(finding["sources"] as unknown[]).every(validSourceRef))),
        )
      ) {
        throw corrupt(`synthesis manifest ${manifestKey} has malformed unresolvedFindings`, { planID, manifestKey });
      }
    }
    // Immutable revision chain: each manifest id carries contiguous 1..n.
    for (const [id, revisions] of revisionChains) {
      revisions.sort((a, b) => a - b);
      for (let index = 0; index < revisions.length; index++) {
        if (revisions[index] !== index + 1) {
          throw corrupt(`synthesis manifest ${id} has a broken revision chain (${revisions.join(", ")})`, { planID });
        }
      }
    }
  }

  // -- Phase 2G semantic validation (fail-closed, brief §29) ------------------
  // ADDITIVE family, may be absent entirely (pre-2G documents = "semantic
  // validation has never run"). When present, every stored report must
  // recompute its hash, bind an existing input/manifest pair exactly, and
  // carry structurally exact findings. No auto-repair.
  const validationReports = isRecord(doc.validationReports) ? doc.validationReports : {};
  const manifestFamilyFor = (planID: string): Record<string, unknown> =>
    (isRecord(synthesisManifests[planID]) ? synthesisManifests[planID] : {}) as Record<string, unknown>;

  /** Doc-level exact resolution of a source ref against a stored input record. */
  const sourceResolvesAgainstInput = (ref: unknown, input: Record<string, unknown>): boolean => {
    if (!isRecord(ref)) return false;
    switch (ref["kind"]) {
      case "architecture":
        return true;
      case "section": {
        const sections = Array.isArray(input["sections"]) ? input["sections"] : [];
        return sections.some(
          (section) =>
            isRecord(section) &&
            isRecord(section["ref"]) &&
            (section["ref"] as Record<string, unknown>)["id"] === ref["id"] &&
            (section["ref"] as Record<string, unknown>)["revision"] === ref["revision"],
        );
      }
      case "decision": {
        const decisions = Array.isArray(input["decisions"]) ? input["decisions"] : [];
        return decisions.some(
          (decision) => isRecord(decision) && decision["id"] === ref["id"] && decision["revision"] === ref["revision"],
        );
      }
      case "constraint": {
        const constraints = Array.isArray(input["constraints"]) ? input["constraints"] : [];
        return constraints.some((constraint) => isRecord(constraint) && constraint["id"] === ref["id"]);
      }
      case "question": {
        const questions = Array.isArray(input["questions"]) ? input["questions"] : [];
        return questions.some((question) => isRecord(question) && question["id"] === ref["id"]);
      }
      case "conflict": {
        const conflicts = Array.isArray(input["conflicts"]) ? input["conflicts"] : [];
        return conflicts.some((conflict) => isRecord(conflict) && conflict["id"] === ref["id"]);
      }
      case "evidence": {
        const evidence = Array.isArray(input["evidence"]) ? input["evidence"] : [];
        return evidence.some(
          (record) => isRecord(record) && record["id"] === ref["id"] && record["revision"] === ref["revision"],
        );
      }
      default:
        return false;
    }
  };

  for (const [planID, family] of Object.entries(validationReports)) {
    if (!isRecord(family)) throw corrupt(`validation report family ${planID} is not an object`);
    const inputFamily = isRecord(synthesisInputs[planID]) ? synthesisInputs[planID] : {};
    const manifests = manifestFamilyFor(planID);
    for (const [reportID, report] of Object.entries(family)) {
      if (!isRecord(report)) throw corrupt(`validation report ${reportID} is not an object`);
      if (report["id"] !== reportID) {
        throw corrupt(`validation report key ${reportID} does not match its identity`, { planID });
      }
      // Exact input/manifest binding (§29): both exist, hashes match, the
      // manifest belongs to the input, baseSnapshot mirrors the input.
      const inputID = (isRecord(report["input"]) ? (report["input"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      const input = isRecord(inputFamily[inputID as string]) ? (inputFamily[inputID as string] as Record<string, unknown>) : undefined;
      if (!input) {
        throw corrupt(`validation report ${reportID} references missing synthesis input ${String(inputID)}`, { planID });
      }
      if (report["inputHash"] !== input["hash"]) {
        throw corrupt(`validation report ${reportID} carries a mismatched inputHash`, { planID, reportID });
      }
      const manifestRef = isRecord(report["manifest"]) ? (report["manifest"] as Record<string, unknown>) : undefined;
      const manifestKey = manifestRef ? `${manifestRef["id"]}@${manifestRef["revision"]}` : undefined;
      const manifest = manifestKey && isRecord(manifests[manifestKey]) ? (manifests[manifestKey] as Record<string, unknown>) : undefined;
      if (!manifest) {
        throw corrupt(`validation report ${reportID} references missing synthesis manifest ${String(manifestKey)}`, {
          planID,
          reportID,
        });
      }
      if (report["manifestHash"] !== manifest["hash"]) {
        throw corrupt(`validation report ${reportID} carries a mismatched manifestHash`, { planID, reportID });
      }
      if ((manifest["input"] as Record<string, unknown> | undefined)?.["id"] !== inputID) {
        throw corrupt(`validation report ${reportID} binds a manifest from another synthesis input`, { planID, reportID });
      }
      if (stableStringifyForDoc(report["baseSnapshot"]) !== stableStringifyForDoc(input["baseSnapshot"])) {
        throw corrupt(`validation report ${reportID} baseSnapshot does not match its input`, { planID, reportID });
      }
      if (typeof report["validatorProtocol"] !== "string" || report["validatorProtocol"].length === 0) {
        throw corrupt(`validation report ${reportID} is missing its validator protocol`, { planID, reportID });
      }
      if (
        report["validatorModel"] !== undefined &&
        (typeof report["validatorModel"] !== "string" || report["validatorModel"].length === 0)
      ) {
        throw corrupt(`validation report ${reportID} carries a malformed validatorModel`, { planID, reportID });
      }
      // Result + cardinality (§29) + the §13 clean-forbidden rule.
      const result = report["result"];
      const findings = report["findings"];
      if (result !== "clean" && result !== "findings") {
        throw corrupt(`validation report ${reportID} carries an invalid result`, { planID, reportID });
      }
      if (!Array.isArray(findings)) {
        throw corrupt(`validation report ${reportID} findings is not an array`, { planID, reportID });
      }
      if (result === "clean" && findings.length > 0) {
        throw corrupt(`validation report ${reportID} is clean but carries findings`, { planID, reportID });
      }
      if (result === "findings" && findings.length === 0) {
        throw corrupt(`validation report ${reportID} has findings but an empty findings array`, { planID, reportID });
      }
      const unresolved = Array.isArray(manifest["unresolvedFindings"]) ? (manifest["unresolvedFindings"] as unknown[]).length : 0;
      if (result === "clean" && unresolved > 0) {
        throw corrupt(
          `validation report ${reportID} is clean while its manifest declares ${unresolved} unresolved finding(s)`,
          { planID, reportID },
        );
      }
      // Finding shape + exact scope/manifest-item/source resolution.
      for (const finding of findings as unknown[]) {
        if (!isRecord(finding)) throw corrupt(`validation report ${reportID} has a malformed finding`, { planID, reportID });
        if (typeof finding["id"] !== "string" || finding["id"].length === 0) {
          throw corrupt(`validation report ${reportID} has a finding without a Harness-assigned id`, { planID, reportID });
        }
        if (!SEMANTIC_FINDING_CATEGORIES.includes(finding["category"] as never)) {
          throw corrupt(`validation report ${reportID} has a finding with an unsupported category`, { planID, reportID });
        }
        if (typeof finding["statement"] !== "string" || finding["statement"].length === 0) {
          throw corrupt(`validation report ${reportID} has a finding without a statement`, { planID, reportID });
        }
        const scope = finding["scope"];
        if (!isRecord(scope)) throw corrupt(`validation report ${reportID} has a finding without a scope`, { planID, reportID });
        let scopeBound = false;
        if (scope["architecture"] !== undefined) {
          const arch = scope["architecture"];
          if (
            !isRecord(arch) ||
            arch["id"] !== "ARCH" ||
            arch["revision"] !== (isRecord(input["architecture"]) ? (input["architecture"] as Record<string, unknown>)["revision"] : undefined)
          ) {
            throw corrupt(`validation report ${reportID} has a finding citing a non-input architecture revision`, { planID, reportID });
          }
          scopeBound = true;
        }
        if (scope["sections"] !== undefined) {
          const sections = scope["sections"];
          if (!Array.isArray(sections)) {
            throw corrupt(`validation report ${reportID} has a finding with malformed scope sections`, { planID, reportID });
          }
          for (const sectionRef of sections) {
            if (!sourceResolvesAgainstInput({ kind: "section", ...(isRecord(sectionRef) ? sectionRef : {}) }, input)) {
              throw corrupt(`validation report ${reportID} has a finding citing non-input section ${JSON.stringify(sectionRef)}`, {
                planID,
                reportID,
              });
            }
          }
          if ((sections as unknown[]).length > 0) scopeBound = true;
        }
        if (!scopeBound) {
          throw corrupt(`validation report ${reportID} has a finding without an affected scope`, { planID, reportID });
        }
        if (finding["manifestItem"] !== undefined) {
          const item = finding["manifestItem"];
          if (!isRecord(item)) {
            throw corrupt(`validation report ${reportID} has a malformed manifestItem`, { planID, reportID });
          }
          const withinBounds =
            (item["kind"] === "cross_section_link" &&
              typeof item["index"] === "number" &&
              item["index"] >= 1 &&
              item["index"] <= (Array.isArray(manifest["crossSectionLinks"]) ? (manifest["crossSectionLinks"] as unknown[]).length : 0)) ||
            (item["kind"] === "implementation_step" &&
              Array.isArray(manifest["implementationOrder"]) &&
              (manifest["implementationOrder"] as unknown[]).some(
                (step) => isRecord(step) && step["order"] === item["order"],
              )) ||
            (item["kind"] === "limitation" &&
              typeof item["index"] === "number" &&
              item["index"] >= 1 &&
              item["index"] <= (Array.isArray(manifest["limitations"]) ? (manifest["limitations"] as unknown[]).length : 0)) ||
            (item["kind"] === "synthesis_finding" &&
              typeof item["index"] === "number" &&
              item["index"] >= 1 &&
              item["index"] <= unresolved);
          if (!withinBounds) {
            throw corrupt(`validation report ${reportID} has a finding citing a nonexistent manifest item`, { planID, reportID });
          }
        }
        if (finding["sources"] !== undefined) {
          const sources = finding["sources"];
          if (!Array.isArray(sources)) {
            throw corrupt(`validation report ${reportID} has a finding with malformed sources`, { planID, reportID });
          }
          for (const source of sources) {
            if (!validSourceRef(source) || !sourceResolvesAgainstInput(source, input)) {
              throw corrupt(`validation report ${reportID} has a finding citing a source outside its input`, { planID, reportID });
            }
          }
        }
      }
      // The stored hash must recompute (id/createdAt excluded by contract).
      if (
        computeValidationReportHashFromRecord({
          planID: report["planID"] as ValidationReport["planID"],
          input: report["input"] as ValidationReport["input"],
          inputHash: report["inputHash"] as string,
          manifest: report["manifest"] as ValidationReport["manifest"],
          manifestHash: report["manifestHash"] as string,
          baseSnapshot: report["baseSnapshot"] as ValidationReport["baseSnapshot"],
          validatorProtocol: report["validatorProtocol"] as string,
          ...(report["validatorModel"] !== undefined ? { validatorModel: report["validatorModel"] as string } : {}),
          result: report["result"] as ValidationReport["result"],
          findings: findings as SemanticValidationFinding[],
        }) !== report["hash"]
      ) {
        throw corrupt(`validation report ${reportID} content does not recompute to its frozen hash`, { planID, reportID });
      }
    }
  }

  // Admission records: transient but durable single-flight ownership (§32).
  const validationAdmissions = isRecord(doc.validationAdmissions) ? doc.validationAdmissions : {};
  for (const [planID, family] of Object.entries(validationAdmissions)) {
    if (!isRecord(family)) throw corrupt(`validation admission family ${planID} is not an object`);
    for (const [identityKey, admission] of Object.entries(family)) {
      if (!isRecord(admission)) throw corrupt(`validation admission ${identityKey} is not an object`);
      const parts = typeof identityKey === "string" ? identityKey.split("|") : [];
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        throw corrupt(`validation admission key ${identityKey} is not a validation identity`, { planID });
      }
      for (const field of ["admittedAt", "expiresAt"] as const) {
        if (typeof admission[field] !== "string" || (admission[field] as string).length === 0) {
          throw corrupt(`validation admission ${identityKey} is missing "${field}"`, { planID });
        }
      }
      if (Date.parse(admission["expiresAt"] as string) < Date.parse(admission["admittedAt"] as string)) {
        throw corrupt(`validation admission ${identityKey} expires before it was admitted`, { planID });
      }
    }
  }

  // -- Phase 2H finalization (fail-closed, brief §61/§62/§63) ------------------
  // Both families are ADDITIVE and may be absent entirely (pre-2H documents =
  // "finalization has never run"). When present: stored hashes must recompute
  // exactly, every cross-reference must resolve with matching hashes, evidence
  // entries must be exact, counts/result/blockers consistent, and the
  // candidate must be the exact projection of its bound authority objects.
  // No repair.
  const evidenceAudits = isRecord(doc.evidenceAudits) ? doc.evidenceAudits : {};
  const finalPlanCandidates = isRecord(doc.finalPlanCandidates) ? doc.finalPlanCandidates : {};

  /** Newest revision of one evidence id across a doc-level evidence family. */
  const latestEvidenceRevision = (family: Record<string, unknown>, id: string): number => {
    let highest = 0;
    for (const key of Object.keys(family)) {
      if (!key.startsWith(`${id}@`)) continue;
      const revision = Number(key.slice(id.length + 1));
      if (Number.isInteger(revision) && revision > highest) highest = revision;
    }
    return highest;
  };

  for (const [planID, family] of Object.entries(evidenceAudits)) {
    if (!isRecord(family)) throw corrupt(`evidence audit family ${planID} is not an object`);
    const inputFamily = isRecord(synthesisInputs[planID]) ? (synthesisInputs[planID] as Record<string, unknown>) : {};
    const manifests = manifestFamilyFor(planID);
    const reports = isRecord(validationReports[planID]) ? (validationReports[planID] as Record<string, unknown>) : {};
    const snapshots = isRecord((doc as { snapshots?: unknown }).snapshots)
      ? ((doc as { snapshots: Record<string, unknown> }).snapshots[planID] as Record<string, unknown> | undefined) ?? {}
      : {};
    const evidence = isRecord((doc as { evidence?: unknown }).evidence)
      ? ((doc as { evidence: Record<string, unknown> }).evidence[planID] as Record<string, unknown> | undefined) ?? {}
      : {};
    for (const [auditID, audit] of Object.entries(family)) {
      if (!isRecord(audit)) throw corrupt(`evidence audit ${auditID} is not an object`);
      if (audit["id"] !== auditID) {
        throw corrupt(`evidence audit key ${auditID} does not match its identity`, { planID });
      }
      // Hash recompute (§62).
      const auditRest = { ...audit } as Record<string, unknown>;
      delete auditRest["id"];
      delete auditRest["createdAt"];
      delete auditRest["hash"];
      if (
        computeEvidenceAuditHashFromRecord(auditRest as unknown as Parameters<typeof computeEvidenceAuditHashFromRecord>[0]) !==
        audit["hash"]
      ) {
        throw corrupt(`evidence audit ${auditID} content does not recompute to its frozen hash`, { planID, auditID });
      }
      // HEAD/base refs well-formed + resolvable (§62).
      const headSnapshot = (isRecord(audit["headSnapshot"]) ? (audit["headSnapshot"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      if (typeof headSnapshot !== "string" || !snapshots[headSnapshot]) {
        throw corrupt(`evidence audit ${auditID} references missing HEAD snapshot ${String(headSnapshot)}`, { planID, auditID });
      }
      // Input/manifest/report existence + exact hash mirrors (§62).
      const auditInputID = (isRecord(audit["synthesisInput"]) ? (audit["synthesisInput"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      const auditInputHash = isRecord(audit["synthesisInput"]) ? (audit["synthesisInput"] as Record<string, unknown>)["hash"] : undefined;
      const auditInput = isRecord(inputFamily[auditInputID as string]) ? (inputFamily[auditInputID as string] as Record<string, unknown>) : undefined;
      if (!auditInput || auditInputHash !== auditInput["hash"]) {
        throw corrupt(`evidence audit ${auditID} references missing synthesis input ${String(auditInputID)} (or a mismatched hash)`, { planID, auditID });
      }
      const auditManifestRef = isRecord(audit["synthesisManifest"]) ? (audit["synthesisManifest"] as Record<string, unknown>) : undefined;
      const auditManifestKey = auditManifestRef ? `${auditManifestRef["id"]}@${auditManifestRef["revision"]}` : undefined;
      const auditManifest = auditManifestKey && isRecord(manifests[auditManifestKey]) ? (manifests[auditManifestKey] as Record<string, unknown>) : undefined;
      if (
        !auditManifest ||
        auditManifestRef?.["hash"] !== auditManifest["hash"] ||
        (isRecord(auditManifest["input"]) ? (auditManifest["input"] as Record<string, unknown>)["id"] : undefined) !== auditInputID
      ) {
        throw corrupt(`evidence audit ${auditID} references missing synthesis manifest ${String(auditManifestKey)} (or a mismatched hash/binding)`, { planID, auditID });
      }
      const auditReportID = (isRecord(audit["validationReport"]) ? (audit["validationReport"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      const auditReport = isRecord(reports[auditReportID as string]) ? (reports[auditReportID as string] as Record<string, unknown>) : undefined;
      if (!auditReport || (audit["validationReport"] as Record<string, unknown>)["hash"] !== auditReport["hash"]) {
        throw corrupt(`evidence audit ${auditID} references missing validation report ${String(auditReportID)} (or a mismatched hash)`, { planID, auditID });
      }
      // Entries exact (§62): each entry resolves at its exact revision with
      // matching state, and reports the family's true newest revision.
      const entries = audit["entries"];
      if (!Array.isArray(entries)) throw corrupt(`evidence audit ${auditID} entries is not an array`, { planID, auditID });
      for (const entry of entries as unknown[]) {
        if (!isRecord(entry)) throw corrupt(`evidence audit ${auditID} has a malformed entry`, { planID, auditID });
        const entryRef = isRecord(entry["ref"]) ? (entry["ref"] as Record<string, unknown>) : undefined;
        const evidenceID = entryRef?.["id"] as string | undefined;
        const revision = entryRef?.["revision"];
        const recordKey = evidenceID !== undefined && typeof revision === "number" ? `${evidenceID}@${revision}` : undefined;
        const record = recordKey && isRecord(evidence[recordKey]) ? (evidence[recordKey] as Record<string, unknown>) : undefined;
        if (!record) {
          throw corrupt(`evidence audit ${auditID} entry ${String(evidenceID)}@${String(revision)} does not resolve`, { planID, auditID });
        }
        if (
          record["confidence"] !== entry["confidence"] ||
          record["criticality"] !== entry["criticality"] ||
          record["freshness"] !== entry["freshness"] ||
          record["status"] !== entry["status"]
        ) {
          throw corrupt(`evidence audit ${auditID} entry ${String(evidenceID)}@${String(revision)} state does not match the stored record`, { planID, auditID });
        }
        if (latestEvidenceRevision(evidence, evidenceID as string) < (entry["latestRevision"] as number)) {
          // Evidence grows monotonically: a HISTORICAL audit legitimately
          // records the newest revision AT AUDIT TIME (evidence is a separate
          // trust domain and may advance afterwards, brief §9) — the load
          // check only requires the record to never shrink below it.
          throw corrupt(`evidence audit ${auditID} entry ${String(evidenceID)} records a latest revision below the stored record`, { planID, auditID });
        }
      }
      // Consistency + fingerprint recompute (§62). Any structural violation
      // the shared guard throws is corruption at load time — fail closed.
      try {
        assertEvidenceAuditInternallyConsistent(audit as unknown as Parameters<typeof assertEvidenceAuditInternallyConsistent>[0]);
      } catch (error) {
        throw corrupt(`evidence audit ${auditID}: ${error instanceof Error ? error.message : String(error)}`, { planID, auditID });
      }
    }
  }

  for (const [planID, family] of Object.entries(finalPlanCandidates)) {
    if (!isRecord(family)) throw corrupt(`final plan candidate family ${planID} is not an object`);
    const inputFamily = isRecord(synthesisInputs[planID]) ? (synthesisInputs[planID] as Record<string, unknown>) : {};
    const manifests = manifestFamilyFor(planID);
    const reports = isRecord(validationReports[planID]) ? (validationReports[planID] as Record<string, unknown>) : {};
    const audits = isRecord(evidenceAudits[planID]) ? (evidenceAudits[planID] as Record<string, unknown>) : {};
    for (const [candidateKey, candidate] of Object.entries(family)) {
      if (!isRecord(candidate)) throw corrupt(`final plan candidate ${candidateKey} is not an object`);
      const candidateID = candidate["id"];
      const candidateRevision = candidate["revision"];
      if (
        typeof candidateID !== "string" ||
        candidateID.length === 0 ||
        typeof candidateRevision !== "number" ||
        !Number.isInteger(candidateRevision) ||
        candidateRevision < 1
      ) {
        throw corrupt(`final plan candidate ${candidateKey} has a malformed identity`, { planID });
      }
      if (candidateKey !== `${candidateID}@${candidateRevision}`) {
        throw corrupt(`final plan candidate key ${candidateKey} does not match its identity ${candidateID}@${String(candidateRevision)}`, { planID });
      }
      // Hash recompute (§63).
      const candidateRest = { ...candidate } as Record<string, unknown>;
      delete candidateRest["id"];
      delete candidateRest["revision"];
      delete candidateRest["createdAt"];
      delete candidateRest["hash"];
      if (
        computeFinalPlanCandidateHashFromRecord(candidateRest as unknown as Parameters<typeof computeFinalPlanCandidateHashFromRecord>[0]) !==
        candidate["hash"]
      ) {
        throw corrupt(`final plan candidate ${candidateKey} content does not recompute to its frozen hash`, { planID, candidateKey });
      }
      // Bound authority: audit pass + clean report + exact input/manifest (§63).
      const auditRef = isRecord(candidate["evidenceAudit"]) ? (candidate["evidenceAudit"] as Record<string, unknown>) : undefined;
      const audit = auditRef && isRecord(audits[auditRef["id"] as string]) ? (audits[auditRef["id"] as string] as Record<string, unknown>) : undefined;
      if (!audit || auditRef?.["hash"] !== audit["hash"]) {
        throw corrupt(`final plan candidate ${candidateKey} references missing evidence audit ${String(auditRef?.["id"])}`, { planID, candidateKey });
      }
      if (audit["result"] !== "pass") {
        throw corrupt(`final plan candidate ${candidateKey} references a ${String(audit["result"])} evidence audit`, { planID, candidateKey });
      }
      const inputID = (isRecord(candidate["synthesisInput"]) ? (candidate["synthesisInput"] as Record<string, unknown>)["id"] : undefined) as string | undefined;
      const boundInput = isRecord(inputFamily[inputID as string]) ? (inputFamily[inputID as string] as Record<string, unknown>) : undefined;
      if (!boundInput || (candidate["synthesisInput"] as Record<string, unknown>)["hash"] !== boundInput["hash"]) {
        throw corrupt(`final plan candidate ${candidateKey} references missing synthesis input ${String(inputID)} (or a mismatched hash)`, { planID, candidateKey });
      }
      const manifestRef = isRecord(candidate["synthesisManifest"]) ? (candidate["synthesisManifest"] as Record<string, unknown>) : undefined;
      const manifestKey = manifestRef ? `${manifestRef["id"]}@${manifestRef["revision"]}` : undefined;
      const boundManifest = manifestKey && isRecord(manifests[manifestKey]) ? (manifests[manifestKey] as Record<string, unknown>) : undefined;
      if (!boundManifest || manifestRef?.["hash"] !== boundManifest["hash"]) {
        throw corrupt(`final plan candidate ${candidateKey} references missing synthesis manifest ${String(manifestKey)}`, { planID, candidateKey });
      }
      const reportID = (isRecord(candidate["semanticValidation"]) ? (candidate["semanticValidation"] as Record<string, unknown>)["reportID"] : undefined) as string | undefined;
      const boundReport = isRecord(reports[reportID as string]) ? (reports[reportID as string] as Record<string, unknown>) : undefined;
      if (!boundReport || (candidate["semanticValidation"] as Record<string, unknown>)["hash"] !== boundReport["hash"] || boundReport["result"] !== "clean") {
        throw corrupt(`final plan candidate ${candidateKey} references missing/non-clean validation report ${String(reportID)}`, { planID, candidateKey });
      }
      // Exact projection mirrors (§63): snapshot/commit, architecture,
      // sections, decisions, constraints, implementationOrder, limitations.
      const docEqual = (a: unknown, b: unknown): boolean => stableStringifyForDoc(a) === stableStringifyForDoc(b);
      const sectionRefs = Array.isArray(boundInput["sections"])
        ? (boundInput["sections"] as unknown[]).map((section) => (isRecord(section) ? section["ref"] : undefined))
        : [];
      if (
        !docEqual(candidate["baseSnapshot"], boundInput["baseSnapshot"]) ||
        candidate["baseCommit"] !== boundInput["baseCommit"] ||
        !docEqual(candidate["architecture"], boundInput["architecture"]) ||
        !docEqual(candidate["sections"], sectionRefs) ||
        !docEqual(candidate["decisions"], boundInput["decisions"]) ||
        !docEqual(candidate["constraints"], boundInput["constraints"]) ||
        !docEqual(candidate["implementationOrder"], boundManifest["implementationOrder"]) ||
        !docEqual(candidate["limitations"], boundManifest["limitations"])
      ) {
        throw corrupt(`final plan candidate ${candidateKey} is not the exact projection of its bound authority objects`, { planID, candidateKey });
      }
      const validation = candidate["validation"];
      if (
        !isRecord(validation) ||
        validation["blockingQuestions"] !== 0 ||
        validation["blockingConflicts"] !== 0 ||
        validation["invalidSections"] !== 0 ||
        validation["semanticValidation"] !== "clean" ||
        validation["evidenceAudit"] !== "pass"
      ) {
        throw corrupt(`final plan candidate ${candidateKey} carries an inconsistent validation summary`, { planID, candidateKey });
      }
    }
  }

  // -- Phase 2I committed FinalPlans (fail-closed, brief §70-§74) --------------
  // ADDITIVE family (pre-2I documents = "no Final PlanCommit has happened").
  // A FinalPlan is COMMITTED Plan Memory, so load validation proves the full
  // chain: hash + body projection recompute (§70), every exact ref resolves,
  // the bound candidate/input/manifest/report/audit exist with matching hashes
  // and the clean/pass results (§70), the payload is still the exact
  // deterministic projection of its candidate (§73 mutation cases), and the
  // run-pointer/commit/snapshot triangle is consistent (§71/§72/§74). No repair.
  const finalPlans = isRecord(doc.finalPlans) ? doc.finalPlans : {};
  const committedFamilies = isRecord(doc.committed) ? doc.committed : {};

  for (const [planID, family] of Object.entries(finalPlans)) {
    if (!isRecord(family)) throw corrupt(`final plan family ${planID} is not an object`);
    const candidateFamily = isRecord(finalPlanCandidates[planID]) ? (finalPlanCandidates[planID] as Record<string, unknown>) : {};
    const inputFamily2 = isRecord(synthesisInputs[planID]) ? (synthesisInputs[planID] as Record<string, unknown>) : {};
    const manifests2 = manifestFamilyFor(planID);
    const reports2 = isRecord(validationReports[planID]) ? (validationReports[planID] as Record<string, unknown>) : {};
    const audits2 = isRecord(evidenceAudits[planID]) ? (evidenceAudits[planID] as Record<string, unknown>) : {};
    const committed = isRecord(committedFamilies[planID]) ? (committedFamilies[planID] as Record<string, unknown>) : {};
    const architectures2 = isRecord(committed["architectures"]) ? (committed["architectures"] as Record<string, unknown>) : {};
    const sectionRevisions2 = isRecord(committed["sectionRevisions"]) ? (committed["sectionRevisions"] as Record<string, unknown>) : {};
    const decisions2 = isRecord(committed["decisions"]) ? (committed["decisions"] as Record<string, unknown>) : {};
    for (const [planKey, plan] of Object.entries(family)) {
      if (!isRecord(plan)) throw corrupt(`final plan ${planKey} is not an object`);
      const id = plan["id"];
      const revision = plan["revision"];
      if (typeof id !== "string" || id.length === 0 || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
        throw corrupt(`final plan ${planKey} has a malformed identity`, { planID });
      }
      if (planKey !== `${id}@${revision}`) {
        throw corrupt(`final plan key ${planKey} does not match its identity ${id}@${String(revision)}`, { planID });
      }
      if (plan["status"] !== "approved") {
        throw corrupt(`final plan ${planKey} is not approved; a committed FinalPlan exists only through an approved final transaction`, { planID, planKey });
      }
      if (typeof plan["approvedAt"] !== "string" || (plan["approvedAt"] as string).length === 0) {
        throw corrupt(`final plan ${planKey} is missing approvedAt (= the exact user Approval's createdAt)`, { planID, planKey });
      }
      // Hash + body projection recompute (§70/§14): the persisted body is a
      // hash-bound deterministic projection, never a second source of truth.
      const rest = { ...plan } as Record<string, unknown>;
      delete rest["hash"];
      if (
        computeFinalPlanHashFromContent(rest as unknown as Parameters<typeof computeFinalPlanHashFromContent>[0]) !==
        plan["hash"]
      ) {
        throw corrupt(`final plan ${planKey} content does not recompute to its frozen hash`, { planID, planKey });
      }
      try {
        if (renderFinalPlanBody(rest as unknown as Parameters<typeof renderFinalPlanBody>[0]) !== plan["body"]) {
          throw new Error("body differs from the deterministic projection of the structured payload");
        }
      } catch (error) {
        throw corrupt(`final plan ${planKey}: ${error instanceof Error ? error.message : String(error)}`, { planID, planKey });
      }
      // Bound candidate resolves with matching hash (§70).
      const candRef = isRecord(plan["finalPlanCandidate"]) ? (plan["finalPlanCandidate"] as Record<string, unknown>) : undefined;
      const candKey = candRef ? `${candRef["id"]}@${candRef["revision"]}` : undefined;
      const boundCandidate = candKey && isRecord(candidateFamily[candKey]) ? (candidateFamily[candKey] as Record<string, unknown>) : undefined;
      if (!boundCandidate || candRef?.["hash"] !== boundCandidate["hash"]) {
        throw corrupt(`final plan ${planKey} references missing final plan candidate ${String(candKey)}`, { planID, planKey });
      }
      // Derived provenance bindings resolve with matching hashes + results (§70).
      const inputRef = isRecord(plan["synthesisInput"]) ? (plan["synthesisInput"] as Record<string, unknown>) : undefined;
      const boundInput2 = inputRef && isRecord(inputFamily2[inputRef["id"] as string]) ? (inputFamily2[inputRef["id"] as string] as Record<string, unknown>) : undefined;
      if (!boundInput2 || inputRef?.["hash"] !== boundInput2["hash"]) {
        throw corrupt(`final plan ${planKey} references missing synthesis input ${String(inputRef?.["id"])}`, { planID, planKey });
      }
      const manRef = isRecord(plan["synthesisManifest"]) ? (plan["synthesisManifest"] as Record<string, unknown>) : undefined;
      const manKey = manRef ? `${manRef["id"]}@${manRef["revision"]}` : undefined;
      const boundManifest2 = manKey && isRecord(manifests2[manKey]) ? (manifests2[manKey] as Record<string, unknown>) : undefined;
      if (!boundManifest2 || manRef?.["hash"] !== boundManifest2["hash"]) {
        throw corrupt(`final plan ${planKey} references missing synthesis manifest ${String(manKey)}`, { planID, planKey });
      }
      const valRef = isRecord(plan["semanticValidation"]) ? (plan["semanticValidation"] as Record<string, unknown>) : undefined;
      const boundReport2 = valRef && isRecord(reports2[valRef["reportID"] as string]) ? (reports2[valRef["reportID"] as string] as Record<string, unknown>) : undefined;
      if (!boundReport2 || valRef?.["hash"] !== boundReport2["hash"] || valRef?.["result"] !== "clean" || boundReport2["result"] !== "clean") {
        throw corrupt(`final plan ${planKey} references a missing/non-clean validation report ${String(valRef?.["reportID"])}`, { planID, planKey });
      }
      const audRef = isRecord(plan["evidenceAudit"]) ? (plan["evidenceAudit"] as Record<string, unknown>) : undefined;
      const boundAudit2 = audRef && isRecord(audits2[audRef["id"] as string]) ? (audits2[audRef["id"] as string] as Record<string, unknown>) : undefined;
      if (!boundAudit2 || audRef?.["hash"] !== boundAudit2["hash"] || audRef?.["result"] !== "pass" || boundAudit2["result"] !== "pass") {
        throw corrupt(`final plan ${planKey} references a missing/blocked evidence audit ${String(audRef?.["id"])}`, { planID, planKey });
      }
      // Exact committed refs resolve (§70) + the payload is STILL the exact
      // deterministic projection of the bound candidate (§73 mutation cases:
      // tampered implementation order / limitations / section revisions /
      // constraints / architecture / provenance all differ from the candidate).
      const docEqual2 = (a: unknown, b: unknown): boolean => stableStringifyForDoc(a) === stableStringifyForDoc(b);
      if (docEqual2(plan["architecture"], boundCandidate["architecture"]) === false) {
        throw corrupt(`final plan ${planKey} architecture differs from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["sections"], boundCandidate["sections"]) === false) {
        throw corrupt(`final plan ${planKey} section refs differ from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["decisions"], boundCandidate["decisions"]) === false) {
        throw corrupt(`final plan ${planKey} decision refs differ from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["constraints"], boundCandidate["constraints"]) === false) {
        throw corrupt(`final plan ${planKey} constraints differ from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["implementationOrder"], boundCandidate["implementationOrder"]) === false) {
        throw corrupt(`final plan ${planKey} implementationOrder differs from its bound candidate`, { planID, planKey });
      }
      if (docEqual2(plan["limitations"], boundCandidate["limitations"]) === false) {
        throw corrupt(`final plan ${planKey} limitations differ from its bound candidate`, { planID, planKey });
      }
      if (
        docEqual2(plan["baseSnapshot"], boundCandidate["baseSnapshot"]) === false ||
        plan["baseCommit"] !== boundCandidate["baseCommit"] ||
        docEqual2(plan["synthesisInput"], boundCandidate["synthesisInput"]) === false ||
        docEqual2(plan["synthesisManifest"], boundCandidate["synthesisManifest"]) === false ||
        // semanticValidation/evidenceAudit legitimately carry the extra
        // committed `result` stamp ("clean"/"pass") — compare the binding
        // subset the candidate actually holds.
        (isRecord(plan["semanticValidation"]) && isRecord(boundCandidate["semanticValidation"])
          ? plan["semanticValidation"]["reportID"] !== boundCandidate["semanticValidation"]["reportID"] ||
            plan["semanticValidation"]["hash"] !== boundCandidate["semanticValidation"]["hash"] ||
            plan["semanticValidation"]["result"] !== "clean"
          : true) ||
        (isRecord(plan["evidenceAudit"]) && isRecord(boundCandidate["evidenceAudit"])
          ? plan["evidenceAudit"]["id"] !== boundCandidate["evidenceAudit"]["id"] ||
            plan["evidenceAudit"]["hash"] !== boundCandidate["evidenceAudit"]["hash"] ||
            plan["evidenceAudit"]["result"] !== "pass"
          : true)
      ) {
        throw corrupt(`final plan ${planKey} provenance differs from its bound candidate`, { planID, planKey });
      }
      const archRef = isRecord(plan["architecture"]) ? (plan["architecture"] as Record<string, unknown>) : undefined;
      if (!archRef || !architectures2[`ARCH@${archRef["revision"] as number}`]) {
        throw corrupt(`final plan ${planKey} architecture ARCH@${String(archRef?.["revision"])} does not resolve`, { planID, planKey });
      }
      for (const sectionRef of Array.isArray(plan["sections"]) ? (plan["sections"] as unknown[]) : []) {
        const ref = isRecord(sectionRef) ? sectionRef : undefined;
        if (!ref || !sectionRevisions2[`${ref["id"]}@${ref["revision"]}`]) {
          throw corrupt(`final plan ${planKey} section ${JSON.stringify(sectionRef)} does not resolve`, { planID, planKey });
        }
      }
      for (const decisionRef of Array.isArray(plan["decisions"]) ? (plan["decisions"] as unknown[]) : []) {
        const ref = isRecord(decisionRef) ? decisionRef : undefined;
        if (!ref || !decisions2[`${ref["id"]}@${ref["revision"]}`]) {
          throw corrupt(`final plan ${planKey} decision ${JSON.stringify(decisionRef)} does not resolve`, { planID, planKey });
        }
      }
    }
  }

  // Run-pointer / commit / snapshot consistency (§71/§72/§74) — impossible
  // states fail closed at load, never repaired.
  for (const [planID, run] of Object.entries(runs)) {
    if (!isRecord(run)) continue;
    const runFinalPlan = run["finalPlan"] as Record<string, unknown> | undefined | null;
    const family = isRecord(finalPlans[planID]) ? (finalPlans[planID] as Record<string, unknown>) : {};
    const familyKeys = Object.keys(family);
    if (runFinalPlan === undefined || runFinalPlan === null) {
      if (familyKeys.length > 0) {
        throw corrupt(`run ${planID} has committed FinalPlan(s) [${familyKeys.join(", ")}] but its finalPlan pointer is unset`, { planID });
      }
      continue;
    }
    const pointerKey = `${runFinalPlan["id"]}@${runFinalPlan["revision"]}`;
    if (!isRecord(family[pointerKey])) {
      throw corrupt(`run ${planID}.finalPlan references missing FinalPlan ${pointerKey}`, { planID });
    }
    if (familyKeys.length !== 1) {
      throw corrupt(`run ${planID} has ${familyKeys.length} committed FinalPlans for an initial-only family`, { planID });
    }
    if (run["lifecycle"] === "handoff_pending" || run["lifecycle"] === "completed") {
      const terminal = String(run["lifecycle"]);
      if (run["stage"] !== "final") {
        throw corrupt(`run ${planID} is ${terminal} but stage is ${String(run["stage"])} (must be final)`, { planID });
      }
      const headCommitID = run["headCommit"];
      const commitFamily = isRecord(commits[planID]) ? (commits[planID] as Record<string, unknown>) : {};
      const headCommit = typeof headCommitID === "string" ? commitFamily[headCommitID] : undefined;
      if (!isRecord(headCommit)) {
        throw corrupt(`${terminal} run ${planID} has no final PlanCommit at HEAD`, { planID });
      }
      const proposalFamily = isRecord(proposals[planID]) ? (proposals[planID] as Record<string, unknown>) : {};
      const commitProposal = proposalFamily[headCommit["proposalID"] as string];
      if (
        !isRecord(commitProposal) ||
        commitProposal["type"] !== "final_plan" ||
        commitProposal["status"] !== "approved"
      ) {
        throw corrupt(`${terminal} run ${planID}'s HEAD commit is not an approved final_plan transaction`, { planID });
      }
      const changes = headCommit["changes"];
      if (
        !Array.isArray(changes) ||
        !changes.some((change) => isRecord(change) && change["kind"] === "add_final_plan")
      ) {
        throw corrupt(`run ${planID}'s final PlanCommit does not record add_final_plan`, { planID });
      }
      const snapshotFamily2 = isRecord(snapshots[planID]) ? (snapshots[planID] as Record<string, unknown>) : {};
      const resultingSnapshot = snapshotFamily2[headCommit["resultingSnapshot"] as string];
      const snapshotState = isRecord(resultingSnapshot) ? resultingSnapshot["state"] : undefined;
      if (!isRecord(snapshotState) || snapshotState["finalPlanRevision"] !== runFinalPlan["revision"]) {
        throw corrupt(`run ${planID}'s final commit snapshot does not carry the committed finalPlan ref`, { planID });
      }
      const approvalFamily = isRecord(approvals[planID]) ? (approvals[planID] as Record<string, unknown>) : {};
      const approval = approvalFamily[headCommit["approvalID"] as string];
      if (!isRecord(approval) || approval["proposalID"] !== headCommit["proposalID"]) {
        throw corrupt(`run ${planID}'s final PlanCommit approval binding does not resolve`, { planID });
      }
      // §124: a completed run REQUIRES its confirmed delivered handoff.
      if (run["lifecycle"] === "completed") {
        const deliveries = isRecord((doc as { handoffDeliveries?: unknown }).handoffDeliveries)
          ? ((doc as { handoffDeliveries: Record<string, Record<string, unknown>> }).handoffDeliveries[planID] as Record<string, unknown> | undefined) ?? {}
          : {};
        const hasDelivered = Object.values(deliveries).some(
          (delivery) => isRecord(delivery) && delivery["state"] === "delivered",
        );
        if (!hasDelivered) {
          throw corrupt(`completed run ${planID} has no delivered handoff delivery`, { planID });
        }
      }
    }
  }
  // An approved final_plan proposal must have its final commit (§74).
  for (const [planID, family] of Object.entries(proposals)) {
    if (!isRecord(family)) continue;
    const commitByProposalFamily = isRecord(doc.commitByProposal) ? doc.commitByProposal : {};
    const commitFamily = isRecord(commits[planID]) ? (commits[planID] as Record<string, unknown>) : {};
    for (const [proposalID, proposal] of Object.entries(family)) {
      if (!isRecord(proposal) || proposal["type"] !== "final_plan" || proposal["status"] !== "approved") continue;
      const commitID = commitByProposalFamily[`${planID}:${proposalID}`];
      const commit = typeof commitID === "string" ? commitFamily[commitID] : undefined;
      if (!isRecord(commit)) {
        throw corrupt(`approved final_plan proposal ${proposalID} has no corresponding final commit`, { planID });
      }
      const changes = commit["changes"];
      if (
        !Array.isArray(changes) ||
        !changes.some((change) => isRecord(change) && change["kind"] === "add_final_plan")
      ) {
        throw corrupt(`final commit ${String(commitID)} does not record add_final_plan`, { planID });
      }
    }
  }

  // -- Phase 2J runtime handoff (fail-closed, §86/§87/§122/§123) --------------
  // ADDITIVE families (pre-2J documents = "no handoff has ever been prepared").
  // The handoff projection must equal the committed FinalPlan; the delivery
  // must obey the state machine — a receipt on a non-delivered state, a
  // delivered without a receipt, or a wrong session/key all fail closed. No
  // silent delivery repair happens here (§88): dispatching stays dispatching.
  const executionHandoffs = isRecord(doc.executionHandoffs) ? doc.executionHandoffs : {};
  const handoffDeliveries = isRecord(doc.handoffDeliveries) ? doc.handoffDeliveries : {};

  for (const [planID, family] of Object.entries(executionHandoffs)) {
    if (!isRecord(family)) throw corrupt(`execution handoff family ${planID} is not an object`);
    if (Object.keys(family).length > 1) {
      throw corrupt(`plan ${planID} has ${Object.keys(family).length} canonical ExecutionHandoffs (one per FinalPlan, §16)`, { planID });
    }
    const planFamily = isRecord(finalPlans[planID]) ? (finalPlans[planID] as Record<string, unknown>) : {};
    const run = runs[planID];
    for (const [handoffID, handoff] of Object.entries(family)) {
      if (!isRecord(handoff)) throw corrupt(`execution handoff ${handoffID} is not an object`);
      if (handoff["id"] !== handoffID) {
        throw corrupt(`execution handoff key ${handoffID} does not match its identity`, { planID });
      }
      if (computeExecutionHandoffHashFromRecord(handoff as unknown as Parameters<typeof computeExecutionHandoffHashFromRecord>[0]) !== handoff["hash"]) {
        throw corrupt(`execution handoff ${handoffID} content does not recompute to its frozen hash`, { planID });
      }
      if (!isRecord(run)) throw corrupt(`execution handoff ${handoffID} references missing run ${planID}`, { planID });
      if (handoff["sessionID"] !== run["sessionID"]) {
        throw corrupt(`execution handoff ${handoffID} is bound to another session than run ${planID}`, { planID });
      }
      const planRef = isRecord(handoff["finalPlan"]) ? (handoff["finalPlan"] as Record<string, unknown>) : undefined;
      const planKey = planRef ? `${planRef["id"]}@${planRef["revision"]}` : undefined;
      const finalPlan = planKey && isRecord(planFamily[planKey]) ? (planFamily[planKey] as Record<string, unknown>) : undefined;
      if (!finalPlan || finalPlan["hash"] !== handoff["finalPlanHash"] || finalPlan["status"] !== "approved") {
        throw corrupt(`execution handoff ${handoffID} references a missing/mismatched FinalPlan ${String(planKey)}`, { planID });
      }
      if (handoff["finalCommit"] !== run["headCommit"] || (isRecord(handoff["finalSnapshot"]) ? (handoff["finalSnapshot"] as Record<string, unknown>)["id"] : undefined) !== run["headSnapshot"]) {
        throw corrupt(`execution handoff ${handoffID} final commit/snapshot disagrees with run ${planID} HEAD`, { planID });
      }
      // §86: the projection must equal the deterministic FinalPlan projection.
      const docEqual3 = (a: unknown, b: unknown): boolean => stableStringifyForDoc(a) === stableStringifyForDoc(b);
      if (
        !docEqual3(handoff["sections"], finalPlan["sections"]) ||
        !docEqual3(handoff["criticalDecisions"], finalPlan["decisions"]) ||
        !docEqual3(handoff["implementationSteps"], finalPlan["implementationOrder"]) ||
        !docEqual3(handoff["knownLimitations"], (Array.isArray(finalPlan["limitations"]) ? finalPlan["limitations"] : []).map((limitation) => (isRecord(limitation) ? limitation["statement"] : ""))) ||
        !docEqual3(handoff["architecture"], finalPlan["architecture"]) ||
        !docEqual3(handoff["hardConstraints"], (Array.isArray(finalPlan["constraints"]) ? finalPlan["constraints"] : []).filter(
          (constraint) => isRecord(constraint) && constraint["severity"] === "hard" && constraint["status"] === "active",
        ))
      ) {
        throw corrupt(`execution handoff ${handoffID} is not the exact deterministic projection of its FinalPlan`, { planID });
      }
    }
  }

  for (const [planID, family] of Object.entries(handoffDeliveries)) {
    if (!isRecord(family)) throw corrupt(`handoff delivery family ${planID} is not an object`);
    const handoffFamily = isRecord(executionHandoffs[planID]) ? (executionHandoffs[planID] as Record<string, unknown>) : {};
    const run = runs[planID];
    for (const [handoffID, delivery] of Object.entries(family)) {
      if (!isRecord(delivery)) throw corrupt(`handoff delivery ${handoffID} is not an object`);
      const handoff = isRecord(handoffFamily[handoffID]) ? (handoffFamily[handoffID] as Record<string, unknown>) : undefined;
      if (!handoff) {
        throw corrupt(`handoff delivery ${handoffID} references missing execution handoff`, { planID });
      }
      if (delivery["handoffHash"] !== handoff["hash"]) {
        throw corrupt(`handoff delivery ${handoffID} carries a mismatched handoff hash`, { planID });
      }
      const state = delivery["state"];
      if (state !== "prepared" && state !== "dispatching" && state !== "delivered") {
        throw corrupt(`handoff delivery ${handoffID} carries an invalid state ${String(state)}`, { planID });
      }
      if (typeof delivery["deliveryKey"] !== "string" || !isRecord(run)) {
        throw corrupt(`handoff delivery ${handoffID} has a malformed deliveryKey or run binding`, { planID });
      }
      if (delivery["deliveryKey"] !== handoffDeliveryKey(planID as never, handoffID as never, handoff["hash"] as string)) {
        throw corrupt(`handoff delivery ${handoffID} carries a non-deterministic deliveryKey`, { planID });
      }
      if (delivery["sessionID"] !== run["sessionID"]) {
        throw corrupt(`handoff delivery ${handoffID} is bound to another session than run ${planID}`, { planID });
      }
      if (typeof delivery["attempt"] !== "number" || (delivery["attempt"] as number) < 0) {
        throw corrupt(`handoff delivery ${handoffID} has a malformed attempt counter`, { planID });
      }
      const receipt = isRecord(delivery["hostReceipt"]) ? (delivery["hostReceipt"] as Record<string, unknown>) : undefined;
      if (state === "delivered") {
        if (!receipt || typeof receipt["sessionID"] !== "string" || typeof receipt["messageID"] !== "string" || receipt["messageID"].length === 0) {
          throw corrupt(`delivered handoff delivery ${handoffID} has no valid host receipt`, { planID });
        }
        if (receipt["sessionID"] !== run["sessionID"] || delivery["sessionID"] !== run["sessionID"]) {
          throw corrupt(`handoff delivery ${handoffID} receipt session mismatches the run's trusted session`, { planID });
        }
        if (typeof delivery["deliveredAt"] !== "string") {
          throw corrupt(`delivered handoff delivery ${handoffID} is missing deliveredAt`, { planID });
        }
      } else if (receipt !== undefined) {
        // §87: a prepared/dispatching delivery must not carry a fake receipt.
        throw corrupt(`${String(state)} handoff delivery ${handoffID} carries a host receipt before confirmation`, { planID });
      }
    }
  }
}

/**
 * Hash over a stored proposal's canonical payload WITHOUT importing the
 * transaction engine — the exact same canonical serialization as
 * transaction/hash.ts (stableStringify: sorted keys, undefined dropped).
 */
function approvalHashForDoc(proposal: Record<string, unknown>): string {
  const payload = {
    id: proposal["id"],
    revision: proposal["revision"],
    type: proposal["type"],
    scope: proposal["scope"],
    title: proposal["title"],
    summary: proposal["summary"],
    changes: proposal["changes"],
    dependencies: proposal["dependencies"],
    impact: proposal["impact"],
    createdFrom: proposal["createdFrom"],
  };
  return createHash("sha256").update(stableStringifyForDoc(payload)).digest("hex");
}

function stableStringifyForDoc(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringifyForDoc).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringifyForDoc(v)}`).join(",")}}`;
}

