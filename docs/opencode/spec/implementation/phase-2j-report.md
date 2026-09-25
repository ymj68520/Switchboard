# Phase 2J Implementation Report

## Implemented

Phase 2J — Recoverable ExecutionHandoff & Same-session Build Transition. The
final runtime boundary of the v0.1 authority chain:

- the `ExecutionHandoff` (HANDOFF-###) derived artifact — ONE canonical,
  canonical-hashed, deterministic projection per approved FinalPlan (§6-§16);
- the `HandoffDelivery` workflow record — the durable prepared → dispatching →
  delivered state machine with attempt counter, stable deliveryKey, and the
  host receipt (§19-§25);
- the narrow `ExecutionRuntimeAdapter` boundary and its OpenCode
  implementation (`prompt_async` dispatch + history-query confirmation) —
  the only SDK-aware component (§74/§75);
- the `HandoffCoordinator` (controller `recoverExecutionHandoff`) —
  recover/freeze/policy/admission/dispatch/receipt/complete, fully reentrant,
  single-flight, with §43 host-evidence-first ambiguity recovery (§76-§82);
- the narrow `completeHandoffRun` lifecycle operation and the §47
  preconditions (§46-§49);
- deterministic trigger wiring: the plugin `event` hook on `session.idle` and
  the /ultra-plan resume path (§35/§36/§78);
- durable additive families `executionHandoffs`/`handoffDeliveries` with
  fail-closed load validation (§85-§88/§122-§124);
- the §66-§70 status blocks and §71/§72 L0 fragments; plan_memory
  `kind=execution_handoff` exact reads (§111).

NOT implemented (per the brief): Build execution tracking, ExecutionIssue/
replanning, build-progress state on the PlanningRun (§107/§108). The frozen
architecture spec was NOT modified.

## OpenCode Runtime Audit

Audited the installed `@opencode-ai/plugin` 1.18.x SDK types (dist type
definitions; same host verified live in earlier phases), answering §2's eight
questions with code-level evidence:

1. **Next turn in an existing session:** `client.session.prompt({
   path:{id}, body:{parts,…} })` = `POST /session/{id}/message`;
   `client.session.promptAsync(...)` = `POST /session/{id}/prompt_async`
   (documented `204 "Prompt accepted"`). Both accept a `body.agent` string
   and `body.model {providerID, modelID}`.
2. **Agent/model/provider per turn:** YES — exactly the §4/§33 single-call
   shape the brief prefers. The synchronous variant resolves only with the
   FULL assistant response (`{info: AssistantMessage, parts}`), which would
   conflate delivery with Build execution — so the ASYNC variant is the
   dispatch primitive (§105), and delivery is instead confirmed by history.
3. **Imperative session-level agent/model switch:** not needed — the turn
   creation call itself carries agent/model, satisfying the frozen
   "switch model → switch agent → inject handoff" ORDER inside ONE atomic
   host action (documented implementation interpretation, §4).
4. **Receipt:** the async endpoint returns 204 void (acceptance only). The
   strongest REAL receipt is therefore the created user message OBSERVED via
   `client.session.messages` — carrying `id`, `sessionID`, `agent`,
   `model {providerID, modelID}` — plus the assistant response `parentID`
   linkage for the first Build response. Only host-observable identifiers
   are persisted (§22/§112).
5. **History query:** YES — `client.session.messages` returns all messages
   with parts, enabling marker search (§43 step 1, §140 duplicate detection).
6. **Caller-controlled id:** `body.messageID` exists in the type system, but
   its server-side acceptance semantics are undocumented on 1.18.x — it is
   deliberately NOT relied on; the stable `delivery-key=` marker line is the
   idempotency/confirmation mechanism (§24 option B + C).
7. **Build/execution agent representation:** host-native agents by name;
   the default Build agent is `"build"` (§30's host-native execution agent).
8. **Planning vs Build distinction:** the planning agent is the plugin's
   `ultraplan` (config hook); the handoff turn explicitly names the resolved
   execution agent, and the host records that agent on the delivered message
   (asserted live, §100).

## Same-session Runtime Primitive

`OpenCodeExecutionAdapter.dispatchHandoff`: `session.promptAsync` with
`{ parts:[{type:"text", text: prompt}], agent?, model? }` and
`path.id = PlanningRun.sessionID` — ONE host request binding turn + agent +
model + handoff (§33). Bounded 15s timeout (§104): a timeout is classified
AMBIGUOUS (never retry-safe). `findHandoffDelivery`: bounded history polling
for the marker line; returns the exact receipt or "definitively not found".
Proven live (see Live validation): the delivered turn lands in the SAME
session with the marker, and the host records the agent/model on it.

## Execution Model Policy

Deterministic role policy from adapter configuration (§29): `spec.executionModel`
("provider/model") or ABSENT = host default model (the documented §57 safe
default — OpenCode applies the session model). Empty/unparseable →
`execution_policy_unresolved`, handoff stays pending (§115). The planning
model is never reused; no complexity routing exists (§59).

## Execution Agent Policy

`spec.executionAgent` defaults to the HOST-NATIVE Build agent `"build"` — no
second custom Build agent was created (§30). Empty →
`execution_policy_unresolved`. The planning agent is never silently used as
Build (no fallback exists to document beyond the host default itself).

## ExecutionHandoff Contract

`src/handoff/types.ts` (adapted to the real domain): planID + trusted
sessionID; finalPlan ref + hash; finalCommit + finalSnapshot; goal;
architecture ref; exact section refs; exact hard+active constraints;
EXACT implementationSteps; one exact canonical SectionContract per exact
approved SectionRevision (caller-resolved from committed Plan Memory,
deduplicated, canonical order — §11); criticalDecisions = ALL FinalPlan
decision refs (§12's documented precise rule); exact limitation statements;
the closed §14 validation-requirement set; createdAt + canonical hash.

## Deterministic Handoff Rendering

`renderExecutionHandoffPrompt` — the §26 ULTRA PLAN EXECUTION HANDOFF block
(handoff ref/hash, final plan ref/hash, goal, architecture, implementation
order, required contracts, critical constraints, decisions, limitations, the
execution rules incl. §9 FinalPlan-authority and §53 no-permission-bypass
lines) preceded by the §25 machine marker block (`ULTRA_PLAN_HANDOFF` /
`plan=` / `handoff=` / `hash=` / `finalPlan=` / `delivery-key=`), ending with
the §54 continue-without-reconfirmation instruction. Pure projection; no
planning conversation (§55); byte-stable.

## Handoff Hash / Idempotency

`computeExecutionHandoffHash` — SHA-256 over stableStringify of the semantic
payload excluding id/createdAt/hash (§15). Mutation tests cover §125's whole
list (finalPlan hash, sections, order, limitations, goal, architecture,
decisions, constraints, validation requirements). Idempotency (§16): the
hash excludes createdAt, so recovery re-assembly yields the SAME identity;
`saveExecutionHandoff` returns the original immutable record
(created=false) and refuses a second handoff for the same plan.

## Handoff Delivery State Machine

`prepared` (durable outbox intent, created BEFORE any dispatch, §38) →
`dispatching` (single-flight CAS `beginHandoffDispatch`, attempt + 1, §39/
§41/§119) → `delivered` (`recordHandoffDelivered`, requires a real receipt:
session must equal the delivery's trusted session, non-empty message id).
`reclaimHandoffDispatch` (dispatching → prepared) is the ONLY backward edge
and the coordinator invokes it only on host evidence: definite
pre-acceptance rejection (§61) or a queryable host definitively not showing
the handoff (§43 step 5). No dispatching→delivered repair exists (§88).

## Host Receipt Semantics

`HostDeliveryReceipt { sessionID, messageID, agent?, model? }` — built ONLY
from `session.messages` observations of the exact marker message (§22/§23).
Confirmation semantics documented (§23): delivered = the exact handoff
message durably OBSERVED in the target session's host history with the
stable marker under the resolved execution context — strictly stronger than
the 204 acceptance. Exactly-once is achieved via §24 option B
(query-before-retry); the marker provides duplicate detection (option C).

## Dispatch Single-flight

The durable CAS admission is the only dispatch gate (§41/§119): a second
coordinator observing `dispatching`/`delivered` returns `in_flight`/
`completed` and never dispatches. The delivery record lives in the durable
store, so cross-instance serialization is the store write lock
(rehydration-under-lock). §120: B observing `delivered` completes the
lifecycle instead of resending.

## Ambiguous Delivery Recovery

§42/§43/§62/§81/§92 implemented verbatim: stale `dispatching` → query host
by deliveryKey → found ⇒ delivered + complete; definitively absent ⇒ reclaim
+ retry (same deliveryKey); query unsupported/failing ⇒ stay
`handoff_pending` + `dispatching` with the ambiguity surfaced
(`handoff_delivery_ambiguous`), never re-sent (§132). Timeout classification
(§104): a dispatch timeout is ambiguity, not retry-safe. §137's
ambiguous-acceptance acceptance test passes with host dispatch count == 1.

## Lifecycle Completion Semantics

`completeHandoffRun` (§46/§47): a narrow Harness-owned workflow transition
(no Proposal/Approval/PlanCommit; generic `set_lifecycle` does not exist)
with in-lock preconditions — handoff_pending, stage final, exact approved
FinalPlan, handoff binding it, `delivered` delivery, verified receipt in the
trusted session. No receipt → no completion. §48: creates no commit/snapshot,
moves no HEAD, mutates no FinalPlan. §121: idempotent. `completed` (§106):
Final Plan approved + handoff delivered + Ultra Plan no longer owns active
workflow — NOT "implementation finished" (§105). §49: completed is terminal;
/ultra-plan starts a NEW run.

## Final HEAD Immutability

Pinned: after the full handoff workflow (including completion) the run's
`headCommit`/`headSnapshot` are still the Phase 2I Final PlanCommit/Snapshot;
commit and head.moved event counts are unchanged; the durable load validation
additionally refuses a completed run whose final HEAD is not the final
commit (§124, extended in 2I's triangle check to completed runs).

## Build Read-only Plan Memory Boundary

No planning mutation capability exists in handoff_pending/completed (matrix
unchanged, §141 — reads only, server-side enforcement authoritative). Build
turns can read FinalPlan/exact refs/contracts/decisions/constraints through
the existing `plan_memory` surface; the handoff prompt states the read-only
rule and the no-permission-bypass rule (§53). New read: plan_memory
`kind=execution_handoff` (exact ids only; the delivery runtime record is
deliberately not exposed, §111/§112).

## Restart Recovery

§78: recovery is deterministic Harness behavior — the plugin `event` hook
fires the coordinator on `session.idle` (no planning-model turn), and the
/ultra-plan resume path runs it too (§35's continuation path; zero authority
parameters). §117/§118: a run pushed to handoff_pending by a pre-restart
process (or by 2I's post-commit crash recovery) is consumed by the SAME
coordinator — no new run, no re-approval. Windows A-F proven with REAL child
processes against a file-backed fake host shared across probe invocations:
A (no artifact → freeze+deliver once), B (prepared → dispatch once), C
(admission, host never called → reclaim + dispatch once), D (host accepted
before delivered persist → query finds receipt → delivered + complete,
DISPATCHES=1 — §130/§137), E (delivered before completion → complete without
resend, §133), F (completed → `already_completed`, no redispatch, §134).

## Cross-instance Concurrency

§119: two coordinators — the durable CAS admission yields exactly one
dispatch (loser `in_flight`). §120: delivered-observing recovery completes.
§121: idempotent completion (one lifecycle_changed event for the transition).
All store mutations run under the durable write lock; the host call runs
outside any lock (§40).

## Corruption / Fail-closed Validation

Durable load (§86/§87/§122-§124): handoff hash recompute; plan/session
binding; FinalPlan exists + approved + hash match; final commit/snapshot ==
run HEAD; projection == deterministic FinalPlan projection; ONE handoff per
plan; delivery → existing handoff + deterministic deliveryKey + trusted
session; delivered ⇒ valid receipt (session match, non-empty message id,
deliveredAt); prepared/dispatching ⇒ NO receipt; completed run ⇒ a delivered
delivery exists (2I's triangle extended to completed runs). Fail closed, no
repair.

## Tests Added

- `test/handoff.test.ts` (33 tests): freeze preconditions; deterministic
  contract + §16 idempotency + §125 hash mutations; §25/§26/§54/§55 payload
  pins; the no-tool/no-authority surface; §136 primary integration
  (one handoff/delivery/dispatch/receipt; HEAD immutable; event order);
  policy determinism + default host agent + unresolvable-policy blocking;
  single-flight; definite-reject retry; ambiguous-acceptance recovery with
  dispatch count 1 (§130/§137); no-query fail-closed (§132); receipt
  validation (session mismatch/empty id); delivered recovery without resend;
  completion preconditions; commit/HEAD immutability; idempotent completion;
  terminal completed runs; §122-§124 durable corruption; §66-§70 status
  blocks; §71/§72 L0; exact reads; resume-path restart recovery.
- `test/durable-crash.test.ts` (+6): crash windows A-F with REAL child
  processes and a cross-process file-backed fake host — every window
  recovers with host dispatch count == 1.
- `scripts/crash-probe.mjs` (+handoff mode), `scripts/opencode-handoff-smoke.mjs`
  (new live validation), `scripts/opencode-handoff-setup.mjs` (TEST-ONLY
  live fixture driver, §98).

Full OpenCode suite: 536 tests / 20 files, all green (497 pre-2J + 39 new).

## Live OpenCode Handoff Validation

**16/16 checks PASS, exit 0** (dedicated script, §97 — runtime handoff IS
the feature, so a real-host proof is mandatory): real `opencode serve` +
real session ses_…; the fixture reaches handoff_pending via the TEST-ONLY
standalone setup script driving the REAL controller flow against the SAME
durable store (§98 boundary documented — no production seam; Final Approval
protocol not weakened); the server RESTARTS; the Harness recovery performs
the handoff; the live assertions proved:

- §138: run lifecycle → `completed` with a `delivered` handoff record;
- §138/§25: the delivered handoff turn exists in host history with the
  stable `ULTRA_PLAN_HANDOFF` / `plan=PLAN-001` marker — exactly once (§140);
- §99: planning session == handoff target session == delivered turn session
  (all three recorded and asserted equal);
- §100: the delivered turn's host-recorded agent == the resolved build agent
  (`build`), matching the persisted receipt;
- §101: the delivered turn records the host model identity
  (`{providerID: "opencode", modelID: "ling-3.0-flash-fin-free"}`), equal to
  the receipt's model;
- §22: the persisted receipt's messageID EQUALS the delivered turn's real
  host message id;
- §135: final HEAD unchanged (before=after=COMMIT-007);
- §102: the first Build response occurs in the SAME session (bounded wait).

Honest split: the durable/store semantics (state machine, single-flight,
crash windows, corruption) are integration-tested with the fake adapter and
real child processes; ONLY the runtime transition itself (prompt_async
dispatch + history confirmation + agent/model metadata) is claimed from this
live run.

## Verification Results

True producer exit codes, `adapters/opencode` workspace:

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck -w @switchboard/opencode` | exit 0 |
| Lint | `npm run lint -w @switchboard/opencode` | exit 0 |
| Tests | `npm test -w @switchboard/opencode` | exit 0 — 536 passed / 536 (20 files) |
| Build | `npm run build -w @switchboard/opencode` | exit 0 |
| Main live smoke | `npm run smoke:opencode` | 35/35 checks, exit 0 (regression) |
| Handoff live smoke | `npm run smoke:opencode-handoff` | 16/16 checks, exit 0 (see below) |

Root aggregate (true producer exit codes, first run — no retry needed):

- `npm run typecheck` → exit 0
- `npm run lint` → exit 0
- `npm test` → exit 0 (claude-code 521+1skip, codex 180, opencode 536 —
  the concurrent claude-code workstream's earlier failures were resolved
  upstream by its own workstream during this session)
- `npm run build` → exit 0

The frozen architecture spec (`docs/opencode/spec/opencode-ultra-plan-architecture.md`)
has zero diffs (`git diff --stat` empty).

## Deviations From Frozen Architecture

None requiring an amendment. Documented implementation interpretations: the
frozen "switch model → switch agent → inject handoff" order is expressed
inside ONE host turn-creation call (prompt_async carries agent+model+prompt
atomically) — §4 explicitly sanctions this; `prompt_async` (not synchronous
`prompt`) is the dispatch primitive so delivery is not conflated with Build
execution, with history-observation as the confirmation; the §12
"critical decisions" rule is "ALL FinalPlan DecisionRefs"; hard+active
constraints are the "critical constraints" projection (the full set remains
in the FinalPlan authority).

## Risks / Open Issues

- `session.prompt_async` while the session is mid-turn (the /ultra-plan
  resume turn) is host-scheduling territory; if the host rejects a busy
  prompt the delivery reverts to prepared and the session-idle recovery
  completes it — self-healing, but the completion timing is host-dependent
  (the smoke polls, bounded).
- Marker search is O(session history) per confirmation query; acceptable at
  planning-conversation scale.
- Build-discovered design defects (§108) remain unimplemented follow-up work
  (ExecutionIssue/replanning), as the brief directs.

## v0.1 Workflow Exit Status

The complete v0.1 end-to-end authority chain is implemented and verified:

```text
explicit /ultra-plan → Discovery → Architecture → Section DAG →
Section design/checkpoints → Section completion → Synthesis →
Semantic Validation → Evidence Audit → deterministic Finalization →
FinalPlanCandidate → Final Approval → Final PlanCommit → handoff_pending →
deterministic same-session ExecutionHandoff → Build
```

Per the brief, the next step is a **v0.1 Integration / Architecture Exit
Review** — a whole-spec audit against the implementation (deferred items
such as the full Context Assembler, token budgeting, ContextTrace), NOT
another automatic feature phase.
