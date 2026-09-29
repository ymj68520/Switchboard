/**
 * Runtime identity used by the MCP server handshake and doctor reports.
 *
 * Phase 18 §3/§4 version contract: the plugin manifest
 * (.claude-plugin/plugin.json) is the ONLY hand-written release version.
 * The runtime constant, the MCP serverInfo version, the store migration
 * records, and the release manifest all derive from it, so they cannot
 * drift apart. Bumping the release version means bumping the manifest.
 */

import manifest from "../../.claude-plugin/plugin.json" with { type: "json" };

export const RUNTIME_NAME: string = manifest.name;

/**
 * The bundled release version. Claude Code 2.1.28x keys its plugin MCP
 * tool-schema snapshot on the server identity+version, so every release
 * MUST ship a new manifest version or hosts keep the stale tool schema and
 * silently strip unknown fields from tool calls (live-found in Phase 17).
 */
export const RUNTIME_VERSION: string = manifest.version;

/**
 * Release identity banner for `--version` (Phase 18 §37): the three facts a
 * user must be able to read off any artifact. Never prints paths or
 * environment details — those belong to `doctor`.
 */
export function renderVersionBanner(schemaVersion: number, requiredNodeVersion: string): string {
  return [
    `${RUNTIME_NAME} ${RUNTIME_VERSION}`,
    `schema support ${schemaVersion}`,
    `required Node >=${requiredNodeVersion}`,
  ].join("\n");
}
