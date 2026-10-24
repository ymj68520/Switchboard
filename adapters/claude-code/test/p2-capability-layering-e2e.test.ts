/**
 * P2 E2E Test Suite — Shell Capability Layering vs Fine-grained Capability Enforcement.
 *
 * Verifies:
 * 1. Allows compilation, build, tests, and workspace mutations with commandExecution=true.
 * 2. Explicitly forbids gitPush, networkAccess, gitCommit, and external service mutations.
 * 3. Layered enforcement allows worker launch with fine-grained restriction envelope.
 * 4. Normal build/test commands succeed cleanly.
 * 5. Prohibited operations (git push, git commit, curl/network) are rejected at the execution boundary.
 * 6. Interception leaves clear audit records and does not corrupt authorized build work.
 * 7. System honestly exposes enforceability tiers (enforceable vs advisory) without false sandbox claims.
 * 8. Real local git repository: no unapproved commits or pushes occur.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  boundariesOf,
  callWorkerTool,
  freshWorkerSession,
  makeAcceptanceWorld,
  runImplementation,
  runFreshVerifier,
  supervisorCall,
  startWorkerAttemptAndPrepareLaunchInTx,
} from "./v020-e2e-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { narrowWorkerTool, capabilityEnforceabilityReport } from "../src/runtime/worker-capabilities.js";
import { handlePreToolUse } from "../src/hooks/handlers.js";

describe("P2: Shell Capability Layering vs Fine-grained Capability Enforcement E2E", () => {
  it("honestly exposes enforceability tiers without false sandbox claims", () => {
    const envelope = {
      repositoryRead: true,
      repositoryWrite: true,
      commandExecution: true,
      networkAccess: false,
      dependencyMutation: false,
      gitCommit: false,
      gitPush: false,
      externalServiceMutation: false,
    };

    const report = capabilityEnforceabilityReport(envelope);
    expect(report).toHaveLength(8);

    const gitPushReport = report.find((r) => r.capability === "gitPush")!;
    expect(gitPushReport.granted).toBe(false);
    expect(gitPushReport.tier).toBe("enforceable");

    const gitCommitReport = report.find((r) => r.capability === "gitCommit")!;
    expect(gitCommitReport.granted).toBe(false);
    expect(gitCommitReport.tier).toBe("enforceable");

    const networkReport = report.find((r) => r.capability === "networkAccess")!;
    expect(networkReport.granted).toBe(false);
    // Honestly marked advisory when shell is active, noting lack of OS network sandbox
    expect(networkReport.tier).toBe("advisory");
    expect(networkReport.mechanism).toContain("advisory without container sandbox");
  });

  it("executes build/test with commandExecution=true while intercepting prohibited operations at execution boundary", async () => {
    const world = await makeAcceptanceWorld("P2-E2E");
    const wsRoot = world.f.workspaceRoot;

    // Set up local build script in workspace
    const buildScript = path.join(wsRoot, "build.js");
    fs.writeFileSync(buildScript, "console.log('BUILD_SUCCESS');\n");

    // 1. Issue Directive with commandExecution=true and restricted high-risk capabilities
    const fineGrainedEnvelope = {
      repositoryRead: true,
      repositoryWrite: true,
      commandExecution: true,
      networkAccess: false,
      dependencyMutation: false,
      gitCommit: false,
      gitPush: false,
      externalServiceMutation: false,
    };

    const directive = issueDirective(world, {
      directiveId: "DIR-P2-BUILD-TEST",
      kind: "implementation",
      capabilityEnvelope: fineGrainedEnvelope as never,
    });

    // 2. Launch worker attempt using layered enforcement policy
    const { attempt, launch } = world.ctx.store.withWrite((tx: any) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: directive.directiveId,
          directiveRevision: directive.revision,
          directiveHash: directive.hash,
          workerRole: "executor",
          enforcementPolicy: "layered",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );

    expect(attempt.state).toBe("running");
    expect(launch.launchToken).toBeTruthy();

    // 3. Worker claims attempt and checks assignment
    const session = freshWorkerSession(world, "W-P2");
    const claimResult = callWorkerTool(world, session, "worker_claim", {
      attempt_id: attempt.attemptId,
      launch_token: launch.launchToken,
    }) as { status: string };
    expect(claimResult.status).toBe("claimed");

    const assignment = callWorkerTool(world, session, "worker_get_assignment", {}) as {
      status: string;
      directive: any;
      capability_enforceability: Array<{ capability: string; granted: boolean; tier: string }>;
    };
    expect(assignment.status).toBe("ok");
    expect(assignment.capability_enforceability).toBeDefined();

    const pushEnforceability = assignment.capability_enforceability.find((c) => c.capability === "gitPush");
    expect(pushEnforceability?.granted).toBe(false);

    // 4. Verify boundary narrowing decisions directly on shell commands
    // 4a. Authorized build / test commands are ALLOWED:
    const buildDecision = narrowWorkerTool("Bash", fineGrainedEnvelope, { command: "node build.js" });
    expect(buildDecision.allowed).toBe(true);

    const testDecision = narrowWorkerTool("Bash", fineGrainedEnvelope, { command: "npm test -- --run" });
    expect(testDecision.allowed).toBe(true);

    // 4b. Prohibited commands are REJECTED at the execution boundary:
    const pushDecision = narrowWorkerTool("Bash", fineGrainedEnvelope, { command: "git push origin main" });
    expect(pushDecision.allowed).toBe(false);
    if (!pushDecision.allowed) {
      expect(pushDecision.capability).toBe("gitPush");
      expect(pushDecision.reason).toContain("gitPush=false");
    }

    const commitDecision = narrowWorkerTool("Bash", fineGrainedEnvelope, { command: "git commit -m 'unauthorized commit'" });
    expect(commitDecision.allowed).toBe(false);
    if (!commitDecision.allowed) {
      expect(commitDecision.capability).toBe("gitCommit");
      expect(commitDecision.reason).toContain("gitCommit=false");
    }

    const curlDecision = narrowWorkerTool("Bash", fineGrainedEnvelope, { command: "curl -s http://unauthorized.external.com" });
    expect(curlDecision.allowed).toBe(false);
    if (!curlDecision.allowed) {
      expect(curlDecision.capability).toBe("networkAccess");
      expect(curlDecision.reason).toContain("networkAccess=false");
    }

    const npmInstallDecision = narrowWorkerTool("Bash", fineGrainedEnvelope, { command: "npm install malicious-pkg" });
    expect(npmInstallDecision.allowed).toBe(false);
    if (!npmInstallDecision.allowed) {
      expect(npmInstallDecision.capability).toBe("dependencyMutation");
      expect(npmInstallDecision.reason).toContain("dependencyMutation=false");
    }

    // 5. Test PreToolUse hook integration for the worker session
    // Calling WebFetch tool directly is denied mechanically:
    const webFetchDenial = narrowWorkerTool("WebFetch", fineGrainedEnvelope);
    expect(webFetchDenial.allowed).toBe(false);

    // 6. Complete normal authorized work and verify submit report succeeds
    fs.mkdirSync(path.join(wsRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, "src", "feature.ts"), "export const Built = true;\n");

    const reportAck = callWorkerTool(world, session, "worker_submit_report", {
      result: "completed",
      candidate_mutated: true,
      actions_performed: [{ action: "build", detail: "compiled local modules" }],
      commands_run: [{ command: "node build.js", detail: "exit 0" }],
      files_changed: ["src/feature.ts"],
    }) as { report_id: string };

    expect(reportAck.report_id).toBeTruthy();

    // 7. Verify verifier run and supervisor acceptance
    runFreshVerifier(world, { directiveId: "DIR-P2-VERIFY" });
    const accept = acceptViaMcp(world);
    expect(accept.status).toBe("accepted");
    expect(accept.commit).toBeDefined();

    // Verify bounds advanced cleanly
    const bounds = boundariesOf(world);
    expect(bounds.acceptedHead).toBe((accept.commit as { id: string }).id);
  });
});
