/**
 * Host path canonicalization (frozen plan §13/§41).
 *
 * One explicit abstraction — no scattered toLowerCase()/separator replaces:
 *
 *   1. `path.resolve` the input (absolute, trailing separator resolved);
 *   2. `fs.realpathSync` when the path exists — the filesystem's own answer,
 *      which resolves symlink aliases AND returns true on-disk casing on
 *      case-insensitive filesystems;
 *   3. strip a trailing separator (kept for filesystem roots).
 *
 * Case policy: trust the native realpath casing; never blanket-lowercase
 * (Unix paths are case-sensitive). Non-existent paths are an error for
 * workspace discovery — a workspace observation needs a real directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { RuntimeError } from "../runtime/errors.js";

/** A realpath-resolved, separator-stable absolute path. */
export interface CanonicalPath {
  /** Native canonical form (what gets stored as locator/root). */
  readonly value: string;
  /** Comparison key: native form, lowercased ONLY on case-insensitive platforms. */
  readonly key: string;
}

export function canonicalizeExistingPath(input: string): CanonicalPath {
  const resolved = path.resolve(input.trim());
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new RuntimeError("WORKSPACE_UNAVAILABLE", `workspace path does not exist: ${resolved}`, {
        detail: { path: resolved },
      });
    }
    throw new RuntimeError("WORKSPACE_UNAVAILABLE", `cannot canonicalize workspace path: ${resolved}`, {
      cause: err instanceof Error ? err.message : String(err),
      detail: { path: resolved },
    });
  }
  return { value: stripTrailingSeparator(real), key: comparisonKey(real) };
}

/**
 * Comparison key for in-memory equality decisions. Windows (and macOS by
 * default) resolve case-insensitively — realpath already yields true casing,
 * so the key lowercases only on win32 to absorb drive-letter/casing drift in
 * user input BEFORE resolution.
 */
export function comparisonKey(nativePath: string): string {
  const normalized = nativePath.replace(/[/\\]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stripTrailingSeparator(value: string): string {
  const parsed = path.parse(value);
  if (parsed.root === value) {
    return value; // filesystem root keeps its separator
  }
  return value.replace(/[\\/]+$/, "");
}
