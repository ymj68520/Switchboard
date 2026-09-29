# Phase Plan

Persistent, approval-driven planning for Claude Code. Phase Plan runs a
structured planning lifecycle — Discovery → Evidence → Architecture →
Detail → Sections → Synthesis → Validator → Finalization → Execution
handoff — inside your repository, with a durable store that survives
sessions, crashes, and Claude Code restarts.

Nothing enters the plan without a human approval: every design decision is
frozen into an immutable proposal, shown to you in a dialog, and committed
only when you approve it.

## Requirements

| Requirement | Why |
| --- | --- |
| Claude Code plugin host (validated on 2.1.284; approval dialogs require ≥ 2.1.199) | plugin discovery, hooks, MCP, mandatory approval dialogs |
| Node.js ≥ 24.15.0 on PATH | the runtime bundle uses the built-in `node:sqlite` store |

Installing Claude Code does **not** install a usable Node 24 — verify with
`node --version` (Windows users: check PATH precedence explicitly; a
bundled or older `node.exe` earlier on PATH is the most common failure).
Phase Plan never runs `npm install` and needs no Python, no external
`sqlite3` binary, and no compiler.

## Installation

Install from a marketplace that lists the `phase-plan` plugin:

```
/plugin marketplace add <marketplace>
/plugin install phase-plan@<marketplace>
```

Then restart Claude Code. Verify the installation in any directory with:

```
node "$CLAUDE_PLUGIN_ROOT/dist/phase-plan-runtime.mjs" --version
```

(inside a plugin session) or run the doctor from the installed plugin
directory (see *Troubleshooting*). Upgrades use `/plugin update` — plugin
data (plans, history, signing secret) is stored outside the plugin cache
and survives updates. Manual downgrades to older plugin versions are
unsupported unless a release note explicitly documents the path.

## Starting a plan

In any git repository (or any project directory), run:

```
/phase-plan <what you want planned>
```

If your host only exposes namespaced skills, the command may appear as
`/phase-plan:phase-plan` — that is the same entry. Phase Plan attaches to
the session, opens (or resumes) the persistent plan run, and drives the
workflow with you. If another session already owns the active run, you are
shown the candidate and asked before anything attaches.

## The human approval model

- **Proposals are frozen, then approved.** The assistant cannot commit a
  design change by itself. Each proposal is snapshotted (id + revision +
  content hash) and must be confirmed by you via a mandatory approval
  dialog. Denying a dialog produces zero mutation.
- **Evidence goes stale.** Proposals pin the exact evidence revisions they
  rest on. When the underlying files change, the affected evidence is
  invalidated and dependent sections return to review automatically.
- **Validation is isolated.** Before finalization a read-only validator
  subagent reviews the frozen context and must report clean.
- **Final approval gates execution.** The finalized plan only becomes an
  execution handoff after your explicit Final Approval, delivered back into
  the same session.

## A1 — resuming across sessions (crash/restart UX)

Plan state is durable and version-fenced. If Claude Code exits or the
session dies mid-run, start `/phase-plan` again in a new session: the run
resumes at its last committed revision with an explicit capsule of what
happened while you were away. Nothing is re-approved and nothing is lost.
A different session can only take the run over through the same explicit,
auditable takeover path.

## A2 — abort UX

`/phase-plan abort` (or asking the assistant to abort) requires an explicit
human confirmation dialog and leaves an audit-recorded tombstone. Aborted
runs are terminal: their history stays readable, but they can never be
resumed or mutated. A follow-up plan starts a fresh run and may reference
the aborted one.

## Plan Store location

All persistent state lives under the host-managed plugin data root
(`${CLAUDE_PLUGIN_DATA}`):

```
store/phase-plan.sqlite3   durable plan store (SQLite, schema-versioned)
store/backups/             automatic pre-migration backups
blobs/                     content-addressed observation payloads
runtime/host-context.key   per-install signing secret (created on first run)
capability-proofs.json     recorded host capability probes
```

The store is created on the first MCP startup. Uninstalling the plugin
leaves this data in place (removing the plugin does not delete your
planning history); deleting the plugin data directory is the only way to
reset it. Never edit or move store files while a session is running.

## Doctor

Run from the installed plugin directory:

```
node dist/phase-plan-runtime.mjs doctor          # human-readable report
node dist/phase-plan-runtime.mjs doctor --json   # machine-readable report
node dist/phase-plan-runtime.mjs --version       # release identity
```

The doctor is strictly read-only: it never migrates, repairs, or mutates
the store, and it never prints secrets. It reports the runtime version,
Node and `node:sqlite` status, the detected Claude Code version and
capabilities, the plugin environment, plugin-data writability, and the
Plan Store schema state. On a Node older than 24.15 it still runs and tells
you exactly that; the MCP server, by contrast, refuses to start
(`UNSUPPORTED_NODE_VERSION`).

## Troubleshooting

- **`UNSUPPORTED_NODE_VERSION` / node FAIL in doctor** — Node 24.15+ is not
  what the runtime resolved. Fix PATH so a real Node 24.15+ comes first.
- **Tool calls arrive with missing arguments** — a stale host-side MCP
  schema cache. Update the plugin (each release ships a new version, which
  refreshes the cache); restarting Claude Code also reconnects the MCP
  server.
- **`STALE_SESSION_BINDING`** — the run moved to another session or a newer
  binding generation. Re-enter `/phase-plan` and follow the takeover or
  selection prompt instead of retrying.
- **`STORE_SCHEMA_TOO_NEW`** — the plugin is older than the store. Upgrade
  the plugin; the store is never touched automatically.
- **`WORKSPACE_MISMATCH`** — the run belongs to a different workspace.
  Start a new run in this workspace or re-enter from the original one.

## Known host notes

- Validated host line: Claude Code 2.1.284 (capability floor for mandatory
  approval dialogs: 2.1.199). Other versions are expected to work but are
  validated by capability checks (run `doctor`) rather than a blanket
  version claim.
- Tool Search does not bypass Phase Plan's PreToolUse signing; no special
  Tool Search setting is required. Setting `ENABLE_TOOL_SEARCH=false` is a
  diagnostic workaround, not a requirement.
- Phase Plan never modifies `~/.claude/settings.json`, project settings, or
  `defaultMode`. Plan Mode is requested per-session, at runtime.
