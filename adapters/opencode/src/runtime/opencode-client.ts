/**
 * Narrow structural view of the OpenCode SDK client — v0.2.0 Phase 7A.
 *
 * The runtime adapters depend on ONLY these calls (verified against
 * @opencode-ai/sdk 1.18.32, §10 audit). A narrow structural type keeps the
 * adapters testable with plain fakes (§73/§74 — no live network) while the
 * real generated client satisfies it structurally:
 *
 * - `session.create` → POST /session with optional `parentID` (child-session
 *   lineage; the FRESH isolated context for every Worker invocation, §17).
 * - `session.prompt` → POST /session/{id}/message — SYNCHRONOUS: resolves
 *   with the complete assistant response `{info, parts}`; per-call `agent`,
 *   `model`, `system`, and `tools` overrides bind role/model/tool policy to
 *   ONE invocation (mechanical isolation, §21/§31).
 * - `session.status` → per-session idle/busy/retry (liveness correlation
 *   only — NEVER workflow authority, §61).
 */
export interface OpenCodeModelClient {
  session: {
    create(input: { body?: { parentID?: string; title?: string } }): Promise<{
      data?: { id: string };
      error?: unknown;
    }>;
    prompt(input: {
      path: { id: string };
      body: {
        parts: { type: "text"; text: string }[];
        agent?: string;
        model?: { providerID: string; modelID: string };
        system?: string;
        tools?: Record<string, boolean>;
      };
    }): Promise<{
      data?: {
        info: { id: string; sessionID: string; error?: { name?: string; data?: { message?: string } } };
        parts: { type: string; text?: string }[];
      };
      error?: unknown;
    }>;
  };
  status?(): Promise<{ data?: Record<string, { type: string }> | undefined; error?: unknown }>;
}

/** Extract the complete final text from a prompt response (text parts only). */
export function finalTextOf(response: { parts: { type: string; text?: string }[] }): string {
  return response.parts
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("\n");
}
