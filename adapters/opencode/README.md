# Ultra Plan for OpenCode

**A deterministic planning harness for OpenCode.** Ultra Plan turns a goal into an approved, auditable implementation plan inside your normal OpenCode session: the model proposes, a deterministic harness freezes and validates every artifact, you approve every committed change, and the finished plan is handed to OpenCode's Build agent in the same session.

Ultra Plan is **not** a model and **not** a router. It is a workflow layer that makes the planning loop deterministic: the model never names authoritative objects, never commits anything, and never approves anything. Every committed fact entered through an explicit user approval of an exact proposal.

---

## Supported environment (validated release boundary)

```text
OpenCode CLI  1.18.32        (validated version — no other version is claimed)
Node.js       24.21.0        (validated version; Node 24.x is the declared compatible family)
OS            Windows        (10.0.19044 validated; no macOS/Linux claim)
```

These versions were used for every automated and live validation of this release. Compatibility with other versions is neither tested nor claimed — do not upgrade OpenCode past 1.18.32 within this release line.

## Installation

Ultra Plan is distributed as a **GitHub Release asset**. Download the release tarball, install it into your project from the downloaded file, and register the plugin with a one-line shim.

```text
1. download switchboard-opencode-0.1.0.tgz
   from the GitHub Release assets
2. npm install ./switchboard-opencode-0.1.0.tgz
3. create .opencode/plugin/ultra-plan.js containing exactly:
      export { default } from "@switchboard/opencode";
4. start OpenCode normally
5. invoke /ultra-plan <goal>
```

The package is not published to the npm registry; the GitHub Release tarball is the only supported installation source.

On startup the plugin registers the `/ultra-plan` command, the `ultraplan` planning agent, and the `ultraplan_*` tool family. Pin the session model in `opencode.json` as usual — Ultra Plan uses the session's configured model for planning and OpenCode's native `build` agent for execution.

## Configuration

Everything is optional; there are no required environment variables.

| Setting | Default | Meaning |
|---|---|---|
| `ULTRA_PLAN_CONTEXT_BUDGET_TOKENS` | `12000` | Estimated-token budget for the planning context injected into each model request. Invalid values fall back to the default. |
| `ULTRA_PLAN_CONTEXT_OVERFLOW` | `render` | What happens when required context exceeds the budget: `render` renders all required context and flags the overflow; `fail` refuses the turn with `context_budget_exceeded`. |
| `ULTRA_PLAN_DATA_DIR` | `~/.local/share/switchboard/ultra-plan/projects/` | Root directory for durable plan stores. |

Model selection: the **planning model** is the OpenCode/session configured model; the **execution agent** is OpenCode's native `build`; the **execution model** is the host default. Ultra Plan performs no dynamic routing.

## Usage

```text
/ultra-plan <goal>     start or resume the planning run for this session
/ultra-plan            resume (never overwrites an existing goal)
```

The run lives in your session. You progress it by talking to the planning agent; the harness moves the run through **discovery → architecture → detail → synthesis → final** and enforces what may happen at each stage.

## Planning vs committed state

Ultra Plan separates three kinds of state:

- **Working state** — the current stage, open questions, conflicts, the current proposal. Visible, changeable, not yet real.
- **Committed Plan Memory** — architecture, decisions, sections, contracts, the final plan. Immutable once committed; changed only by an approved amendment/reopen flow. Every commit is one atomic, hash-verified transaction.
- **Evidence** — repository observations with confidence and freshness. A separate trust domain; evidence never silently rewrites committed memory.

Each model request receives a deterministic context assembled from committed state (protocol, run state, goal, hard constraints, architecture, active scope, evidence, current proposal, available operations) — never from conversation history. Compaction can remove discussion; it cannot remove committed design.

## Questions, conflicts, and blockers

The model can record questions and raise conflicts. `blocking` ones stop finalization and intersecting commits until cured. Every blocker has a sanctioned cure: a user-approved resolution/amendment proposal, a blocker-driven reopen back into design, or — always — the explicit abort below.

## Approvals

Nothing reaches committed state without you. A proposal is frozen with a canonical hash; your approval binds that exact id/revision/hash (a real Allow in the OpenCode dialog — no "always allow" shortcut exists); the commit then validates everything again and publishes atomically. If the proposal drifted before you clicked Allow, the approval is refused with zero state change.

## Abort

`ultraplan_request_abort` ends an active run after a real one-shot confirmation. Committed memory, approvals, commits, and evidence are untouched; the run becomes terminal; a new `/ultra-plan` starts a fresh run. Abort is an escape hatch, never a blocker resolution.

## Architecture remediation

Approved design changes only through reopen → amendment → re-approval. An architecture-level finding opens the Architecture itself (no section churn); the approved amendment invalidates the current section decomposition — old sections remain exact history, and a fresh decomposition is required against the new architecture revision. Section provenance (which architecture revision a DAG came from) is durable data, verified at load.

## Persistent data location and backup

One durable store per project identity:

```text
<ULTRA_PLAN_DATA_DIR | ~/.local/share/switchboard/ultra-plan/projects/>/<sha256-prefix>/plan-store.json
```

The store is a single JSON document published atomically (write-temp-rename). **Do not hand-edit it.** Back up the file before major plugin upgrades. Disabling or uninstalling the plugin never deletes your data.

## Restart / resume

State is durable across OpenCode restarts. Reopen the project and run `/ultra-plan` (or just continue) — the run resumes from committed state with IDs continuing where they left off. A run interrupted mid-handoff recovers automatically.

## Final approval and the Build handoff

Synthesis produces a frozen input, a provenance-bound manifest, an isolated-session semantic validation, and an evidence audit; a deterministic finalization gate decides — the model cannot. The final plan requires one more explicit approval (verified twice: pre-ask and inside the commit). The commit publishes the FinalPlan and moves the run to `handoff_pending`; the harness then dispatches a deterministic ExecutionHandoff to OpenCode's `build` agent **in the same session**, confirms delivery from the host's history, and marks the run `completed`. The final commit chain is immutable.

## Known limitations

- Validated only on OpenCode CLI 1.18.32, Node 24.21.0, Windows.
- No Build execution tracking, no execution-issue/replanning workflow, no automatic FinalPlan amendment (explicitly out of v0.1 scope).
- Context token counts are conservative estimates, not provider billing tokens.
- The durable store is a whole document: publication is O(state) — fine for planning-scale data, not a database.
- Handoff delivery confirmation scans session history within a bounded loop.
- Live validation used free-tier gateway models; those legs inherit gateway availability.

## Troubleshooting

| Error | Meaning | What to do |
|---|---|---|
| `store_corrupt` | The durable store failed validation (invalid JSON, hash mismatch, broken reference, inconsistent conflict/provenance state). The store is never auto-repaired. | Restore your backup of `plan-store.json`; do not hand-edit. |
| `store_busy` | Another writer holds the store lock (bounded 4 s wait exhausted). | Retry; after a killed process the lock self-heals within ~15 s. |
| `store_version_unsupported` | The store was written by a NEWER plugin version. | Upgrade the plugin; the store is refused rather than misread. |
| `context_budget_exceeded` | Required planning context exceeded the configured budget (`overflow=fail`), or rendered complete with a warning (default). | Raise `ULTRA_PLAN_CONTEXT_BUDGET_TOKENS`. |
| `start_not_authorized` | `ultraplan_start` was invoked without the `/ultra-plan` command. | Use `/ultra-plan`. |
| `capability_not_available` | The operation is not valid in the current stage/substate. | Check the status block / L5 checklist. |

## License

MIT — see the included [LICENSE](LICENSE) file.

---

**Package:** `@switchboard/opencode` — protocol contract: `docs/opencode/spec/opencode-ultra-plan-agent-protocol.md` (v0.13); frozen architecture: `docs/opencode/spec/opencode-ultra-plan-architecture.md`.
