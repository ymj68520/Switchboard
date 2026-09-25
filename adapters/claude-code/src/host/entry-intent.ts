/**
 * EntryIntentV1 — the signed proof that a real human invoked /phase-plan
 * (Phase 7 directive §8–§11).
 *
 * The UserPromptExpansion hook fires for the user-invoked /phase-plan command
 * and injects a signed token into the skill turn via additionalContext. The
 * token binds sessionId + promptId + commandName, so a token captured from
 * prompt A cannot authorize prompt B and cannot cross sessions. There is no
 * TTL: prompt scoping comes from the binding, not from expiry.
 *
 * The token is opaque to the model (base64url of a signed JSON object) and is
 * never persisted to the Plan Store.
 */

import { RuntimeError } from "../runtime/errors.js";
import { canonicalJson } from "../core/canonical-json.js";
import { ENTRY_INTENT_DOMAIN, signCanonical, verifyCanonical } from "./signing.js";

export const ENTRY_INTENT_VERSION = 1 as const;
/** The only command an EntryIntent can ever authorize (directive §10). */
export const ENTRY_INTENT_COMMAND_NAME = "phase-plan";

export interface EntryIntentV1 {
  version: typeof ENTRY_INTENT_VERSION;
  sessionId: string;
  promptId: string;
  commandName: typeof ENTRY_INTENT_COMMAND_NAME;
}

export interface IssueEntryIntentInput {
  sessionId: string;
  promptId: string;
}

function entryIntentError(message: string, cause?: string): RuntimeError {
  return new RuntimeError("ENTRY_INTENT_INVALID", message, cause === undefined ? {} : { cause });
}

/** Issue an opaque signed token for one explicit human /phase-plan invocation. */
export function issueEntryIntent(secret: Buffer, input: IssueEntryIntentInput): string {
  const payload: EntryIntentV1 = {
    version: ENTRY_INTENT_VERSION,
    sessionId: input.sessionId,
    promptId: input.promptId,
    commandName: ENTRY_INTENT_COMMAND_NAME,
  };
  const signature = signCanonical(ENTRY_INTENT_DOMAIN, secret, { ...payload });
  return Buffer.from(JSON.stringify({ ...payload, signature }), "utf8").toString("base64url");
}

/**
 * Verify a token's signature and shape. Binding checks against the CURRENT
 * session/prompt are the caller's responsibility (compare the returned intent
 * to the live hook input) — this function only proves authorship and shape.
 */
export function verifyEntryIntent(secret: Buffer, token: unknown): EntryIntentV1 {
  if (typeof token !== "string" || token.trim() === "") {
    throw entryIntentError("entry intent token is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw entryIntentError("entry intent token is not decodable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw entryIntentError("entry intent token payload is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const { signature, ...rest } = record;
  const signedPayload: Record<string, unknown> = JSON.parse(canonicalJson(rest));
  if (!verifyCanonical(ENTRY_INTENT_DOMAIN, secret, signedPayload, typeof signature === "string" ? signature : "")) {
    throw entryIntentError("entry intent signature verification failed");
  }
  if (rest.version !== ENTRY_INTENT_VERSION) {
    throw entryIntentError(`unsupported entry intent version: ${String(rest.version)}`);
  }
  if (rest.commandName !== ENTRY_INTENT_COMMAND_NAME) {
    throw entryIntentError(`entry intent is bound to command '${String(rest.commandName)}', not '${ENTRY_INTENT_COMMAND_NAME}'`);
  }
  if (typeof rest.sessionId !== "string" || rest.sessionId === "") {
    throw entryIntentError("entry intent sessionId is missing");
  }
  if (typeof rest.promptId !== "string" || rest.promptId === "") {
    throw entryIntentError("entry intent promptId is missing");
  }
  return {
    version: ENTRY_INTENT_VERSION,
    sessionId: rest.sessionId,
    promptId: rest.promptId,
    commandName: ENTRY_INTENT_COMMAND_NAME,
  };
}

/** True when a verified intent is bound to exactly this session and prompt. */
export function entryIntentIsCurrent(intent: EntryIntentV1, current: { sessionId: string; promptId?: string }): boolean {
  if (intent.sessionId !== current.sessionId) return false;
  // The host stamps prompt_id on every hook input (v2.1.196+); when the
  // current input carries one it must match the bound prompt exactly.
  if (current.promptId !== undefined && current.promptId !== "" && intent.promptId !== current.promptId) {
    return false;
  }
  return true;
}
