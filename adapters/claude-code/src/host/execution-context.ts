/**
 * ExecutionHostContextV1 — signed current-host authority for the Build
 * read-side (Phase 14 §53–§56).
 *
 * Built and signed ONLY by the PreToolUse hook from current hook input plus
 * the authoritative Store (delivered ExecutionHandoff + attached
 * ExecutionBinding). Injected into the tool call as the SAME reserved
 * `_hostContext` field (§55); the parser distinguishes the two authorities by
 * the signed `authority` field, never by model input.
 *
 * Domain separation (§54): the signature domain is
 * `phase-plan:execution-context:v1` — a signed Planning HostContext can never
 * be replayed as execution authority and vice versa; both directions fail
 * HMAC verification and therefore fail closed.
 *
 * Every Build read revalidates the binding generation against the Store
 * (§56); a detached/rebound generation fences outstanding tokens as
 * STALE_EXECUTION_BINDING.
 */

import { RuntimeError } from "../runtime/errors.js";
import { canonicalJson } from "../core/canonical-json.js";
import {
  EXECUTION_CONTEXT_DOMAIN,
  signCanonical,
  verifyCanonical,
} from "./signing.js";
import {
  businessInputHashOf,
  logicalToolName,
  verifyHostContext,
  type HostContextEnvelopeV1,
  type HostContextEnvelopeV2,
} from "./host-context.js";

export const EXECUTION_CONTEXT_VERSION = 1 as const;
export const EXECUTION_CONTEXT_AUTHORITY = "execution" as const;

export interface ExecutionHostContextV1 {
  version: typeof EXECUTION_CONTEXT_VERSION;
  authority: typeof EXECUTION_CONTEXT_AUTHORITY;
  sessionId: string;
  promptId?: string;
  workspaceId: string;
  runId: string;
  finalPlanId: string;
  executionBindingGeneration: number;
  permissionMode: string;
  toolUseId: string;
  toolName: string;
  businessInputHash: string;
}

export interface BuildExecutionContextInput {
  sessionId: string;
  promptId?: string;
  workspaceId: string;
  runId: string;
  finalPlanId: string;
  executionBindingGeneration: number;
  permissionMode: string;
  toolUseId: string;
  toolName: string;
  businessInputHash: string;
}

export function buildExecutionHostContextEnvelope(
  input: BuildExecutionContextInput,
): ExecutionHostContextV1 {
  return {
    version: EXECUTION_CONTEXT_VERSION,
    authority: EXECUTION_CONTEXT_AUTHORITY,
    sessionId: input.sessionId,
    ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
    workspaceId: input.workspaceId,
    runId: input.runId,
    finalPlanId: input.finalPlanId,
    executionBindingGeneration: input.executionBindingGeneration,
    permissionMode: input.permissionMode,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    businessInputHash: input.businessInputHash,
  };
}

/** Serialize to the opaque signed token injected as `_hostContext` (§55). */
export function encodeExecutionHostContextToken(
  secret: Buffer,
  envelope: ExecutionHostContextV1,
): string {
  const signature = signCanonical(EXECUTION_CONTEXT_DOMAIN, secret, { ...envelope });
  return Buffer.from(JSON.stringify({ ...envelope, signature }), "utf8").toString("base64url");
}

function executionContextError(code: RuntimeError["code"], message: string, cause?: string): RuntimeError {
  return new RuntimeError(code, message, cause === undefined ? {} : { cause });
}

/**
 * Decode + signature-verify a token as execution authority. Shape failures
 * and HMAC failures fail closed as HOST_CONTEXT_INVALID. A Planning
 * HostContext has no `authority` field and fails here before any store check.
 */
export function verifyExecutionHostContext(secret: Buffer, token: unknown): ExecutionHostContextV1 {
  if (typeof token !== "string" || token.trim() === "") {
    throw executionContextError("HOST_CONTEXT_REQUIRED", "no signed host context was provided");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw executionContextError("HOST_CONTEXT_INVALID", "host context token is not decodable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw executionContextError("HOST_CONTEXT_INVALID", "host context payload is not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.authority !== EXECUTION_CONTEXT_AUTHORITY) {
    throw executionContextError(
      "HOST_CONTEXT_INVALID",
      "host context is not an execution authority envelope",
    );
  }
  const { signature, ...rest } = record;
  const signedPayload: Record<string, unknown> = JSON.parse(canonicalJson(rest));
  if (!verifyCanonical(EXECUTION_CONTEXT_DOMAIN, secret, signedPayload, typeof signature === "string" ? signature : "")) {
    throw executionContextError("HOST_CONTEXT_INVALID", "execution host context signature verification failed");
  }
  if (rest.version !== EXECUTION_CONTEXT_VERSION) {
    throw executionContextError("HOST_CONTEXT_INVALID", `unsupported execution context version: ${String(rest.version)}`);
  }
  for (const key of [
    "sessionId",
    "workspaceId",
    "runId",
    "finalPlanId",
    "permissionMode",
    "toolUseId",
    "toolName",
    "businessInputHash",
  ] as const) {
    if (typeof rest[key] !== "string" || rest[key] === "") {
      throw executionContextError("HOST_CONTEXT_INVALID", `execution context field '${key}' is missing or malformed`);
    }
  }
  if (
    typeof rest.executionBindingGeneration !== "number"
    || !Number.isInteger(rest.executionBindingGeneration)
    || rest.executionBindingGeneration < 1
  ) {
    throw executionContextError("HOST_CONTEXT_INVALID", "execution context field 'executionBindingGeneration' is malformed");
  }
  if (rest.promptId !== undefined && typeof rest.promptId !== "string") {
    throw executionContextError("HOST_CONTEXT_INVALID", "execution context field 'promptId' is malformed");
  }
  return {
    version: EXECUTION_CONTEXT_VERSION,
    authority: EXECUTION_CONTEXT_AUTHORITY,
    sessionId: rest.sessionId as string,
    ...(rest.promptId === undefined ? {} : { promptId: rest.promptId as string }),
    workspaceId: rest.workspaceId as string,
    runId: rest.runId as string,
    finalPlanId: rest.finalPlanId as string,
    executionBindingGeneration: rest.executionBindingGeneration as number,
    permissionMode: rest.permissionMode as string,
    toolUseId: rest.toolUseId as string,
    toolName: rest.toolName as string,
    businessInputHash: rest.businessInputHash as string,
  };
}

export interface AssertExecutionContextInput {
  tool: string;
  businessInput: Record<string, unknown>;
}

/**
 * Full verification chain for a Build read handler: signature+shape → tool
 * binding → business-input hash (§56). Binding generation/session/workspace
 * are revalidated against the Store by the application service.
 */
export function assertExecutionHostContextForTool(
  secret: Buffer,
  token: unknown,
  expected: AssertExecutionContextInput,
): ExecutionHostContextV1 {
  const envelope = verifyExecutionHostContext(secret, token);
  if (logicalToolName(envelope.toolName) !== expected.tool) {
    throw executionContextError(
      "HOST_CONTEXT_TOOL_MISMATCH",
      `execution context was signed for tool '${envelope.toolName}', not '${expected.tool}'`,
    );
  }
  const recomputed = businessInputHashOf(expected.businessInput);
  if (recomputed !== envelope.businessInputHash) {
    throw executionContextError(
      "HOST_CONTEXT_INPUT_MISMATCH",
      "business input does not match the hash signed into the execution host context",
    );
  }
  return envelope;
}

/**
 * §55 — parse the reserved `_hostContext` token under EITHER authority. The
 * signed `authority` field decides; the two domains never cross (§54).
 */
export type SignedHostContext =
  | { authority: "planning"; envelope: HostContextEnvelopeV1 | HostContextEnvelopeV2 }
  | { authority: "execution"; envelope: ExecutionHostContextV1 };

export function parseSignedHostContext(secret: Buffer, token: unknown): SignedHostContext {
  if (typeof token === "string" && token.trim() !== "") {
    let probe: unknown;
    try {
      probe = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    } catch {
      // falls through to planning verification, which fails closed
    }
    if (typeof probe === "object" && probe !== null && (probe as Record<string, unknown>).authority === EXECUTION_CONTEXT_AUTHORITY) {
      return { authority: "execution", envelope: verifyExecutionHostContext(secret, token) };
    }
  }
  return { authority: "planning", envelope: verifyHostContext(secret, token) };
}
