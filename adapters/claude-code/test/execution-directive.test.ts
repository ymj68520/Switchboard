/**
 * v0.2.0 E4 — ExecutionDirective foundation (E4 §47 focused tests T1–T12).
 *
 * Target state under test: active ExecutionRun + active Stage + open Window →
 * immutable exact-revision Directives bound to the full authority context.
 * No Attempt/Report/Verification/Assessment/ExecutionCommit machinery here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  executionDirectiveHash,
  parseCapabilityEnvelope,
  type ExecutionCapabilityEnvelope,
  type ExecutionDirective,
} from "../src/core/execution-directive.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { parseFinalPlanCanonical } from "../src/application/final-plan-canonical.js";
import { getOpenWindowInTx } from "../src/store/execution-structure.js";
import { getExecutionStructureInTx } from "../src/application/execution-structure-service.js";
import { getExecutionDirectiveInTx } from "../src/store/execution-directives.js";
import {
  advanceCandidate,
  directiveService,
  fullEnvelope,
  issueDirective,
  makeActiveExecutionWorld,
  type E4World,
} from "./execution-protocol-helpers.js";
import { codeOf } from "./execution-protocol-helpers.js";

/** Hash-shaped view of a directive: hash/issuedAt excluded by convention. */
function contentOf(directive: ExecutionDirective): Parameters<typeof executionDirectiveHash>[0] {
  const clone: Record<string, unknown> = { ...directive };
  delete clone.hash;
  delete clone.issuedAt;
  return clone as unknown as Parameters<typeof executionDirectiveHash>[0];
}

/** A plan ref that IS an exact approved reference of the world's bound FinalPlan. */
function approvedRefOf(w: E4World): { kind: string; id: string; revision: number } {
  const row = w.ctx.store.withRead((tx) => getFinalPlanInTx(tx, w.f.runId));
  if (row === null) throw new Error("fixture has no FinalPlan");
  const plan = parseFinalPlanCanonical(row.canonicalJson, w.executionRunId);
  if (plan.sections.length > 0) {
    const section = plan.sections[0]!;
    return { kind: "section", id: section.sectionId, revision: section.revision };
  }
  if (plan.decisions.length > 0) {
    const decision = plan.decisions[0]!;
    return { kind: decision.kind, id: decision.id, revision: decision.revision };
  }
  throw new Error("fixture FinalPlan has no provable refs");
}

describe("v0.2.0 E4 — ExecutionDirective foundation (T1–T12)", () => {
  it("T1: issuance binds the EXACT run/FinalPlan/Stage/Window/candidateRevision/accepted base", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      expect(directive.revision).toBe(1);
      const run = w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId));
      expect(run!.lifecycle).toBe("active");
      // A1 §20 — the canonical scope is the ExecutionRunID; runId stays the
      // source-PlanningRun provenance.
      expect(directive.executionRunId).toBe(w.executionRunId);
      expect(directive.runId).toBe(w.f.runId);
      expect(directive.finalPlanRef).toEqual(run!.finalPlan);
      expect(directive.stageId).toBe(w.activeStageId);
      expect(directive.windowId).toBe(w.openWindowId);
      const window = w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId));
      expect(directive.baseCandidateRevision).toBe(window!.candidateRevision);
      // E4 §5 — the accepted base resolves exactly to the persisted baseline.
      expect(directive.acceptedBase.kind).toBe("execution_start");
      expect(
        directive.acceptedBase.kind === "execution_start" ? directive.acceptedBase.baseline : null,
      ).toEqual(run!.executionStartBaseline);
      // The hash is stored and reproducible from the content.
      const persisted = w.ctx.store.withRead((tx) =>
        getExecutionDirectiveInTx(tx, directive.directiveId, directive.revision),
      );
      expect(persisted!.hash).toBe(directive.hash);
      expect(persisted!.hash).toBe(executionDirectiveHash(contentOf(persisted!)));
    } finally {
      w.ctx.store.close();
    }
  });

  it("T2: the hash is deterministic over canonical content and moves with any semantic change", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const openContract = {
        requireActionsPerformed: false,
        requireFilesExamined: false,
        requireFilesChanged: false,
        requireCommandsRun: false,
        requireTestsRun: false,
        requireFindings: false,
        requireDeviations: false,
        requireBlockers: false,
        requireDeliverables: false,
      };
      const first = issueDirective(w, { directiveId: "DIR-H1" });
      // Same canonical content → same hash (recomputed from the full content;
      // issuedAt is hash-excluded by convention).
      expect(executionDirectiveHash(contentOf(first))).toBe(first.hash);
      // Any semantic field change → different hash. Each variant issues a real
      // directive so the mutated candidate is the persisted canonical shape.
      const variants: Array<[string, Record<string, unknown>]> = [
        ["objective", { objective: "Different objective" }],
        ["body", { body: "Different body" }],
        ["kind", { kind: "verification" }],
        ["capabilityEnvelope", { capabilityEnvelope: fullEnvelope({ repositoryWrite: true }) }],
        ["planRefs", { planRefs: [approvedRefOf(w)] }],
        ["reportContract", { reportContract: { ...openContract, requireFindings: true } }],
      ];
      let suffix = 0;
      for (const [, variant] of variants) {
        suffix += 1;
        const mutated = issueDirective(w, { directiveId: `DIR-H2-${suffix}`, ...variant });
        const rehash = executionDirectiveHash(contentOf(mutated));
        expect(rehash).toBe(mutated.hash);
        expect(rehash).not.toBe(first.hash);
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("T3: issued revisions are DDL-immutable — no UPDATE, no DELETE", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-I" });
      const rawUpdate = () =>
        w.ctx.store.withWrite((tx) =>
          codeOf(() =>
            tx.prepare("UPDATE execution_directives SET objective = 'rewritten' WHERE directive_id = ? AND revision = ?")
              .run(directive.directiveId, directive.revision),
          ),
        );
      expect(rawUpdate()).not.toBe("no-error");
      const rawDelete = () =>
        w.ctx.store.withWrite((tx) =>
          codeOf(() =>
            tx.prepare("DELETE FROM execution_directives WHERE directive_id = ?").run(directive.directiveId),
          ),
        );
      expect(rawDelete()).not.toBe("no-error");
      const still = w.ctx.store.withRead((tx) =>
        getExecutionDirectiveInTx(tx, directive.directiveId, directive.revision),
      );
      expect(still!.objective).toBe(directive.objective);
      // No generic update path exists on the store module or service.
      const service = directiveService(w) as Record<string, unknown>;
      expect(Object.keys(service)).not.toContain("updateDirective");
      expect(Object.keys(service)).not.toContain("setDirectiveHash");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T4: revisions are strictly monotonic — @1 then @2 valid; duplicate and skipped revisions conflict", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const first = issueDirective(w, { directiveId: "DIR-R", objective: "v1" });
      expect(first.revision).toBe(1);
      const second = issueDirective(w, { directiveId: "DIR-R", objective: "v2" });
      expect(second.revision).toBe(2);
      // Duplicate revision.
      expect(codeOf(() => issueDirective(w, { directiveId: "DIR-R", revision: 2, objective: "dup" }))).toBe(
        "DIRECTIVE_REVISION_CONFLICT",
      );
      // Skipped revision: the chosen Core rule is strictly latest+1 (documented).
      expect(codeOf(() => issueDirective(w, { directiveId: "DIR-R", revision: 9, objective: "skip" }))).toBe(
        "DIRECTIVE_REVISION_CONFLICT",
      );
    } finally {
      w.ctx.store.close();
    }
  });

  it("T5: issuing @2 preserves @1 byte-for-byte — history is immutable", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const first = issueDirective(w, { directiveId: "DIR-HIST", objective: "v1", body: "b1" });
      const snapshot = () =>
        w.ctx.store.withRead((tx) =>
          tx.prepare("SELECT * FROM execution_directives WHERE directive_id = 'DIR-HIST' ORDER BY revision").all(),
        );
      const before = snapshot();
      issueDirective(w, { directiveId: "DIR-HIST", objective: "v2", body: "b2" });
      const after = snapshot();
      expect(after).toHaveLength(2);
      expect(after[0]).toEqual(before[0]);
      const reread = w.ctx.store.withRead((tx) => getExecutionDirectiveInTx(tx, "DIR-HIST", 1));
      expect(reread!.hash).toBe(first.hash);
      expect(reread!.objective).toBe("v1");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T6: stale candidate issuance fails closed — base must equal the current window revision", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      // Move the candidate 0 → 1 → 2 through the E3 CAS.
      advanceCandidate(w, 0);
      advanceCandidate(w, 1);
      const window = w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId));
      expect(window!.candidateRevision).toBe(2);
      // Explicit stale base.
      expect(codeOf(() => issueDirective(w, { directiveId: "DIR-S", baseCandidateRevision: 1 }))).toBe(
        "STALE_CANDIDATE_REVISION",
      );
      // Core stamps the CURRENT revision when the caller omits a base.
      const directive = issueDirective(w, { directiveId: "DIR-S" });
      expect(directive.baseCandidateRevision).toBe(2);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T7: a Directive for a non-active Stage or a stale/non-open Window fails", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const structure = w.ctx.store.withRead((tx) => getExecutionStructureInTx(tx, w.executionRunId));
      const pending = structure.stages.find((stage) => stage.status === "pending");
      if (pending !== undefined) {
        expect(codeOf(() => issueDirective(w, { directiveId: "DIR-ST", stageId: pending.id }))).toBe(
          "EXECUTION_STAGE_NOT_ELIGIBLE",
        );
      }
      expect(
        codeOf(() => issueDirective(w, { directiveId: "DIR-W", windowId: "win_absent" })),
      ).toBe("VERIFICATION_WINDOW_REQUIRED");
      // The current open window is required, not just any window of the run.
      const directive = issueDirective(w, { directiveId: "DIR-OK" });
      expect(directive.windowId).toBe(w.openWindowId);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T8: a Directive cannot bind a different or 'latest' FinalPlan — the run binding wins", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const run = w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId));
      const wrongs = [
        { id: run!.finalPlan.id, revision: run!.finalPlan.revision + 1, hash: run!.finalPlan.hash },
        { id: run!.finalPlan.id, revision: run!.finalPlan.revision, hash: "sha256:deadbeef" },
        { id: "final_plan_latest", revision: 99, hash: "sha256:deadbeef" },
      ];
      for (const wrong of wrongs) {
        expect(codeOf(() => issueDirective(w, { directiveId: "DIR-FP", finalPlanRef: wrong }))).toBe(
          "EXECUTION_RUN_FINALPLAN_MISMATCH",
        );
      }
      const directive = issueDirective(w, { directiveId: "DIR-FP-OK" });
      expect(directive.finalPlanRef).toEqual(run!.finalPlan);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T9: planRefs must be exact approved references of the bound FinalPlan", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const approved = approvedRefOf(w);
      const ok = issueDirective(w, { directiveId: "DIR-REF-OK", planRefs: [approved] });
      expect(ok.planRefs).toEqual([approved]);
      const rejected: Array<{ kind: string; id: string; revision: number }> = [
        { kind: "question", id: approved.id, revision: approved.revision }, // not provable from the FinalPlan
        { kind: approved.kind, id: approved.id, revision: approved.revision + 1 }, // unapproved revision
        { kind: approved.kind, id: "ghost", revision: 1 }, // unapproved id
        { kind: "latest", id: approved.id, revision: approved.revision }, // non-exact vocabulary
      ];
      for (const ref of rejected) {
        expect(codeOf(() => issueDirective(w, { directiveId: "DIR-REF-BAD", planRefs: [ref] }))).toBe(
          "PLAN_REF_INVALID",
        );
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("T10: expected execution scope is persisted guidance — no path enforcement exists anywhere", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, {
        directiveId: "DIR-SCOPE",
        expectedExecutionScope: { files: ["src/index.ts"], symbols: ["main"], callPaths: [], tests: [] },
      });
      expect(directive.expectedExecutionScope.files).toEqual(["src/index.ts"]);
      // Static proof: the enforcement layers (hooks, MCP tools) never read
      // the expected scope, so no path allowlist / PreToolUse rejection can
      // exist (E4 §13). The scope fields live only in the pure domain and
      // persistence layers.
      const srcRoot = path.resolve(__dirname, "../src");
      const offenders: string[] = [];
      // The ENFORCEMENT layers are the hooks (deterministic PreToolUse) and the
      // host authority modules. The MCP layer legitimately ACCEPTS the scope as
      // directive content (guidance input) — it must never DECIDE with it.
      for (const layer of ["hooks", "host"]) {
        const dir = path.join(srcRoot, layer);
        const walk = (root: string): void => {
          for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            const full = path.join(root, entry.name);
            if (entry.isDirectory()) {
              walk(full);
            } else if (entry.name.endsWith(".ts")) {
              // Code only — prose mentions in doc comments are not enforcement.
              const code = fs
                .readFileSync(full, "utf8")
                .split(/\r?\n/)
                .filter((line) => {
                  const t = line.trim();
                  return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
                })
                .join("\n");
              if (code.includes("expectedExecutionScope")) {
                offenders.push(path.relative(srcRoot, full));
              }
            }
          }
        };
        walk(dir);
      }
      expect(offenders).toEqual([]);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T11: the capability envelope round-trips exactly — complete, explicit, no path-level fields", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const envelope = fullEnvelope({
        repositoryWrite: true,
        commandExecution: true,
        networkAccess: true,
        dependencyMutation: true,
        gitCommit: true,
        gitPush: true,
        externalServiceMutation: true,
      });
      const directive = issueDirective(w, { directiveId: "DIR-ENV", capabilityEnvelope: envelope });
      expect(directive.capabilityEnvelope).toEqual(envelope);
      const persisted = w.ctx.store.withRead((tx) => getExecutionDirectiveInTx(tx, "DIR-ENV", 1));
      expect(persisted!.capabilityEnvelope).toEqual(envelope);
      // Missing field.
      const partial = { ...envelope };
      delete (partial as Partial<ExecutionCapabilityEnvelope>).gitPush;
      expect(codeOf(() => issueDirective(w, { directiveId: "DIR-ENV-BAD", capabilityEnvelope: partial }))).toBe(
        "CAPABILITY_ENVELOPE_INVALID",
      );
      // Path-level capability fields do not exist in the schema.
      expect(codeOf(() =>
        parseCapabilityEnvelope({ ...envelope, allowedPaths: ["src/**"] }),
      )).toBe("CAPABILITY_ENVELOPE_INVALID");
      expect(Object.keys(parseCapabilityEnvelope(envelope))).not.toContain("allowedPaths");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T12: a stale Supervisor generation (or foreign session) cannot issue a Directive", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      expect(
        codeOf(() => issueDirective(w, { directiveId: "DIR-STALE-GEN", generation: w.f.generation + 1 })),
      ).toBe("STALE_SUPERVISOR_BINDING");
      expect(
        codeOf(() => issueDirective(w, { directiveId: "DIR-STALE-SESSION", sessionId: "S-OTHER" })),
      ).toBe("STALE_SUPERVISOR_BINDING");
      // The stale authority wrote nothing.
      const rows = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT count(*) AS n FROM execution_directives").get(),
      ) as { n: number };
      expect(rows.n).toBe(0);
      // Sanity: a thrown RuntimeError carries the stable code.
      try {
        issueDirective(w, { generation: w.f.generation + 1 });
        throw new Error("unreachable");
      } catch (err) {
        expect(err).toBeInstanceOf(RuntimeError);
      }
    } finally {
      w.ctx.store.close();
    }
  });
});
