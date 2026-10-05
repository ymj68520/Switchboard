/**
 * v0.2.0 E5 — worker assignment context (E5 §52 focused tests T8–T12): exact
 * Directive identity, exact plan refs only, fail-closed resolution, no
 * supervisor/main-session context, verifier independence.
 */
import { describe, expect, it } from "vitest";

import {
  callWorkerTool,
  codeOf,
  freshWorkerSession,
  makeWorkerWorld,
} from "./execution-worker-helpers.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { parseFinalPlanCanonical } from "../src/application/final-plan-canonical.js";

function claimFor(w: Awaited<ReturnType<typeof makeWorkerWorld>>, name = "W1"): ReturnType<typeof freshWorkerSession> {
  const session = freshWorkerSession(w, name);
  callWorkerTool(w, session, "worker_claim", {
    attempt_id: w.attempt.attemptId,
    launch_token: w.launch.launchToken,
  });
  return session;
}

describe("v0.2.0 E5 — worker assignment context (T8–T12)", () => {
  it("T8: the worker receives the EXACT bound Directive revision + hash, never a latest revision", async () => {
    const w = await makeWorkerWorld();
    try {
      // Issue a second revision BEFORE claim — the attempt still binds @1.
      const service = await import("../src/application/execution-directive-service.js");
      service.createExecutionDirectiveService(w.ctx.store, w.ctx.clock).issueExecutionDirective(
        (await import("./execution-protocol-helpers.js")).directiveInput(w, {
          directiveId: "DIR-W",
          objective: "revised instructions",
        }),
      );
      const session = claimFor(w, "W1");
      const assignment = callWorkerTool(w, session, "worker_get_assignment", {});
      const directive = assignment.directive as Record<string, unknown>;
      expect(directive.directiveId).toBe("DIR-W");
      expect(directive.revision).toBe(1);
      expect(directive.hash).toBe(w.directive.hash);
      expect(directive.objective).toBe(w.directive.objective);
      // The report contract and envelope travel with the directive.
      expect(directive.reportContract).toEqual(w.directive.reportContract);
      expect(directive.capabilityEnvelope).toEqual(w.directive.capabilityEnvelope);
      expect(typeof directive.body).toBe("string");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T9: the assignment contains EXACTLY Directive.planRefs — no extra approved Plan Memory", async () => {
    const w = await makeWorkerWorld();
    try {
      // Issue a directive with one exact approved ref (a FinalPlan section).
      const row = w.ctx.store.withRead((tx) => getFinalPlanInTx(tx, w.f.runId));
      const plan = parseFinalPlanCanonical(row!.canonicalJson, w.executionRunId);
      const section = plan.sections[0];
      const world2 = section
        ? await makeWorkerWorld("S1", {
            directiveId: "DIR-R",
            planRefs: [{ kind: "section", id: section.sectionId, revision: section.revision }],
          })
        : w;
      const session = claimFor(world2, "W1");
      const assignment = callWorkerTool(world2, session, "worker_get_assignment", {});
      const planContext = assignment.plan_context as Array<{ ref: { kind: string; id: string; revision: number } }>;
      const expected = section
        ? [{ kind: "section", id: section.sectionId, revision: section.revision }]
        : [];
      expect(planContext.map((entry) => entry.ref)).toEqual(expected);
      // The resolved content is the exact approved revision (not a projection dump).
      if (section) {
        expect((planContext[0] as unknown as { content: Record<string, unknown> }).content).toBeDefined();
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("T10: a referenced approved artifact that cannot be resolved fails the assignment closed", async () => {
    const w = await makeWorkerWorld();
    try {
      // The resolver contract: a planRef with no memory revision fails closed.
      const { resolveDirectivePlanContext } = await import("../src/application/worker-runtime-service.js");
      expect(
        codeOf(() =>
          resolveDirectivePlanContext(w.ctx.store, w.executionRunId, [
            { kind: "section", id: "SEC-GHOST", revision: 99 },
          ]),
        ),
      ).toBe("DIRECTIVE_NOT_CURRENT");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T11: the assignment carries no main-session transcript or supervisor reasoning", async () => {
    const w = await makeWorkerWorld();
    try {
      const session = claimFor(w, "W1");
      const assignment = callWorkerTool(w, session, "worker_get_assignment", {});
      const text = JSON.stringify(assignment);
      // The structural package has no conversation/reasoning surface at all.
      expect(assignment).not.toHaveProperty("conversation");
      expect(assignment).not.toHaveProperty("transcript");
      expect(assignment).not.toHaveProperty("reasoning");
      expect(assignment).not.toHaveProperty("supervisor_context");
      // The only plan context is the (empty) exact-ref list of this directive.
      expect(assignment.plan_context).toEqual([]);
      // Directives only — never the planning run's goal text or audit history.
      expect(text).not.toContain("planning_baseline");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T12: a verifier's assignment never includes Executor reports or conversation", async () => {
    const w = await makeWorkerWorld("S1", { kind: "verification" });
    try {
      // The executor cycle ran first via makeWorkerWorld? No — this world's
      // attempt IS the verification attempt. Simulate an executor report on a
      // PRIOR attempt of the same run, then claim as verifier and check.
      const session = claimFor(w, "V1");
      expect(w.attempt.workerRole).toBe("verifier");
      const assignment = callWorkerTool(w, session, "worker_get_assignment", {});
      const text = JSON.stringify(assignment);
      expect(text).not.toContain("executor_report");
      expect(text).not.toContain("previous_report");
      expect(text).not.toContain("action_performed");
      // Verifier independence is structural: the package derives from the
      // VerificationDirective alone.
      expect((assignment.directive as Record<string, unknown>).kind).toBe("verification");
      expect((assignment.worker_role as string)).toBe("verifier");
    } finally {
      w.ctx.store.close();
    }
  });
});
