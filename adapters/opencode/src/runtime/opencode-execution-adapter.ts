/**
 * OpenCode execution runtime adapter (Phase 2J §74/§75) — the ONLY place that
 * knows the host's handoff API shapes. Runtime audit findings this maps onto
 * (installed @opencode-ai/plugin 1.18.x, verified against the SDK types):
 *
 * 1. SAME-SESSION TURN CREATION (§3/§4 gate): `client.session.promptAsync({
 *    path: { id }, body: { parts, agent?, model? } })` →
 *    `POST /session/{id}/prompt_async`, documented by the host as
 *    `204 "Prompt accepted"`. ONE call binds the execution agent + model +
 *    handoff payload into a single host action (§33 — no separate
 *    switch-model/switch-agent steps to model as substates). The ASYNC
 *    variant is deliberate: `session.prompt` resolves only after the FULL
 *    assistant response, which would conflate handoff delivery with Build
 *    execution (§105 — delivered means the turn is accepted and durably
 *    inserted, NOT that Build finished).
 *
 * 2. RECEIPT / CONFIRMATION (§22/§23): the strongest real host evidence is
 *    the created USER MESSAGE in the session history, obtained through
 *    `client.session.messages({ path: { id } })`. `delivered` is recorded
 *    ONLY after that exact message — carrying the stable
 *    `delivery-key=<key>` marker line (§25) — is OBSERVED in the target
 *    session, together with the host-recorded `agent` and
 *    `model {providerID, modelID}` fields of that message. A 204 alone is
 *    acceptance, not confirmation.
 *
 * 3. RECOVERY (§24 option B / §42/§43): because history is queryable, a
 *    stale `dispatching` record is resolved by searching the session for the
 *    marker: found → delivered (no resend); definitively not found → safe
 *    re-dispatch; query failure → fail-closed ambiguity.
 *
 * Caller-controlled request ids: the prompt body exposes an optional
 * `messageID`, but its server-side acceptance semantics are not documented
 * for 1.18.x — it is deliberately NOT relied on; the stable marker search is
 * the idempotency/confirmation mechanism.
 */
import type { PluginInput } from "@opencode-ai/plugin";

import { HandoffDispatchRejected } from "./types.js";
import type {
  ExecutionHandoffDispatchInput,
  ExecutionRuntimeAdapter,
  HostDeliveryReceipt,
} from "./types.js";

/** Bounded wait for the acceptance call (§104) — ambiguity, never blind retry. */
const DISPATCH_TIMEOUT_MS = 15_000;
/** Bounded wait for the history confirmation of a just-accepted handoff. */
const CONFIRM_TIMEOUT_MS = 10_000;
const CONFIRM_ATTEMPTS = 10;
const CONFIRM_DELAY_MS = 500;

export interface OpenCodeExecutionAdapterOptions {
  /** Bounded dispatch timeout override (tests). */
  dispatchTimeoutMs?: number;
}

export class OpenCodeExecutionAdapter implements ExecutionRuntimeAdapter {
  constructor(
    private readonly client: PluginInput["client"],
    private readonly options: OpenCodeExecutionAdapterOptions = {},
  ) {}

  /** The §25 marker line searched in host history. */
  static markerLine(deliveryKey: string): string {
    return `delivery-key=${deliveryKey}`;
  }

  async dispatchHandoff(input: ExecutionHandoffDispatchInput): Promise<{ accepted: true }> {
    const dispatch = this.client.session.promptAsync({
      path: { id: input.sessionID },
      body: {
        parts: [{ type: "text", text: input.prompt }],
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
      },
    });
    // §104: a timeout after a possibly-sent request is AMBIGUOUS — classified
    // as such by the caller (the error below is distinguished from a definite
    // pre-acceptance rejection only by whether the host may have received it;
    // a timeout inherits that ambiguity).
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("handoff dispatch timed out (ambiguous)")), this.options.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS);
    });
    const result = await Promise.race([dispatch, timeout]);
    if (result.error) {
      // Definite host rejection BEFORE acceptance (4xx/5xx with an error
      // response) — the caller may safely return the delivery to prepared.
      throw new HandoffDispatchRejected(`handoff dispatch rejected: ${JSON.stringify(result.error)}`);
    }
    return { accepted: true };
  }

  async findHandoffDelivery(input: { sessionID: string; deliveryKey: string }): Promise<HostDeliveryReceipt | undefined> {
    const marker = OpenCodeExecutionAdapter.markerLine(input.deliveryKey);
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      const history = await this.client.session.messages({ path: { id: input.sessionID } });
      if (!history.error && history.data) {
        for (const message of history.data) {
          const info = message.info;
          if (info.role !== "user") continue;
          const text = message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n");
          if (text.includes(marker)) {
            return {
              sessionID: info.sessionID,
              messageID: info.id,
              ...(info.agent ? { agent: info.agent } : {}),
              ...(info.model ? { model: { providerID: info.model.providerID, modelID: info.model.modelID } } : {}),
            };
          }
        }
      }
      if (Date.now() + CONFIRM_DELAY_MS > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_DELAY_MS));
    }
    return undefined;
  }
}
