/**
 * Workspace Lifecycle & Abort Reconciliation Service (Phase Plan v0.2.0 P7).
 *
 * Implements:
 * 1. Physical execution baseline capture (git HEAD, branch, pre-existing dirty/untracked files).
 * 2. Accepted checkpoint recording at ExecutionCommit boundaries.
 * 3. Comprehensive Abort Manifest distinguishing accepted, unaccepted, user pre-existing, and temporary files.
 * 4. Explicit non-destructive cleanup without destructive repository reset operations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

import type { StoreTx } from "../store/transaction.js";
import { getExecutionRunInTx } from "../store/execution-runs.js";
import { listExecutionStagesInTx, getOpenWindowInTx } from "../store/execution-structure.js";
import { listRunCommitsInTx, getAcceptedHeadCommitIdInTx } from "../store/execution-commits.js";
import { listRunReportsInTx } from "../store/execution-reports.js";
import { getExecutionAbortRecordInTx } from "../store/execution-aborts.js";

export interface PhysicalWorkspaceBaseline {
  capturedAt: string;
  gitHead: string | null;
  gitBranch: string | null;
  userModifiedFiles: string[];
  userUntrackedFiles: string[];
  fileFingerprints: Record<string, string>; // relativePath -> sha256
}

export interface AcceptedCheckpoint {
  commitId: string;
  stageId: string | null;
  sequence: number;
  acceptedFiles: string[];
  fileFingerprints: Record<string, string>;
  createdAt: string;
}

export interface AbortManifest {
  executionRunId: string;
  abortedAt: string;
  acceptedHeadCommitId: string | null;
  completedStages: Array<{ id: string; ordinal: number; objective: string }>;
  acceptedFiles: string[];
  unacceptedCandidateFiles: string[];
  userPreExistingFiles: string[];
  temporaryBuildFiles: string[];
  unclassifiedFiles: string[];
  safeCleanupOptions: Array<{
    option: "keep_all" | "clean_unaccepted_only" | "export_diff";
    description: string;
    safe: boolean;
  }>;
}

export interface CleanupResult {
  mode: "keep_all" | "clean_unaccepted_only" | "export_diff";
  retainedFiles: string[];
  deletedFiles: string[];
  exportedDiffPath: string | null;
}

function computeFileHash(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return null;
    const content = fs.readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Capture physical workspace baseline before execution begins.
 */
export function capturePhysicalWorkspaceBaseline(workspaceRoot: string): PhysicalWorkspaceBaseline {
  const now = new Date().toISOString();
  let gitHead: string | null = null;
  let gitBranch: string | null = null;
  const userModifiedFiles: string[] = [];
  const userUntrackedFiles: string[] = [];
  const fileFingerprints: Record<string, string> = {};

  if (!fs.existsSync(workspaceRoot)) {
    return {
      capturedAt: now,
      gitHead: null,
      gitBranch: null,
      userModifiedFiles: [],
      userUntrackedFiles: [],
      fileFingerprints: {},
    };
  }

  try {
    // Check if git repo
    gitHead = execSync("git rev-parse HEAD", { cwd: workspaceRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
    gitBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();

    // Query status porcelain
    const statusOut = execSync("git status --porcelain -uall", { cwd: workspaceRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8");

    const lines = statusOut.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.length < 4) continue;
      const status = line.slice(0, 2);
      const relPath = line.slice(3).trim();

      if (status === "??") {
        userUntrackedFiles.push(relPath);
      } else {
        userModifiedFiles.push(relPath);
      }

      const absPath = path.resolve(workspaceRoot, relPath);
      const hash = computeFileHash(absPath);
      if (hash) fileFingerprints[relPath] = hash;
    }
  } catch {
    // Non-git directory: scan files directly on disk
    function scanDir(dir: string, base: string) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const fullPath = path.join(dir, entry.name);
        const rel = path.relative(base, fullPath).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          scanDir(fullPath, base);
        } else if (entry.isFile()) {
          userUntrackedFiles.push(rel);
          const hash = computeFileHash(fullPath);
          if (hash) fileFingerprints[rel] = hash;
        }
      }
    }
    scanDir(workspaceRoot, workspaceRoot);
  }

  return {
    capturedAt: now,
    gitHead,
    gitBranch,
    userModifiedFiles,
    userUntrackedFiles,
    fileFingerprints,
  };
}

/**
 * Generate a comprehensive, honest Abort Manifest for an aborted ExecutionRun.
 */
export function generateAbortManifestInTx(
  tx: StoreTx,
  executionRunId: string,
  workspaceRoot: string,
): AbortManifest {
  const run = getExecutionRunInTx(tx, executionRunId);
  const stages = listExecutionStagesInTx(tx, executionRunId);
  const commits = listRunCommitsInTx(tx, executionRunId);
  const headCommitId = getAcceptedHeadCommitIdInTx(tx, executionRunId);
  const reports = listRunReportsInTx(tx, executionRunId);

  const completedStages = stages
    .filter((s) => s.status === "completed")
    .map((s) => ({ id: s.id, ordinal: s.ordinal, objective: s.objective }));

  // 1. Identify accepted files from all accepted ExecutionCommits
  const acceptedFilesSet = new Set<string>();
  for (const commit of commits) {
    for (const rRef of commit.reportRefs) {
      const rep = reports.find((r) => r.reportId === rRef.reportId);
      if (rep && rep.filesChanged) {
        rep.filesChanged.forEach((f) => acceptedFilesSet.add(f));
      }
    }
  }
  const acceptedFiles = Array.from(acceptedFilesSet);

  // 2. Identify unaccepted candidate files (files changed in current window after latest commit)
  const openWindow = getOpenWindowInTx(tx, executionRunId);
  const unacceptedFilesSet = new Set<string>();
  for (const rep of reports) {
    // If report is not in any commit, its changes are unaccepted
    const isCommitted = commits.some((c) => c.reportRefs.some((ref) => ref.reportId === rep.reportId));
    if (!isCommitted && rep.filesChanged) {
      rep.filesChanged.forEach((f) => {
        if (!acceptedFilesSet.has(f)) {
          unacceptedFilesSet.add(f);
        }
      });
    }
  }
  const unacceptedCandidateFiles = Array.from(unacceptedFilesSet);

  // 3. User pre-existing files (from execution baseline if recorded, or derived from git status)
  let userPreExistingFiles: string[] = [];
  try {
    const baseline = run?.executionStartBaseline as any;
    if (baseline?.physicalBaseline) {
      const p = baseline.physicalBaseline as PhysicalWorkspaceBaseline;
      userPreExistingFiles = [...p.userModifiedFiles, ...p.userUntrackedFiles];
    } else if (workspaceRoot !== "") {
      const currentPhysical = capturePhysicalWorkspaceBaseline(workspaceRoot);
      userPreExistingFiles = [
        ...currentPhysical.userModifiedFiles.filter((f) => !acceptedFilesSet.has(f) && !unacceptedFilesSet.has(f)),
        ...currentPhysical.userUntrackedFiles.filter((f) => !acceptedFilesSet.has(f) && !unacceptedFilesSet.has(f)),
      ];
    }
  } catch {
    // ignore
  }

  // 4. Temporary build artifacts
  const temporaryBuildFiles: string[] = [];
  const buildPatterns = [/\.tmp$/i, /^dist\//i, /^build\//i, /\.cache\//i, /^temp-/i];
  for (const f of unacceptedCandidateFiles) {
    if (buildPatterns.some((p) => p.test(f))) {
      temporaryBuildFiles.push(f);
    }
  }

  return {
    executionRunId,
    abortedAt: new Date().toISOString(),
    acceptedHeadCommitId: headCommitId,
    completedStages,
    acceptedFiles,
    unacceptedCandidateFiles,
    userPreExistingFiles,
    temporaryBuildFiles,
    unclassifiedFiles: [],
    safeCleanupOptions: [
      {
        option: "keep_all",
        description: "Preserve entire workspace as-is with all files intact (default non-destructive path)",
        safe: true,
      },
      {
        option: "export_diff",
        description: "Export unaccepted candidate changes as a unified diff patch file without deleting files",
        safe: true,
      },
      {
        option: "clean_unaccepted_only",
        description: "Preserve all user pre-existing files and accepted commits; safely remove only unaccepted candidate changes and temporary files",
        safe: true,
      },
    ],
  };
}

/**
 * Execute explicit safe cleanup requested by human user.
 * Crucially: NEVER touches userPreExistingFiles or acceptedFiles.
 */
export function executeExplicitCleanup(
  workspaceRoot: string,
  manifest: AbortManifest,
  mode: "keep_all" | "clean_unaccepted_only" | "export_diff",
): CleanupResult {
  const retainedFiles: string[] = [];
  const deletedFiles: string[] = [];
  let exportedDiffPath: string | null = null;

  if (mode === "keep_all") {
    return {
      mode,
      retainedFiles: [...manifest.acceptedFiles, ...manifest.unacceptedCandidateFiles, ...manifest.userPreExistingFiles],
      deletedFiles: [],
      exportedDiffPath: null,
    };
  }

  if (mode === "export_diff") {
    // Export diff of unaccepted files
    const patchPath = path.join(workspaceRoot, `aborted-${manifest.executionRunId.slice(0, 8)}.patch`);
    let patchContent = `# Abort Manifest Diff for ${manifest.executionRunId}\n# Created at ${manifest.abortedAt}\n\n`;
    for (const relFile of manifest.unacceptedCandidateFiles) {
      const absFile = path.resolve(workspaceRoot, relFile);
      if (fs.existsSync(absFile)) {
        patchContent += `--- a/${relFile}\n+++ b/${relFile}\n`;
        patchContent += fs.readFileSync(absFile, "utf8") + "\n";
      }
    }
    fs.writeFileSync(patchPath, patchContent);
    exportedDiffPath = patchPath;

    return {
      mode,
      retainedFiles: [...manifest.acceptedFiles, ...manifest.unacceptedCandidateFiles, ...manifest.userPreExistingFiles],
      deletedFiles: [],
      exportedDiffPath: patchPath,
    };
  }

  if (mode === "clean_unaccepted_only") {
    const userFilesSet = new Set(manifest.userPreExistingFiles);
    const acceptedFilesSet = new Set(manifest.acceptedFiles);

    for (const relFile of manifest.unacceptedCandidateFiles) {
      // INVARIANT: Never delete user pre-existing files or accepted commit files
      if (userFilesSet.has(relFile) || acceptedFilesSet.has(relFile)) {
        retainedFiles.push(relFile);
        continue;
      }

      const absFile = path.resolve(workspaceRoot, relFile);
      if (fs.existsSync(absFile)) {
        try {
          fs.unlinkSync(absFile);
          deletedFiles.push(relFile);
        } catch {
          retainedFiles.push(relFile);
        }
      }
    }

    return {
      mode,
      retainedFiles: [...manifest.acceptedFiles, ...manifest.userPreExistingFiles, ...retainedFiles],
      deletedFiles,
      exportedDiffPath: null,
    };
  }

  return {
    mode,
    retainedFiles,
    deletedFiles,
    exportedDiffPath: null,
  };
}
