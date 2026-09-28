/**
 * Runtime identity used by the MCP server handshake and doctor reports.
 * Single source so the bundled artifact, the plugin manifest, and diagnostics
 * cannot drift apart.
 */

export const RUNTIME_NAME = "phase-plan";
// 0.1.1 — Phase 17 §55: the tool surface changed (prepare_proposal gained
// the optional proposal_id revise route). Claude Code 2.1.283 keys its
// plugin MCP tool-schema snapshot on the server identity+version, so a
// rebuilt bundle MUST ship a new version or every session — including fresh
// ones — keeps the stale schema and silently strips unknown fields from
// tool calls (live-found in the golden run).
export const RUNTIME_VERSION = "0.1.1";
