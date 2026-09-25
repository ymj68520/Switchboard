/**
 * Real child-process worker for Phase 9 concurrency tests: performs exactly
 * one capture or one promotion against the canonical store and prints one
 * JSON result line (the same shape used by the Phase 4 store workers).
 */

import * as path from "node:path";
import { initializePlanStore } from "../../src/store/sqlite-store.js";
import { systemStoreClock } from "../../src/store/clock.js";
import { createBlobStore } from "../../src/store/blob-store.js";
import { getWorkspaceById } from "../../src/store/repositories.js";
import { captureObservation } from "../../src/observations/capture.js";
import { createEvidenceService } from "../../src/application/evidence-service.js";

interface WorkerJob {
  mode: "capture" | "promote";
  runId: string;
  workspaceId: string;
  event?: {
    sessionId: string;
    toolName: string;
    toolUseId: string;
    toolInput: Record<string, unknown>;
    toolResponse: unknown;
    cwd?: string;
  };
  request?: unknown;
  operationId?: string;
}

async function main(): Promise<void> {
  const [pluginDataRoot, jobJson] = process.argv.slice(2) as [string, string];
  const job = JSON.parse(jobJson) as WorkerJob;
  const store = await initializePlanStore({ pluginDataRoot });
  try {
    const workspace = getWorkspaceById(store, job.workspaceId);
    if (workspace === null) {
      console.log(JSON.stringify({ ok: false, code: "WORKSPACE_NOT_FOUND", message: "workspace missing" }));
      return;
    }
    const blobs = createBlobStore(path.join(pluginDataRoot, "blobs"));
    if (job.mode === "capture") {
      try {
        const outcome = await captureObservation(
          { store, clock: systemStoreClock(), runId: job.runId, workspace, blobs },
          job.event!,
        );
        console.log(JSON.stringify({
          ok: true,
          status: outcome.status,
          ...(outcome.status === "skipped"
            ? { reason: outcome.reason }
            : { observationId: outcome.observation.observationId, payloadHash: outcome.observation.payloadHash }),
        }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, code: (err as { code?: string }).code, message: (err as Error).message }));
      }
      return;
    }
    try {
      const service = createEvidenceService(store, blobs, systemStoreClock());
      const result = service.promoteEvidence({
        runId: job.runId,
        workspaceId: job.workspaceId,
        request: job.request as Parameters<typeof service.promoteEvidence>[0]["request"],
        operationId: job.operationId!,
      });
      console.log(JSON.stringify({
        ok: true,
        evidenceId: result.evidence.evidenceId,
        revision: result.evidence.revision,
        idempotent: result.idempotent,
      }));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, code: (err as { code?: string }).code, message: (err as Error).message }));
    }
  } finally {
    store.close();
  }
}

await main();
