import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyPluginEnvironment,
  nodePluginDataIo,
  PHASE_PLAN_DATA_SUBDIRS,
  PHASE_PLAN_ENV_SPEC,
  preflightPluginData,
  type PluginDataIo,
} from "../src/claude/environment.js";
import { makeTempDir, removeTempDir } from "./helpers.js";

describe("plugin environment classification", () => {
  it("classifies the frozen variable set", () => {
    expect(Object.keys(PHASE_PLAN_ENV_SPEC).sort()).toEqual(
      [
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_PLUGIN_DATA",
        "CLAUDE_PLUGIN_ROOT",
        "CLAUDE_PROJECT_DIR",
      ].sort(),
    );
    expect(PHASE_PLAN_ENV_SPEC.CLAUDE_PLUGIN_DATA?.classification).toBe("plugin_runtime");
    expect(PHASE_PLAN_ENV_SPEC.CLAUDE_PLUGIN_ROOT?.classification).toBe("plugin_runtime");
    expect(PHASE_PLAN_ENV_SPEC.CLAUDE_PROJECT_DIR?.classification).toBe("host_session");
    expect(PHASE_PLAN_ENV_SPEC.CLAUDE_CODE_SESSION_ID?.classification).toBe("host_session");
  });

  it("reports NOT_ACTIVE — never failure — outside a plugin session", () => {
    const report = classifyPluginEnvironment({});
    expect(report.status).toBe("NOT_ACTIVE");
    expect(report.variables.every((v) => !v.present)).toBe(true);
  });

  it("reports ACTIVE when a plugin_runtime variable is present", () => {
    const report = classifyPluginEnvironment({
      CLAUDE_PLUGIN_ROOT: "D:/plugins/phase-plan",
      CLAUDE_PROJECT_DIR: "D:/work/some-repo",
    });
    expect(report.status).toBe("ACTIVE");
    const byName = Object.fromEntries(report.variables.map((v) => [v.name, v]));
    expect(byName.CLAUDE_PLUGIN_ROOT?.present).toBe(true);
    expect(byName.CLAUDE_PLUGIN_DATA?.present).toBe(false);
    expect(byName.CLAUDE_PROJECT_DIR?.present).toBe(true);
  });

  it("treats blank values as absent (missing env vars)", () => {
    const report = classifyPluginEnvironment({
      CLAUDE_PLUGIN_DATA: "   ",
      CLAUDE_CODE_SESSION_ID: "",
    });
    expect(report.status).toBe("NOT_ACTIVE");
    expect(report.variables.every((v) => !v.present)).toBe(true);
  });
});

describe("plugin data preflight (real fs)", () => {
  it("creates the frozen layout for a missing root and leaves no probe", async () => {
    const root = path.join(await makeTempDir("phase-plan-pf-"), "data root with spaces", "üñí 目录");
    try {
      const result = await preflightPluginData(root);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.createdRoot).toBe(true);
        expect(result.createdDirs).toEqual([...PHASE_PLAN_DATA_SUBDIRS]);
        expect(result.resolvedRoot).toBe(path.resolve(root));
      }
      const entries = await fs.readdir(root);
      expect(entries.sort()).toEqual([...PHASE_PLAN_DATA_SUBDIRS].sort());
      const storeEntries = await fs.readdir(path.join(root, "store"));
      expect(storeEntries).toEqual([]);
    } finally {
      await removeTempDir(root);
    }
  });

  it("is idempotent for an existing root", async () => {
    // mkdtemp already created the root, so createdRoot is false on both runs;
    // the frozen layout subdirs are created once.
    const root = await makeTempDir("phase-plan-pf-existing-");
    try {
      const first = await preflightPluginData(root);
      const second = await preflightPluginData(root);
      expect(first.status).toBe("ok");
      expect(second.status).toBe("ok");
      if (first.status === "ok" && second.status === "ok") {
        expect(first.createdRoot).toBe(false);
        expect(first.createdDirs).toEqual([...PHASE_PLAN_DATA_SUBDIRS]);
        expect(second.createdRoot).toBe(false);
        expect(second.createdDirs).toEqual([]);
      }
      const leftovers = (await fs.readdir(root)).filter((n) => n.includes("write-probe"));
      expect(leftovers).toEqual([]);
    } finally {
      await removeTempDir(root);
    }
  });

  it("rejects a path occupied by a file (unavailable)", async () => {
    const dir = await makeTempDir("phase-plan-pf-file-");
    const occupied = path.join(dir, "occupied");
    await fs.writeFile(occupied, "not a directory");
    try {
      const result = await preflightPluginData(occupied);
      expect(result).toMatchObject({ status: "unavailable", errorCode: "PLUGIN_DATA_UNAVAILABLE" });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("rejects an empty value (unavailable)", async () => {
    const result = await preflightPluginData("   ");
    expect(result).toMatchObject({ status: "unavailable", errorCode: "PLUGIN_DATA_UNAVAILABLE" });
  });
});

describe("plugin data preflight (injected io failure paths)", () => {
  it("maps write failures to PLUGIN_DATA_NOT_WRITABLE", async () => {
    const failingWrite: PluginDataIo = {
      ...nodePluginDataIo,
      writeFile: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const root = await makeTempDir("phase-plan-pf-ro-");
    try {
      const result = await preflightPluginData(root, failingWrite);
      expect(result).toMatchObject({
        status: "not_writable",
        errorCode: "PLUGIN_DATA_NOT_WRITABLE",
      });
    } finally {
      await removeTempDir(root);
    }
  });

  it("maps mkdir failures to PLUGIN_DATA_UNAVAILABLE", async () => {
    const failingMkdir: PluginDataIo = {
      ...nodePluginDataIo,
      mkdir: async () => {
        throw new Error("EACCES: cannot create directory");
      },
    };
    const root = path.join(await makeTempDir("phase-plan-pf-md-"), "nested", "deep");
    const result = await preflightPluginData(root, failingMkdir);
    expect(result).toMatchObject({ status: "unavailable", errorCode: "PLUGIN_DATA_UNAVAILABLE" });
  });

  it("flags leftover probes as not writable", async () => {
    const leakyUnlink: PluginDataIo = {
      ...nodePluginDataIo,
      unlink: async () => {
        throw new Error("EBUSY");
      },
    };
    const root = await makeTempDir("phase-plan-pf-leak-");
    try {
      const result = await preflightPluginData(root, leakyUnlink);
      expect(result).toMatchObject({ status: "not_writable", errorCode: "PLUGIN_DATA_NOT_WRITABLE" });
    } finally {
      await removeTempDir(root);
    }
  });
});
