import { describe, expect, it } from "vitest";

import {
  CAPABILITY_POLICY,
  CLAUDE_CAPABILITY_NAMES,
  evaluateClaudeCapabilities,
  REQUIRED_USER_INTERACTION_VERSION,
  type CapabilityPolicyEntry,
} from "../src/doctor/capabilities.js";
import type { ClaudeVersionResult } from "../src/claude/version.js";

function okVersion(version: string): ClaudeVersionResult {
  return { status: "ok", version, raw: `Claude Code ${version}`, binPath: "claude" };
}

describe("per-capability compatibility policy matrix", () => {
  it("covers every frozen capability exactly once", () => {
    expect(CAPABILITY_POLICY.map((entry) => entry.id).sort()).toEqual(
      [...CLAUDE_CAPABILITY_NAMES].sort(),
    );
  });

  it("version-verified entries carry a floor plus evidence; unknown entries never guess one", () => {
    for (const entry of CAPABILITY_POLICY as readonly CapabilityPolicyEntry[]) {
      if (entry.verification === "version") {
        expect(entry.minimumVersion, entry.id).toMatch(/^\d+\.\d+\.\d+$/);
        expect(entry.evidence, entry.id).not.toBe("");
      } else {
        expect(entry.minimumVersion, `${entry.id} must not guess a floor`).toBeUndefined();
        expect(entry.evidence, entry.id).toContain("runtime probe");
      }
    }
  });

  it("gates the Approval security boundary at 2.1.199, critical", () => {
    const entry = CAPABILITY_POLICY.find((e) => e.id === "requiredUserInteraction");
    expect(entry?.verification).toBe("version");
    expect(entry?.minimumVersion).toBe("2.1.199");
    expect(entry?.critical).toBe(true);
    expect(REQUIRED_USER_INTERACTION_VERSION).toBe("2.1.199");
  });

  it("marks plugins and stdioMcp critical with evidence-backed 2.0.0 floors", () => {
    for (const id of ["plugins", "stdioMcp"] as const) {
      const entry = CAPABILITY_POLICY.find((e) => e.id === id);
      expect(entry?.verification, id).toBe("version");
      expect(entry?.minimumVersion, id).toBe("2.0.0");
      expect(entry?.critical, id).toBe(true);
      expect(entry?.evidence, id).toContain("2.0.0");
    }
  });

  it("leaves planModeIntegration and hookLifecycle unknown (no speculative floors)", () => {
    for (const id of ["planModeIntegration", "hookLifecycle"] as const) {
      const entry = CAPABILITY_POLICY.find((e) => e.id === id);
      expect(entry?.verification, id).toBe("unknown");
      expect(entry?.critical, id).toBe(false);
    }
  });
});

describe("Claude 2.1.198 (below the approval floor)", () => {
  const report = evaluateClaudeCapabilities(okVersion("2.1.198"));

  it("requiredUserInteraction is not PASS", () => {
    expect(report.capabilities.requiredUserInteraction.status).not.toBe("PASS");
    expect(report.capabilities.requiredUserInteraction.status).toBe("FAIL");
    expect(report.capabilities.requiredUserInteraction.reason).toContain("2.1.199");
  });

  it("overall compatibility fails closed", () => {
    expect(report.supported).toBe(false);
  });
});

describe("Claude 2.1.199 (at the approval floor)", () => {
  const report = evaluateClaudeCapabilities(okVersion("2.1.199"));

  it("requiredUserInteraction is PASS", () => {
    expect(report.capabilities.requiredUserInteraction.status).toBe("PASS");
  });

  it("overall compatibility is supported via the critical gates", () => {
    expect(report.supported).toBe(true);
    expect(report.version).toBe("2.1.199");
    expect(report.policy.approvalInteractionFloor).toBe("2.1.199");
  });

  it("unknown-verification capabilities stay UNKNOWN even on a new version", () => {
    // UNKNOWN ≠ SUPPORTED: they are reported honestly, never converted to PASS.
    expect(report.capabilities.planModeIntegration.status).toBe("UNKNOWN");
    expect(report.capabilities.hookLifecycle.status).toBe("UNKNOWN");
  });
});

describe("Claude 2.1.276 (current line)", () => {
  const report = evaluateClaudeCapabilities(okVersion("2.1.276"));

  it("requiredUserInteraction is PASS", () => {
    expect(report.capabilities.requiredUserInteraction.status).toBe("PASS");
    expect(report.capabilities.requiredUserInteraction.reason).toContain("2.1.276");
  });

  it("all critical gates PASS and compatibility is supported", () => {
    for (const entry of CAPABILITY_POLICY) {
      if (!entry.critical) continue;
      expect(report.capabilities[entry.id].status, entry.id).toBe("PASS");
    }
    expect(report.supported).toBe(true);
  });
});

describe("unknown/malformed versions (fail-closed)", () => {
  it("unreadable version: requiredUserInteraction is UNKNOWN and support is refused", () => {
    const report = evaluateClaudeCapabilities({
      status: "unreadable",
      reason: "could not parse a semver from claude --version output",
    });
    expect(report.capabilities.requiredUserInteraction.status).toBe("UNKNOWN");
    expect(report.supported).toBe(false);
    expect(report.version).toBeUndefined();
  });

  it("missing CLI: every capability is UNKNOWN and support is refused", () => {
    const report = evaluateClaudeCapabilities({ status: "not_found", attempted: ["claude"] });
    for (const name of CLAUDE_CAPABILITY_NAMES) {
      expect(report.capabilities[name].status, name).toBe("UNKNOWN");
    }
    expect(report.supported).toBe(false);
  });
});

describe("critical-gate semantics", () => {
  it("a critical FAIL below the plugin floor blocks support", () => {
    const report = evaluateClaudeCapabilities(okVersion("1.9.9"));
    expect(report.capabilities.plugins.status).toBe("FAIL");
    expect(report.capabilities.stdioMcp.status).toBe("FAIL");
    expect(report.capabilities.requiredUserInteraction.status).toBe("FAIL");
    expect(report.supported).toBe(false);
  });

  it("supports custom policy overrides for evaluation", () => {
    const relaxed: CapabilityPolicyEntry[] = [
      {
        id: "requiredUserInteraction",
        verification: "version",
        minimumVersion: "2.1.199",
        critical: true,
        reason: "test",
        evidence: "test",
      },
    ];
    const report = evaluateClaudeCapabilities(okVersion("2.1.199"), relaxed);
    expect(report.supported).toBe(true);
    expect(report.policy.entries).toEqual(relaxed);
  });

  it("treats a version-verified entry without a floor as fail-closed UNKNOWN", () => {
    const broken: CapabilityPolicyEntry[] = [
      {
        id: "requiredUserInteraction",
        verification: "version",
        critical: true,
        reason: "test",
        evidence: "test",
      },
    ];
    const report = evaluateClaudeCapabilities(okVersion("9.9.9"), broken);
    expect(report.capabilities.requiredUserInteraction.status).toBe("UNKNOWN");
    expect(report.supported).toBe(false);
  });
});
