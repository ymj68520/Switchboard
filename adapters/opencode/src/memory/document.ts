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

export const STORE_SCHEMA_VERSION = 1;

/**
 * Authoritative durable state. Record keys:
 * - committed artifacts: `ID@REVISION` (architectures use `ARCH@N`)
 * - sections: SectionID
 * - proposals/approvals/commits/snapshots: their own ids
 * - evidence: `EVD-###@REVISION`
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

