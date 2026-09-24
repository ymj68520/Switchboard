import { describe, expect, it } from "vitest";

import {
  claudeCandidates,
  nodeSpawnRunner,
  parseClaudeVersion,
  probeClaudeVersion,
} from "../src/claude/version.js";
import { claudeVersionOutcome, fakeSpawnRunner } from "./helpers.js";

describe("parseClaudeVersion", () => {
  it("extracts a semver from plausible CLI outputs", () => {
    expect(parseClaudeVersion("Claude Code 2.1.276")).toBe("2.1.276");
    expect(parseClaudeVersion("2.0.14 (Claude Code)")).toBe("2.0.14");
    expect(parseClaudeVersion("claude/1.0.98 linux-x64 node-v24.21.0")).toBe("1.0.98");
    expect(parseClaudeVersion("2.1.0-beta.3")).toBe("2.1.0-beta.3");
  });

  it("returns null for malformed output", () => {
    expect(parseClaudeVersion("")).toBeNull();
    expect(parseClaudeVersion("claude ready")).toBeNull();
    expect(parseClaudeVersion("version")).toBeNull();
  });
});

describe("claudeCandidates", () => {
  it("uses the explicit override when provided", () => {
    expect(
      claudeCandidates({ PHASE_PLAN_CLAUDE_BIN: "/opt/tools/my claude" }, "linux"),
    ).toEqual([{ file: "/opt/tools/my claude", viaCmdShim: false }]);
  });

  it("adds the Windows npm shim candidate", () => {
    const win = claudeCandidates({}, "win32");
    expect(win.map((c) => c.file)).toEqual(["claude", "claude.cmd"]);
    expect(win[1]?.viaCmdShim).toBe(true);
    expect(claudeCandidates({}, "darwin").map((c) => c.file)).toEqual(["claude"]);
  });
});

describe("probeClaudeVersion (injected runners)", () => {
  it("reports ok with parsed version and binary path", async () => {
    const result = await probeClaudeVersion(
      fakeSpawnRunner({ claude: claudeVersionOutcome("2.1.276") }),
    );
    expect(result).toMatchObject({ status: "ok", version: "2.1.276", binPath: "claude" });
  });

  it("falls back to the Windows .cmd shim when the bare name misses", async () => {
    const result = await probeClaudeVersion(
      fakeSpawnRunner({
        // Node launches .cmd shims through cmd.exe with a fixed argv.
        "cmd.exe": (_file, args) =>
          args.includes("claude.cmd")
            ? claudeVersionOutcome("2.0.14")
            : { kind: "spawn_error", errorCode: "ENOENT" },
      }),
      { platform: "win32" },
    );
    expect(result).toMatchObject({ status: "ok", version: "2.0.14", binPath: "claude.cmd" });
  });

  it("reports not_found after all ENOENT attempts", async () => {
    const platform: NodeJS.Platform = process.platform;
    const result = await probeClaudeVersion(fakeSpawnRunner({}), { platform });
    const expectedAttempted = platform === "win32" ? ["claude", "claude.cmd"] : ["claude"];
    expect(result).toEqual({ status: "not_found", attempted: expectedAttempted });
  });

  it("maps nonzero exit codes to unreadable (fail-closed)", async () => {
    const result = await probeClaudeVersion(
      fakeSpawnRunner({
        claude: { kind: "exit", exitCode: 7, stdout: "", stderr: "boom" },
      }),
    );
    expect(result).toMatchObject({ status: "unreadable", exitCode: 7 });
  });

  it("maps unparseable output to unreadable", async () => {
    const result = await probeClaudeVersion(
      fakeSpawnRunner({
        claude: { kind: "exit", exitCode: 0, stdout: "gibberish 42", stderr: "" },
      }),
    );
    expect(result).toMatchObject({ status: "unreadable" });
  });

  it("maps timeouts to unreadable and stops probing", async () => {
    const result = await probeClaudeVersion(
      fakeSpawnRunner({
        claude: { kind: "timeout" },
        "claude.cmd": claudeVersionOutcome("2.0.0"),
      }),
      { platform: "win32" },
    );
    expect(result).toMatchObject({ status: "unreadable", reason: expect.stringContaining("timed out") });
  });

  it("override failures are reported as-is (no silent fallback)", async () => {
    const result = await probeClaudeVersion(fakeSpawnRunner({}), {
      env: { PHASE_PLAN_CLAUDE_BIN: "D:/Program Files with spaces/claude.exe" },
    });
    expect(result).toEqual({
      status: "not_found",
      attempted: ["D:/Program Files with spaces/claude.exe"],
    });
  });

  it("supports Unicode and spaces in override paths", async () => {
    const weird = "D:/路径 with spaces/claïde";
    const result = await probeClaudeVersion(
      fakeSpawnRunner({ [weird]: claudeVersionOutcome("2.1.0") }),
      { env: { PHASE_PLAN_CLAUDE_BIN: weird } },
    );
    expect(result).toMatchObject({ status: "ok", version: "2.1.0", binPath: weird });
  });
});

describe("nodeSpawnRunner (real process API shape)", () => {
  it("executes a real node child without a shell", async () => {
    const outcome = await nodeSpawnRunner(process.execPath, ["-e", "process.stdout.write('ok 1.2.3')"], {
      timeoutMs: 5000,
    });
    expect(outcome.kind).toBe("exit");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("ok 1.2.3");
  });

  it("surfaces spawn errors for missing executables", async () => {
    const missing = process.platform === "win32" ? "definitely-not-installed-claude.exe" : "definitely-not-installed-claude";
    const outcome = await nodeSpawnRunner(missing, ["--version"], { timeoutMs: 5000 });
    expect(outcome).toMatchObject({ kind: "spawn_error", errorCode: "ENOENT" });
  });
});
