/**
 * ExecutionHandoff canonical hash (Phase 2J brief §15) — the existing derived
 * -artifact convention: canonical hashable projection = the full semantic
 * payload EXCLUDING id/createdAt/hash (pure persistence metadata and the hash
 * itself). Any authority-bearing change — FinalPlan hash, implementation
 * steps, constraints, contracts, decisions, limitations, validation
 * requirements, section refs, goal — changes the handoff hash.
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../core/invariants.js";
import type { ExecutionHandoff } from "./types.js";

/** §15/§16: excludes the hash itself + pure persistence metadata (id/createdAt). */
export type ExecutionHandoffHashPayload = Omit<ExecutionHandoff, "id" | "createdAt" | "hash">;

export function executionHandoffHashPayload(handoff: ExecutionHandoff): ExecutionHandoffHashPayload {
  const { id: _id, createdAt: _createdAt, hash: _hash, ...payload } = handoff;
  void _id;
  void _createdAt;
  void _hash;
  return payload;
}

export function computeExecutionHandoffHash(payload: ExecutionHandoffHashPayload): string {
  const digest = createHash("sha256");
  digest.update(stableStringify(payload));
  return digest.digest("hex");
}

/** Recompute from a stored record (durable load validation, §86). */
export function computeExecutionHandoffHashFromRecord(record: ExecutionHandoff): string {
  return computeExecutionHandoffHash(executionHandoffHashPayload(record));
}
