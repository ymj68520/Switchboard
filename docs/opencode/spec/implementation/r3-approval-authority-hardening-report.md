# R3 — Approval Authority Hardening Report (RF-01)

**Task:** RF-01 Approval Hardening (closure brief §4–§15). **Status: RESOLVED — Core Invariant 9 PASS RESTORED.**
**Companion records:** `v0.1-rc-validation.md` (candidate identity, live proofs) · `v0.1-rc-manual-acceptance.md` (human-gate log) · `v0.1-release-freeze-report.md` (disposition).

---

## 1. The tainted original run (preserved, never counted)

During the 2026-09-28 afternoon acceptance attempt (attach-TUI architecture, headless server on :26644, default host configuration, **no** permission block), the harness recorded:

```text
5 Approvals (APPR-001…005, every one actor="user")
5 PlanCommits (COMMIT-001…005: architecture@1, complete_architecture,
  3-section decomposition, DEC-001, SEC-001@1)
52 seconds (08:26:02Z → 08:26:54Z)
0 human clicks (no dialog was ever rendered; the user was not present)
```

That is a silent fail-open of approval authority and violates Core Invariant 9 (no committed change without an explicit user approval of the exact proposal). The run was frozen, ABANDONED as tainted, and the store preserved verbatim at `ultra-plan-data-tainted-run1/` (rr2-consumer). None of its approvals or commits were ever counted as acceptance evidence.

## 2. Permission-resolution audit (OpenCode 1.18.32 installed binary + real probes)

Established from the installed 1.18.32 binary (embedded source extracted and read directly), the shipped config schema, `opencode debug config` on live consumers, and real probes — not from documentation:

1. **Root cause of RF-01 — empty `patterns` short-circuits evaluation.** The host's permission `ask` evaluates rules ONLY inside its loop over the request's `patterns` (`for pattern of patterns { evaluate(...) }`; each "allow" continues, "deny" throws `DeniedError`, "ask" sets `needsAsk`). With `patterns: []` the loop body never runs, so the call resolves immediately without ever consulting any rule — **an implicit allow under every configuration**. Ultra Plan's approval call (`ultraplan_request_user_approval` → `ToolContext.ask`) passed `patterns: []` (deliberately, alongside `always: []`). The default-config auto-grant therefore had NOTHING to do with permission values: no configuration could have prevented it.
2. **Default ruleset baseline is permissive.** The host's base agent defaults include `"*": "allow"` (plus targeted exceptions such as `external_directory: {"*":"ask"}`); `build`/`plan` additionally force `question: "allow"`. Any permission string not matched by a later rule resolves to allow.
3. **Rule resolution is last-match over glob keys.** `evaluate()` = `findLast` over the flattened rulesets with `Wildcard.match(permissionString, rule.key)`; no match falls back to `{"ask"}`. Insertion order therefore matters: a rule appended last outranks an earlier `"*": "allow"`.
4. **Ruleset at tool-ask time** = `merge(runningAgent.permission, session.permission ?? [])`. Config-defined agents are constructed as `merge(baseDefaults, fromConfig(globalConfig.permission), …)` and then `merge(…, fromConfig(agentDef.permission ?? {}))` — so both a global-config rule and the agent definition's own `permission` land AFTER the base `"*": "allow"` and win last-match.
5. **Auto-answer surfaces (§9 audit):** `--auto` / `--yolo` / `--dangerously-skip-permissions` normalize into a client-side permission mode that replies `"once"` to EVERY `permission.asked` event from the connected client; the TUI also carries a `permissions.autoApprove` preference (default false). These are CLIENT-side — a plugin cannot detect them from inside the host. `OPENCODE_PERMISSION` (env) is an additional config source, not a bypass. A server with no connected client leaves the ask pending indefinitely. The `permission.ask` plugin hook appears in the 1.18.32 documentation string but is NOT implemented (zero trigger sites) — unusable.

## 3. Chosen remediation (narrow, per brief §6/§7)

Production changes (commit `941873d2cc804fdf868a5b29677539c4e7b3f223`):

1. **The approval ask now carries a NON-EMPTY pattern** — `patterns: [ "<proposalID>@<revision>" ]`, the exact approval target — so the host actually evaluates rules and can raise its dialog. `always: []` is kept deliberately: no standing approval authority can be created.
2. **`applyToConfig` (the plugin config hook) forces the narrow rule** `"ultraplan.approval:*" → "ask"` in BOTH the planning agent's own `permission` and the resolved global permission config — appended LAST (delete + re-insert) so last-match resolution outranks any earlier wildcard, including a user-level `"*": "allow"`. Every unrelated permission (bash, edit, webfetch, external_directory, read, …) is preserved verbatim; nothing else is rewritten. The key is exact-scoped to Ultra Plan's approval permission — the broader `question` category is NOT touched (§7).
3. **Plugin config-hook enforcement means NO user configuration is required** — the fail-safe ships with the plugin (brief §6's preferred shape). The earlier manual consumer-side permission block is no longer needed and is no longer part of the runbook.

Bypass honesty (§9): a client started with `--auto`/`--yolo`/`--dangerously-skip-permissions`, or with the TUI's `permissions.autoApprove` preference enabled, will auto-reply to pending asks; this is client-side and not reliably detectable from the plugin. OpenCode offers no stronger mandatory-interaction primitive in 1.18.32 (the `permission.ask` hook is unimplemented). The acceptance procedure therefore mandates the primary TUI with no auto flags (runbook), and the human-attestation step below is part of the gate evidence.

## 4. Default-config runtime proof (brief §12) — PASS

Fresh consumer `rr3-consumer`: candidate artifact installed, NO permission block in `opencode.json` (only model/share/autoupdate), OpenCode **1.18.32** verified (binary self-updated to 1.18.33 beforehand and was re-pinned), primary TUI, fresh `ULTRA_PLAN_DATA_DIR`, fresh run **PLAN-001** created through the real TUI `/ultra-plan` command menu.

The model was steered (operator prompts via Computer Use typing — never approval clicks) to prepare and submit the architecture proposal. Host log (the authoritative record, `~/.local/share/opencode/log/opencode.log`):

```text
11:41:21.909Z evaluated permission=ultraplan.approval:PROP-001@1:c58f7d5a9f1c6aa3
              pattern=PROP-001@1 action.permission=ultraplan.approval:* action.action=ask
11:41:21.910Z asking id=per_0e7d1ce76001JkUS9Ta8WR0Sv5
              permission=ultraplan.approval:PROP-001@1:c58f7d5a9f1c6aa3 patterns=["PROP-001@1"]
```

The forced rule was evaluated and selected (last-match), the request was raised as a pending dialog, and it **PENDED ~52 seconds** while the durable store showed `approvals=0, commits=0, HEAD unchanged`. No auto-grant occurred on the default configuration — the defect is fixed at its root.

## 5. First human Approval (brief §13) — PASS

The user physically clicked **Allow** in the primary TUI dialog (attested in this session; the ~52 s pend excludes any automatic resolution path). Read-back from the durable store:

```text
sessionID    ses_f183ab8f9ffeeMrMn4HK8972HB
PlanID       PLAN-001 (stage architecture → detail after commit)
ProposalID   PROP-001, revision 1, hash c58f7d5a9f1c6aa3… (exact binding)
ApprovalID   APPR-001, actor=user
PlanCommitID COMMIT-001 (add_architecture + complete_architecture), parent=null
HEAD         SNAP-002 (moved exactly once)
totals       exactly 1 approval, exactly 1 commit
```

## 6. Second and later Proposals still ask (brief §14) — PASS

The run continued through Detail with three further proposals — PROP-002 (section decomposition SEC-001 → SEC-002), PROP-003 (SEC-001@1 checkpoint), PROP-004 (SEC-002@1 checkpoint). Each one independently entered `awaiting_approval` while the approval count stood at its previous value, produced its own pending dialog, and required its own human Allow (all four clicks attested by the user). Host log shows the identical evaluate→ask chain for each (11:52:23, 11:53:40, 11:55:03 with pend windows of ~5–64 s). No implicit session-wide "always allow" exists — `always: []` is structural.

## 7. Deterministic tests (brief §11)

`adapters/opencode/test/r3-approval-hardening.test.ts` (new, 6 tests) pins: default-config force; unrelated user permissions preserved verbatim; explicit user `allow` for the approval key overridden back to `ask`; the forced rule appended AFTER a user-level `"*": "allow"` (last-match); idempotence with the rule kept last; command/agent registration unchanged. The two tests that previously pinned the defective `patterns: []` were corrected to pin the exact non-empty pattern binding (`architecture-workflow.test.ts`, `transaction-engine.test.ts`; the deny path — no Approval, no PlanCommit, unchanged HEAD — and the exact proposalID/revision/hash binding were already covered there and remain green). Full suite: **640/640 passed**, typecheck 0, lint 0, build 0.

## 8. Live tests

- Default-config runtime proof + four real human approvals: sections 4–6 above (primary TUI, 1.18.32, no permission block).
- Deterministic handoff runtime smoke on the RF-01 build (`smoke:opencode-handoff-det`): re-run on the fixed dist — see `v0.1-rc-validation.md` for the recorded result.
- The morning's context (17/17) / main (37/37) smokes ran on the pre-RF-01 dist; §33's full live-smoke re-run is scheduled for the complete vertical window (its precondition includes RR-03, which remains provider-blocked below).

## 9. Invariant 9 disposition

```text
Core Invariant 9 (approval authority): PASS RESTORED

The approval primitive is fail-closed by construction: the ask always
evaluates (non-empty pattern), the forced narrow rule always resolves to
"ask" (last-match, plugin-enforced, no user configuration required), the
pending dialog can only be resolved by a decision on a real client, and no
standing authority can accumulate (always: []). actor:"user" now has a
defensible interaction basis: under the enforced ruleset the ONLY path from
awaiting_approval to approved is a reply to a real pending dialog (accepting
the documented client-side --auto/autoApprove caveat, which the acceptance
procedure forbids and attestation covers).
```

Only after this PASS did the acceptance vertical continue (see `v0.1-rc-manual-acceptance.md`).
