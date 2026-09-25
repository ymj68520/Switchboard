/**
 * Content-addressed blob store for Observation payloads (Phase 9 §16–§18).
 *
 * Physical layout (frozen §16): `${CLAUDE_PLUGIN_DATA}/blobs/sha256/<aa>/<full-hash>`
 * — SQLite rows carry only payload_hash/payload_size/content_type; the bytes
 * live here. Publication algorithm (§17): bytes → sha256 → temp file in the
 * final directory → fsync → atomic rename onto the canonical path. Two
 * processes publishing the same bytes converge on ONE canonical object: the
 * rename is atomic and byte-identical, so both outcomes are success
 * (deduplicated), never partial.
 *
 * A blob file's NAME is its hash; reading re-verifies sha256(bytes) == hash
 * and fails closed (OBSERVATION_BLOB_CORRUPT) on any mismatch (§18) — a
 * corrupt payload can never reach Evidence promotion. A missing file for a
 * recorded hash is OBSERVATION_BLOB_MISSING.
 *
 * Orphan semantics (§43): the store NEVER deletes; unreferenced blobs after
 * a metadata-transaction rollback are harmless GC candidates for a later
 * phase. There is no cross-resource atomicity between the filesystem CAS and
 * SQLite by design.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { RuntimeError } from "../runtime/errors.js";

/** "sha256:<64 lowercase hex>" — the row-level reference form. */
export type PayloadHash = string;

const HEX64 = /^[0-9a-f]{64}$/;

export interface BlobPutResult {
  payloadHash: PayloadHash;
  payloadSize: number;
  /** True when the canonical object already existed (deduplicated, §17). */
  deduplicated: boolean;
}

export interface BlobStore {
  /** The `…/blobs/sha256` root this store publishes into. */
  readonly root: string;
  /** CAS-publish bytes; idempotent and race-safe (§17). */
  putBytes(bytes: Uint8Array): BlobPutResult;
  /** Read + re-verify a blob; fail closed on corruption/absence (§18). */
  readBytes(payloadHash: PayloadHash): Uint8Array;
  /** Existence check WITHOUT verification (fast paths only). */
  exists(payloadHash: PayloadHash): boolean;
}

export function blobHashOf(bytes: Uint8Array): PayloadHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function payloadHashHex(payloadHash: PayloadHash): string {
  const hex = payloadHash.startsWith("sha256:") ? payloadHash.slice("sha256:".length) : payloadHash;
  if (!HEX64.test(hex)) {
    throw new RuntimeError("OBSERVATION_BLOB_CORRUPT", `payload hash is not a sha256 digest: '${payloadHash}'`);
  }
  return hex;
}

function blobPath(root: string, payloadHash: PayloadHash): string {
  const hex = payloadHashHex(payloadHash);
  return path.join(root, hex.slice(0, 2), hex);
}

export function createBlobStore(blobsDir: string): BlobStore {
  const root = path.join(blobsDir, "sha256");

  function publish(bytes: Uint8Array, hex: string): BlobPutResult {
    const finalPath = path.join(root, hex.slice(0, 2), hex);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    // Temp file lives in the FINAL directory so the rename never crosses
    // volumes; the dot prefix keeps it out of the canonical namespace.
    const tempPath = path.join(path.dirname(finalPath), `.${hex}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = fs.openSync(tempPath, "wx");
    try {
      fs.writeSync(fd, bytes, 0, bytes.byteLength);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // If the canonical path appeared between the exists-check and the rename
    // (concurrent publisher), the rename re-publishes byte-identical content
    // atomically — one canonical object either way (§17).
    try {
      fs.renameSync(tempPath, finalPath);
    } catch (err) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // best-effort temp cleanup on the failure path
      }
      throw new RuntimeError("OBSERVATION_CAPTURE_FAILED", `cannot publish observation blob sha256:${hex}`, {
        cause: err instanceof Error ? err.message : String(err),
        detail: { root, finalPath },
      });
    }
    return { payloadHash: `sha256:${hex}`, payloadSize: bytes.byteLength, deduplicated: false };
  }

  return {
    root,
    putBytes(bytes: Uint8Array): BlobPutResult {
      const hex = createHash("sha256").update(bytes).digest("hex");
      const finalPath = path.join(root, hex.slice(0, 2), hex);
      try {
        if (fs.statSync(finalPath).isFile()) {
          return { payloadHash: `sha256:${hex}`, payloadSize: bytes.byteLength, deduplicated: true };
        }
      } catch {
        // absent — publish below
      }
      return publish(bytes, hex);
    },
    readBytes(payloadHash: PayloadHash): Uint8Array {
      const finalPath = blobPath(root, payloadHash);
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(finalPath);
      } catch {
        throw new RuntimeError("OBSERVATION_BLOB_MISSING", `observation payload blob is missing: ${payloadHash}`, {
          detail: { payloadHash, path: finalPath },
        });
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== payloadHashHex(payloadHash)) {
        throw new RuntimeError(
          "OBSERVATION_BLOB_CORRUPT",
          `observation payload blob content does not match its hash: ${payloadHash}`,
          { detail: { payloadHash, path: finalPath } },
        );
      }
      return bytes;
    },
    exists(payloadHash: PayloadHash): boolean {
      try {
        return fs.statSync(blobPath(root, payloadHash)).isFile();
      } catch {
        return false;
      }
    },
  };
}
