import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe } from "vitest";

import {
  DurablePlanStore,
  InMemoryObservationLedger,
  InMemoryPlanStore,
  UltraPlanController,
  type Evidence,
  type EvidenceID,
} from "../src/index.js";
import type { PlanningRun } from "../src/core/types.js";
import { definePlanStoreContractSuite } from "./parity-suite.js";

function evidenceFixture(id: EvidenceID): Evidence {
  return {
    id,
    revision: 1,
    kind: "file",
    claim: `Claim ${id}`,
    source: [{ type: "file", path: "src/example.ts" }],
    scope: { kind: "run" },
    confidence: "direct",
    criticality: "supporting",
    freshness: "fresh",
    status: "active",
    discoveredAt: "2026-09-24T18:00:00.000Z",
    lastValidatedAt: "2026-09-24T18:00:00.000Z",
  };
}

// The in-memory oracle runs the same contract suite as the durable store.
describe("PlanStore contract — InMemoryPlanStore", () => {
  definePlanStoreContractSuite("in-memory", async () => {
    const store = new InMemoryPlanStore(() => "2026-09-24T18:00:00.000Z");
    const ledger = new InMemoryObservationLedger();
    const controller = new UltraPlanController({ store, ledger, now: () => "2026-09-24T18:00:00.000Z" });
    return {
      store,
      controller,
      seed: async (
        planID: Parameters<InMemoryPlanStore["seedCommittedState"]>[0],
        data?: Parameters<InMemoryPlanStore["seedCommittedState"]>[1],
      ) => {
        store.seedCommittedState(planID, data ?? {});
      },
      evidence: (id: EvidenceID): Evidence => evidenceFixture(id),
      close: async () => {},
    };
  });
});

// The durable store must satisfy the identical contract.
describe("PlanStore contract — DurablePlanStore", () => {
  definePlanStoreContractSuite("durable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultraplan-parity-"));
    const store = new DurablePlanStore(path.join(dir, "plan-store.json"), {
      now: () => "2026-09-24T18:00:00.000Z",
    });
    const ledger = new InMemoryObservationLedger();
    const controller = new UltraPlanController({ store, ledger, now: () => "2026-09-24T18:00:00.000Z" });
    return {
      store,
      controller,
      seed: async (
        planID: Parameters<InMemoryPlanStore["seedCommittedState"]>[0],
        data?: Parameters<InMemoryPlanStore["seedCommittedState"]>[1],
      ) => {
        await store.seedCommittedStateAsync(planID, data ?? {});
      },
      evidence: (id: EvidenceID): Evidence => evidenceFixture(id),
      close: async () => {
        store.close();
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  });
});

void ({} as PlanningRun | undefined);
