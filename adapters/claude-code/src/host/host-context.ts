/**
 * HostContextEnvelopeV1 — signed current-host authority for MCP calls
 * (frozen architecture §30, Phase 7 directive §17–§23).
 *
 * Built and signed ONLY by PreToolUse hooks from current hook input plus the
 * authoritative Store (workspace catalog / SessionBinding). Injected into the
 * tool call as `_hostContext`. The MCP handler verifies the HMAC, the tool
 * binding, and the business-input hash before any authority is granted.
 *
 * Field authority (directive §18):
 *   sessionId/promptId/permissionMode/toolUseId/toolName ← hook input
 *   workspaceId ← authoritative workspace discovery/catalog
 *   runId/bindingGeneration ← SessionBinding Store (signed OBSERVATION only —
 *   the true mutation path still revalidates against the Store, §23)
 *
 * Never sourced from: model tool input, MCP process.env, conversation text.
 */

import { createHash } from "node:crypto";

import { RuntimeError } from "../runtime/errors.js";
import { canonicalJson } from "../core/canonical-json.js";
import { HOST_CONTEXT_DOMAIN, signCanonical, verifyCanonical } from "./signing.js";

export const HOST_CONTEXT_VERSION = 1 as const;

export interface HostContextEnvelopeV1 {
  version: typeof HOST_CONTEXT_VERSION;
  sessionId: string;
  promptId?: string;
  workspaceId: string;
  runId?: string;
  bindingGeneration?: number;
  permissionMode: string;
  toolUseId: string;
  toolName: string;
  businessInputHash: string;
}

/** Model-facing reserved host fields, stripped before hashing (directive §20). */
export const HOST_CONTEXT_RESERVED_FIELDS = ["_hostContext", "_entryIntent"] as const;

/** The logical phase-plan tool a hook-built context may target. */
export type HostContextLogicalTool =
  | "start_or_resume"
  | "get_state"
  | "get_context"
  | "read_memory"
  | "list_observations"
  | "promote_evidence"
  | "revalidate_evidence"
  | "approve_proposal";

export interface BuildHostContextInput {
  sessionId: string;
  promptId?: string;
  workspaceId: string;
  runId?: string;
  bindingGeneration?: number;
  permissionMode: string;
  toolUseId: string;
  toolName: string;
  businessInputHash: string;
}

export function buildHostContextEnvelope(input: BuildHostContextInput): HostContextEnvelopeV1 {
  return {
    version: HOST_CONTEXT_VERSION,
    sessionId: input.sessionId,
    ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
    workspaceId: input.workspaceId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.bindingGeneration === undefined ? {} : { bindingGeneration: input.bindingGeneration }),
    permissionMode: input.permissionMode,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    businessInputHash: input.businessInputHash,
  };
}

/** Serialize an envelope to the opaque signed token injected as `_hostContext`. */
export function encodeHostContextToken(secret: Buffer, envelope: HostContextEnvelopeV1): string {
  const signature = signCanonical(HOST_CONTEXT_DOMAIN, secret, { ...envelope });
  return Buffer.from(JSON.stringify({ ...envelope, signature }), "utf8").toString("base64url");
}

/**
 * Hash of the business input a context authorizes: reserved host fields are
 * removed, the remainder is canonical-JSON'd and SHA-256'd (directive §20).
 */
export function businessInputHashOf(businessInput: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(businessInput)) {
    if ((HOST_CONTEXT_RESERVED_FIELDS as readonly string[]).includes(key)) continue;
    rest[key] = businessInput[key];
  }
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

/**
 * The tool name Claude Code shows to hooks is scoped for plugin MCP servers
 * (mcp__plugin_<plugin>_<server>__<tool>); authority binds to the logical
 * tool that follows the last `__` separator.
 */
export function logicalToolName(toolName: string): string {
  const index = toolName.lastIndexOf("__");
  return index === -1 ? toolName : toolName.slice(index + 2);
}

function hostContextError(code: RuntimeError["code"], message: string, cause?: string): RuntimeError {
  return new RuntimeError(code, message, cause === undefined ? {} : { cause });
}

/**
 * Decode + signature-verify a token. Shape failures and HMAC failures both
 * fail closed as HOST_CONTEXT_INVALID — an HMAC failure is never remapped to
 * a session-binding error (directive §22).
 */
export function verifyHostContext(secret: Buffer, token: unknown): HostContextEnvelopeV1 {
  if (typeof token !== "string" || token.trim() === "") {
    throw hostContextError("HOST_CONTEXT_REQUIRED", "no signed host context was provided");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw hostContextError("HOST_CONTEXT_INVALID", "host context token is not decodable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw hostContextError("HOST_CONTEXT_INVALID", "host context payload is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const { signature, ...rest } = record;
  const signedPayload: Record<string, unknown> = JSON.parse(canonicalJson(rest));
  if (!verifyCanonical(HOST_CONTEXT_DOMAIN, secret, signedPayload, typeof signature === "string" ? signature : "")) {
    throw hostContextError("HOST_CONTEXT_INVALID", "host context signature verification failed");
  }
  if (rest.version !== HOST_CONTEXT_VERSION) {
    throw hostContextError("HOST_CONTEXT_INVALID", `unsupported host context version: ${String(rest.version)}`);
  }
  for (const key of ["sessionId", "workspaceId", "permissionMode", "toolUseId", "toolName", "businessInputHash"] as const) {
    if (typeof rest[key] !== "string" || rest[key] === "") {
      throw hostContextError("HOST_CONTEXT_INVALID", `host context field '${key}' is missing or malformed`);
    }
  }
  if (rest.promptId !== undefined && typeof rest.promptId !== "string") {
    throw hostContextError("HOST_CONTEXT_INVALID", "host context field 'promptId' is malformed");
  }
  if (rest.runId !== undefined && (typeof rest.runId !== "string" || rest.runId === "")) {
    throw hostContextError("HOST_CONTEXT_INVALID", "host context field 'runId' is malformed");
  }
  if (
    rest.bindingGeneration !== undefined &&
    (typeof rest.bindingGeneration !== "number" || !Number.isInteger(rest.bindingGeneration) || rest.bindingGeneration < 1)
  ) {
    throw hostContextError("HOST_CONTEXT_INVALID", "host context field 'bindingGeneration' is malformed");
  }
  return {
    version: HOST_CONTEXT_VERSION,
    sessionId: rest.sessionId as string,
    ...(rest.promptId === undefined ? {} : { promptId: rest.promptId as string }),
    workspaceId: rest.workspaceId as string,
    ...(rest.runId === undefined ? {} : { runId: rest.runId as string }),
    ...(rest.bindingGeneration === undefined ? {} : { bindingGeneration: rest.bindingGeneration as number }),
    permissionMode: rest.permissionMode as string,
    toolUseId: rest.toolUseId as string,
    toolName: rest.toolName as string,
    businessInputHash: rest.businessInputHash as string,
  };
}

export interface AssertHostContextInput {
  /** The logical tool this handler serves (e.g. "approve_proposal"). */
  tool: HostContextLogicalTool;
  /** The raw MCP arguments as received — reserved fields are stripped. */
  businessInput: Record<string, unknown>;
}

/**
 * Full verification chain for a mutation/read handler:
 * signature+shape → tool binding → business-input hash (directive §20–§22).
 */
export function assertHostContextForTool(secret: Buffer, token: unknown, expected: AssertHostContextInput): HostContextEnvelopeV1 {
  const envelope = verifyHostContext(secret, token);
  if (logicalToolName(envelope.toolName) !== expected.tool) {
    throw hostContextError(
      "HOST_CONTEXT_TOOL_MISMATCH",
      `host context was signed for tool '${envelope.toolName}', not '${expected.tool}'`,
    );
  }
  const recomputed = businessInputHashOf(expected.businessInput);
  if (recomputed !== envelope.businessInputHash) {
    throw hostContextError(
      "HOST_CONTEXT_INPUT_MISMATCH",
      "business input does not match the hash signed into the host context",
    );
  }
  return envelope;
}
