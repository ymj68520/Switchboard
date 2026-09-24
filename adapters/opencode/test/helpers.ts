import type { ToolContext } from "@opencode-ai/plugin";

import type { Evidence } from "../src/repository/evidence.js";
import { EvidenceIDs, SectionIDs } from "../src/core/ids.js";
import type { EvidenceID, SectionID } from "../src/core/ids.js";
import type { FinalizationInput } from "../src/core/invariants.js";
import type { Architecture, Section } from "../src/core/types.js";

export function section(init: { id: SectionID } & Partial<Section>): Section {
  return {
    title: `Section ${init.id}`,
    objective: `Design ${init.id}`,
    dependencies: [],
    status: "pending",
    validation: "valid",
    ...init,
  };
}

export function evidence(init: { id: EvidenceID } & Partial<Evidence>): Evidence {
  return {
    revision: 1,
    kind: "file",
    claim: `Claim for ${init.id}`,
    source: [{ type: "file", path: "src/example.ts" }],
    scope: { kind: "run" },
    confidence: "direct",
    criticality: "supporting",
    freshness: "fresh",
    status: "active",
    discoveredAt: "2026-09-24T00:00:00.000Z",
    lastValidatedAt: "2026-09-24T00:00:00.000Z",
    ...init,
  };
}

export function approvedEvidence(id: string): Evidence {
  return evidence({ id: EvidenceIDs.cast(id) });
}

export function approvedArchitecture(): Architecture {
  return {
    id: "ARCH",
    revision: 1,
    status: "approved",
    summary: "Test architecture",
    components: [],
    boundaries: [],
    dataFlows: [],
    principles: [],
    unresolved: [],
    basedOn: [],
  };
}

export function finalizationInput(
  overrides: Partial<FinalizationInput> = {},
): FinalizationInput {
  const approved = section({ id: SectionIDs.from(1), status: "approved" });
  return {
    architecture: approvedArchitecture(),
    sections: [approved],
    openQuestions: [],
    conflicts: [],
    evidence: [],
    ...overrides,
  };
}

/** Minimal ToolContext stub standing in for the OpenCode tool host. */
export function fakeToolContext(sessionID: string): ToolContext {
  const abortController = new AbortController();
  return {
    sessionID,
    messageID: "msg-test",
    agent: "ultraplan",
    directory: ".",
    worktree: ".",
    abort: abortController.signal,
    metadata: () => {},
    ask: async () => {},
  };
}
