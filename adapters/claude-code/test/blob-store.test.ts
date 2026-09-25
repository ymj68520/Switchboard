/**
 * Blob CAS invariants (Phase 9 §16–§19, §43, §65) — Windows included.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createBlobStore, payloadHashHex } from "../src/store/blob-store.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("observation payload blob CAS (§16–§19, §43, §65)", () => {
  it("same bytes → same hash and one canonical object (dedup)", () => {
    const root = makeTempPluginDataRoot("phase-plan-blob-");
    try {
      const blobs = createBlobStore(path.join(root, "blobs"));
      const bytes = Buffer.from("PHASE9 BLOB PAYLOAD alpha", "utf8");
      const first = blobs.putBytes(bytes);
      const second = blobs.putBytes(bytes);
      expect(first.deduplicated).toBe(false);
      expect(second).toEqual({ payloadHash: first.payloadHash, payloadSize: bytes.byteLength, deduplicated: true });
      expect(first.payloadHash).toBe(sha256(bytes));
      const hex = payloadHashHex(first.payloadHash);
      expect(fs.existsSync(path.join(blobs.root, hex.slice(0, 2), hex))).toBe(true);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("parallel writers converge on one canonical blob object (§65, race-safe §17)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-blob-race-");
    try {
      const blobs = createBlobStore(path.join(root, "blobs"));
      const bytes = Buffer.from("PHASE9 RACE PAYLOAD".repeat(64), "utf8");
      const results = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          // Interleave synchronous publications from parallel "processes".
          if (i % 2 === 0) return blobs.putBytes(bytes);
          await new Promise((resolve) => setTimeout(resolve, i));
          return blobs.putBytes(bytes);
        }),
      );
      expect(new Set(results.map((r) => r.payloadHash))).toHaveLength(1);
      const hex = payloadHashHex(results[0]!.payloadHash);
      const canonical = path.join(blobs.root, hex.slice(0, 2), hex);
      expect(sha256(fs.readFileSync(canonical))).toBe(results[0]!.payloadHash);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("read verifies sha256(bytes) == recorded hash; corrupt → OBSERVATION_BLOB_CORRUPT (§18)", () => {
    const root = makeTempPluginDataRoot("phase-plan-blob-corrupt-");
    try {
      const blobs = createBlobStore(path.join(root, "blobs"));
      const published = blobs.putBytes(Buffer.from("integrity check", "utf8"));
      expect(Buffer.from(blobs.readBytes(published.payloadHash)).toString("utf8")).toBe("integrity check");

      const hex = payloadHashHex(published.payloadHash);
      fs.writeFileSync(path.join(blobs.root, hex.slice(0, 2), hex), Buffer.from("tampered", "utf8"));
      try {
        blobs.readBytes(published.payloadHash);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RuntimeError);
        expect((err as RuntimeError).code).toBe("OBSERVATION_BLOB_CORRUPT");
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("missing blob file → OBSERVATION_BLOB_MISSING; a rollback-orphaned blob is harmless (§43)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-blob-orphan-");
    try {
      const blobs = createBlobStore(path.join(root, "blobs"));
      const published = blobs.putBytes(Buffer.from("orphan candidate", "utf8"));
      // Simulate the §43 rollback: metadata transaction rolled back, blob stays.
      const hex = payloadHashHex(published.payloadHash);
      const orphanPath = path.join(blobs.root, hex.slice(0, 2), hex);
      expect(fs.existsSync(orphanPath)).toBe(true);
      // No DB row references it — reads of UNRECORDED hashes fail closed…
      try {
        blobs.readBytes(`sha256:${"0".repeat(64)}`);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as RuntimeError).code).toBe("OBSERVATION_BLOB_MISSING");
      }
      // …and the orphan itself stays readable/verifiable (GC candidate only).
      expect(Buffer.from(blobs.readBytes(published.payloadHash)).toString("utf8")).toBe("orphan candidate");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("refuses malformed payload hashes (fail closed, not a path-traversal surface)", () => {
    const root = makeTempPluginDataRoot("phase-plan-blob-shape-");
    try {
      const blobs = createBlobStore(path.join(root, "blobs"));
      for (const bad of ["sha256:zzzz", "sha256:../..", "deadbeef", "sha256:"]) {
        try {
          blobs.readBytes(bad);
          throw new Error(`should have thrown for ${bad}`);
        } catch (err) {
          expect((err as RuntimeError).code).toBe("OBSERVATION_BLOB_CORRUPT");
        }
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
