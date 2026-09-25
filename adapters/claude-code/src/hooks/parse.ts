/**
 * Typed hook input parsers (Phase 7 directive §33).
 *
 * Hook stdin is never trusted blindly (`JSON.parse(stdin) as SomeInput` is
 * forbidden). Every event has a parser that:
 *   - tolerates unknown/additional future fields (host evolves forward);
 *   - fails closed on missing correctness-critical fields.
 *
 * Parsers throw RuntimeError("HOOK_INPUT_INVALID", …). The hook runtime maps
 * that to the event-appropriate fail-closed behavior (see run.ts).
 */

import { RuntimeError } from "../runtime/errors.js";

export type HookParseIssue = { field: string; problem: string };

export class HookInputError extends RuntimeError {
  readonly issues: HookParseIssue[];
  constructor(issues: HookParseIssue[]) {
    super(
      "HOOK_INPUT_INVALID",
      `hook input rejected: ${issues.map((i) => `${i.field} ${i.problem}`).join("; ")}`,
      { cause: "hook parsers fail closed on missing correctness-critical fields (directive §33)" },
    );
    this.name = "HookInputError";
    this.issues = issues;
  }
}

export interface HookCommonInput {
  sessionId: string;
  promptId?: string;
  transcriptPath?: string;
  cwd?: string;
  permissionMode?: string;
  hookEventName: string;
  /** Unknown future fields are tolerated, never stripped from authority decisions. */
  [key: string]: unknown;
}

export type SessionStartSource = "startup" | "resume" | "clear" | "compact" | "fork";

export interface SessionStartInput extends HookCommonInput {
  source: SessionStartSource;
  model?: string;
}

export type SessionEndReason = "clear" | "resume" | "logout" | "prompt_input_exit" | "other";

export interface SessionEndInput extends HookCommonInput {
  reason: SessionEndReason;
}

export interface UserPromptSubmitInput extends HookCommonInput {
  prompt: string;
}

export interface UserPromptExpansionInput extends HookCommonInput {
  commandName: string;
  expansionType?: string;
  commandArgs?: string;
  commandSource?: string;
  prompt?: string;
}

export interface PreToolUseInput extends HookCommonInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}

export interface PermissionRequestInput extends HookCommonInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  // NOTE: PermissionRequest carries no tool_use_id (host docs) — authority
  // binding across this event relies on the signed tokens inside tool_input.
}

type RawRecord = Record<string, unknown>;

function asRecord(raw: unknown): RawRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HookInputError([{ field: "(root)", problem: "is not a JSON object" }]);
  }
  return raw as RawRecord;
}

function requireString(record: RawRecord, key: string, issues: HookParseIssue[]): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    issues.push({ field: key, problem: "is required and must be a non-empty string" });
    return "";
  }
  return value;
}

function optionalString(record: RawRecord, key: string, issues: HookParseIssue[]): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push({ field: key, problem: "must be a string when present" });
    return undefined;
  }
  return value;
}

function requireEnum<T extends string>(
  record: RawRecord,
  key: string,
  allowed: readonly T[],
  issues: HookParseIssue[],
): T {
  const value = record[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.push({ field: key, problem: `is required and must be one of: ${allowed.join(", ")}` });
    return allowed[0]!;
  }
  return value as T;
}

function parseCommon(record: RawRecord, expectedEvent: string, issues: HookParseIssue[]): HookCommonInput {
  const eventName = requireString(record, "hook_event_name", issues);
  if (issues.length === 0 && eventName !== expectedEvent) {
    throw new HookInputError([
      { field: "hook_event_name", problem: `'${eventName}' does not match the invoked event '${expectedEvent}'` },
    ]);
  }
  return {
    sessionId: requireString(record, "session_id", issues),
    ...(() => {
      const promptId = optionalString(record, "prompt_id", issues);
      return promptId === undefined ? {} : { promptId };
    })(),
    ...(() => {
      const transcriptPath = optionalString(record, "transcript_path", issues);
      return transcriptPath === undefined ? {} : { transcriptPath };
    })(),
    ...(() => {
      const cwd = optionalString(record, "cwd", issues);
      return cwd === undefined ? {} : { cwd };
    })(),
    ...(() => {
      const permissionMode = optionalString(record, "permission_mode", issues);
      return permissionMode === undefined ? {} : { permissionMode };
    })(),
    hookEventName: eventName,
    ...record,
  };
}

function finish(issues: HookParseIssue[]): void {
  if (issues.length > 0) throw new HookInputError(issues);
}

export const SESSION_START_SOURCES: readonly SessionStartSource[] = ["startup", "resume", "clear", "compact", "fork"];
export const SESSION_END_REASONS: readonly SessionEndReason[] = ["clear", "resume", "logout", "prompt_input_exit", "other"];

export function parseHookCommonInput(raw: unknown, expectedEvent: string): HookCommonInput {
  const record = asRecord(raw);
  const issues: HookParseIssue[] = [];
  const common = parseCommon(record, expectedEvent, issues);
  finish(issues);
  return common;
}

export function parseSessionStartInput(raw: unknown, expectedEvent = "SessionStart"): SessionStartInput {
  const record = asRecord(raw);
  const issues: HookParseIssue[] = [];
  const common = parseCommon(record, expectedEvent, issues);
  const source = requireEnum(record, "source", SESSION_START_SOURCES, issues);
  const model = optionalString(record, "model", issues);
  finish(issues);
  return { ...common, source, ...(model === undefined ? {} : { model }) };
}

export function parseSessionEndInput(raw: unknown, expectedEvent = "SessionEnd"): SessionEndInput {
  const record = asRecord(raw);
  const issues: HookParseIssue[] = [];
  const common = parseCommon(record, expectedEvent, issues);
  const reason = requireEnum(record, "reason", SESSION_END_REASONS, issues);
  finish(issues);
  return { ...common, reason };
}

export function parseUserPromptSubmitInput(raw: unknown, expectedEvent = "UserPromptSubmit"): UserPromptSubmitInput {
  const record = asRecord(raw);
  const issues: HookParseIssue[] = [];
  const common = parseCommon(record, expectedEvent, issues);
  const prompt = requireString(record, "prompt", issues);
  finish(issues);
  return { ...common, prompt };
}

export function parseUserPromptExpansionInput(raw: unknown, expectedEvent = "UserPromptExpansion"): UserPromptExpansionInput {
  const record = asRecord(raw);
  const issues: HookParseIssue[] = [];
  const common = parseCommon(record, expectedEvent, issues);
  const commandName = requireString(record, "command_name", issues);
  const expansionType = optionalString(record, "expansion_type", issues);
  const commandArgs = optionalString(record, "command_args", issues);
  const commandSource = optionalString(record, "command_source", issues);
  const prompt = optionalString(record, "prompt", issues);
  finish(issues);
  return {
    ...common,
    commandName,
    ...(expansionType === undefined ? {} : { expansionType }),
    ...(commandArgs === undefined ? {} : { commandArgs }),
    ...(commandSource === undefined ? {} : { commandSource }),
    ...(prompt === undefined ? {} : { prompt }),
  };
}

function parseToolEvent(raw: unknown, expectedEvent: string): { common: HookCommonInput; toolName: string; toolInput: Record<string, unknown> } {
  const record = asRecord(raw);
  const issues: HookParseIssue[] = [];
  const common = parseCommon(record, expectedEvent, issues);
  const toolName = requireString(record, "tool_name", issues);
  let toolInput: Record<string, unknown>;
  const rawToolInput = record.tool_input;
  if (typeof rawToolInput !== "object" || rawToolInput === null || Array.isArray(rawToolInput)) {
    issues.push({ field: "tool_input", problem: "is required and must be an object" });
    toolInput = {};
  } else {
    toolInput = rawToolInput as Record<string, unknown>;
  }
  finish(issues);
  return { common, toolName, toolInput };
}

export function parsePreToolUseInput(raw: unknown, expectedEvent = "PreToolUse"): PreToolUseInput {
  const { common, toolName, toolInput } = parseToolEvent(raw, expectedEvent);
  const issues: HookParseIssue[] = [];
  const toolUseId = requireString(common as unknown as RawRecord, "tool_use_id", issues);
  finish(issues);
  return { ...common, toolName, toolInput, toolUseId };
}

export function parsePermissionRequestInput(raw: unknown, expectedEvent = "PermissionRequest"): PermissionRequestInput {
  const { common, toolName, toolInput } = parseToolEvent(raw, expectedEvent);
  return { ...common, toolName, toolInput };
}
