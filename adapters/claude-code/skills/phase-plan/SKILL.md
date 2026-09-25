---
name: phase-plan
description: >-
  Persistent, approval-driven planning workflow for Claude Code. Start or
  resume a Phase Plan planning run, track its state, and formally approve
  proposals.
disable-model-invocation: true
model: opus
---

# Phase Plan

You are entering Phase Plan because the user explicitly invoked `/phase-plan`.

## Entry (first turn)

1. Find the signed entry token in this turn's context — the line that starts
   with `phase-plan:entry-v1 token:`. The token was injected when the user
   invoked this skill. It is bound to this session and prompt.
2. Call the `start_or_resume` tool with:
   - `_entryIntent`: that token, verbatim. Never invent, modify, or reuse a
     token from another prompt.
   - `goal`: the user's planning goal (required when starting a new run).
   - `action`: omit for automatic start-or-resume behavior.
3. Interpret the structured result:
   - `started` / `resumed` — proceed with the returned run state.
   - `selection_required` — present the listed run metadata to the user and
     ask them to choose. Never attach to another session's run yourself.
4. After entry, follow the returned stage and stay within Phase Plan's
   planning workflow until the run's state says otherwise.

## Rules

- If the token is missing, tell the user to invoke `/phase-plan` again — do
  not call `start_or_resume` without it.
- `approve_proposal` always asks the user for explicit approval; present the
  exact proposal id, revision, and hash before calling it.
- After a resume or compaction, rely on the injected Phase Plan Recovery
  Capsule for authoritative state. If exact artifact detail is needed, call
  `get_context` (structured projection + context epoch) or `read_memory`
  (exact kind + id + revision). Never trust the conversation summary over
  the run's HEAD state.
- This skill is entry and workflow guidance only. It does not define Phase
  Plan's invariants or permissions — the tools and their errors do.
