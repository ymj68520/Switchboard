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

/**
 * HostContextEnvelopeV2 (Phase 12 §6–§7) — V1 plus the OPTIONAL signed agent
 * attestation. Field names come from the real host probe (Claude Code 2.1.283
 * PreToolUse input): `agent_id` (opaque per-spawn id, == the background task
 * id) and `agent_type` (`<plugin>:<agent-name>`). Main-session hook input
 * carries neither, so a V2 envelope WITHOUT agent attests a main-agent call.
 *
 * V2 is signed ONLY for the validator/synthesis/reopen capability family;
 * the ten Phase 7–11 tools keep byte-identical V1 envelopes (§7).
 */
export const HOST_CONTEXT_V2_VERSION = 2 as const;

export interface HostContextAgent {
  agentId?: string;
  agentType?: string;
}

export interface HostContextEnvelopeV2 extends Omit<HostContextEnvelopeV1, "version"> {
  version: typeof HOST_CONTEXT_V2_VERSION;
  agent?: HostContextAgent;
}

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
  | "select_section"
  | "prepare_proposal"
  | "approve_proposal"
  | "submit_synthesis"
  | "submit_validation"
  | "request_reopen";

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

export interface BuildHostContextV2Input extends BuildHostContextInput {
  /** Present only when the hook input carried the host's subagent fields. */
  agent?: HostContextAgent;
}

/** Build a V2 envelope (§6) — identical rules to V1 plus the agent attestation. */
export function buildHostContextEnvelopeV2(input: BuildHostContextV2Input): HostContextEnvelopeV2 {
  return {
    ...buildHostContextEnvelope(input),
    version: HOST_CONTEXT_V2_VERSION,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  };
}

/** Serialize a V2 envelope to the opaque signed token injected as `_hostContext`. */
export function encodeHostContextTokenV2(secret: Buffer, envelope: HostContextEnvelopeV2): string {
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
 * a session-binding error (directive §22). Accepts V1 and V2 envelopes; the
 * version byte decides whether the optional agent attestation may appear.
 */
export function verifyHostContext(secret: Buffer, token: unknown): HostContextEnvelopeV1 | HostContextEnvelopeV2 {
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
  if (rest.version !== HOST_CONTEXT_VERSION && rest.version !== HOST_CONTEXT_V2_VERSION) {
    throw hostContextError("HOST_CONTEXT_INVALID", `unsupported host context version: ${String(rest.version)}`);
  }
  const isV2 = rest.version === HOST_CONTEXT_V2_VERSION;
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
  let agent: HostContextAgent | undefined;
  if (isV2 && rest.agent !== undefined) {
    if (typeof rest.agent !== "object" || rest.agent === null) {
      throw hostContextError("HOST_CONTEXT_INVALID", "host context field 'agent' is malformed");
    }
    const rawAgent = rest.agent as Record<string, unknown>;
    if (rawAgent.agentId !== undefined && (typeof rawAgent.agentId !== "string" || rawAgent.agentId === "")) {
      throw hostContextError("HOST_CONTEXT_INVALID", "host context field 'agent.agentId' is malformed");
    }
    if (rawAgent.agentType !== undefined && (typeof rawAgent.agentType !== "string" || rawAgent.agentType === "")) {
      throw hostContextError("HOST_CONTEXT_INVALID", "host context field 'agent.agentType' is malformed");
    }
    agent = {
      ...(rawAgent.agentId === undefined ? {} : { agentId: rawAgent.agentId }),
      ...(rawAgent.agentType === undefined ? {} : { agentType: rawAgent.agentType }),
    };
  }
  const common = {
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
  return isV2 ? { ...common, version: HOST_CONTEXT_V2_VERSION, ...(agent === undefined ? {} : { agent }) } : { ...common, version: HOST_CONTEXT_VERSION };
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
export function assertHostContextForTool(
  secret: Buffer,
  token: unknown,
  expected: AssertHostContextInput,
): HostContextEnvelopeV1 | HostContextEnvelopeV2 {
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
