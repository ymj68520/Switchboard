# Ultra Plan for OpenCode

**A deterministic planning-and-execution harness for OpenCode.** Ultra Plan turns a goal into an approved, auditable implementation plan inside your normal OpenCode session: the model proposes, a deterministic harness freezes and validates every artifact, you approve every committed change — and after Final Approval the plan is executed under a supervised execution protocol (a Supervisor that directs, Workers that act, independent Verifiers, and a Core that owns every authoritative transition).

Ultra Plan is **not** a model and **not** a router. It is a workflow layer that makes the loop deterministic: the model never names authoritative objects, never commits anything, and never approves anything. Every committed fact entered through an explicit user approval of an exact proposal.

---

## Supported environment (validated release boundary)

```text
OpenCode CLI  1.18.32        (validated version — no other version is claimed)
Node.js       24.21.0        (validated version; the declared compatible family is >=24.21.0 <25)
OS            Windows        (10.0.19044 validated; no macOS/Linux claim)
```

These versions were used for every automated and live validation of this release. Compatibility with other versions is neither tested nor claimed — do not upgrade OpenCode past 1.18.32 within this release line.

### Provider support (validator boundary)

| Capability | Provider/model claim |
|---|---|
| Planning, approvals, context assembly, durable restart, same-session Build handoff | Live-validated on `opencode/ling-3.0-flash-fin-free` (OpenCode free-tier Console provider) |
| **Semantic validation (synthesis stage)** | **NOT supported on any free-tier `opencode/*` model.** The production validator issues its isolated inference with a per-request tools-disable map (structural tool isolation); the free-tier Console provider rejects ANY request that carries a tools map (`OpenCode's free tier can only be used from within OpenCode`), so validation can never complete there. A provider/model that permits this request shape is required; none was configured or proven during this release's validation. |

This is a provider policy boundary of the free tier, not a generic OpenCode incompatibility. With an affected provider, everything up to synthesis works, but clean semantic validation — and therefore final approval and handoff — cannot complete.

## Installation

Ultra Plan is distributed as a **GitHub Release asset**. Download the release tarball, install it into your project from the downloaded file, and register the plugin with a one-line shim.

```text
1. download switchboard-opencode-0.2.0.tgz
   from the GitHub Release assets
2. npm install ./switchboard-opencode-0.2.0.tgz
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
/ultra-plan <goal>     start a run with this goal; on resume, fills an EMPTY goal only — never overwrites
/ultra-plan            start an unnamed run, or resume the existing run
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

Synthesis produces a frozen input, a provenance-bound manifest, an isolated-session semantic validation, and an evidence audit; a deterministic finalization gate decides — the model cannot. The final plan requires one more explicit approval (verified twice: pre-ask and inside the commit). The commit publishes the FinalPlan, moves the run to `handoff_pending`, and durably records the `supervised_v0_2` handoff protocol.

## Supervised execution (v0.2.0 production path)

After Final Approval, the run no longer falls back to a free-Build handoff. `/ultra-plan` enters the **supervised execution** state machine:

```text
Final Approval (handoff_pending, supervised_v0_2)
  → prepareInitialExecutionRun        (exactly one ExecutionRun per Final Approval)
  → SupervisorBinding                 (owner = the trusted user session; generation fencing)
  → ExecutionRun active → PlanningRun completed
  → production pump, driven by the Supervisor model:
      derive the Stage decomposition (§JIT — from the approved FinalPlan only)
      activate a Stage → open its VerificationWindow → issue Directives
      Workers execute through OpenCode repository tools in FRESH child sessions
      independent Verifiers verify candidates; conflicts and indeterminate
      side effects go through the frozen conflict/reconciliation protocols
      accept → ExecutionCommit (the only acceptedHead advancer)
  → final_closure Stage → ExecutionCompletionGate → ExecutionRun completed
```

Supervisor, Workers, and Verifiers are mechanically isolated (per-call host tool maps over the DISCOVERED host tool inventory — the Supervisor gets no host tools at all; Workers only the capability-mapped tools; OpenCode's per-call maps are overrides, so the deny coverage comes from a live inventory, fail-closed at startup). Budgets yield the pump WITHOUT lifecycle mutation; the run stays active and resumable.

### Execution control (human-only; the model can relay but never authorize)

```text
/ultra-plan                        enter: recover/resume execution, or start planning
/ultra-plan resume [EXEC-###]      resume the recoverable execution run (same session)
/ultra-plan resume EXEC-### --takeover   explicit human takeover (binding generation +1)
/ultra-plan abort EXEC-###         terminate the EXACT run (history kept; no rollback;
                                   an unprovable running Attempt becomes indeterminate)
/ultra-plan replan [EXEC-###]      stop for replanning → a NEW PlanningRun carrying the
                                   ExecutionIssue provenance; a new Final Approval
                                   creates a NEW ExecutionRun (old runs never rebind)
```

Ambiguous recovery targets are never auto-picked (`ambiguous_execution_run`); a different session surfaces `requires_takeover` instead of taking over.

### Runtime configuration (validated fail-closed at startup)

All settings are optional; invalid values REFUSE the plugin load (never silent degradation).

| Setting | Type | Default | Allowed range | Failure behavior |
|---|---|---|---|---|
| `ULTRA_PLAN_SUPERVISOR_MODEL` | `"provider/model"` | planning model | any configured ref | unparsable ref refuses startup |
| `ULTRA_PLAN_WORKER_MODEL` | `"provider/model"` | host execution model | any configured ref | unparsable ref refuses startup |
| `ULTRA_PLAN_VERIFIER_MODEL` | `"provider/model"` | worker model | any configured ref | unparsable ref refuses startup |
| `ULTRA_PLAN_PLANNING_MODEL` | `"provider/model"` | session model | any configured ref | unparsable ref refuses startup |
| `ULTRA_PLAN_MAX_SUPERVISOR_TURNS_PER_PUMP` | positive int | `25` | ≥ 1 | non-integer/≤0 refuses startup |
| `ULTRA_PLAN_MAX_WORKER_DISPATCHES_PER_PUMP` | positive int | `25` | ≥ 1 | non-integer/≤0 refuses startup |
| `ULTRA_PLAN_MAX_SUPERVISOR_READ_OPS_PER_TURN` | positive int | `8` | ≥ 1 | non-integer/≤0 refuses startup |
| `ULTRA_PLAN_SUPERVISOR_TIMEOUT_MS` | positive int ms | `300000` | ≥ 1 | non-integer/≤0 refuses startup |
| `ULTRA_PLAN_WORKER_TIMEOUT_MS` | positive int ms | `600000` | ≥ 1 | non-integer/≤0 refuses startup |
| `ULTRA_PLAN_MAX_CONSECUTIVE_SUPERVISOR_PROTOCOL_FAILURES` | positive int | `3` | ≥ 1 | non-integer/≤0 refuses startup |

Reasoning-style models also need an adequate OUTPUT limit in the host model config (e.g. `provider.sensenova.models["deepseek-v4-flash"].limit.output`); a too-small output budget truncates strict-JSON control payloads and the turns fail closed.

Budgets are runtime-only (never persisted). Exhaustion yields; `/ultra-plan` resumes with a fresh budget from the durable Store.

### Where execution state lives

The same durable per-project store as planning (`plan-store.json`): the protocol discriminator, the ExecutionRun, SupervisorBinding, Stages/Windows/Directives/Attempts/Reports/Assessments/Commits, the ExecutionIssue, and the ExecutionCompletionRecord. Every recovery decision is rebuilt from this file — never from conversations or child-session existence.

### Legacy free-Build compatibility (pre-cutover recovery only)

Handoffs created BEFORE the v0.2.0 cutover (no durable protocol marker) still recover through the legacy free-Build path. New Final Approvals can never produce one: the store refuses legacy handoff creation for supervised runs, and a legacy-looking run carrying execution state is corruption (fails closed).

## Known limitations

- Validated only on OpenCode CLI 1.18.x, Node 24.x, Windows.
- Execution is SERIAL: one active Stage, one open VerificationWindow, one active Attempt per run. No parallel execution, no ExecutionObservation.
- Worker/Verifier Reports are trusted factual inputs — they do not by themselves advance authoritative state; Core owns every acceptance.
- No cross-machine active-run migration (the run binds a stable workspace identity); no automatic rollback on abort.
- Legacy free-Build exists ONLY for pre-cutover recovery (see above).
- Context token counts are conservative estimates, not provider billing tokens.
- The durable store is a whole document: publication is O(state) — fine for planning/execution-scale data, not a database.
- The semantic validator cannot run on free-tier `opencode/*` models (provider policy rejects tools-disabled requests — see "Provider support" above).
- Per-call tool maps deny the DISCOVERED host inventory at plugin load; a host tool registered AFTER load (without a host restart) is not covered until the next plugin construction.

## Troubleshooting

| Error | Meaning | What to do |
|---|---|---|
| `store_corrupt` | The durable store failed validation (invalid JSON, hash mismatch, broken reference, inconsistent conflict/provenance state), or it was written by an OLDER plugin version (no downgrade migration exists). The store is never auto-repaired. | Restore your backup of `plan-store.json`; do not hand-edit. If the store is older than the plugin, reinstall the plugin version that wrote it. |
| `store_busy` | Another writer holds the store lock (bounded 4 s wait exhausted). | Retry; after a killed process the lock self-heals within ~15 s. |
| `store_version_unsupported` | The store was written by a NEWER plugin version. | Upgrade the plugin; the store is refused rather than misread. |
| `context_budget_exceeded` | Required planning context exceeded the configured budget (`overflow=fail`), or rendered complete with a warning (default). | Raise `ULTRA_PLAN_CONTEXT_BUDGET_TOKENS`. |
| `start_not_authorized` | `ultraplan_start` was invoked without the `/ultra-plan` command, or an execution control action (takeover/abort/replan) was relayed without the host-minted authorization from the raw `/ultra-plan` arguments. | Use `/ultra-plan …` (the model cannot mint these). |
| `capability_not_available` | The operation is not valid in the current stage/substate. | Check the status block / L5 checklist. |
| `supervisor_tool_isolation_blocked` | The host tool inventory (`client.tool.ids()`) was unavailable at startup — supervised execution refuses to run without a trusted inventory. | Upgrade/repair the OpenCode host so the inventory endpoint responds; restart. |
| `budget_exhausted` / yielded pump | The turn/dispatch budget for this pump run was consumed; NO lifecycle state changed. | Run `/ultra-plan` again to resume with a fresh budget. |
| `requires_takeover` | The recoverable run is owned by another session. | From that session: resume; or here: `/ultra-plan resume EXEC-### --takeover`. |
| `ambiguous_execution_run` | More than one recoverable execution run matches; auto-picking is forbidden. | Resume the exact run: `/ultra-plan resume EXEC-###`. |
| `stale_supervisor_binding` | A takeover happened elsewhere; the presented generation is stale. | Never auto-taken-over — resume with the current owner or take over explicitly. |

## License

MIT — see the included [LICENSE](LICENSE) file.

---

**Package:** `@switchboard/opencode` — protocol contract: `docs/opencode/spec/opencode-ultra-plan-agent-protocol.md` (v0.13); frozen architecture: `docs/opencode/spec/opencode-ultra-plan-architecture.md`.
