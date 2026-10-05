/**
 * WorkerHostContextV1 — signed current-host authority for the Phase Plan
 * ExecutionWorker runtime (v0.2.0 E5 §8/§33/§44).
 *
 * Built and signed ONLY by the PreToolUse hook from current hook input. The
 * host probe (src/hooks/parse.ts, Claude Code 2.1.283) shows `agent_id` /
 * `agent_type` appear ONLY on subagent tool calls — a main-session call
 * attests itself by their ABSENCE. A worker authority envelope therefore
 * REQUIRES both fields and `agent_type === "phase-plan:execution-worker"`; the
 * MCP layer fails closed on anything else (E5 §44).
 *
 * Domain separation: the signature domain is `phase-plan:worker-context:v1` —
 * a signed Planning/Execution HostContext can never be replayed as worker
 * authority and vice versa; every direction fails HMAC and closes.
 *
 * The worker session id is the SUBAGENT's own authoritative hook session —
 * never a model-supplied argument (E5 §33/§I5).
 */

import { RuntimeError } from "../runtime/errors.js";
import { canonicalJson } from "../core/canonical-json.js";
import {
  WORKER_CONTEXT_DOMAIN,
  signCanonical,
  verifyCanonical,
} from "./signing.js";
import { businessInputHashOf, logicalToolName } from "./host-context.js";

export const WORKER_CONTEXT_VERSION = 1 as const;
export const WORKER_CONTEXT_AUTHORITY = "worker" as const;

/** The single Phase Plan ExecutionWorker agent type (agents/execution-worker.md). */
export const EXECUTION_WORKER_AGENT_TYPE = "phase-plan:execution-worker";

export interface WorkerHostContextV1 {
  version: typeof WORKER_CONTEXT_VERSION;
  authority: typeof WORKER_CONTEXT_AUTHORITY;
  /** The subagent's OWN session id from the current hook input. */
  sessionId: string;
  promptId?: string;
  workspaceId: string;
  agent: { agentId: string; agentType: string };
  permissionMode: string;
  toolUseId: string;
  toolName: string;
  businessInputHash: string;
}

export interface BuildWorkerContextInput {
  sessionId: string;
  promptId?: string;
  workspaceId: string;
  agent: { agentId: string; agentType: string };
  permissionMode: string;
  toolUseId: string;
  toolName: string;
  businessInputHash: string;
}

export function buildWorkerHostContextEnvelope(input: BuildWorkerContextInput): WorkerHostContextV1 {
  return {
    version: WORKER_CONTEXT_VERSION,
    authority: WORKER_CONTEXT_AUTHORITY,
    sessionId: input.sessionId,
    ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
    workspaceId: input.workspaceId,
    agent: input.agent,
    permissionMode: input.permissionMode,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    businessInputHash: input.businessInputHash,
  };
}

export function encodeWorkerHostContextToken(secret: Buffer, envelope: WorkerHostContextV1): string {
  const signature = signCanonical(WORKER_CONTEXT_DOMAIN, secret, { ...envelope });
  return Buffer.from(JSON.stringify({ ...envelope, signature }), "utf8").toString("base64url");
}

function workerContextError(code: RuntimeError["code"], message: string, cause?: string): RuntimeError {
  return new RuntimeError(code, message, cause === undefined ? {} : { cause });
}

/** Decode + signature-verify a token as worker authority. Fails closed. */
export function verifyWorkerHostContext(secret: Buffer, token: unknown): WorkerHostContextV1 {
  if (typeof token !== "string" || token.trim() === "") {
    throw workerContextError("WORKER_AUTHORITY_REQUIRED", "no signed worker host context was provided");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw workerContextError("HOST_CONTEXT_INVALID", "worker host context token is not decodable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw workerContextError("HOST_CONTEXT_INVALID", "worker host context payload is not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.authority !== WORKER_CONTEXT_AUTHORITY) {
    throw workerContextError(
      "WORKER_AUTHORITY_REQUIRED",
      "host context is not a worker authority envelope",
    );
  }
  const { signature, ...rest } = record;
  const signedPayload: Record<string, unknown> = JSON.parse(canonicalJson(rest));
  if (!verifyCanonical(WORKER_CONTEXT_DOMAIN, secret, signedPayload, typeof signature === "string" ? signature : "")) {
    throw workerContextError("HOST_CONTEXT_INVALID", "worker host context signature verification failed");
  }
  if (rest.version !== WORKER_CONTEXT_VERSION) {
    throw workerContextError("HOST_CONTEXT_INVALID", `unsupported worker context version: ${String(rest.version)}`);
  }
  for (const key of [
    "sessionId",
    "workspaceId",
    "permissionMode",
    "toolUseId",
    "toolName",
    "businessInputHash",
  ] as const) {
    if (typeof rest[key] !== "string" || rest[key] === "") {
      throw workerContextError("HOST_CONTEXT_INVALID", `worker context field '${key}' is missing or malformed`);
    }
  }
  const agent = rest.agent as Record<string, unknown> | undefined;
  if (
    typeof agent !== "object"
    || agent === null
    || typeof agent.agentId !== "string"
    || agent.agentId === ""
    || typeof agent.agentType !== "string"
    || agent.agentType === ""
  ) {
    throw workerContextError(
      "WORKER_AUTHORITY_REQUIRED",
      "worker authority requires the host's subagent identity (agent_id/agent_type); a main session cannot claim Worker authority",
    );
  }
  if (agent.agentType !== EXECUTION_WORKER_AGENT_TYPE) {
    throw workerContextError(
      "WORKER_AUTHORITY_REQUIRED",
      `worker authority requires agent_type '${EXECUTION_WORKER_AGENT_TYPE}'; got '${String(agent.agentType)}'`,
    );
  }
  return {
    version: WORKER_CONTEXT_VERSION,
    authority: WORKER_CONTEXT_AUTHORITY,
    sessionId: rest.sessionId as string,
    ...(rest.promptId === undefined ? {} : { promptId: rest.promptId as string }),
    workspaceId: rest.workspaceId as string,
    agent: { agentId: agent.agentId, agentType: agent.agentType },
    permissionMode: rest.permissionMode as string,
    toolUseId: rest.toolUseId as string,
    toolName: rest.toolName as string,
    businessInputHash: rest.businessInputHash as string,
  };
}

export interface AssertWorkerContextInput {
  tool: string;
  businessInput: Record<string, unknown>;
}

/**
 * Full verification chain for a Worker-only MCP handler: signature+shape →
 * tool binding → business-input hash. The claimed attempt binding is
 * revalidated against the Store by the application service.
 */
export function assertWorkerHostContextForTool(
  secret: Buffer,
  token: unknown,
  expected: AssertWorkerContextInput,
): WorkerHostContextV1 {
  const envelope = verifyWorkerHostContext(secret, token);
  if (logicalToolName(envelope.toolName) !== expected.tool) {
    throw workerContextError(
      "HOST_CONTEXT_TOOL_MISMATCH",
      `worker context was signed for tool '${envelope.toolName}', not '${expected.tool}'`,
    );
  }
  const recomputed = businessInputHashOf(expected.businessInput);
  if (recomputed !== envelope.businessInputHash) {
    throw workerContextError(
      "HOST_CONTEXT_INPUT_MISMATCH",
      "business input does not match the hash signed into the worker host context",
    );
  }
  return envelope;
}
