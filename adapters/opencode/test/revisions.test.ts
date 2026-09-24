import { describe, expect, it } from "vitest";

import { assertRevisionMonotonic } from "../src/core/invariants.js";
import { EvidenceIDs, SectionIDs } from "../src/core/ids.js";
import type { SectionRevisionRef } from "../src/core/refs.js";
import { InMemoryPlanStore } from "../src/memory/store.js";
import { PlanIDs } from "../src/core/ids.js";
import { evidence } from "./helpers.js";

describe("approved revision immutability", () => {
  it("rejects overwriting an existing artifact revision", async () => {
    const store = new InMemoryPlanStore();
    const planID = PlanIDs.from(1);

    const first = evidence({ id: EvidenceIDs.from(1), claim: "original claim" });
    await store.putEvidence(planID, first);

    const overwrite = evidence({ id: EvidenceIDs.from(1), revision: 1, claim: "rewritten claim" });
    await expect(store.putEvidence(planID, overwrite)).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "duplicate_revision"
      );
    });

    // The original revision is untouched.
    const listed = await store.listEvidence(planID);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.claim).toBe("original claim");
  });

  it("enforces strictly sequential revisions so amendments create new revisions", async () => {
    expect(() => assertRevisionMonotonic(undefined, 0, "evidence EVD-001")).toThrow();
    expect(() => assertRevisionMonotonic(undefined, 1, "evidence EVD-001")).not.toThrow();
    expect(() => assertRevisionMonotonic(1, 1, "evidence EVD-001")).toThrow();
    expect(() => assertRevisionMonotonic(1, 3, "evidence EVD-001")).toThrow();
    expect(() => assertRevisionMonotonic(1, 2, "evidence EVD-001")).not.toThrow();

    const store = new InMemoryPlanStore();
    const planID = PlanIDs.from(1);
    await store.putEvidence(planID, evidence({ id: EvidenceIDs.from(2), revision: 1 }));
    // An amendment lands as the NEXT revision.
    await store.putEvidence(planID, evidence({ id: EvidenceIDs.from(2), revision: 2, claim: "amended" }));

    const listed = await store.listEvidence(planID);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.revision).toBe(2);
    expect(listed[0]?.claim).toBe("amended");
  });
});

describe("exact revision references", () => {
  function takeSectionRevisionRef(ref: SectionRevisionRef): SectionRevisionRef {
    return ref;
  }

  it("requires exact revisions on committed-artifact references at the type level", () => {
    // Positive: FinalPlan-style refs pin exact revisions.
    const sectionRef: SectionRevisionRef = {
      id: SectionIDs.from(3),
      revision: 5,
    };
    expect(sectionRef.revision).toBe(5);
    expect(takeSectionRevisionRef(sectionRef)).toBe(sectionRef);

    // Negative type probe: a committed-artifact reference WITHOUT an exact
    // revision must fail to compile. If `revision` ever becomes optional on
    // SectionRevisionRef, the @ts-expect-error below becomes an unused
    // directive and `npm run typecheck` fails.
    // @ts-expect-error committed-artifact references require an exact revision
    const probe = takeSectionRevisionRef({ id: SectionIDs.from(3) });
    expect(probe.id).toBe("SEC-003");
  });
});
