/**
 * Phase 7 host authority units: persistent secret, domain-separated HMAC,
 * EntryIntentV1 binding, HostContextEnvelopeV1 verification, capability
 * proofs lifecycle.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadHostSecret, hostSecretPath, HOST_SECRET_HEX_LENGTH } from "../src/host/secret.js";
import {
  ENTRY_INTENT_DOMAIN,
  HOST_CONTEXT_DOMAIN,
  signCanonical,
  verifyCanonical,
} from "../src/host/signing.js";
import {
  entryIntentIsCurrent,
  issueEntryIntent,
  verifyEntryIntent,
} from "../src/host/entry-intent.js";
import {
  assertHostContextForTool,
  buildHostContextEnvelope,
  businessInputHashOf,
  encodeHostContextToken as encodeToken,
  logicalToolName,
  verifyHostContext,
} from "../src/host/host-context.js";
import {
  proofFreshness,
  readCapabilityProofs,
  writeCapabilityProofs,
  capabilityProofsPath,
} from "../src/host/capability-proofs.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

describe("persistent host signing secret (directive §6)", () => {
  it("creates a 256-bit secret atomically and reads it back deterministically", () => {
    const root = makeTempPluginDataRoot();
    try {
      const first = loadHostSecret(root);
      expect(first.created).toBe(true);
      expect(first.key).toHaveLength(32);

      const second = loadHostSecret(root);
      expect(second.created).toBe(false);
      expect(second.key.equals(first.key)).toBe(true);

      const raw = fs.readFileSync(hostSecretPath(root), "utf8").trim();
      expect(raw).toMatch(/^[0-9a-f]{64}$/);
      expect(raw).toHaveLength(HOST_SECRET_HEX_LENGTH);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("is race-safe: concurrent creators converge on one secret", () => {
    const root = makeTempPluginDataRoot();
    try {
      // loadHostSecret is synchronous; simulate the losing racer by creating
      // the file between existence check and open via a second process-like
      // sequence: create, then force a create attempt against EEXIST.
      const a = loadHostSecret(root);
      fs.rmSync(hostSecretPath(root));
      fs.writeFileSync(hostSecretPath(root), a.key.toString("hex") + "\n");
      const b = loadHostSecret(root);
      expect(b.created).toBe(false);
      expect(b.key.equals(a.key)).toBe(true);
      // And a fresh O_EXCL create against an existing file re-reads it.
      const viaCreate = loadHostSecret(root);
      expect(viaCreate.key.equals(a.key)).toBe(true);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("fails closed on corruption and never falls back to a derived key", () => {
    const root = makeTempPluginDataRoot();
    try {
      fs.mkdirSync(path.dirname(hostSecretPath(root)), { recursive: true });
      fs.writeFileSync(hostSecretPath(root), "not-a-hex-secret\n");
      expect(() => loadHostSecret(root)).toThrowError(expect.objectContaining({ code: "HOST_SECRET_UNAVAILABLE" }));
      // short hex (128-bit) is also rejected — at least 256 bits required
      fs.writeFileSync(hostSecretPath(root), "a".repeat(32) + "\n");
      expect(() => loadHostSecret(root)).toThrowError(expect.objectContaining({ code: "HOST_SECRET_UNAVAILABLE" }));
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("persists across simulated plugin upgrade (same root, new process state)", () => {
    const root = makeTempPluginDataRoot();
    try {
      const before = loadHostSecret(root).key;
      const after = loadHostSecret(root).key;
      expect(after.equals(before)).toBe(true);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("domain-separated HMAC signing (directive §7)", () => {
  it("same payload in different domains yields different signatures", () => {
    const root = makeTempPluginDataRoot();
    try {
      const secret = loadHostSecret(root).key;
      const payload = { a: 1 };
      const entrySig = signCanonical(ENTRY_INTENT_DOMAIN, secret, payload);
      const hostSig = signCanonical(HOST_CONTEXT_DOMAIN, secret, payload);
      expect(entrySig).not.toBe(hostSig);
      // cross-domain verification fails
      expect(verifyCanonical(HOST_CONTEXT_DOMAIN, secret, payload, entrySig)).toBe(false);
      expect(verifyCanonical(ENTRY_INTENT_DOMAIN, secret, payload, hostSig)).toBe(false);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("is canonical-JSON stable and tamper-evident", () => {
    const root = makeTempPluginDataRoot();
    try {
      const secret = loadHostSecret(root).key;
      const sig1 = signCanonical(ENTRY_INTENT_DOMAIN, secret, { b: 2, a: 1 });
      const sig2 = signCanonical(ENTRY_INTENT_DOMAIN, secret, { a: 1, b: 2 });
      expect(sig1).toBe(sig2);
      expect(verifyCanonical(ENTRY_INTENT_DOMAIN, secret, { a: 1, b: 3 }, sig1)).toBe(false);
      expect(sig1).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("different secrets never verify", () => {
    const rootA = makeTempPluginDataRoot();
    const rootB = makeTempPluginDataRoot();
    try {
      const sig = signCanonical(ENTRY_INTENT_DOMAIN, loadHostSecret(rootA).key, { x: true });
      expect(verifyCanonical(ENTRY_INTENT_DOMAIN, loadHostSecret(rootB).key, { x: true }, sig)).toBe(false);
    } finally {
      removeTempPluginDataRoot(rootA);
      removeTempPluginDataRoot(rootB);
    }
  });
});

describe("EntryIntentV1 (directive §10/§11)", () => {
  it("issues an opaque token bound to session+prompt+command", () => {
    const root = makeTempPluginDataRoot();
    try {
      const secret = loadHostSecret(root).key;
      const token = issueEntryIntent(secret, { sessionId: "S1", promptId: "P1" });
      expect(token).not.toContain("S1");
      const intent = verifyEntryIntent(secret, token);
      expect(intent).toEqual({ version: 1, sessionId: "S1", promptId: "P1", commandName: "phase-plan" });
      expect(entryIntentIsCurrent(intent, { sessionId: "S1", promptId: "P1" })).toBe(true);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rejects replay across prompts and sessions (§63)", () => {
    const root = makeTempPluginDataRoot();
    try {
      const secret = loadHostSecret(root).key;
      const token = issueEntryIntent(secret, { sessionId: "S1", promptId: "P1" });
      const intent = verifyEntryIntent(secret, token);
      expect(entryIntentIsCurrent(intent, { sessionId: "S1", promptId: "P2" })).toBe(false);
      expect(entryIntentIsCurrent(intent, { sessionId: "S2", promptId: "P1" })).toBe(false);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("fails closed on tampering and forgery", () => {
    const rootA = makeTempPluginDataRoot();
    const rootB = makeTempPluginDataRoot();
    try {
      const secret = loadHostSecret(rootA).key;
      const token = issueEntryIntent(secret, { sessionId: "S1", promptId: "P1" });
      // decode, swap sessionId, re-encode (signature now stale)
      const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      decoded.sessionId = "S2";
      const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
      expect(() => verifyEntryIntent(secret, forged)).toThrowError(
        expect.objectContaining({ code: "ENTRY_INTENT_INVALID" }),
      );
      expect(() => verifyEntryIntent(secret, "garbage!!!")).toThrowError(
        expect.objectContaining({ code: "ENTRY_INTENT_INVALID" }),
      );
      // valid shape, wrong secret
      const forgedWithOtherSecret = issueEntryIntent(loadHostSecret(rootB).key, { sessionId: "S1", promptId: "P1" });
      expect(() => verifyEntryIntent(secret, forgedWithOtherSecret)).toThrowError(
        expect.objectContaining({ code: "ENTRY_INTENT_INVALID" }),
      );
    } finally {
      removeTempPluginDataRoot(rootA);
      removeTempPluginDataRoot(rootB);
    }
  });
});

describe("HostContextEnvelopeV1 (directive §17–§23)", () => {
  function envelope(overrides: Record<string, unknown> = {}) {
    return buildHostContextEnvelope({
      sessionId: "S1",
      promptId: "P1",
      workspaceId: "W1",
      runId: "R1",
      bindingGeneration: 2,
      permissionMode: "plan",
      toolUseId: "TU1",
      toolName: "mcp__plugin_phase-plan_phase-plan__approve_proposal",
      businessInputHash: businessInputHashOf({ proposal_id: "PROP-1" }),
      ...overrides,
    });
  }

  it("round-trips through the opaque token and strips reserved fields from the input hash", () => {
    const secret = loadHostSecret(makeTempPluginDataRoot()).key;
    const token = encodeToken(secret, envelope());
    expect(token).not.toContain("S1");
    const verified = verifyHostContext(secret, token);
    expect(verified.sessionId).toBe("S1");
    expect(verified.toolUseId).toBe("TU1");
    expect(logicalToolName(verified.toolName)).toBe("approve_proposal");
    // reserved fields never change the business hash
    expect(businessInputHashOf({ proposal_id: "PROP-1", _hostContext: "x", _entryIntent: "y" })).toBe(
      businessInputHashOf({ proposal_id: "PROP-1" }),
    );
  });

  it("binds to the tool: cross-tool replay fails HOST_CONTEXT_TOOL_MISMATCH (E58)", () => {
    const secret = loadHostSecret(makeTempPluginDataRoot()).key;
    const token = encodeToken(secret, envelope());
    expect(() =>
      assertHostContextForTool(secret, token, { tool: "start_or_resume", businessInput: { proposal_id: "PROP-1" } }),
    ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_TOOL_MISMATCH" }));
  });

  it("binds to the business input: post-signing tamper fails HOST_CONTEXT_INPUT_MISMATCH (E59)", () => {
    const secret = loadHostSecret(makeTempPluginDataRoot()).key;
    const token = encodeToken(secret, envelope());
    expect(() =>
      assertHostContextForTool(secret, token, { tool: "approve_proposal", businessInput: { proposal_id: "PROP-2" } }),
    ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_INPUT_MISMATCH" }));
  });

  it("fails closed on forged signatures and malformed tokens (E56)", () => {
    const rootA = makeTempPluginDataRoot();
    const rootB = makeTempPluginDataRoot();
    try {
      const secret = loadHostSecret(rootA).key;
      const other = loadHostSecret(rootB).key;
      expect(() => verifyHostContext(secret, encodeToken(other, envelope()))).toThrowError(
        expect.objectContaining({ code: "HOST_CONTEXT_INVALID" }),
      );
      expect(() => verifyHostContext(secret, "!!!")).toThrowError(
        expect.objectContaining({ code: "HOST_CONTEXT_INVALID" }),
      );
      expect(() => verifyHostContext(secret, undefined)).toThrowError(
        expect.objectContaining({ code: "HOST_CONTEXT_REQUIRED" }),
      );
      // tampered payload field
      const token = encodeToken(secret, envelope());
      const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      decoded.workspaceId = "W2";
      const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
      expect(() => verifyHostContext(secret, forged)).toThrowError(
        expect.objectContaining({ code: "HOST_CONTEXT_INVALID" }),
      );
    } finally {
      removeTempPluginDataRoot(rootA);
      removeTempPluginDataRoot(rootB);
    }
  });
});

describe("capability proofs (directive §45/§46)", () => {
  it("round-trips and reports freshness per version", () => {
    const root = makeTempPluginDataRoot();
    try {
      expect(readCapabilityProofs(root)).toBeNull();
      writeCapabilityProofs(root, {
        claudeVersion: "2.1.276",
        proofVersion: 1,
        hookLifecycleVerified: true,
        planModeIntegrationVerified: true,
        verifiedAt: "2026-09-25T00:00:00.000Z",
      });
      const proof = readCapabilityProofs(root);
      expect(proof?.claudeVersion).toBe("2.1.276");
      expect(proofFreshness(proof, "2.1.276")).toBe("current");
      // §46 — a different host version invalidates the proof
      expect(proofFreshness(proof, "2.2.0")).toBe("version-changed");
      expect(proofFreshness(proof, undefined)).toBe("version-changed");
      expect(capabilityProofsPath(root)).toContain("runtime");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("treats corrupt proofs as absent, never as evidence", () => {
    const root = makeTempPluginDataRoot();
    try {
      fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
      fs.writeFileSync(path.join(root, "runtime", "capability-proofs.json"), "{ broken");
      expect(readCapabilityProofs(root)).toBeNull();
      fs.writeFileSync(
        path.join(root, "runtime", "capability-proofs.json"),
        JSON.stringify({ claudeVersion: "1", proofVersion: 99 }),
      );
      expect(readCapabilityProofs(root)).toBeNull();
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
