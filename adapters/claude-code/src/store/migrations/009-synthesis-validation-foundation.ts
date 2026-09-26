/**
 * Migration 009 — synthesis-validation-foundation (Phase 12 directive §10–§12).
 *
 * Adds the Synthesis / Semantic Validation domain over the frozen Plan
 * Memory, as three durable, immutable, auditable record families that can
 * NEVER move HEAD, create PlanCommits, or approve design (§1):
 *
 *   synthesis_inputs                 the frozen world one synthesis cycle
 *                                    may depend on (§13–§27) — canonical
 *                                    payload + exact relational refs
 *   synthesis_input_refs             exact approved design refs (§16)
 *   synthesis_input_evidence         frozen relevant-Evidence state (§23)
 *   synthesis_manifests              the derived projection one input
 *                                    yielded (§35–§45); UNIQUE per input
 *   synthesis_manifest_refs          relational provenance of every
 *                                    supporting ref (§38/§90)
 *   semantic_validation_reports      durable validator output (§46)
 *   semantic_validation_findings     the frozen finding vocabulary (§47)
 *
 * Deliberately NOT created (§12): final_plan_candidates, final_plans,
 * finalization_requests, finalization_results, evidence_audit_snapshots,
 * execution_handoffs, execution_bindings — Finalization belongs to Phase 13+.
 *
 * NO backfill (§19): runs already at stage=synthesis under schema 8 keep that
 * stage with NO fabricated input — they become "legacy synthesis runs
 * requiring reopen" and fail closed on submit_synthesis with
 * SYNTHESIS_INPUT_REQUIRED until a real reopen/recompletion cycle creates a
 * genuine Phase-12 input.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createSynthesisValidationMigration(): StoreMigration {
  return {
    from: 8,
    to: 9,
    name: "synthesis-validation-foundation",
    apply(tx: StoreTx): void {
      // -- §65: extend the section workflow event vocabulary --------------------
      // The v8 DDL CHECK freezes the event vocabulary at five types; the three
      // reopen-driven review events require a table rebuild (SQLite cannot
      // alter a CHECK). Order matters with foreign keys ON: nothing may
      // reference a table while it is dropped, so the child (states) is
      // dropped before the parent (events), and the new states copy — whose
      // FK clause names `section_workflow_events` — is only created after the
      // rebuilt events table has taken that name.
      tx.exec(`
        CREATE TABLE section_workflow_events_v9 (
          run_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_id TEXT NOT NULL,
          section_id TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN
            ('REGISTERED','COMPLETED','REOPENED','DEPENDENCY_REVIEW_REQUIRED','EVIDENCE_REVIEW_REQUIRED',
             'SYNTHESIS_REVIEW_REQUIRED','VALIDATION_REVIEW_REQUIRED','ARCHITECTURE_REVIEW_REQUIRED')),
          from_state TEXT CHECK (from_state IS NULL OR from_state IN
            ('open','completed','needs_review')),
          to_state TEXT NOT NULL CHECK (to_state IN ('open','completed','needs_review')),
          reason_code TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          request_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, event_seq),
          UNIQUE (run_id, event_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id)
        )
      `);
      tx.exec(
        "INSERT INTO section_workflow_events_v9 "
        + "(run_id, event_seq, event_id, section_id, event_type, from_state, to_state, reason_code, detail_json, request_id, created_at) "
        + "SELECT run_id, event_seq, event_id, section_id, event_type, from_state, to_state, reason_code, detail_json, request_id, created_at "
        + "FROM section_workflow_events ORDER BY run_id, event_seq",
      );
      // The staged states copy references events_v9 — never the old events
      // table — so dropping the old parent cannot violate it.
      tx.exec(`
        CREATE TABLE section_workflow_states_v9 (
          run_id TEXT NOT NULL,
          section_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open','completed','needs_review')),
          completed_revision INTEGER CHECK (completed_revision IS NULL OR completed_revision >= 1),
          completed_proposal_id TEXT,
          completed_proposal_revision INTEGER CHECK (completed_proposal_revision IS NULL OR completed_proposal_revision >= 1),
          completion_commit_id TEXT,
          last_event_seq INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, section_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (run_id, last_event_seq)
            REFERENCES section_workflow_events_v9(run_id, event_seq),
          CHECK (
            (
              status IN ('completed','needs_review')
              AND completed_revision IS NOT NULL
              AND completed_proposal_id IS NOT NULL
              AND completed_proposal_revision IS NOT NULL
              AND completion_commit_id IS NOT NULL
            )
            OR
            (
              status = 'open'
              AND completed_revision IS NULL
              AND completed_proposal_id IS NULL
              AND completed_proposal_revision IS NULL
              AND completion_commit_id IS NULL
            )
          )
        )
      `);
      tx.exec(
        "INSERT INTO section_workflow_states_v9 "
        + "(run_id, section_id, status, completed_revision, completed_proposal_id, completed_proposal_revision, completion_commit_id, last_event_seq, updated_at) "
        + "SELECT run_id, section_id, status, completed_revision, completed_proposal_id, completed_proposal_revision, completion_commit_id, last_event_seq, updated_at "
        + "FROM section_workflow_states ORDER BY run_id, section_id",
      );
      tx.exec("DROP TABLE section_workflow_states");
      tx.exec("DROP TABLE section_workflow_events");
      // The rename rewrites states_v9's FK clause to the final table name.
      tx.exec("ALTER TABLE section_workflow_events_v9 RENAME TO section_workflow_events");
      tx.exec("ALTER TABLE section_workflow_states_v9 RENAME TO section_workflow_states");
      tx.exec(`
        CREATE INDEX idx_section_workflow_events_section
          ON section_workflow_events (run_id, section_id, event_seq)
      `);
      tx.exec(`
        CREATE TRIGGER section_workflow_events_no_update BEFORE UPDATE ON section_workflow_events
        BEGIN
          SELECT RAISE(ABORT, 'section_workflow_events is immutable');
        END
      `);
      tx.exec(`
        CREATE TRIGGER section_workflow_events_no_delete BEFORE DELETE ON section_workflow_events
        BEGIN
          SELECT RAISE(ABORT, 'section_workflow_events is immutable');
        END
      `);
      tx.exec(`
        CREATE TRIGGER section_workflow_states_no_delete BEFORE DELETE ON section_workflow_states
        BEGIN
          SELECT RAISE(ABORT, 'section_workflow_states is immutable');
        END
      `);

      // -- Frozen synthesis inputs (§13–§15/§27): append-only per-cycle worlds --
      // input_seq is the per-run synthesis cycle number (§69) — deterministic
      // history ordering, never created_at. No uniqueness on the HEAD pair:
      // two cycles through the same HEAD are DISTINCT audit units (§68).
      tx.exec(`
        CREATE TABLE synthesis_inputs (
          run_id TEXT NOT NULL REFERENCES planning_runs(run_id),
          input_seq INTEGER NOT NULL CHECK (input_seq >= 1),
          input_id TEXT NOT NULL CHECK (input_id LIKE 'synin_%'),
          base_run_revision INTEGER NOT NULL CHECK (base_run_revision >= 1),
          base_head_snapshot_id TEXT NOT NULL,
          base_head_commit_id TEXT,
          canonical_json TEXT NOT NULL,
          input_hash TEXT NOT NULL CHECK (input_hash LIKE 'sha256:%'),
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, input_id),
          UNIQUE (run_id, input_seq),
          UNIQUE (run_id, input_id),
          FOREIGN KEY (run_id, base_head_snapshot_id)
            REFERENCES plan_snapshots(run_id, snapshot_id),
          FOREIGN KEY (run_id, base_head_commit_id)
            REFERENCES plan_commits(run_id, commit_id)
        )
      `);

      // -- Exact approved design refs (§16): one current ref per artifact,
      // pinned to the immutable memory_revisions row. SectionContracts are
      // embedded in the pinned section revision (contract_json) — no separate
      // ref family is needed or allowed.
      tx.exec(`
        CREATE TABLE synthesis_input_refs (
          run_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          kind TEXT NOT NULL CHECK (kind IN
            ('constraint','decision','architecture','section','open_question','conflict')),
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          PRIMARY KEY (run_id, input_id, position),
          UNIQUE (run_id, input_id, kind, artifact_id),
          FOREIGN KEY (run_id, input_id)
            REFERENCES synthesis_inputs(run_id, input_id),
          FOREIGN KEY (run_id, kind, artifact_id, revision)
            REFERENCES memory_revisions(run_id, kind, artifact_id, revision)
        )
      `);

      // -- Frozen relevant-Evidence state (§20–§23): the freshness state is
      // mutable upstream, so the EXACT (revision, state, last_event_seq)
      // snapshot at input creation becomes part of the input itself.
      tx.exec(`
        CREATE TABLE synthesis_input_evidence (
          run_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          evidence_id TEXT NOT NULL,
          evidence_revision INTEGER NOT NULL CHECK (evidence_revision >= 1),
          confidence TEXT NOT NULL CHECK (confidence IN ('direct','derived','uncertain')),
          criticality TEXT NOT NULL CHECK (criticality IN ('critical','supporting','informational')),
          validation_strategy TEXT NOT NULL CHECK (validation_strategy IN ('fingerprint','reobserve')),
          frozen_state TEXT NOT NULL CHECK (frozen_state IN ('fresh','needs_validation','stale','invalidated')),
          frozen_last_event_seq INTEGER NOT NULL CHECK (frozen_last_event_seq >= 1),
          PRIMARY KEY (run_id, input_id, position),
          UNIQUE (run_id, input_id, evidence_id),
          FOREIGN KEY (run_id, input_id)
            REFERENCES synthesis_inputs(run_id, input_id),
          FOREIGN KEY (run_id, evidence_id, evidence_revision)
            REFERENCES evidence_revisions(run_id, evidence_id, revision)
        )
      `);

      // -- Synthesis manifests (§35–§36/§45): immutable derived projections;
      // UNIQUE(run_id, input_id) is the database-level "at most one accepted
      // manifest per frozen input". request_id carries the idempotency
      // operation identity `synthesis:<signed toolUseId>` (§44).
      tx.exec(`
        CREATE TABLE synthesis_manifests (
          run_id TEXT NOT NULL,
          manifest_id TEXT NOT NULL CHECK (manifest_id LIKE 'synm_%'),
          input_id TEXT NOT NULL,
          input_hash TEXT NOT NULL CHECK (input_hash LIKE 'sha256:%'),
          canonical_json TEXT NOT NULL,
          manifest_hash TEXT NOT NULL CHECK (manifest_hash LIKE 'sha256:%'),
          request_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, manifest_id),
          UNIQUE (run_id, input_id),
          UNIQUE (run_id, request_id),
          FOREIGN KEY (run_id, input_id)
            REFERENCES synthesis_inputs(run_id, input_id)
        )
      `);

      // -- Relational provenance of every manifest supporting ref (§38/§90):
      // the structural checker verifies subset-of-input purely in SQL.
      // section_contract refs pin the contract embedded in that exact
      // section revision; the checker resolves them to their section ref.
      tx.exec(`
        CREATE TABLE synthesis_manifest_refs (
          run_id TEXT NOT NULL,
          manifest_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          kind TEXT NOT NULL CHECK (kind IN
            ('constraint','decision','architecture','section','section_contract','open_question','conflict','evidence')),
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          PRIMARY KEY (run_id, manifest_id, position),
          UNIQUE (run_id, manifest_id, kind, artifact_id, revision),
          FOREIGN KEY (run_id, manifest_id)
            REFERENCES synthesis_manifests(run_id, manifest_id)
        )
      `);

      // -- Semantic validation reports (§46/§51/§58): durable validator
      // output; UNIQUE(run_id, manifest_id) is the database-level "one
      // accepted report per manifest". validator_agent_json records the
      // signed caller attestation provenance. is_clean is CORE-DERIVED
      // (§48) — a projection for queries, never model-submitted.
      tx.exec(`
        CREATE TABLE semantic_validation_reports (
          run_id TEXT NOT NULL,
          report_id TEXT NOT NULL CHECK (report_id LIKE 'valrep_%'),
          manifest_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          input_hash TEXT NOT NULL CHECK (input_hash LIKE 'sha256:%'),
          manifest_hash TEXT NOT NULL CHECK (manifest_hash LIKE 'sha256:%'),
          is_clean INTEGER NOT NULL CHECK (is_clean IN (0,1)),
          canonical_json TEXT NOT NULL,
          report_hash TEXT NOT NULL CHECK (report_hash LIKE 'sha256:%'),
          validator_agent_json TEXT NOT NULL,
          request_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, report_id),
          UNIQUE (run_id, manifest_id),
          UNIQUE (run_id, request_id),
          FOREIGN KEY (run_id, manifest_id)
            REFERENCES synthesis_manifests(run_id, manifest_id)
        )
      `);

      // -- Findings (§47/§49–§50): frozen vocabulary, server-generated
      // finding ids (vf_), exact refs carried as JSON projections of the
      // frozen bundle refs.
      tx.exec(`
        CREATE TABLE semantic_validation_findings (
          run_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          finding_seq INTEGER NOT NULL CHECK (finding_seq >= 1),
          finding_id TEXT NOT NULL CHECK (finding_id LIKE 'vf_%'),
          kind TEXT NOT NULL CHECK (kind IN
            ('unsupported_new_fact','contradiction','missing_design','missing_dependency',
             'incorrect_derivation','coverage_gap','clean')),
          summary TEXT NOT NULL,
          detail TEXT NOT NULL,
          subject_refs_json TEXT NOT NULL,
          supporting_refs_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, report_id, finding_seq),
          UNIQUE (run_id, finding_id),
          FOREIGN KEY (run_id, report_id)
            REFERENCES semantic_validation_reports(run_id, report_id)
        )
      `);

      // -- Immutability triggers (§14/§36/§46): synthesis inputs, manifests,
      // and reports are history. Nothing in this domain is ever edited in
      // place — a new cycle creates new rows (§68).
      const immutableTables = [
        "synthesis_inputs",
        "synthesis_input_refs",
        "synthesis_input_evidence",
        "synthesis_manifests",
        "synthesis_manifest_refs",
        "semantic_validation_reports",
        "semantic_validation_findings",
      ];
      for (const table of immutableTables) {
        tx.exec(`
          CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table} is immutable');
          END
        `);
        tx.exec(`
          CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table} is immutable');
          END
        `);
      }
      tx.exec(`
        CREATE INDEX idx_synthesis_inputs_run ON synthesis_inputs (run_id, input_seq)
      `);
      tx.exec(`
        CREATE INDEX idx_synthesis_manifests_input ON synthesis_manifests (run_id, input_id)
      `);
      tx.exec(`
        CREATE INDEX idx_validation_reports_manifest ON semantic_validation_reports (run_id, manifest_id)
      `);
    },
  };
}
