/**
 * Persistent plugin-owned signing secret (Phase 7 directive §6).
 *
 * Location: ${CLAUDE_PLUGIN_DATA}/runtime/host-context.key
 *
 * The secret exists so that neither model parameters, a stale MCP process
 * environment, nor ordinary tool input can ever be mistaken for current host
 * authority: only processes the Claude host launches (hooks and the MCP
 * server) can read this file, and every HostContext/EntryIntent they sign
 * carries an HMAC the model cannot produce.
 *
 * Properties (directive §6):
 * - cryptographically random, >= 256 bits (32 bytes, stored as 64 hex chars);
 * - persistent across plugin upgrade (never regenerated when readable);
 * - atomic create and race-safe across Hook/MCP processes (O_EXCL "wx" flag,
 *   losing racer re-reads the winner's file);
 * - deterministic read;
 * - corruption fails closed (HOST_SECRET_UNAVAILABLE — never a fallback key).
 *
 * No external crypto dependency: node:crypto randomBytes + HMAC-SHA256 only.
 * POSIX restrictive mode is applied best-effort; on Windows no POSIX-mode ACL
 * equivalence is claimed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { RuntimeError } from "../runtime/errors.js";

export const HOST_SECRET_FILE = "host-context.key";
/** 32 bytes = 256 bits of entropy, hex-encoded to 64 characters. */
export const HOST_SECRET_HEX_LENGTH = 64;

export interface HostSecret {
  /** Raw 32-byte key material. Never log or serialize. */
  key: Buffer;
  /** True when this call created the file (first use on this install). */
  created: boolean;
}

export function hostSecretPath(pluginDataRoot: string): string {
  return path.join(pluginDataRoot, "runtime", HOST_SECRET_FILE);
}

function secretError(reason: string, cause?: string): RuntimeError {
  return new RuntimeError(
    "HOST_SECRET_UNAVAILABLE",
    "the Phase Plan host signing secret is unavailable; refusing to proceed (fail closed)",
    cause === undefined ? { cause: reason } : { cause: `${reason}: ${cause}` },
  );
}

function parseSecretFile(raw: string): Buffer {
  const text = raw.trim();
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw secretError("host-context.key is malformed", "expected exactly 64 lowercase hex characters");
  }
  return Buffer.from(text, "hex");
}

function readSecretFile(filePath: string): Buffer {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw secretError("host-context.key is not readable", err instanceof Error ? err.message : String(err));
  }
  return parseSecretFile(raw);
}

/**
 * Read or create the persistent signing secret. Throws HOST_SECRET_UNAVAILABLE
 * on any corruption/unreadability — callers must fail closed, never fall back
 * to an ephemeral or derived key.
 */
export function loadHostSecret(pluginDataRoot: string): HostSecret {
  if (typeof pluginDataRoot !== "string" || pluginDataRoot.trim() === "") {
    throw secretError("plugin data root is missing");
  }
  const filePath = hostSecretPath(pluginDataRoot);
  const runtimeDir = path.dirname(filePath);

  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
  } catch (err) {
    throw secretError("runtime directory cannot be created", err instanceof Error ? err.message : String(err));
  }

  if (fs.existsSync(filePath)) {
    return { key: readSecretFile(filePath), created: false };
  }

  // Atomic create: "wx" fails when another process won the race; the loser
  // re-reads the winner's key so every process converges on one secret.
  const key = randomBytes(32);
  try {
    const handle = fs.openSync(filePath, "wx");
    try {
      fs.writeFileSync(handle, key.toString("hex") + "\n", "utf8");
      if (process.platform !== "win32") {
        try {
          fs.fchmodSync(handle, 0o600);
        } catch {
          // restrictive mode is best-effort on POSIX; Windows makes no claim
        }
      }
    } finally {
      fs.closeSync(handle);
    }
    return { key, created: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "EEXIST") {
      return { key: readSecretFile(filePath), created: false };
    }
    throw secretError("host-context.key cannot be created", err instanceof Error ? err.message : String(err));
  }
}
