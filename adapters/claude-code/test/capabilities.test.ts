import { describe, expect, it } from "vitest";

import {
  CLAUDE_CAPABILITY_NAMES,
  evaluateClaudeCapabilities,
  MINIMUM_CLAUDE_CODE_VERSION,
} from "../src/doctor/capabilities.js";

describe("Claude compatibility policy (centralized)", () => {
  it("exposes the policy minimum as the single version source", () => {
    expect(MINIMUM_CLAUDE_CODE_VERSION).toBe("2.0.0");
  });

  it("passes all capabilities when the version satisfies the policy", () => {
    const report = evaluateClaudeCapabilities({
      status: "ok",
      version: "2.1.276",
      raw: "Claude Code 2.1.276",
      binPath: "claude",
    });
    expect(report.version).toBe("2.1.276");
    expect(report.supported).toBe(true);
    expect(Object.keys(report.capabilities).sort()).toEqual([...CLAUDE_CAPABILITY_NAMES].sort());
    for (const name of CLAUDE_CAPABILITY_NAMES) {
      expect(report.capabilities[name].status, name).toBe("PASS");
      expect(report.capabilities[name].reason, name).toContain("2.1.276");
    }
  });

  it("fails closed below the policy minimum with explicit reasons", () => {
    const report = evaluateClaudeCapabilities({
      status: "ok",
      version: "1.9.9",
      raw: "claude 1.9.9",
      binPath: "claude",
    });
    expect(report.supported).toBe(false);
    for (const name of CLAUDE_CAPABILITY_NAMES) {
      expect(report.capabilities[name].status, name).toBe("FAIL");
      expect(report.capabilities[name].reason, name).toContain("below the policy minimum");
    }
  });

  it("yields UNKNOWN (fail-closed, never falsely supported) when the CLI is missing", () => {
    const report = evaluateClaudeCapabilities({ status: "not_found", attempted: ["claude"] });
    expect(report.supported).toBe(false);
    expect(report.version).toBeUndefined();
    for (const name of CLAUDE_CAPABILITY_NAMES) {
      expect(report.capabilities[name].status, name).toBe("UNKNOWN");
      expect(report.capabilities[name].reason, name).toContain("not found");
    }
  });

  it("yields UNKNOWN when the version is unreadable (§13.4 fail-closed gate)", () => {
    const report = evaluateClaudeCapabilities({
      status: "unreadable",
      reason: "timed out",
    });
    expect(report.supported).toBe(false);
    for (const name of CLAUDE_CAPABILITY_NAMES) {
      expect(report.capabilities[name].status, name).toBe("UNKNOWN");
    }
  });

  it("supports policy overrides for evaluation", () => {
    const report = evaluateClaudeCapabilities(
      { status: "ok", version: "1.5.0", raw: "", binPath: "x" },
      "1.5.0",
    );
    expect(report.supported).toBe(true);
    expect(report.policy).toEqual({ minimumVersion: "1.5.0" });
  });
});
