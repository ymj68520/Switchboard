# Phase 12 live validation — frozen synthesis + isolated semantic validator

Host: Claude Code **2.1.283**, Windows 10.0.19044, Node **24.21.0**, plugin
inline `--plugin-dir D:\Programing\agent\plan-plugin\adapters\claude-code`
(dist built from the phase-12 working tree). Workspace:
`C:\Users\Administrator\phase12-live-ws` (fresh trust). Store: the host-managed
inline-plugin root `C:\Users\Administrator\.claude\plugins\data\phase-plan-inline\`
(shared with the Phase 7–11 live runs — the REAL data, including the legacy
Phase 11 synthesis run).

Session: interactive TUI, run
`plan_84387626-92af-46f7-ba1c-54d5e82216e2`, session
`e82b2f57-00c8-4a0b-9643-f1f17c42090e` (resumable), plan mode on via the
normal `/phase-plan` → `start_or_resume` → PermissionRequest `setMode(plan)`
chain ("Allowed by PermissionRequest hook" on screen).

## §0 — live migration 8 → 9 on the real store

The shared host store was at `user_version` 8 when the Phase 12 binary first
loaded; the plugin's own migration path advanced it to **9** (history row
`synthesis-validation-foundation`), preserving every prior row INCLUDING the
legacy Phase 11 run that sits at `stage = synthesis` — that run gained **no
fabricated SynthesisInput** (§19), and remains the live legacy specimen.

## §1 — sanctioned fixture drive to synthesis (§100 setup)

`test/live-fixture.test.ts` mode `phase12` (the TEST-ONLY seam used by every
prior phase) drove the live run through the real domain path — Discovery
prepare-bridge → architecture checkpoint/completion → two-section DAG →
select + section_completion for both sections — with the test authorization
factory. The LAST completion reached DETAIL_COMPLETE and, in the same
transaction, froze:

- input `synin_76be3a67-dfe5-403a-91b1-ac4f99bbd58b` (seq 1),
  `sha256:eb3907c2…c9a7`, anchored to HEAD
  `CMT-745a33a2…/snap_8f80e5ef…`, run revision 7.

The fixture log printed the full Recovery Capsule v3 — the `Synthesis:`
segment (input id/hash/base HEAD/ref counts), `Synthesis manifest: (none)`,
and `Semantic validation: (no report yet)` segments all present.

## §2 — live submit_synthesis (§100/§64)

The main model was prompted to derive a manifest ONLY from
`get_context(detail=validation)`. Live behavior recorded on screen:

1. The model read the frozen bundle and stated "all authoritative content
   lives in the frozen bundle."
2. The server STRUCTURE-SHAPED the manifest live: two rejections the model
   quotes verbatim — `SYNTHESIS_MANIFEST_INVALID: bundle ref must be an
   object` (string refs rejected) and required `title/description/statement`
   fields — "the tool errors, not assumptions, defined the exact manifest
   shape."
3. Accepted: **manifest `synm_dada9d8b-c7d4-4684-9339-83c97cfcba2d`
   (sha256:45616247…561e), run advanced synthesis → validation at revision
   8** (exactly one bump). Store verified: manifest row bound to the exact
   input hash; HEAD unchanged; no PlanCommit/Approval created by submission.

## §3 — live isolated validator (§96/§101/§63 acceptance)

After submission the main model itself launched the plugin agent — on screen:
`phase-plan:validator(Validate frozen synthesis bundle)` as a background
task ("Waiting for 1 background agent to finish"). The validator:

- ran as an isolated background subagent (own task, own context);
- called `get_context` ("Reading frozen validation bundle from get_context")
  and worked only from the frozen bundle;
- attempted `submit_validation` → the host permission dialog appeared
 (approving the HOST gate — the SERVER attestation gate is separate and
  follows); the server **accepted** the call:
  - report `valrep_123a27f1-0c5b-4b13-9e05-8df0f219521e`, `is_clean = 1`,
    bound to `synm_dada9d8b…`, report_hash `sha256:622a557a…8eca`;
  - **`validator_agent_json = {"agentId":"a8cd2bbaa9d39989f","agentType":
    "phase-plan:validator"}`** — the signed HostContext V2 envelope carried
    the real host probe fields (`agent_id`/`agent_type`) into the persisted
    provenance;
- the report did NOT move stage/revision/HEAD (still validation / 8 /
  CMT-745a33a2) — §56 live.

## §4 — live main-impersonation rejection (§98/E33)

The main agent was told to call `submit_validation` itself with the current
manifest and a clean finding. The host dialog was approved so the call could
reach the server; the server **rejected it with `VALIDATOR_CALLER_REQUIRED`**
(the string appears verbatim in the session transcript and in the model's own
on-screen summary table: "Negative probe — main agent cannot forge validation
authority"). No second report exists — the store still holds exactly one
report, the validator's.

Bonus live fence: when the main turn ended, `ExitPlanMode` was hook-blocked
("Phase Plan has not completed Final Approval/Handoff. The PlanningRun is
still active; ExitPlanMode cannot end it.") — the Phase 7 §41 guard still
standing at the validation stage.

## §5 — live compaction at validation (§105/§71/§72)

`/compact` ran ("Compacting conversation… 44s"; skills restored; plan file
referenced). The SessionStart(compact) hook re-injected the Recovery Capsule
v3; the post-compact conversation continued with exact run identity (the
model's subsequent reopen used the exact stage/ids, and its final message
quotes "stage synthesis, revision 13 … against synin_9ba94f24…" — identity
survived compaction, conversation summary was never the authority).

## §6 — live request_reopen + new synthesis cycle (§102/§63/§66/§68)

`request_reopen(target=detail, reason "phase12 live reopen after clean
validation")` — dialog approved; result verified in the store:

- stage `detail`, run revision 9 (**+1 exactly once**);
- BOTH completed sections → `needs_review` (conservative §63 policy — clean
  report, no finding ids supplied);
- HEAD unchanged (`CMT-745a33a2…`); input seq 1 / manifest / report intact.

Then the model re-completed both sections through the REAL
`select_section` → `prepare_proposal(section_completion)` → **real user
`approve_proposal` dialogs** chain (7 approvals/commits total on the run).
The last approval reached DETAIL_COMPLETE and froze a SECOND input:

- `synin_9ba94f24-1332-4349-aa2f-2b36817ad49b` (seq 2), anchored to the NEW
  HEAD commit `CMT-29dea357…` — a distinct audit unit; the old input was
  never reused (§68/E54). Sections re-bound the SAME exact revisions (§66).
- Run final state: stage synthesis, revision 13.

## §7 — live session teardown

`/exit` ended the session cleanly (SessionEnd hook; CLI returned to the shell
with the resume hint `claude --resume e82b2f57-…`); the cmd window was
closed. No orphan processes.

## Verdict

Every Phase 12 live-host gate passed on real Claude Code 2.1.283 with the
shared production store: live 8→9 migration with fail-closed legacy
synthesis, frozen input at DETAIL_COMPLETE, real manifest submission with
server-shaped structure, isolated validator discovery + acceptance with the
signed `phase-plan:validator` attestation, main-impersonation rejection,
compaction survival, reopen review policy, and a brand-new synthesis cycle
through real human approvals.
