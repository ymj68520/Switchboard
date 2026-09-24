import { describe, expect, it } from "vitest";

import {
  assertAcyclicSections,
  assertSectionCanComplete,
  collectDownstreamSections,
  propagateNeedsReview,
} from "../src/core/invariants.js";
import { isUltraPlanError } from "../src/core/errors.js";
import { SectionIDs } from "../src/core/ids.js";
import { section } from "./helpers.js";

const SEC = (n: number) => SectionIDs.from(n);

describe("section DAG cycle rejection", () => {
  it("rejects a dependency cycle", () => {
    const sections = [
      section({ id: SEC(1), dependencies: [SEC(2)] }),
      section({ id: SEC(2), dependencies: [SEC(3)] }),
      section({ id: SEC(3), dependencies: [SEC(1)] }),
    ];

    try {
      assertAcyclicSections(sections);
      expect.unreachable("cycle not detected");
    } catch (error) {
      expect(isUltraPlanError(error) && error.code).toBe("section_dependency_cycle");
      expect(isUltraPlanError(error) && error.detail?.cycle).toEqual([
        "SEC-001",
        "SEC-002",
        "SEC-003",
        "SEC-001",
      ]);
    }
  });

  it("rejects a self-dependency", () => {
    const sections = [section({ id: SEC(1), dependencies: [SEC(1)] })];
    expect(() => assertAcyclicSections(sections)).toThrowError(/cycle/i);
  });

  it("accepts a legal DAG", () => {
    const sections = [
      section({ id: SEC(1) }),
      section({ id: SEC(2), dependencies: [SEC(1)] }),
      section({ id: SEC(3), dependencies: [SEC(1)] }),
      section({ id: SEC(4), dependencies: [SEC(2), SEC(3)] }),
    ];
    expect(() => assertAcyclicSections(sections)).not.toThrow();
  });
});

describe("dependency completion rules", () => {
  it("refuses completion while a required dependency is incomplete", () => {
    const sections = [
      section({ id: SEC(1), status: "pending" }),
      section({ id: SEC(2), dependencies: [SEC(1)], status: "awaiting_approval" }),
    ];

    try {
      assertSectionCanComplete(sections, SEC(2));
      expect.unreachable("completion should have been blocked");
    } catch (error) {
      expect(isUltraPlanError(error) && error.code).toBe("dependency_incomplete");
    }
  });

  it("refuses completion when a dependency is missing from the plan entirely", () => {
    const sections = [section({ id: SEC(2), dependencies: [SEC(9)] })];
    expect(() => assertSectionCanComplete(sections, SEC(2))).toThrowError(/dependency_incomplete|SEC-009/);
  });

  it("allows completion once all dependencies are approved", () => {
    const sections = [
      section({ id: SEC(1), status: "approved", approvedRevision: 1 }),
      section({ id: SEC(2), dependencies: [SEC(1)], status: "awaiting_approval" }),
    ];
    expect(() => assertSectionCanComplete(sections, SEC(2))).not.toThrow();
  });

  it("reports unknown sections", () => {
    expect(() => assertSectionCanComplete([], SEC(1))).toThrowError(/not part of the plan/);
  });
});

describe("downstream needs_review propagation", () => {
  it("marks direct AND transitive dependents needs_review after a dependency change", () => {
    // SEC-001 -> SEC-002 -> SEC-003 (chain), SEC-004 independent,
    // SEC-005 depends on SEC-002 (diamond-ish second consumer).
    const sections = [
      section({ id: SEC(1), status: "approved" }),
      section({ id: SEC(2), dependencies: [SEC(1)], status: "approved" }),
      section({ id: SEC(3), dependencies: [SEC(2)], status: "approved" }),
      section({ id: SEC(4), status: "approved" }),
      section({ id: SEC(5), dependencies: [SEC(2)], status: "approved" }),
    ];

    const downstream = collectDownstreamSections(sections, [SEC(1)]);
    expect(downstream).toEqual([SEC(2), SEC(3), SEC(5)]);

    const updated = propagateNeedsReview(sections, [SEC(1)]);
    const byId = new Map(updated.map((s) => [s.id, s]));
    expect(byId.get(SEC(1))?.validation).toBe("valid"); // changed section itself untouched
    expect(byId.get(SEC(2))?.validation).toBe("needs_review");
    expect(byId.get(SEC(3))?.validation).toBe("needs_review");
    expect(byId.get(SEC(5))?.validation).toBe("needs_review");
    expect(byId.get(SEC(4))?.validation).toBe("valid");

    // Dependents are never deleted; status is untouched (reopen is explicit).
    expect(byId.get(SEC(2))?.status).toBe("approved");
  });
});
