/**
 * Phase Plan stdio MCP bootstrap (frozen plan §10, architecture §28.2).
 *
 * Phase 1 scope: protocol/server initialization, server identity, clean
 * startup, clean shutdown, logging discipline, and the future tool
 * registration boundary. The frozen Phase Plan domain tools
 * (prepare_proposal, approve_proposal, …) belong to later phases and are
 * deliberately NOT stubbed here; tools/list returns an empty set, which keeps
 * stdout protocol-pure and the domain state untouched.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createLogger, type Logger } from "../runtime/logger.js";
import { RuntimeError } from "../runtime/errors.js";
import { RUNTIME_NAME, RUNTIME_VERSION } from "../runtime/version.js";

export interface McpServerHandle {
  /** Close the transport and stop serving. Idempotent. */
  close(): Promise<void>;
}

export interface McpBootstrapOptions {
  logger?: Logger;
}

/**
 * Start the long-lived stdio MCP server and resolve once the transport is
 * connected. The promise returned by `waitStopped` settles after the server
 * stops (stdin end, transport close, or explicit close()).
 */
export async function startMcpServer(options: McpBootstrapOptions = {}): Promise<{
  handle: McpServerHandle;
  waitStopped: Promise<void>;
}> {
  const logger = options.logger ?? createLogger("info");
  const server = new Server({ name: RUNTIME_NAME, version: RUNTIME_VERSION }, { capabilities: { tools: {} } });

  // Phase 1 tool registration boundary: an empty, read-only tool surface.
  // Later phases replace this handler's body with typed domain tools; the
  // server must never expose ad-hoc mutation tools ahead of the frozen
  // contract.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

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

  logger.info(`mcp server '${RUNTIME_NAME}' v${RUNTIME_VERSION} ready on stdio`);
  return { handle, waitStopped };
}
