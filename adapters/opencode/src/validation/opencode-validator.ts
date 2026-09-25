/**
 * OpenCode runtime adapter for the semantic validator (Phase 2G brief §7/§8/§9).
 *
 * RUNTIME BEHAVIOR (verified against @opencode-ai/plugin 1.18 types and the
 * generated @opencode-ai/sdk surface the plugin input binds):
 *
 * 1. `client.session.create({})` opens a FRESH, Harness-owned, ephemeral
 *    session — validator-only, not user planning state, no conversation
 *    history, not used for planning continuity (§9).
 * 2. `client.session.prompt(...)` performs ONE inference with a deterministic
 *    system prompt (semantic-validation:v1) and the frozen capsule as the only
 *    user content. `body.system` replaces the system context for this request
 *    and `body.tools` disables tools PER REQUEST.
 * 3. Tool isolation is STRUCTURAL, not prompt-based (§8/§9):
 *    - the validator session is NOT the PlanningRun owner: every Ultra Plan
 *      tool resolves its run via findActiveRunBySession(validatorSessionID) →
 *      none → deterministic `no_active_run`. The validator cannot become
 *      workflow authority even if it invoked a harness tool;
 *    - defense-in-depth: all `ultraplan_*` tools and the standard
 *      repository/shell builtins are disabled by name in the per-request
 *      tools map (mutation tools, approval tools, repository-write tools,
 *      and read tools — the frozen capsule is the only input, §8).
 * 4. The ephemeral session is deleted after text extraction.
 *
 * KNOWN LIMIT (stated honestly, §8/§10): the per-request tools map disables
 * tools BY NAME — OpenCode v1.18 exposes no verified "disable every tool"
 * wildcard, so a third-party plugin registering an unknown tool name would not
 * be covered by the map. The structural guarantee (different session ⇒ no run
 * ⇒ `no_active_run` on every harness tool) does not depend on the map.
 *
 * No child-session API is assumed beyond the verified `session.create` /
 * `session.prompt` / `session.delete` triple; no generic subagent
 * orchestration is built (§7/§9).
 */
import type { PluginInput } from "@opencode-ai/plugin";

import { ULTRA_PLAN_TOOL_NAMES } from "../runtime/opencode-plugin.js";
import { SEMANTIC_VALIDATION_SYSTEM_PROMPT } from "./protocol.js";
import type { RawValidatorOutput, SemanticValidator, ValidationCapsule } from "./types.js";

/** Repository/shell builtins a capsule-only inference never needs. */
const DISABLED_BUILTIN_TOOLS = [
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "glob",
  "list",
  "patch",
  "apply_patch",
  "read_many",
  "todowrite",
  "task",
  "webfetch",
] as const;

export class OpenCodeSemanticValidator implements SemanticValidator {
  readonly model?: string;

  constructor(
    private readonly client: PluginInput["client"],
    options: { model?: string } = {},
  ) {
    if (options.model) this.model = options.model;
  }

  async validate(capsule: ValidationCapsule): Promise<RawValidatorOutput> {
    const created = await this.client.session.create({});
    if (created.error || !created.data) {
      throw new Error(`semantic validator session could not be created: ${JSON.stringify(created.error ?? "no data")}`);
    }
    const sessionID = created.data.id;
    try {
      const reply = await this.client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: capsule }],
          system: SEMANTIC_VALIDATION_SYSTEM_PROMPT,
          tools: {
            ...Object.fromEntries(ULTRA_PLAN_TOOL_NAMES.map((name) => [name, false])),
            ...Object.fromEntries(DISABLED_BUILTIN_TOOLS.map((name) => [name, false])),
          },
        },
      });
      if (reply.error || !reply.data) {
        throw new Error(`semantic validator inference failed: ${JSON.stringify(reply.error ?? "no data")}`);
      }
      const text = reply.data.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      return { text, ...(this.model !== undefined ? { model: this.model } : {}) };
    } finally {
      // Ephemeral by contract; deletion failure must not mask the result.
      try {
        await this.client.session.delete({ path: { id: sessionID } });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
