/**
 * Host tool inventory discovery — Phase 8 §12/§13/§14.
 *
 * Phase 7B established that OpenCode's per-call `tools` maps are OVERRIDES:
 * a host tool absent from the map stays enabled for that invocation. The
 * Phase 7B deny maps therefore had to enumerate names from a hardcoded
 * baseline — which the live host immediately proved incomplete (the real
 * 1.18 surface includes `apply_patch`, `websearch`, `skill`, `question`,
 * `invalid`, none of which the baseline knew).
 *
 * The production fix is discovery: the host itself enumerates its complete
 * currently-registered tool surface (built-in AND dynamically registered) at
 * `GET /experimental/tool/ids` (`client.tool.ids()`). The Supervisor denies
 * the WHOLE discovered inventory; the Worker denies everything discovered
 * except the capability-mapped baseline. A newly introduced host tool is
 * denied by default at the next bundle construction — no protocol source
 * change (§16).
 *
 * Fail-closed (§13): production bundle construction refuses to build when a
 * trusted inventory cannot be obtained — it NEVER silently falls back to the
 * hardcoded baseline and claims isolation.
 */

/** The outcome of host tool inventory discovery. */
export type HostToolInventory =
  | { ok: true; source: "host_endpoint"; tools: readonly string[] }
  | { ok: false; reason: string };

/** Minimal structural view of the SDK client's tool inventory surface. */
interface ToolInventoryClient {
  tool?: {
    ids?: (options?: unknown) => Promise<{ data?: unknown; error?: unknown }>;
  };
}

/**
 * Discover the host's complete currently-registered tool names. The result is
 * deduplicated and sorted so the deny map is deterministic. Any failure shape
 * (client without the endpoint, non-list payload, throwing call) is an
 * explicit `ok: false` — never a partial inventory.
 */
export async function discoverHostToolNames(client: unknown): Promise<HostToolInventory> {
  const tool = (client as ToolInventoryClient | undefined)?.tool;
  if (!tool || typeof tool.ids !== "function") {
    return {
      ok: false,
      reason: "the host client does not expose a tool inventory endpoint (client.tool.ids is unavailable)",
    };
  }
  try {
    const response = await tool.ids();
    const data = response?.data;
    if (!Array.isArray(data) || data.some((name) => typeof name !== "string" || name.length === 0)) {
      return { ok: false, reason: "the host tool inventory endpoint returned no usable tool name list" };
    }
    return { ok: true, source: "host_endpoint", tools: Object.freeze([...new Set(data as string[])].sort()) };
  } catch (error) {
    return {
      ok: false,
      reason: `host tool inventory discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
