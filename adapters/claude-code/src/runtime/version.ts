/**
 * Runtime identity used by the MCP server handshake and doctor reports.
 * Single source so the bundled artifact, the plugin manifest, and diagnostics
 * cannot drift apart.
 */

export const RUNTIME_NAME = "phase-plan";
export const RUNTIME_VERSION = "0.1.0";
