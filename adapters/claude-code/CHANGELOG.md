# Changelog

All notable user-visible changes to the Phase Plan plugin are documented
here. Versions follow the plugin manifest (`.claude-plugin/plugin.json`),
which is the single release version source.

## 0.1.1

Re-release build of the v0.1.0 content at version 0.1.1: the release-version validation pass (Phase 18 R8) exercised the plugin-update channel (0.1.0 → 0.1.1) and confirmed plugin-data persistence across updates. No product changes.

## 0.1.0

First public release of Phase Plan v0.1 for Claude Code.

- **Persistent Plan Store** — every planning artifact (runs, proposals,
  commits, evidence, sections, validation reports) is durably recorded in a
  schema-versioned SQLite store under the host-managed plugin data root,
  with automatic pre-migration backups and fail-closed corruption and
  downgrade handling.
- **Approval-driven planning** — a full Discovery → Evidence → Architecture
  → Detail → Sections → Synthesis → Finalization lifecycle in which every
  committed change passes through a frozen proposal and a mandatory human
  approval dialog; Deny always means zero mutation.
- **Evidence freshness** — proposals pin exact evidence revisions; file
  changes invalidate stale evidence, propagate `needs_review` to dependent
  sections, and drive targeted replanning instead of silent drift.
- **Section workflow** — DAG-ordered sections with atomic completion,
  reopen, and revision tracking across sessions.
- **Isolated semantic validator** — a read-only validator subagent
  attests synthesis quality before finalization; found issues route back
  through explicit recovery instead of being papered over.
- **Finalization + same-session handoff** — an explicit Final Approval
  freezes the final plan and hands it to execution in the same session,
  with generation-fenced bindings that refuse stale executors.
- **Execution replanning** — execution issues can open successor planning
  runs that inherit completed work from their predecessor.
- **Recovery and concurrency safety** — crash resume (A1), session
  takeover, fencing, and terminal abort (A2) with audit-recorded
  tombstones; all authority transitions are signed by the host and keyed
  to one canonical plugin data location.
- **Read-only diagnostics** — `doctor` (human and `--json`) reports
  runtime, host, storage, and capability status without ever mutating the
  store; `--version` prints the release identity.

### Compatibility requirements

- Claude Code plugin host (validated on 2.1.284; mandatory approval
  dialogs require ≥ 2.1.199).
- Node.js ≥ 24.15.0 (built-in `node:sqlite`); the MCP server refuses to
  start on older Node.
- No `npm install`, no external database, no Python — the plugin is fully
  self-contained.
