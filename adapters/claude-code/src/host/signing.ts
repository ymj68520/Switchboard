/**
 * Domain-separated HMAC signing over the deterministic canonical JSON seam
 * (Phase 7 directive §7).
 *
 * One persistent secret backs at least two independent message domains:
 *   - phase-plan:entry-intent:v1  — signed /phase-plan entry tokens
 *   - phase-plan:host-context:v1  — signed HostContext envelopes
 *
 * Domain separation derives an independent per-domain key
 * (domainKey = HMAC-SHA256(secret, domain)) and signs
 * HMAC-SHA256(domainKey, canonicalJson(payload)). A signature from one domain
 * can never verify in the other, and payloads are signed as canonical JSON so
 * key order/whitespace can never change a signature.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "../core/canonical-json.js";

export const ENTRY_INTENT_DOMAIN = "phase-plan:entry-intent:v1";
export const HOST_CONTEXT_DOMAIN = "phase-plan:host-context:v1";

/** Signature encoding: URL-safe base64, no padding. */
export function encodeSignature(signature: Buffer): string {
  return signature.toString("base64url");
}

function domainKey(secret: Buffer, domain: string): Buffer {
  return createHmac("sha256", secret).update(domain, "utf8").digest();
}

/** HMAC-SHA256 over canonical JSON with a derived domain key. */
export function signCanonical(domain: string, secret: Buffer, payload: Record<string, unknown>): string {
  const mac = createHmac("sha256", domainKey(secret, domain)).update(canonicalJson(payload), "utf8").digest();
  return encodeSignature(mac);
}

/**
 * Constant-time signature verification. Any malformed signature decodes to a
 * verification failure — never an exception leak into caller control flow.
 */
export function verifyCanonical(domain: string, secret: Buffer, payload: Record<string, unknown>, signature: string): boolean {
  if (typeof signature !== "string" || signature === "") return false;
  const expected = createHmac("sha256", domainKey(secret, domain)).update(canonicalJson(payload), "utf8").digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
