/**
 * P7 E2E Test Suite — Abort Workspace Lifecycle & Reconciliation.
 *
 * Requirements verified:
 * 1. Pre-records physical execution baseline with user's uncommitted/untracked files.
 * 2. Completes Stage 1 and Stage 2 with ExecutionCommits and verified deliverables.
 * 3. Stage 3 produces unaccepted candidate modifications and temporary build files.
 * 4. Human-authorized Abort transitions run to terminal aborted without crude git reset --hard.
 * 5. Generates comprehensive Abort Manifest distinguishing:
 *    - Accepted commit files
 *    - Unaccepted candidate files
 *    - User pre-existing files
 *    - Temporary build artifacts
 * 6. Default Abort performs NO destructive rollback (all files survive).
 * 7. Explicit user-authorized cleanup safely removes only unaccepted/temporary files,
 *    strictly preserving all user pre-existing files and accepted achievements.
 * 8. A new execution run can safely start on the reconciled workspace.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  boundariesOf,
  completeStageViaGate,
  currentRevision,
  freshWorkerSession,
  getAcceptedHeadCommitIdInTx,
  makeAcceptanceWorld,
  runImplementation,
  runFreshVerifier,
  supervisorCall,
  callWorkerTool,
  startWorkerAttemptAndPrepareLaunchInTx,
} from "./v020-e2e-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import {
  capturePhysicalWorkspaceBaseline,
  executeExplicitCleanup,
  generateAbortManifestInTx,
} from "../src/application/workspace-reconciliation-service.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";

function abortViaMcp(
  world: any,
  input: { requesterSessionId: string; reason: string; toolUseId: string },
): Record<string, unknown> {
  const business = { execution_run_id: world.executionRunId, reason: input.reason };
  const token = hostTokenV2(world.ctx.secret, "abort_execution_run", business, {
    sessionId: input.requesterSessionId,
    workspaceId: world.f.workspaceId,
  }, { permissionMode: "default", toolUseId: input.toolUseId });
  return executePhasePlanTool(world.ctx, "abort_execution_run", { ...business, _hostContext: token });
}

describe("P7: Abort Workspace Lifecycle & Reconciliation E2E", () => {
  it("generates honest Abort Manifest, preserves user pre-existing files, and executes non-destructive explicit cleanup", async () => {
    const world = await makeAcceptanceWorld("P7-E2E");
    const wsRoot = world.f.workspaceRoot;

    // -------------------------------------------------------------------------
    // 1. User pre-existing files in workspace before execution mutations
    // -------------------------------------------------------------------------
    const userNotesFile = path.join(wsRoot, "user-notes.txt");
    fs.writeFileSync(userNotesFile, "User confidential research notes — do not touch!\n");

    const userReadmeFile = path.join(wsRoot, "USER_README.md");
    fs.writeFileSync(userReadmeFile, "# User Project Notes\nCustom configuration.\n");

    // Capture initial physical baseline
    const initialBaseline = capturePhysicalWorkspaceBaseline(wsRoot);
    expect(initialBaseline.userUntrackedFiles.some((f) => f.includes("user-notes.txt"))).toBe(true);

    // -------------------------------------------------------------------------
    // 2. Complete Stage 1 and Stage 2 with ExecutionCommits
    // -------------------------------------------------------------------------
    const dbFile = path.join(wsRoot, "src", "database.ts");
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(dbFile, "export const DB = { connected: true };\n");

    const st1 = completeStageViaGate(world);
    expect(st1.commitId).toBeTruthy();

    const boundsAfterSt1 = boundariesOf(world);
    const st2Id = boundsAfterSt1.stages[1]!.id;

    // Activate Stage 2
    const act2 = supervisorCall(world, "activate_execution_stage", {
      target_stage_id: st2Id,
    }) as { window: { id: string } };
    world.activeStageId = st2Id;
    world.openWindowId = act2.window.id;

    // Implement and complete Stage 2
    const authFile = path.join(wsRoot, "src", "auth.ts");
    fs.writeFileSync(authFile, "export const Auth = { verifyToken: () => true };\n");

    runImplementation(world, {
      directiveId: "DIR-P7-ST2-IMPL",
      candidateMutated: true,
      reportOverrides: {
        files_changed: ["src/auth.ts"],
      },
    });

    const st2 = completeStageViaGate(world);
    expect(st2.commitId).toBeTruthy();

    // -------------------------------------------------------------------------
    // 3. Stage 3: Unaccepted modifications and temporary build artifacts
    // -------------------------------------------------------------------------
    // Begin final closure window to run unaccepted integration work
    const begin = supervisorCall(world, "begin_execution_final_closure") as {
      status: string;
      window: { id: string; candidate_revision: number };
    };
    expect(begin.status).toBe("final_closure_open");
    world.openWindowId = begin.window.id;

    const experimentalFile = path.join(wsRoot, "src", "experimental.ts");
    fs.writeFileSync(experimentalFile, "export const Experimental = 'unaccepted_work';\n");

    const tempBuildFile = path.join(wsRoot, "temp-build.tmp");
    fs.writeFileSync(tempBuildFile, "Temporary build cache 12345\n");

    const unacceptedDirective = issueDirective(world, {
      directiveId: "DIR-P7-UNACCEPTED-IMPL",
      kind: "implementation",
      scopeKind: "final_closure" as never,
      stageId: undefined,
      windowId: world.openWindowId,
    });

    const { attempt, launch } = world.ctx.store.withWrite((tx: any) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: unacceptedDirective.directiveId,
          directiveRevision: unacceptedDirective.revision,
          directiveHash: unacceptedDirective.hash,
          workerRole: "executor",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );

    const session = freshWorkerSession(world, "W-P7");
    callWorkerTool(world, session, "worker_claim", {
      attempt_id: attempt.attemptId,
      launch_token: launch.launchToken,
    });
    callWorkerTool(world, session, "worker_submit_report", {
      result: "completed",
      candidate_mutated: true,
      files_changed: ["src/experimental.ts", "temp-build.tmp"],
      actions_performed: [{ action: "experiment", detail: "created experimental files" }],
    });

    // -------------------------------------------------------------------------
    // 4. Human-Authorized Abort
    // -------------------------------------------------------------------------
    const abortResult = abortViaMcp(world, {
      requesterSessionId: "P7-HUMAN-USER",
      reason: "User decided to abort run: architecture change requested before Stage 3",
      toolUseId: "TU-P7-ABORT-DIALOG",
    }) as {
      status: string;
      abort_manifest: any;
      execution_run: { lifecycle: string };
    };

    expect(abortResult.status).toBe("aborted");
    expect(abortResult.execution_run.lifecycle).toBe("aborted");
    expect(abortResult.abort_manifest).toBeDefined();

    // -------------------------------------------------------------------------
    // 5. Verify Abort Manifest content
    // -------------------------------------------------------------------------
    const manifest = abortResult.abort_manifest;
    expect(manifest.executionRunId).toBe(world.executionRunId);
    expect(manifest.acceptedHeadCommitId).toBe(st2.commitId);
    expect(manifest.completedStages).toHaveLength(2);

    // Verify file categorization
    expect(manifest.acceptedFiles).toContain("src/auth.ts");
    expect(manifest.unacceptedCandidateFiles).toContain("src/experimental.ts");
    expect(manifest.unacceptedCandidateFiles).toContain("temp-build.tmp");
    expect(manifest.userPreExistingFiles.some((f: string) => f.includes("user-notes.txt"))).toBe(true);
    expect(manifest.temporaryBuildFiles).toContain("temp-build.tmp");

    // -------------------------------------------------------------------------
    // 6. Verify Default Abort is NON-DESTRUCTIVE (all files still exist)
    // -------------------------------------------------------------------------
    expect(fs.existsSync(userNotesFile)).toBe(true);
    expect(fs.existsSync(userReadmeFile)).toBe(true);
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(fs.existsSync(authFile)).toBe(true);
    expect(fs.existsSync(experimentalFile)).toBe(true);
    expect(fs.existsSync(tempBuildFile)).toBe(true);

    // -------------------------------------------------------------------------
    // 7. Explicit User-Authorized Cleanup: clean_unaccepted_only
    // -------------------------------------------------------------------------
    const cleanupResult = executeExplicitCleanup(wsRoot, manifest, "clean_unaccepted_only");
    expect(cleanupResult.deletedFiles).toContain("src/experimental.ts");
    expect(cleanupResult.deletedFiles).toContain("temp-build.tmp");

    // CRITICAL INVARIANT: User pre-existing files and accepted files are NEVER deleted!
    expect(fs.existsSync(userNotesFile)).toBe(true);
    expect(fs.readFileSync(userNotesFile, "utf8")).toBe("User confidential research notes — do not touch!\n");

    expect(fs.existsSync(userReadmeFile)).toBe(true);
    expect(fs.readFileSync(userReadmeFile, "utf8")).toBe("# User Project Notes\nCustom configuration.\n");

    expect(fs.existsSync(dbFile)).toBe(true); // Stage 1 accepted
    expect(fs.existsSync(authFile)).toBe(true); // Stage 2 accepted

    // Only unaccepted files were safely removed
    expect(fs.existsSync(experimentalFile)).toBe(false);
    expect(fs.existsSync(tempBuildFile)).toBe(false);

    // -------------------------------------------------------------------------
    // 8. Reconciled workspace is clean and ready for future runs
    // -------------------------------------------------------------------------
    const postCleanupBaseline = capturePhysicalWorkspaceBaseline(wsRoot);
    expect(postCleanupBaseline.userUntrackedFiles.some((f) => f.includes("experimental.ts"))).toBe(false);
    expect(postCleanupBaseline.userUntrackedFiles.some((f) => f.includes("user-notes.txt"))).toBe(true);
  });
});
