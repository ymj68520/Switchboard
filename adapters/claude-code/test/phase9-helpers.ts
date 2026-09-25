/**
 * Shared Phase 9 fixtures: Observation capture helpers over a real store
 * fixture, a real temp workspace with a fingerprintable source file, and the
 * Phase 9 host-token factory (reuse of the Phase 8 shape, §45).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { createBlobStore, type BlobStore } from "../src/store/blob-store.js";
import { getWorkspaceById, type WorkspaceRecord } from "../src/store/repositories.js";
import type { ObservationCaptureDeps } from "../src/observations/capture.js";
import type { ObservationCaptureEvent } from "../src/observations/types.js";
import { makeContextFixture, type ContextFixture } from "./context-helpers.js";

export interface Phase9Fixture extends ContextFixture {
  blobs: BlobStore;
  workspace: WorkspaceRecord;
  /** Directory the fixture's sample files live in (= workspace root). */
  workspaceRoot: string;
  close(): void;
}

export async function makePhase9Fixture(sessionId = "S1"): Promise<Phase9Fixture> {
  const fixture = await makeContextFixture(sessionId);
  // The proposal fixture's project dir doubles as the workspace root here;
  // the binding/workspaceId already points at its registered workspace.
  const workspace = getWorkspaceById(fixture.store, fixture.workspaceId);
  if (workspace === null) {
    throw new Error("phase9 fixture: bound workspace missing from the catalog");
  }
  const workspaceRoot = workspace.canonicalRoot;
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return {
    ...fixture,
    blobs: createBlobStore(path.join(fixture.root, "blobs")),
    workspace,
    workspaceRoot,
    close: fixture.close,
  };
}

let captureIdCounter = 0;

export function captureDeps(fixture: Phase9Fixture, overrides: Partial<ObservationCaptureDeps> = {}): ObservationCaptureDeps {
  return {
    store: fixture.store,
    clock: {
      nowIso: () => new Date(0).toISOString(),
      // Process-unique observation ids: several deps instances may capture
      // into one run across one test, and observation ids must never collide.
      newId: () => `obs${(captureIdCounter += 1)}`,
    },
    runId: fixture.runId,
    workspace: fixture.workspace,
    blobs: fixture.blobs,
    ...overrides,
  };
}

export function writeSourceFile(fixture: Phase9Fixture, relativePath: string, content: string): string {
  const absolute = path.join(fixture.workspaceRoot, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
  return absolute;
}

export function sourceEvent(
  fixture: Phase9Fixture,
  relativePath: string,
  overrides: Partial<ObservationCaptureEvent> = {},
): ObservationCaptureEvent {
  const absolute = path.join(fixture.workspaceRoot, relativePath);
  // Missing/unreadable files are legitimate capture scenarios (§37) — the
  // default response is only computed when the file actually exists.
  let content = "";
  try {
    content = fs.readFileSync(absolute, "utf8");
  } catch {
    content = "";
  }
  return {
    sessionId: fixture.sessionId,
    toolName: "Read",
    toolUseId: `call_${relativePath.replace(/[^a-z0-9]/gi, "")}`,
    toolInput: { file_path: absolute },
    toolResponse: { type: "text", file: { filePath: relativePath, content } },
    cwd: fixture.workspaceRoot,
    ...overrides,
  };
}

export function locatorEvent(
  fixture: Phase9Fixture,
  overrides: Partial<ObservationCaptureEvent> = {},
): ObservationCaptureEvent {
  return {
    sessionId: fixture.sessionId,
    toolName: "Grep",
    toolUseId: "call_grep1",
    toolInput: { pattern: "alpha" },
    toolResponse: { mode: "files_with_matches", filenames: ["sample.txt"], numFiles: 1, totalFiles: 1 },
    cwd: fixture.workspaceRoot,
    ...overrides,
  };
}

export function executionEvent(
  fixture: Phase9Fixture,
  command: string,
  overrides: Partial<ObservationCaptureEvent> = {},
): ObservationCaptureEvent {
  return {
    sessionId: fixture.sessionId,
    toolName: "PowerShell",
    toolUseId: `call_exec_${Math.abs(hash(command))}`,
    toolInput: { command, description: "phase9 fixture" },
    toolResponse: { stdout: "ok", stderr: "", interrupted: false, isImage: false },
    cwd: fixture.workspaceRoot,
    ...overrides,
  };
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}
