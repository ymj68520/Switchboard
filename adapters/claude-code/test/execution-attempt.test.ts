/**
 * v0.2.0 E4 — ExecutionAttempt foundation (E4 §47 focused tests T13–T20,
 * T34–T35, T37).
 *
 * Target state under test: one logical running Attempt per exact Directive
 * revision, one running Attempt per run, frozen transitions
 * running → reported / running → indeterminate, terminal immutability, and
 * the blocked-revision flow. No real Worker orchestration exists.
 */
import { describe, expect, it } from "vitest";

import { requireLegalExecutionAttemptTransition } from "../src/core/execution-attempt.js";
import {
  getExecutionAttemptInTx,
  markAttemptIndeterminateInTx,
} from "../src/store/execution-attempts.js";
import { getExecutionDirectiveInTx } from "../src/store/execution-directives.js";
import { getReportForAttemptInTx } from "../src/store/execution-reports.js";
import { handleSessionStart } from "../src/hooks/handlers.js";
import {
  advanceCandidate,
  attemptService,
  codeOf,
  issueDirective,
  makeActiveExecutionWorld,
  startAttempt,
  submitReport,
} from "./execution-protocol-helpers.js";

describe("v0.2.0 E4 — ExecutionAttempt foundation (T13–T20, T34–T35, T37)", () => {
  it("T13: an exact Directive revision starts exactly one running Attempt bound to revision + hash", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      const { attempt } = startAttempt(w, { directiveId: directive.directiveId, revision: directive.revision, hash: directive.hash });
      expect(attempt.state).toBe("running");
      expect(attempt.directiveId).toBe("DIR-A");
      expect(attempt.directiveRevision).toBe(1);
      expect(attempt.directiveHash).toBe(directive.hash);
      expect(attempt.endedAt).toBeNull();
      const persisted = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attempt.attemptId));
      expect(persisted).toEqual(attempt);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T14: a second logical Attempt for the same exact revision is impossible", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      const first = startAttempt(w, { directiveId: "DIR-A", revision: directive.revision, hash: directive.hash });
      expect(codeOf(() => startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash }))).toBe(
        "DIRECTIVE_ALREADY_ATTEMPTED",
      );
      // Even after the first attempt terminates, the revision stays attempted.
      submitReport(w, first.attempt.attemptId, { result: "completed", candidateMutated: false });
      expect(codeOf(() => startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash }))).toBe(
        "DIRECTIVE_ALREADY_ATTEMPTED",
      );
      // A forged hash is refused even more cheaply — either way nothing is
      // created and the revision stays single-attempted.
      expect(codeOf(() => startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: "sha256:forge" }))).toBe(
        "DIRECTIVE_HASH_MISMATCH",
      );
    } finally {
      w.ctx.store.close();
    }
  });

  it("T15: a second simultaneous running Attempt for another Directive fails", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const a = issueDirective(w, { directiveId: "DIR-A" });
      const b = issueDirective(w, { directiveId: "DIR-B" });
      startAttempt(w, { directiveId: "DIR-A", revision: a.revision, hash: a.hash });
      expect(codeOf(() => startAttempt(w, { directiveId: "DIR-B", revision: b.revision, hash: b.hash }))).toBe(
        "ATTEMPT_ALREADY_RUNNING",
      );
      // The DDL fence holds independent of the Core pre-check.
      const running = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE state = 'running'").get(),
      ) as { n: number };
      expect(running.n).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T16: an Attempt cannot bind a mismatched Directive hash", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      expect(
        codeOf(() => startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: "sha256:mismatch" })),
      ).toBe("DIRECTIVE_HASH_MISMATCH");
      expect(
        codeOf(() => startAttempt(w, { directiveId: "DIR-A", revision: 2, hash: directive.hash })),
      ).toBe("DIRECTIVE_NOT_CURRENT");
      expect(
        codeOf(() => startAttempt(w, { directiveId: "DIR-GHOST", revision: 1, hash: directive.hash })),
      ).toBe("DIRECTIVE_NOT_CURRENT");
      const rows = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT count(*) AS n FROM execution_attempts").get(),
      ) as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T17: a stale Directive never starts — the candidate moved after issuance", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      expect(directive.baseCandidateRevision).toBe(0);
      advanceCandidate(w, 0);
      expect(codeOf(() => startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash }))).toBe(
        "DIRECTIVE_NOT_CURRENT",
      );
      // The Directive remains an immutable historical artifact; the Supervisor
      // must issue a revision bound to the new base.
      const rows = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT count(*) AS n FROM execution_attempts").get(),
      ) as { n: number };
      expect(rows.n).toBe(0);
      const revised = issueDirective(w, { directiveId: "DIR-A", objective: "rebound to the new candidate" });
      expect(revised.revision).toBe(2);
      expect(revised.baseCandidateRevision).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T18: a valid Report atomically moves the running Attempt to reported", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      const { attempt } = startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash });
      const result = submitReport(w, attempt.attemptId, {
        result: "completed",
        candidateMutated: false,
        filesExamined: ["src/index.ts"],
      });
      expect(result.attempt.state).toBe("reported");
      expect(result.attempt.endedAt).not.toBeNull();
      const persisted = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attempt.attemptId));
      expect(persisted!.state).toBe("reported");
      expect(persisted!.endedAt).not.toBeNull();
    } finally {
      w.ctx.store.close();
    }
  });

  it("T19: running → indeterminate works and fabricates no report", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      const { attempt } = startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash });
      const marked = attemptService(w).markIndeterminate({ attemptId: attempt.attemptId });
      expect(marked.state).toBe("indeterminate");
      expect(marked.endedAt).not.toBeNull();
      expect(marked.directiveId).toBe("DIR-A");
      expect(marked.directiveHash).toBe(directive.hash);
      const report = w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, attempt.attemptId));
      expect(report).toBeNull();
      // No replay: the attempt stays terminal; no second attempt is created.
      expect(attemptService(w).listRunAttempts({ executionRunId: w.executionRunId })).toHaveLength(1);
      expect(codeOf(() => attemptService(w).markIndeterminate({ attemptId: attempt.attemptId }))).not.toBe("no-error");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T20: terminal Attempts are immutable — reported and indeterminate never return to running", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      const { attempt } = startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash });
      submitReport(w, attempt.attemptId, { result: "partial", candidateMutated: false });
      // Core transition authority.
      expect(codeOf(() => requireLegalExecutionAttemptTransition("reported", "running"))).toBe(
        "INVALID_ATTEMPT_TRANSITION",
      );
      expect(codeOf(() => requireLegalExecutionAttemptTransition("indeterminate", "running"))).toBe(
        "INVALID_ATTEMPT_TRANSITION",
      );
      expect(codeOf(() => requireLegalExecutionAttemptTransition("reported", "indeterminate"))).toBe(
        "INVALID_ATTEMPT_TRANSITION",
      );
      expect(codeOf(() => requireLegalExecutionAttemptTransition("indeterminate", "reported"))).toBe(
        "INVALID_ATTEMPT_TRANSITION",
      );
      // Even a raw write is refused by the Core primitives (no state setter exists).
      const service = attemptService(w) as Record<string, unknown>;
      expect(Object.keys(service)).not.toContain("setAttemptState");
      expect(Object.keys(service)).not.toContain("retry");
      const transitionCode = w.ctx.store.withWrite((tx) =>
        codeOf(() => markAttemptIndeterminateInTx(tx, attempt.attemptId, "2026-01-01T00:00:00Z")),
      );
      expect(transitionCode).toBe("INVALID_ATTEMPT_TRANSITION");
      // A second attempt for the same revision is still refused — the terminal
      // attempt is not "reset" by failure.
      expect(codeOf(() => startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash }))).toBe(
        "DIRECTIVE_ALREADY_ATTEMPTED",
      );
    } finally {
      w.ctx.store.close();
    }
  });

  it("E4 §41: a stale Supervisor generation cannot start an Attempt", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      expect(
        codeOf(() =>
          startAttempt(
            w,
            { directiveId: "DIR-A", revision: 1, hash: directive.hash },
            { generation: w.f.generation + 1 },
          ),
        ),
      ).toBe("STALE_SUPERVISOR_BINDING");
      expect(
        codeOf(() =>
          startAttempt(
            w,
            { directiveId: "DIR-A", revision: 1, hash: directive.hash },
            { sessionId: "S-FOREIGN" },
          ),
        ),
      ).toBe("STALE_SUPERVISOR_BINDING");
      const rows = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT count(*) AS n FROM execution_attempts").get(),
      ) as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      w.ctx.store.close();
    }
  });

  it("E4 §20 role rules: implementation≠verifier, verification=verifier, inspection is free", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      // Sequential cycles: only one running attempt at a time, so each probe
      // runs alone (rejected starts leave no row).
      const impl = issueDirective(w, { directiveId: "DIR-IMPL", kind: "implementation" });
      expect(codeOf(() => startAttempt(w, { directiveId: "DIR-IMPL", revision: 1, hash: impl.hash }, { workerRole: "verifier" }))).toBe(
        "ATTEMPT_ROLE_INVALID",
      );
      const ver = issueDirective(w, { directiveId: "DIR-VER", kind: "verification" });
      expect(codeOf(() => startAttempt(w, { directiveId: "DIR-VER", revision: 1, hash: ver.hash }, { workerRole: "executor" }))).toBe(
        "ATTEMPT_ROLE_INVALID",
      );
      const verOk = issueDirective(w, { directiveId: "DIR-VER2", kind: "verification" });
      const started = startAttempt(w, { directiveId: "DIR-VER2", revision: 1, hash: verOk.hash }, { workerRole: "verifier" });
      submitReport(w, started.attempt.attemptId, { result: "completed" });
      const insp = issueDirective(w, { directiveId: "DIR-INSP", kind: "inspection" });
      const inspExec = startAttempt(w, { directiveId: "DIR-INSP", revision: 1, hash: insp.hash }, { workerRole: "executor" });
      submitReport(w, inspExec.attempt.attemptId, { result: "completed" });
      const insp2 = issueDirective(w, { directiveId: "DIR-INSP2", kind: "inspection" });
      const inspVer = startAttempt(w, { directiveId: "DIR-INSP2", revision: 1, hash: insp2.hash }, { workerRole: "verifier" });
      submitReport(w, inspVer.attempt.attemptId, { result: "completed" });
      expect(true).toBe(true);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T34: the blocked revision flow — DIR-A@1 blocked, DIR-A@2 issued and attempted, history immutable", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const v1 = issueDirective(w, {
        directiveId: "DIR-A",
        objective: "v1",
        planRefs: undefined,
      });
      const att1 = startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: v1.hash });
      submitReport(w, att1.attempt.attemptId, {
        result: "blocked",
        candidateMutated: false,
        blockers: [
          {
            kind: "MISSING_CONTEXT",
            summary: "the referenced helper is undocumented",
            details: null,
            relevantRefs: [],
          },
        ],
      });
      // The clarification becomes a new REVISION of the same logical Directive.
      const v2 = issueDirective(w, {
        directiveId: "DIR-A",
        objective: "v2 — with the missing context added",
        body: "Additional planRefs/instructions: use the documented helper.",
      });
      expect(v2.revision).toBe(2);
      expect(v2.hash).not.toBe(v1.hash);
      const att2 = startAttempt(w, { directiveId: "DIR-A", revision: 2, hash: v2.hash });
      expect(att2.attempt.attemptId).not.toBe(att1.attempt.attemptId);
      // The old revision/attempt/report remain immutable and queryable.
      const oldDirective = w.ctx.store.withRead((tx) => getExecutionDirectiveInTx(tx, "DIR-A", 1));
      expect(oldDirective).toMatchObject({ objective: "v1", revision: 1, hash: v1.hash });
      const oldAttempt = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, att1.attempt.attemptId));
      expect(oldAttempt).toMatchObject({ directiveRevision: 1, state: "reported" });
      const oldReport = w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, att1.attempt.attemptId));
      expect(oldReport).toMatchObject({ result: "blocked", directiveRevision: 1 });
    } finally {
      w.ctx.store.close();
    }
  });

  it("T35: no mid-attempt revision mutation — an Attempt bound to @1 can never move to @2", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const v1 = issueDirective(w, { directiveId: "DIR-A", objective: "v1" });
      const att = startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: v1.hash });
      issueDirective(w, { directiveId: "DIR-A", objective: "v2" });
      // Identity trigger refuses any rebinding of the running attempt.
      const rejected = w.ctx.store.withWrite((tx) => {
        try {
          tx.prepare("UPDATE execution_attempts SET directive_revision = 2, directive_hash = ? WHERE attempt_id = ?").run(
            "sha256:whatever",
            att.attempt.attemptId,
          );
          return "updated";
        } catch {
          return "rejected";
        }
      });
      expect(rejected).toBe("rejected");
      const persisted = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, att.attempt.attemptId));
      expect(persisted!.directiveRevision).toBe(1);
      expect(persisted!.directiveHash).toBe(v1.hash);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T37: SessionStart does NOT automatically mark a running Attempt indeterminate", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      const { attempt } = startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash });
      const output = await handleSessionStart(
        { store: w.ctx.store, secret: w.ctx.secret, clock: w.ctx.clock },
        { sessionId: w.f.sessionId, cwd: w.f.workspaceRoot, source: "resume", hookEventName: "SessionStart" },
      );
      const text = output.kind === "json"
        ? String(((output as { payload?: { hookSpecificOutput?: { additionalContext?: string } } }).payload)?.hookSpecificOutput?.additionalContext ?? "")
        : "";
      expect(text).toContain("runtime resolution pending");
      // The attempt is untouched — still running, no report, no new attempt.
      const persisted = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attempt.attemptId));
      expect(persisted!.state).toBe("running");
      expect(persisted!.endedAt).toBeNull();
      expect(attemptService(w).listRunAttempts({ executionRunId: w.executionRunId })).toHaveLength(1);
      const report = w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, attempt.attemptId));
      expect(report).toBeNull();
    } finally {
      w.ctx.store.close();
    }
  });

  it("T42: no E5+ artifacts exist — no Worker runner, Supervisor inference, commits, acceptance, or completion", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      // No forbidden protocol tables.
      const tables = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
      ).map((row) => (row as { name: string }).name);
      for (const forbidden of [
        // execution_commits/supervisor_assessments arrived in E6 and are legal here.
        "accepted_head",
        "verification_results",
        "execution_observations",
        "execution_stage_completions",
        "execution_run_completions",
      ]) {
        expect(tables).not.toContain(forbidden);
      }
      // No source module implements the deferred subsystems.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const srcRoot = path.resolve(__dirname, "../src");
      const modules: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".ts")) modules.push(path.relative(srcRoot, full).split(path.sep).join("/"));
        }
      };
      walk(srcRoot);
      for (const moduleName of modules) {
        // E5 legitimately adds the worker runtime modules, E6 the acceptance
        // modules, E7 the progression modules, and E8 the conflict
        // orchestration; still forbidden here: real agent-runner
        // implementations and the E9+ subsystems.
        expect(moduleName).not.toMatch(/executor-agent|verifier-agent|verification-sched|replan-transition|run-completion|execution-observation/i);
      }
      // No application service exposes acceptance/completion/commit primitives.
      const services = [
        (await import("../src/application/execution-directive-service.js")).createExecutionDirectiveService(w.ctx.store, w.ctx.clock),
        attemptService(w),
        (await import("../src/application/execution-report-service.js")).createExecutionReportService(w.ctx.store, w.ctx.clock),
        (await import("../src/application/execution-structure-service.js")).createExecutionStructureService(w.ctx.store, w.ctx.clock),
      ] as Array<Record<string, unknown>>;
      for (const forbidden of [
        "acceptWindow",
        "closeWindow",
        "completeStage",
        "commitExecution",
        "setAcceptedHead",
        "createSupervisorAssessment",
        "invokeExecutor",
        "invokeVerifier",
        "spawnWorker",
      ]) {
        for (const service of services) {
          expect(Object.keys(service)).not.toContain(forbidden);
        }
      }
    } finally {
      w.ctx.store.close();
    }
  });
});
