/**
 * Observation capture orchestrator (Phase 9 §9/§11–§13/§36/§38/§40/§42).
 *
 * One PostToolUse-shaped host event → at most one ledger Observation. The
 * authority chain is fixed: the HOST provided the tool result; the Session-
 * Binding Store + WorkspaceRecord provided run/workspace attribution (the
 * caller resolves them — hook input ids are never trusted for attribution);
 * this module classifies, projects, sanitizes, fingerprints, CAS-publishes the
 * payload, and writes the metadata row inside one store transaction.
 *
 * Ordering (§42/§43): blobs are published BEFORE the metadata transaction;
 * a rollback may orphan a blob, which is a harmless future-GC candidate —
 * never a partial ledger row (BEGIN IMMEDIATE keeps metadata all-or-nothing).
 *
 * Capture-time fingerprinting (§36): a source-class Read records the
 * whole-file fingerprint AT OBSERVATION TIME. Promotion reuses it verbatim —
 * the file changing later never rewrites recorded provenance (§67), and
 * no freshness comparison happens in Phase 9.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { canonicalJson } from "../core/canonical-json.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { BlobStore } from "../store/blob-store.js";
import { insertObservationInTx } from "../store/observations.js";
import type { WorkspaceRecord } from "../store/repositories.js";
import { nodeGitRunner, type GitProbeOutcome } from "../workspace/discovery.js";
import { observationClassForTool } from "./classify.js";
import { projectToolInput, relativizeWorkspacePath, resolveAgainstWorkspace } from "./project-input.js";
import { payloadSanitizerMarker } from "./sanitize.js";
import {
  PAYLOAD_CONTENT_TYPE_BINARY,
  PAYLOAD_CONTENT_TYPE_OMITTED,
  PAYLOAD_CONTENT_TYPE_TEXT,
  type CaptureOutcome,
  type ObservationCaptureEvent,
  type SourceFingerprint,
} from "./types.js";

export interface ObservationCaptureDeps {
  store: PlanStore;
  clock: StoreClock;
  /** Attribution: the SessionBinding-resolved run + its workspace record. */
  runId: string;
  workspace: WorkspaceRecord;
  /** Content-addressed payload store over `${pluginDataRoot}/blobs`. */
  blobs: BlobStore;
  /** Test seam (§76 reuses the Phase 3 fixed-argv git policy). */
  gitRunner?: (cwd: string, args: string[]) => Promise<GitProbeOutcome>;
}

const GIT_HEAD_PATTERN = /^[0-9a-f]{40,64}$/;

/** §19: only UTF-8 textual results are promotion-capable; others are metadata-only. */
function isTextualResult(observationClass: "source" | "locator" | "execution", toolResponse: unknown): boolean {
  if (observationClass === "locator") return true;
  if (observationClass === "source") {
    const type = (toolResponse as { type?: unknown } | null)?.type;
    return type === undefined || type === "text";
  }
  return (toolResponse as { isImage?: unknown } | null)?.isImage !== true;
}

/** §35/§36: whole-file SHA-256 at observation time; never a promotion-time re-hash. */
function fingerprintSourceFile(observedPath: string, workspaceRoot: string): SourceFingerprint | null {
  const absolute = resolveAgainstWorkspace(observedPath, workspaceRoot);
  let stat: fs.Stats;
  let bytes: Buffer;
  try {
    stat = fs.statSync(absolute);
    if (!stat.isFile()) return null;
    bytes = fs.readFileSync(absolute);
  } catch {
    return null; // §37: capture survives without a fingerprint
  }
  return {
    path: relativizeWorkspacePath(absolute, workspaceRoot),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: stat.size,
    mtimeEpochMs: stat.mtimeMs,
  };
}

async function observeGitHead(cwd: string, runner: (cwd: string, args: string[]) => Promise<GitProbeOutcome>): Promise<string | null> {
  try {
    const outcome = await runner(cwd, ["rev-parse", "HEAD"]);
    if (outcome.kind !== "exit" || outcome.exitCode !== 0) return null;
    const head = outcome.stdout.trim().split(/\r?\n/)[0] ?? "";
    return GIT_HEAD_PATTERN.test(head) ? head : null;
  } catch {
    return null; // §75: git context never blocks the Observation itself
  }
}

/**
 * Capture one host tool result. Skips (never records) unsupported tools;
 * throws OBSERVATION_CAPTURE_FAILED only when an evidence-capable event
 * cannot be recorded — the hook layer turns that into a fail-visible warning
 * while the tool execution itself is never reported as failed (§60).
 */
export async function captureObservation(deps: ObservationCaptureDeps, event: ObservationCaptureEvent): Promise<CaptureOutcome> {
  const observationClass = observationClassForTool(event.toolName);
  if (observationClass === null) {
    return { status: "skipped", reason: "unsupported tool" };
  }
  const workspaceRoot = deps.workspace.canonicalRoot;
  const projection = projectToolInput(event.toolName, observationClass, event.toolInput, workspaceRoot);

  const capturedAt = deps.clock.nowIso();
  const blobs = deps.blobs;

  let payloadHash: string | null = null;
  let payloadSize: number | null = null;
  let contentType: string;
  let promotable = false;
  const sanitized = payloadSanitizerMarker(event);
  if (sanitized !== null) {
    // §15: detectable secret-exposure results are OMITTED, never persisted.
    contentType = PAYLOAD_CONTENT_TYPE_OMITTED;
  } else if (!isTextualResult(observationClass, event.toolResponse)) {
    // §19: non-textual results are captured as metadata only.
    contentType = PAYLOAD_CONTENT_TYPE_BINARY;
  } else {
    const bytes = Buffer.from(canonicalJson(event.toolResponse), "utf8");
    const published = blobs.putBytes(bytes); // blob first, metadata transaction second (§42)
    payloadHash = published.payloadHash;
    payloadSize = published.payloadSize;
    contentType = PAYLOAD_CONTENT_TYPE_TEXT;
    promotable = true;
  }

  const sourceFingerprint =
    observationClass === "source" && projection.kind === "source"
      ? fingerprintSourceFile(projection.path, workspaceRoot)
      : null;
  const repositoryRevision = await observeGitHead(workspaceRoot, deps.gitRunner ?? nodeGitRunner);

  const observationId = `obs_${deps.clock.newId()}`;
  const outcome = deps.store.withWrite((tx) =>
    insertObservationInTx(tx, {
      runId: deps.runId,
      workspaceId: deps.workspace.workspaceId,
      sessionId: event.sessionId,
      observationId,
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      observationClass,
      input: projection,
      payloadHash,
      payloadSize,
      contentType,
      sourceFingerprint,
      repositoryRevision,
      promotable,
      sanitized,
      capturedAt,
    }),
  );
  return outcome.status === "duplicate" ? outcome : { status: "captured", observation: outcome.observation };
}
