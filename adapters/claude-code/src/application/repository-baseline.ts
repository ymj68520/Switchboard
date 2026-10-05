/**
 * Repository baseline derivation (v0.1 Phase 14 §24/§25; reused by v0.2.0 E1 §7).
 *
 * The workspace baseline frozen at execution-handoff creation — and now at
 * ExecutionRun creation — captured once and never re-derived. The exact kind
 * vocabulary and git observation are shared by the handoff, ExecutionIssue,
 * successor-baseline, and ExecutionRun services so no second repository
 * identity system exists.
 */

import type { RepositoryBaseline } from "../core/execution-handoff.js";
import { RuntimeError } from "../runtime/errors.js";
import { observeGitHeadSync } from "../evidence/fingerprint-check.js";

/** §24/§25 — repository baseline frozen at handoff creation; never re-derived. */
export function deriveRepositoryBaseline(kind: string, workspaceRoot: string): RepositoryBaseline {
  if (kind !== "git_worktree") {
    return { kind: "directory", revision: null };
  }
  const head = observeGitHeadSync(workspaceRoot);
  if (head === null) {
    throw new RuntimeError(
      "HANDOFF_NOT_AUTHORIZED",
      "the git repository baseline is unavailable; the execution handoff cannot be derived",
      { detail: { workspaceRoot } },
    );
  }
  return { kind: "git", revision: head };
}
