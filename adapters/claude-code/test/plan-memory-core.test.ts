import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/core/canonical-json.js";
import { isMemoryArtifactKind, MEMORY_ARTIFACT_KINDS, parseEmbeddedMemoryRefs, sortMemoryRefs } from "../src/core/memory-refs.js";
import {
  parseMemoryRevisionContent,
  requiresContractProjection,
} from "../src/core/memory-artifacts.js";
import { validateSectionDag } from "../src/core/section-dag.js";

describe("memory artifact vocabulary (E5–E11)", () => {
  it("pins the six frozen committed-memory kinds", () => {
    expect([...MEMORY_ARTIFACT_KINDS].sort()).toEqual(
      ["architecture", "conflict", "constraint", "decision", "open_question", "section"].sort(),
    );
  });

  it("excludes non-memory domains from the kind set", () => {
    for (const notAKind of ["proposal", "evidence", "final_plan", "observation", "plan_commit"]) {
      expect(isMemoryArtifactKind(notAKind)).toBe(false);
    }
  });

  it("only sections carry contract projections", () => {
    for (const kind of MEMORY_ARTIFACT_KINDS) {
      expect(requiresContractProjection(kind), kind).toBe(kind === "section");
    }
  });
});

describe("canonicalJson (§23)", () => {
  it("serializes the same structure deterministically regardless of key order", () => {
    const a = { b: 1, a: { z: [1, 2], y: "x" } };
    const b = { a: { y: "x", z: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"y":"x","z":[1,2]},"b":1}');
  });

  it("round-trips through JSON.parse without loss", () => {
    const value = { k: ["x", "y"], n: 3, flag: true, nested: { s: "v" } };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });
});

const RUN = "plan_run-1";

describe("MemoryRef handling (E18/E32)", () => {
  it("parses well-formed same-run refs", () => {
    const refs = parseEmbeddedMemoryRefs(
      [{ runId: RUN, kind: "decision", id: "DEC-001", revision: 2 }],
      RUN,
    );
    expect(refs).toEqual([{ runId: RUN, kind: "decision", id: "DEC-001", revision: 2 }]);
  });

  it("rejects cross-run embedded refs", () => {
    expect(() =>
      parseEmbeddedMemoryRefs([{ runId: "plan_other", kind: "decision", id: "DEC-001", revision: 1 }], RUN),
    ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }));
  });

  it("rejects malformed refs", () => {
    for (const bad of [
      { kind: "decision", id: "DEC-001", revision: 1 },
      { runId: RUN, kind: "proposal", id: "P-1", revision: 1 },
      { runId: RUN, kind: "decision", id: "DEC-001", revision: 0 },
    ]) {
      expect(() => parseEmbeddedMemoryRefs([bad], RUN)).toThrowError(
        expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }),
      );
    }
  });

  it("sorts refs canonically by kind, id, revision (§62)", () => {
    const sorted = sortMemoryRefs([
      { runId: RUN, kind: "section", id: "SEC-B", revision: 1 },
      { runId: RUN, kind: "decision", id: "DEC-2", revision: 1 },
      { runId: RUN, kind: "decision", id: "DEC-1", revision: 3 },
      { runId: RUN, kind: "decision", id: "DEC-1", revision: 1 },
    ]);
    expect(sorted.map((r) => `${r.kind}:${r.id}@${r.revision}`)).toEqual([
      "decision:DEC-1@1",
      "decision:DEC-1@3",
      "decision:DEC-2@1",
      "section:SEC-B@1",
    ]);
  });
});

describe("kind-specific content parsers (E12/§12–§22)", () => {
  it("parses a valid constraint", () => {
    const content = parseMemoryRevisionContent(
      "constraint",
      { source: "user", statement: "No network at runtime", severity: "hard", status: "active" },
      RUN,
      "CON-1",
      1,
    );
    expect(content).toMatchObject({ severity: "hard", status: "active" });
  });

  it("rejects invalid constraint severity", () => {
    expect(() =>
      parseMemoryRevisionContent(
        "constraint",
        { source: "user", statement: "x", severity: "medium", status: "active" },
        RUN,
        "CON-1",
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }));
  });

  it("parses a decision with same-run supporting refs and supersedes", () => {
    const content = parseMemoryRevisionContent(
      "decision",
      {
        title: "Use SQLite WAL",
        statement: "Use WAL",
        rationale: "concurrency",
        alternatives: ["lock files"],
        consequences: [" readers never block"],
        scope: "storage",
        supportingRefs: [{ runId: RUN, kind: "constraint", id: "CON-1", revision: 1 }],
        supersedes: { runId: RUN, kind: "decision", id: "DEC-1", revision: 1 },
      },
      RUN,
      "DEC-1",
      2,
    );
    expect((content as { supersedes?: unknown }).supersedes).toEqual({ runId: RUN, kind: "decision", id: "DEC-1", revision: 1 });
  });

  it("rejects cross-run supersedes (§13)", () => {
    expect(() =>
      parseMemoryRevisionContent(
        "decision",
        {
          title: "t", statement: "s", rationale: "r", alternatives: [], consequences: [], scope: "x",
          supportingRefs: [],
          supersedes: { runId: "plan_other", kind: "decision", id: "DEC-1", revision: 1 },
        },
        RUN,
        "DEC-1",
        2,
      ),
    ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }));
  });

  it("binds the section contract to the exact section id and revision (§17)", () => {
    const valid = {
      title: "t", objective: "o", design: "d", interfaces: [], invariants: [], failureModes: [],
      dependencies: [],
      decisionRefs: [], openQuestionRefs: [], impactRefs: [],
      contract: {
        sectionId: "SEC-1", revision: 4, provides: ["p"], requires: [], invariants: [], interfaces: [], decisions: [],
      },
    };
    const content = parseMemoryRevisionContent("section", valid, RUN, "SEC-1", 4);
    expect((content as { contract: { provides: string[] } }).contract.provides).toEqual(["p"]);

    const mismatched = { ...valid, contract: { ...valid.contract, revision: 3 } };
    expect(() => parseMemoryRevisionContent("section", mismatched, RUN, "SEC-1", 4)).toThrowError(
      expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }),
    );
  });

  it("rejects open questions resolved without a resolution (§20)", () => {
    expect(() =>
      parseMemoryRevisionContent(
        "open_question",
        { question: "q?", blocking: true, scope: "run", status: "resolved" },
        RUN,
        "Q-1",
        2,
      ),
    ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }));
    const resolved = parseMemoryRevisionContent(
      "open_question",
      {
        question: "q?", blocking: false, scope: "run", status: "resolved",
        resolution: "decided", resolvedBy: { runId: RUN, kind: "decision", id: "DEC-1", revision: 1 },
      },
      RUN,
      "Q-1",
      2,
    );
    expect((resolved as { resolvedBy?: unknown }).resolvedBy).toEqual({ runId: RUN, kind: "decision", id: "DEC-1", revision: 1 });
  });

  it("rejects conflicts with cross-run refs (§21)", () => {
    expect(() =>
      parseMemoryRevisionContent(
        "conflict",
        {
          type: "contradiction", description: "d", severity: "hard", status: "open",
          refs: [{ runId: "plan_other", kind: "decision", id: "DEC-1", revision: 1 }],
        },
        RUN,
        "CONF-1",
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }));
  });
});

describe("section DAG validation (E16/§26/§77)", () => {
  it("accepts empty, single, linear, and diamond DAGs", () => {
    expect(validateSectionDag([]).valid).toBe(true);
    expect(validateSectionDag([{ sectionId: "SEC-1", dependencies: [] }]).valid).toBe(true);
    expect(
      validateSectionDag([
        { sectionId: "SEC-1", dependencies: [] },
        { sectionId: "SEC-2", dependencies: ["SEC-1"] },
      ]).valid,
    ).toBe(true);
    expect(
      validateSectionDag([
        { sectionId: "SEC-1", dependencies: [] },
        { sectionId: "SEC-2", dependencies: ["SEC-1"] },
        { sectionId: "SEC-3", dependencies: ["SEC-1"] },
        { sectionId: "SEC-4", dependencies: ["SEC-2", "SEC-3"] },
      ]).valid,
    ).toBe(true);
  });

  it("rejects self cycles, two-node cycles, and deep cycles with SECTION_DAG_INVALID codes", () => {
    expect(validateSectionDag([{ sectionId: "SEC-1", dependencies: ["SEC-1"] }]).valid).toBe(false);
    const twoCycle = validateSectionDag([
      { sectionId: "SEC-1", dependencies: ["SEC-2"] },
      { sectionId: "SEC-2", dependencies: ["SEC-1"] },
    ]);
    expect(twoCycle.valid).toBe(false);
    expect(twoCycle.cyclePath).toBeDefined();
    const deep = validateSectionDag([
      { sectionId: "SEC-1", dependencies: ["SEC-3"] },
      { sectionId: "SEC-2", dependencies: ["SEC-1"] },
      { sectionId: "SEC-3", dependencies: ["SEC-2"] },
    ]);
    expect(deep.valid).toBe(false);
    expect(deep.cyclePath).toBeDefined();
  });

  it("rejects missing dependencies and duplicate edges", () => {
    const missing = validateSectionDag([{ sectionId: "SEC-1", dependencies: ["SEC-GHOST"] }]);
    expect(missing.valid).toBe(false);
    expect(missing.problems.join(" ")).toContain("missing section");
    const duplicated = validateSectionDag([
      { sectionId: "SEC-1", dependencies: [] },
      { sectionId: "SEC-2", dependencies: ["SEC-1", "SEC-1"] },
    ]);
    expect(duplicated.valid).toBe(false);
    expect(duplicated.problems.join(" ")).toContain("duplicate dependency");
  });
});
