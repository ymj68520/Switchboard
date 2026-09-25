/**
 * Observation core semantics (Phase 9 §5–§15, §36–§41, §64, §67).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

import { getObservationRecord, listObservationsRecord } from "../src/store/observations.js";
import { observationClassForTool } from "../src/observations/classify.js";
import { captureObservation } from "../src/observations/capture.js";
import { projectToolInput, relativizeWorkspacePath } from "../src/observations/project-input.js";
import { detectEnvDumpCommand, payloadSanitizerMarker } from "../src/observations/sanitize.js";
import { rawConnection } from "./store-helpers.js";
import { storePathsFor } from "./store-helpers.js";
import {
  captureDeps,
  executionEvent,
  locatorEvent,
  makePhase9Fixture,
  sourceEvent,
  writeSourceFile,
} from "./phase9-helpers.js";

describe("tool → class mapping (§7/§8, E4–E7)", () => {
  it("maps the probed host tool names exactly", () => {
    expect(observationClassForTool("Read")).toBe("source");
    expect(observationClassForTool("Grep")).toBe("locator");
    expect(observationClassForTool("Glob")).toBe("locator");
    expect(observationClassForTool("Bash")).toBe("execution");
    expect(observationClassForTool("PowerShell")).toBe("execution");
  });

  it("never guesses a class for other tools (Edit/Write/MCP/unknown)", () => {
    for (const tool of ["Edit", "Write", "NotebookEdit", "AskUserQuestion", "ExitPlanMode", "Task", "WebFetch",
      "mcp__plugin_phase-plan_phase-plan__get_context", "read", "READ", ""]) {
      expect(observationClassForTool(tool)).toBeNull();
    }
  });
});

describe("input projection (§14/§74)", () => {
  it("projects each class to its typed provenance and tolerates unknown fields", () => {
    const root = "C:\\ws";
    expect(projectToolInput("Read", "source", { file_path: "C:\\ws\\a.txt", offset: 2, limit: 10, unknownFuture: 1 }, root))
      .toEqual({ kind: "source", path: "a.txt", offset: 2, limit: 10 });
    expect(projectToolInput("Grep", "locator", { pattern: "alpha", path: "src", glob: "*.ts", junk: true }, root))
      .toEqual({ kind: "locator", tool: "Grep", pattern: "alpha", path: "src", glob: "*.ts" });
    expect(projectToolInput("PowerShell", "execution", { command: "node --version", description: "x" }, root))
      .toEqual({ kind: "execution", command: "node --version" });
  });

  it("fails capture (not silent) when a known shape is unprojectable", () => {
    expect(() => projectToolInput("Read", "source", {}, undefined)).toThrowError(
      expect.objectContaining({ code: "OBSERVATION_CAPTURE_FAILED" }),
    );
  });

  it("stores workspace-relative forward-slash paths; outside paths stay as observed", () => {
    expect(relativizeWorkspacePath("C:\\ws\\nested\\a.txt", "C:\\ws")).toBe("nested/a.txt");
    expect(relativizeWorkspacePath("C:\\other\\b.txt", "C:\\ws")).toBe("C:\\other\\b.txt");
  });

  it("excludes secret-shaped fields from projections (defense-in-depth, §15)", () => {
    const projection = projectToolInput("Read", "source", { file_path: "C:\\ws\\a.txt", _hostContext: "tok", api_key: "k" }, undefined);
    expect(projection).toEqual({ kind: "source", path: "C:\\ws\\a.txt" });
  });
});

describe("capture (§9/§11–§13/§36/§40, E3/E8/E9/E13/E14/E15)", () => {
  it("captures a Read as a source observation with the exact delivered payload and a capture-time fingerprint", async () => {
    const f = await makePhase9Fixture();
    try {
      writeSourceFile(f, "src/sample.txt", "PHASE9 fingerprint me alpha\n");
      const event = sourceEvent(f, "src/sample.txt");
      const outcome = await captureObservation(captureDeps(f), event);
      expect(outcome.status).toBe("captured");
      const obs = outcome.status === "skipped" ? null : outcome.observation;
      expect(obs).toMatchObject({
        runId: f.runId,
        workspaceId: f.workspaceId,
        observationClass: "source",
        toolName: "Read",
        toolUseId: event.toolUseId,
        promotable: true,
        sanitized: null,
      });
      expect(obs!.input).toEqual({ kind: "source", path: "src/sample.txt" });
      expect(obs!.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(obs!.sourceFingerprint).toMatchObject({ path: "src/sample.txt", size: expect.any(Number) });
      expect(obs!.observationSeq).toBe(1);

      // Payload bytes are the canonical serialization of the delivered result (§9).
      const payload = Buffer.from(f.blobs.readBytes(obs!.payloadHash!)).toString("utf8");
      expect(JSON.parse(payload)).toEqual(event.toolResponse);
    } finally {
      f.close();
    }
  });

  it("is idempotent by (run, toolUse): same facts → same observation; changed facts → OBSERVATION_CONFLICT (§40)", async () => {
    const f = await makePhase9Fixture();
    try {
      writeSourceFile(f, "sample.txt", "one\n");
      const event = sourceEvent(f, "sample.txt");
      const deps = captureDeps(f);
      const first = await captureObservation(deps, event);
      const second = await captureObservation(deps, event);
      expect(first.status).toBe("captured");
      expect(second.status).toBe("duplicate");
      expect((second as { observation: { observationId: string } }).observation.observationId)
        .toBe((first as { observation: { observationId: string } }).observation.observationId);

      const changed = sourceEvent(f, "sample.txt", {
        toolResponse: { type: "text", file: { filePath: "sample.txt", content: "TAMPERED\n" } },
      });
      await expect(captureObservation(deps, changed)).rejects.toMatchObject({ code: "OBSERVATION_CONFLICT" });
      // Ledger still has exactly one row.
      expect(listObservationsRecord(f.store, f.runId, { limit: 100 })).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it("classifies locator/execution captures and records execution commands (E5/E6)", async () => {
    const f = await makePhase9Fixture();
    try {
      const grep = await captureObservation(captureDeps(f), locatorEvent(f));
      expect(grep.status === "skipped" ? null : grep.observation.observationClass).toBe("locator");

      const exec = await captureObservation(captureDeps(f), executionEvent(f, "node --version"));
      expect(exec.status === "skipped" ? null : exec.observation.observationClass).toBe("execution");
      expect(exec.status === "skipped" ? null : exec.observation.input).toEqual({ kind: "execution", command: "node --version" });
      // Execution observations default to NO source fingerprint.
      expect(exec.status === "skipped" ? null : exec.observation.sourceFingerprint).toBeNull();
    } finally {
      f.close();
    }
  });

  it("drops the payload of detectable env-dump executions but keeps command provenance (§15)", async () => {
    const f = await makePhase9Fixture();
    try {
      expect(detectEnvDumpCommand("printenv")).toBe(true);
      expect(detectEnvDumpCommand("Get-ChildItem Env:")).toBe(true);
      expect(detectEnvDumpCommand("node --version")).toBe(false);
      expect(payloadSanitizerMarker(executionEvent(f, "printenv"))).toBe("env_dump_detected");

      const outcome = await captureObservation(captureDeps(f), executionEvent(f, "printenv"));
      expect(outcome.status).toBe("captured");
      const obs = outcome.status === "skipped" ? null : outcome.observation;
      expect(obs!.payloadHash).toBeNull();
      expect(obs!.promotable).toBe(false);
      expect(obs!.sanitized).toBe("env_dump_detected");
      expect(obs!.input).toEqual({ kind: "execution", command: "printenv" });
    } finally {
      f.close();
    }
  });

  it("captures metadata only for non-textual results (§19)", async () => {
    const f = await makePhase9Fixture();
    try {
      writeSourceFile(f, "image.png", "fake-bytes");
      const event = sourceEvent(f, "image.png", {
        toolResponse: { type: "image", source: { data: "base64data", media_type: "image/png" } },
      });
      const outcome = await captureObservation(captureDeps(f), event);
      const obs = outcome.status === "skipped" ? null : outcome.observation;
      expect(obs!.payloadHash).toBeNull();
      expect(obs!.contentType).toBe("application/octet-stream");
      expect(obs!.promotable).toBe(false);
    } finally {
      f.close();
    }
  });

  it("records the observation-time whole-file fingerprint; later file edits do not rewrite it (§36/§67)", async () => {
    const f = await makePhase9Fixture();
    try {
      const absolute = writeSourceFile(f, "src/fp.txt", "ORIGINAL CONTENT alpha\n");
      const event = sourceEvent(f, "src/fp.txt");
      const outcome = await captureObservation(captureDeps(f), event);
      const fingerprint = outcome.status === "skipped" ? null : outcome.observation.sourceFingerprint;
      expect(fingerprint).not.toBeNull();
      const originalSha = fingerprint!.sha256;

      fs.writeFileSync(absolute, "CHANGED CONTENT beta\n", "utf8");
      const reread = getObservationRecord(f.store, f.runId, (outcome as { observation: { observationId: string } }).observation.observationId);
      expect(reread!.sourceFingerprint!.sha256).toBe(originalSha);
      // And the recorded fingerprint really is the ORIGINAL file's hash, not
      // the promotion-time state (observation-time provenance, §67).
      expect(originalSha).not.toBe(createHash("sha256").update("CHANGED CONTENT beta\n").digest("hex"));
    } finally {
      f.close();
    }
  });

  it("keeps the observation when the source file is unreadable at capture time (§37)", async () => {
    const f = await makePhase9Fixture();
    try {
      const event = sourceEvent(f, "gone/missing.txt", {
        toolResponse: { type: "text", file: { filePath: "gone/missing.txt", content: "" } },
      });
      const outcome = await captureObservation(captureDeps(f), event);
      expect(outcome.status).toBe("captured");
      expect(outcome.status === "skipped" ? null : outcome.observation.sourceFingerprint).toBeNull();
      expect(outcome.status === "skipped" ? null : outcome.observation.promotable).toBe(true);
    } finally {
      f.close();
    }
  });

  it("records the repository revision via fixed-argv git (§75/§76) and never for directory workspaces", async () => {
    const f = await makePhase9Fixture();
    try {
      writeSourceFile(f, "s.txt", "x\n");
      const outcome = await captureObservation(captureDeps(f), sourceEvent(f, "s.txt"));
      const rev = outcome.status === "skipped" ? null : outcome.observation.repositoryRevision;
      // The phase9 fixture's workspace is not a git repository → null is the
      // correct coarse context (the live-host validation records the real one).
      expect(rev).toBeNull();

      const stubbed = await captureObservation(
        captureDeps(f, {
          gitRunner: async () => ({ kind: "exit", exitCode: 0, stdout: "1234567890123456789012345678901234567890\n" }),
        }),
        sourceEvent(f, "s.txt", { toolUseId: "call_gitok" }),
      );
      expect(stubbed.status === "skipped" ? null : stubbed.observation.repositoryRevision)
        .toBe("1234567890123456789012345678901234567890");

      const failed = await captureObservation(
        captureDeps(f, { gitRunner: async () => ({ kind: "unavailable" }) }),
        sourceEvent(f, "s.txt", { toolUseId: "call_gitfail" }),
      );
      expect(failed.status === "skipped" ? null : failed.observation.repositoryRevision).toBeNull();
    } finally {
      f.close();
    }
  });

  it("assigns a gap-free per-run ledger sequence in capture order (§20)", async () => {
    const f = await makePhase9Fixture();
    try {
      writeSourceFile(f, "a.txt", "a\n");
      writeSourceFile(f, "b.txt", "b\n");
      const deps = captureDeps(f);
      await captureObservation(deps, sourceEvent(f, "a.txt"));
      await captureObservation(deps, locatorEvent(f, { toolUseId: "call_g" }));
      const third = await captureObservation(deps, executionEvent(f, "git status", { toolUseId: "call_e" }));
      const rows = listObservationsRecord(f.store, f.runId, { limit: 100 });
      expect(rows.map((r) => r.observationSeq)).toEqual([1, 2, 3]);
      expect(third.status === "skipped" ? null : third.observation.observationSeq).toBe(3);
    } finally {
      f.close();
    }
  });

  it("enforces ledger immutability at the database level (§6, E15)", async () => {
    const f = await makePhase9Fixture();
    try {
      writeSourceFile(f, "x.txt", "x\n");
      const outcome = await captureObservation(captureDeps(f), sourceEvent(f, "x.txt"));
      const obsId = outcome.status === "skipped" ? null : outcome.observation.observationId;
      const db = rawConnection(storePathsFor(f.root).databasePath, 500);
      try {
        expect(() => db.exec(`UPDATE observations SET tool_name = 'Tampered' WHERE observation_id = '${obsId}'`))
          .toThrowError(/observations is immutable/);
        expect(() => db.exec(`DELETE FROM observations WHERE observation_id = '${obsId}'`))
          .toThrowError(/observations is immutable/);
      } finally {
        db.close();
      }
    } finally {
      f.close();
    }
  });
});

describe("uniqueness backstop (§41)", () => {
  it("UNIQUE(run_id, tool_use_id) rejects a second row even via raw SQL", async () => {
    const f = await makePhase9Fixture();
    try {
      writeSourceFile(f, "u.txt", "u\n");
      const deps = captureDeps(f);
      const outcome = await captureObservation(deps, sourceEvent(f, "u.txt"));
      const capturedToolUseId = (outcome as { status: "captured"; observation: { toolUseId: string } }).observation.toolUseId;
      const db = rawConnection(storePathsFor(f.root).databasePath, 500);
      try {
        expect(() =>
          db.prepare(
            "INSERT INTO observations (run_id, observation_id, observation_seq, workspace_id, session_id, tool_name, tool_use_id, observation_class, input_projection_json, payload_hash, payload_size, content_type, source_fingerprint_json, repository_revision, promotable, sanitized, captured_at) VALUES (?, ?, 99, ?, ?, 'Read', ?, 'source', '{}', NULL, NULL, 'application/octet-stream', NULL, NULL, 0, NULL, '2026-01-01T00:00:00.000Z')",
          ).run(f.runId, "obs_raw", f.workspaceId, f.sessionId, capturedToolUseId),
        ).toThrowError(/UNIQUE/);
      } finally {
        db.close();
      }
    } finally {
      f.close();
    }
  });
});
