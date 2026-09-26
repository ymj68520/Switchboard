/**
 * Deterministic source-validation primitives (Phase 10 §11–§15/§45/§46).
 *
 * Fingerprint validation ALWAYS compares the CURRENT whole-file SHA-256
 * against the capture-time fingerprint recorded in the Evidence provenance
 * (§11) — Phase 10 never regenerates an "original fingerprint". Only
 * SHA-256 whole file + size + workspace-relative path participate; mtime is
 * advisory metadata, and no AST/symbol/semantic hashing exists (§12).
 *
 * Path resolution (§13): workspace-relative Evidence path → the exact bound
 * WorkspaceIdentity root → canonical safe resolution. `..` segments, absolute
 * caller paths, symlink escapes, and cross-workspace paths all fail closed.
 *
 * Reobserve semantics (§14/§45/§46): Phase Plan NEVER reruns commands; the
 * only deterministic signal is the coarse repository-revision comparison
 * (recorded gitHead ≠ current gitHead → needs_validation). HEAD unchanged is
 * NOT freshness; a directory workspace has no git revision and no equivalent
 * is ever invented.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { comparisonKey } from "../workspace/canonical-path.js";

export type FingerprintCheckStatus = "match" | "mismatch" | "unreadable";

export interface FingerprintCheckResult {
  status: FingerprintCheckStatus;
  /** The path whose fingerprint was checked (workspace-relative). */
  path: string;
  /** Present for match/mismatch: the freshly observed whole-file hash. */
  observedSha256?: string;
  observedSize?: number;
}

/**
 * §13 safe resolution: join the workspace-relative path onto the workspace
 * root, reject escapes lexically, then realpath both sides and re-verify
 * containment so symlinks cannot leave the workspace. Returns null when the
 * path escapes the workspace (fail closed) — a nonexistent file inside the
 * workspace resolves fine and is reported by the hash step as unreadable.
 */
export function resolveEvidenceSourcePath(workspaceRoot: string, relativePath: string): string | null {
  if (typeof relativePath !== "string" || relativePath.trim() === "") return null;
  if (path.isAbsolute(relativePath)) return null; // absolute caller-supplied path (§13)
  const joined = path.join(workspaceRoot, relativePath);
  const rootKey = comparisonKey(workspaceRoot);
  const joinedKey = comparisonKey(joined);
  if (joinedKey !== rootKey && !joinedKey.startsWith(`${rootKey}\\`) && !joinedKey.startsWith(`${rootKey}/`)) {
    return null; // lexical `..` escape
  }
  let realJoined = joined;
  try {
    realJoined = fs.realpathSync(joined);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    // Missing target: realpath the deepest existing ancestor to catch a
    // symlinked directory prefix, then re-verify containment.
    let prefix = path.dirname(joined);
    const candidates: string[] = [];
    while (true) {
      try {
        candidates.push(fs.realpathSync(prefix));
        break;
      } catch {
        const parent = path.dirname(prefix);
        if (parent === prefix) return joined;
        prefix = parent;
      }
    }
    const realPrefix = candidates[0]!;
    const tail = path.relative(prefix, joined);
    realJoined = path.join(realPrefix, tail);
  }
  const realKey = comparisonKey(realJoined);
  if (realKey !== rootKey && !realKey.startsWith(`${rootKey}\\`) && !realKey.startsWith(`${rootKey}/`)) {
    return null; // symlink escape
  }
  return realJoined;
}

/**
 * Re-hash one recorded fingerprint against the current file contents (§11/§12).
 * Unreadable/missing files are `unreadable` — a change signal, never `match`.
 */
export function checkSourceFingerprint(
  workspaceRoot: string,
  fingerprint: { path: string; sha256: string; size: number },
): FingerprintCheckResult {
  const resolved = resolveEvidenceSourcePath(workspaceRoot, fingerprint.path);
  if (resolved === null) {
    return { status: "unreadable", path: fingerprint.path };
  }
  let stat: fs.Stats;
  let bytes: Buffer;
  try {
    stat = fs.statSync(resolved);
    if (!stat.isFile()) return { status: "unreadable", path: fingerprint.path };
    bytes = fs.readFileSync(resolved);
  } catch {
    return { status: "unreadable", path: fingerprint.path };
  }
  const observedSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    status: observedSha256 === fingerprint.sha256 ? "match" : "mismatch",
    path: fingerprint.path,
    observedSha256,
    observedSize: stat.size,
  };
}

/** Check every recorded source fingerprint; first mismatch/unreadable wins. */
export function checkAllSourceFingerprints(
  workspaceRoot: string,
  fingerprints: Array<{ path: string; sha256: string; size: number }>,
): FingerprintCheckResult {
  let first: FingerprintCheckResult | null = null;
  for (const fingerprint of fingerprints) {
    const result = checkSourceFingerprint(workspaceRoot, fingerprint);
    if (result.status === "match") continue;
    if (first === null) first = result;
  }
  if (first !== null) return first;
  // Zero fingerprints cannot validate by fingerprint (fail closed upstream).
  return fingerprints.length === 0
    ? { status: "unreadable", path: "" }
    : { status: "match", path: fingerprints[0]!.path };
}

const GIT_HEAD_PATTERN = /^[0-9a-f]{40,64}$/;

/**
 * Coarse repository-revision probe (§15/§45): fixed argv, bounded time,
 * regex-validated output. Any failure — including a non-git directory —
 * returns null, and per §46 nothing is ever inferred from that.
 */
export function observeGitHeadSync(workspaceRoot: string): string | null {
  try {
    const outcome = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    if (outcome.status !== 0 || typeof outcome.stdout !== "string") return null;
    const head = outcome.stdout.trim().split(/\r?\n/)[0] ?? "";
    return GIT_HEAD_PATTERN.test(head) ? head : null;
  } catch {
    return null;
  }
}
