/**
 * Typed hook input parsers (directive §33): tolerate unknown fields, fail
 * closed on missing correctness-critical fields, cross-check event names.
 */

import { describe, expect, it } from "vitest";

import { HookInputError } from "../src/hooks/parse.js";
import {
  parsePermissionRequestInput,
  parsePreToolUseInput,
  parseSessionEndInput,
  parseSessionStartInput,
  parseUserPromptExpansionInput,
  parseUserPromptSubmitInput,
} from "../src/hooks/parse.js";

const COMMON = {
  session_id: "S1",
  prompt_id: "P1",
  transcript_path: "T",
  cwd: "D:/w",
  permission_mode: "plan",
  hook_event_name: "PreToolUse",
  scratchpad_dir: "X",
  some_future_field: { nested: true },
};

describe("hook input parsers (E39)", () => {
  it("PreToolUse: parses typed fields and tolerates unknown future fields", () => {
    const parsed = parsePreToolUseInput({
      ...COMMON,
      tool_name: "mcp__plugin_phase-plan_phase-plan__start_or_resume",
      tool_input: { goal: "g" },
      tool_use_id: "TU1",
    });
    expect(parsed.sessionId).toBe("S1");
    expect(parsed.promptId).toBe("P1");
    expect(parsed.permissionMode).toBe("plan");
    expect(parsed.toolUseId).toBe("TU1");
    expect(parsed.toolInput).toEqual({ goal: "g" });
    expect(parsed.some_future_field).toEqual({ nested: true });
  });

  it("PreToolUse: missing required fields fail closed", () => {
    expect(() =>
      parsePreToolUseInput({ ...COMMON, tool_name: "Bash", tool_input: {}, tool_use_id: "" }),
    ).toThrowError(HookInputError);
    expect(() => parsePreToolUseInput({ ...COMMON, tool_input: {}, tool_use_id: "T" })).toThrowError(HookInputError);
    expect(() => parsePreToolUseInput({ ...COMMON, tool_name: "Bash", tool_use_id: "T" })).toThrowError(HookInputError);
    expect(() => parsePreToolUseInput({ ...COMMON, tool_name: "Bash", tool_input: "nope", tool_use_id: "T" })).toThrowError(
      HookInputError,
    );
    // missing session_id is correctness-critical
    const { session_id: _drop, ...withoutSession } = COMMON;
    void _drop;
    expect(() => parsePreToolUseInput({ ...withoutSession, tool_name: "Bash", tool_input: {}, tool_use_id: "T" })).toThrowError(
      HookInputError,
    );
  });

  it("event name mismatch between argv and payload fails closed", () => {
    expect(() => parsePreToolUseInput({ ...COMMON, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "T" })).toThrowError(
      HookInputError,
    );
  });

  it("SessionStart: source enum enforced; SessionEnd: reason enum enforced", () => {
    const start = parseSessionStartInput({
      session_id: "S1",
      hook_event_name: "SessionStart",
      source: "resume",
      model: "claude-opus-4",
    });
    expect(start.source).toBe("resume");
    expect(start.model).toBe("claude-opus-4");
    expect(() =>
      parseSessionStartInput({ session_id: "S1", hook_event_name: "SessionStart", source: "resurrected" }),
    ).toThrowError(HookInputError);
    expect(() =>
      parseSessionStartInput({ session_id: "S1", hook_event_name: "SessionStart" }),
    ).toThrowError(HookInputError);

    const end = parseSessionEndInput({ session_id: "S1", hook_event_name: "SessionEnd", reason: "clear" });
    expect(end.reason).toBe("clear");
    expect(() => parseSessionEndInput({ session_id: "S1", hook_event_name: "SessionEnd", reason: "nuclear" })).toThrowError(
      HookInputError,
    );
  });

  it("UserPromptSubmit requires the prompt; expansion requires command_name", () => {
    const submitted = parseUserPromptSubmitInput({
      session_id: "S1",
      prompt_id: "P1",
      permission_mode: "plan",
      hook_event_name: "UserPromptSubmit",
      prompt: "/phase-plan",
    });
    expect(submitted.prompt).toBe("/phase-plan");
    expect(() =>
      parseUserPromptSubmitInput({ session_id: "S1", hook_event_name: "UserPromptSubmit", prompt: "" }),
    ).toThrowError(HookInputError);

    const expansion = parseUserPromptExpansionInput({
      session_id: "S1",
      prompt_id: "P1",
      hook_event_name: "UserPromptExpansion",
      command_name: "phase-plan",
      expansion_type: "slash_command",
      command_source: "user",
    });
    expect(expansion.commandName).toBe("phase-plan");
    expect(expansion.expansionType).toBe("slash_command");
    expect(() =>
      parseUserPromptExpansionInput({ session_id: "S1", hook_event_name: "UserPromptExpansion" }),
    ).toThrowError(HookInputError);
  });

  it("PermissionRequest: tool fields required, tool_use_id tolerated-but-not-required (host docs)", () => {
    const parsed = parsePermissionRequestInput({
      session_id: "S1",
      prompt_id: "P1",
      hook_event_name: "PermissionRequest",
      tool_name: "mcp__phase-plan__start_or_resume",
      tool_input: { goal: "g", _entryIntent: "tok" },
    });
    expect(parsed.toolName).toContain("start_or_resume");
    expect("toolUseId" in parsed).toBe(false);
    expect(() =>
      parsePermissionRequestInput({ session_id: "S1", hook_event_name: "PermissionRequest", tool_input: {} }),
    ).toThrowError(HookInputError);
  });
});
