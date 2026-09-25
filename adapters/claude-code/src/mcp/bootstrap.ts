/**
 * Phase Plan stdio MCP bootstrap (frozen plan §10, architecture §28.2).
 *
 * Phase 9 scope: seven tools — start_or_resume, get_state, get_context,
 * read_memory (Phase 8 read-side), list_observations, promote_evidence
 * (Phase 9 observation/evidence), approve_proposal. Tool visibility is not
 * authority: every handler verifies the hook-signed HostContext and then
 * delegates to the Application services / Phase 6 engine, which revalidate
 * stage, lifecycle, binding, HEAD and proposal state (directive §49).
 *
 * stdout stays protocol-pure; diagnostics go to the logger (stderr).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import * as path from "node:path";

import { createLogger, type Logger } from "../runtime/logger.js";
import { RuntimeError, isRuntimeError, toRuntimeError } from "../runtime/errors.js";
import { RUNTIME_NAME, RUNTIME_VERSION } from "../runtime/version.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import { createBlobStore } from "../store/blob-store.js";
import { PHASE_PLAN_TOOLS, executePhasePlanTool, type PhasePlanToolContext } from "./tools.js";

export interface McpServerHandle {
  /** Close the transport and stop serving. Idempotent. */
  close(): Promise<void>;
}

export interface McpBootstrapOptions {
  logger?: Logger;
  /** Opened Plan Store (fail-closed boot happens in the dispatcher). */
  store: PlanStore;
  /** Persistent host signing secret for HostContext verification. */
  secret: Buffer;
  /** Plugin data root — anchors the content-addressed Observation blob store. */
  pluginDataRoot: string;
  clock?: StoreClock;
}

/**
 * Start the long-lived stdio MCP server and resolve once the transport is
 * connected. The promise returned by `waitStopped` settles after the server
 * stops (stdin end, transport close, or explicit close()).
 */
export async function startMcpServer(options: McpBootstrapOptions): Promise<{
  handle: McpServerHandle;
  waitStopped: Promise<void>;
}> {
  const logger = options.logger ?? createLogger("info");
  const server = new Server({ name: RUNTIME_NAME, version: RUNTIME_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: PHASE_PLAN_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
    })),
  }));

  const toolContext: PhasePlanToolContext = {
    store: options.store,
    secret: options.secret,
    clock: options.clock ?? { nowIso: () => new Date().toISOString(), newId: () => crypto.randomUUID() },
    blobs: createBlobStore(path.join(options.pluginDataRoot, "blobs")),
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = executePhasePlanTool(toolContext, name, args);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }],
      };
    } catch (err) {
      const error = toRuntimeError(err, "INTERNAL_ERROR");
      // Stable machine-readable failure: never a stack trace as protocol
      // semantics (directive §52).
      logger.error(`tool ${name} failed: [${error.code}] ${error.message}${error.causeText ? ` — ${error.causeText}` : ""}`);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              code: isRuntimeError(error) ? error.code : "INTERNAL_ERROR",
              message: error.message,
            }),
          },
        ],
      };
    }
  });

  server.onerror = (err) => {
    logger.error(`mcp server error: ${err instanceof Error ? err.message : String(err)}`);
  };

  let stopped!: () => void;
  const waitStopped = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  let closed = false;
  const handle: McpServerHandle = {
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await server.close();
      } finally {
        stopped();
      }
    },
  };
  server.onclose = () => {
    closed = true;
    logger.info("mcp transport closed");
    stopped();
  };

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    throw new RuntimeError("MCP_BOOTSTRAP_FAILED", "stdio MCP transport failed to start", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info(`mcp server '${RUNTIME_NAME}' v${RUNTIME_VERSION} ready on stdio (${PHASE_PLAN_TOOLS.length} tools)`);
  return { handle, waitStopped };
}
