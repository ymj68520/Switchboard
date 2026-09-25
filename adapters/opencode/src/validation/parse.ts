/**
 * STRICT validator output parsing (Phase 2G brief §17/§67).
 *
 * The validator's raw text is never trusted as prose and never recovered from
 * surrounding garbage: the ENTIRE output must be exactly one strict JSON
 * document matching the closed wire schema. Rejected, with the single
 * deterministic code `validation_output_invalid`:
 *
 *   markdown fences, leading/trailing commentary, embedded JSON, duplicate
 *   keys (a hand-rolled parser — JSON.parse silently keeps the last), unknown
 *   fields, NaN/Infinity (not valid JSON), wrong enums, wrong field types,
 *   empty required strings, malformed refs.
 *
 * An execution whose output fails this parsing is an EXECUTION FAILURE (brief
 * §26): no report exists, nothing is persisted, retry is allowed. It is never
 * converted into a findings report.
 */
import { UltraPlanError } from "../core/errors.js";
import type { ConflictID, DecisionID, EvidenceID, QuestionID, SectionID, ConstraintID } from "../core/ids.js";
import type { SynthesisSourceRef } from "../synthesis/types.js";
import {
  SEMANTIC_FINDING_CATEGORIES,
  type ManifestItemRef,
  type SemanticFindingScope,
  type ValidationReportDraft,
  type ValidatorFindingDraft,
} from "./types.js";

export function invalidOutput(reason: string, detail?: Record<string, unknown>): UltraPlanError {
  return new UltraPlanError("validation_output_invalid", `Semantic validator output rejected: ${reason}`, detail);
}

// ---------------------------------------------------------------------------
// Strict JSON: exactly one value, duplicate keys rejected
// ---------------------------------------------------------------------------

/**
 * Recursive-descent JSON parser that behaves like JSON.parse EXCEPT it rejects
 * duplicate object keys and trailing garbage. Numbers follow JSON grammar only
 * (no NaN/Infinity — those are not valid JSON and are rejected here).
 */
function parseStrictJSON(text: string): unknown {
  let pos = 0;
  const peek = (): string => text[pos] ?? "";
  const fail = (why: string): never => {
    throw invalidOutput(`${why} at offset ${pos}`);
  };
  const skipWhitespace = (): void => {
    while (pos < text.length && /\s/.test(peek())) pos++;
  };
  const expect = (char: string): void => {
    if (peek() !== char) fail(`expected "${char}"`);
    pos++;
  };

  const parseValue = (): unknown => {
    skipWhitespace();
    const char = peek();
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === '"') return parseString();
    if (char === "-" || (char >= "0" && char <= "9")) return parseNumber();
    if (text.startsWith("true", pos)) { pos += 4; return true; }
    if (text.startsWith("false", pos)) { pos += 5; return false; }
    if (text.startsWith("null", pos)) { pos += 4; return null; }
    return fail("unexpected token");
  };

  const parseObject = (): Record<string, unknown> => {
    expect("{");
    const record: Record<string, unknown> = {};
    skipWhitespace();
    if (peek() === "}") { pos++; return record; }
    for (;;) {
      skipWhitespace();
      const key = parseString();
      skipWhitespace();
      expect(":");
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        throw invalidOutput(`duplicate object key "${key}"`, { key });
      }
      record[key] = parseValue();
      skipWhitespace();
      if (peek() === ",") { pos++; continue; }
      if (peek() === "}") { pos++; return record; }
      fail(`expected "," or "}" in object`);
    }
  };

  const parseArray = (): unknown[] => {
    expect("[");
    const values: unknown[] = [];
    skipWhitespace();
    if (peek() === "]") { pos++; return values; }
    for (;;) {
      values.push(parseValue());
      skipWhitespace();
      if (peek() === ",") { pos++; continue; }
      if (peek() === "]") { pos++; return values; }
      fail(`expected "," or "]" in array`);
    }
  };

  const parseString = (): string => {
    expect('"');
    let value = "";
    for (;;) {
      if (pos >= text.length) fail("unterminated string");
      const char: string = text[pos] ?? "";
      if (char === '"') { pos++; return value; }
      if (char === "\\") {
        pos++;
        const escape: string = text[pos] ?? "";
        if (text[pos] === undefined) fail("unterminated escape");
        if (escape === "u") {
          const hex = text.slice(pos + 1, pos + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid unicode escape");
          value += String.fromCharCode(Number.parseInt(hex, 16));
          pos += 5;
          continue;
        }
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        const mapped: string | undefined = simple[escape];
        if (mapped === undefined) fail(`invalid escape "\\${escape}"`);
        value += mapped;
        pos++;
        continue;
      }
      if (char < " ") fail("unescaped control character in string");
      value += char;
      pos++;
    }
  };

  const parseNumber = (): number => {
    const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(pos));
    const raw = match?.[0];
    if (!match || raw === undefined || raw.length === 0) {
      throw invalidOutput(`invalid number at offset ${pos}`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) fail("number out of range");
    pos += raw.length;
    return value;
  };

  const value = parseValue();
  skipWhitespace();
  if (pos !== text.length) fail("trailing content after the JSON document");
  return value;
}

// ---------------------------------------------------------------------------
// Closed wire-shape validation
// ---------------------------------------------------------------------------

const WIRE_SOURCE_KINDS = ["architecture", "section", "decision", "constraint", "question", "conflict", "evidence"] as const;

/** Minimal branding shims for transport-shape parsing (resolution happens later). */
const SectionIDBrand = (raw: string): SectionID => raw as SectionID;
const DecisionIDBrand = (raw: string): DecisionID => raw as DecisionID;
const EvidenceIDBrand = (raw: string): EvidenceID => raw as EvidenceID;
const ConstraintIDBrand = (raw: string): ConstraintID => raw as ConstraintID;
const QuestionIDBrand = (raw: string): QuestionID => raw as QuestionID;
const ConflictIDBrand = (raw: string): ConflictID => raw as ConflictID;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unknown fields are rejected, not ignored (§17). */
function checkKeys(record: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw invalidOutput(`${what} carries unknown field "${key}"`, { field: key, at: what });
    }
  }
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidOutput(`${what} requires a non-empty string`);
  }
  return value;
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalidOutput(`${what} requires a positive integer`);
  }
  return value;
}

/** Exact source-ref FORM (resolution against the frozen input happens in validate.ts). */
function parseSourceRef(value: unknown, what: string): SynthesisSourceRef {
  if (!isRecord(value)) throw invalidOutput(`${what} requires a source ref object`);
  const kind = value["kind"];
  if (typeof kind !== "string" || !(WIRE_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw invalidOutput(`${what} carries an unsupported source ref kind`);
  }
  checkKeys(value, ["kind", "id", "revision"], `${what} source ref`);
  switch (kind) {
    case "architecture":
      return { kind: "architecture" };
    case "section":
    case "decision":
    case "evidence": {
      const id = nonEmptyString(value["id"], `${what} ${kind} source`);
      const revision = positiveInt(value["revision"], `${what} ${kind} source ${id}`);
      const cast = { section: SectionIDBrand, decision: DecisionIDBrand, evidence: EvidenceIDBrand }[kind];
      return { kind, id: cast(id), revision } as SynthesisSourceRef;
    }
    default: {
      const id = nonEmptyString(value["id"], `${what} ${kind} source`);
      const cast = { constraint: ConstraintIDBrand, question: QuestionIDBrand, conflict: ConflictIDBrand }[kind as "constraint" | "question" | "conflict"];
      return { kind: kind as "constraint" | "question" | "conflict", id: cast(id) } as SynthesisSourceRef;
    }
  }
}

function parseManifestItem(value: unknown, what: string): ManifestItemRef {
  if (!isRecord(value)) throw invalidOutput(`${what} requires a manifestItem locator object`);
  checkKeys(value, ["kind", "index", "order"], `${what} manifestItem`);
  const kind = value["kind"];
  if (kind === "cross_section_link" || kind === "limitation" || kind === "synthesis_finding") {
    if ("order" in value) throw invalidOutput(`${what} manifestItem ${kind} uses "index", not "order"`);
    return { kind, index: positiveInt(value["index"], `${what} manifestItem ${kind} index`) };
  }
  if (kind === "implementation_step") {
    if ("index" in value) throw invalidOutput(`${what} manifestItem implementation_step uses "order", not "index"`);
    return { kind, order: positiveInt(value["order"], `${what} manifestItem implementation_step order`) };
  }
  throw invalidOutput(`${what} carries an unsupported manifestItem kind`);
}

function parseScope(value: unknown, what: string): SemanticFindingScope {
  if (!isRecord(value)) throw invalidOutput(`${what} requires a scope object`);
  checkKeys(value, ["architecture", "sections"], `${what} scope`);
  const scope: SemanticFindingScope = {};
  if (value["architecture"] !== undefined) {
    const arch = value["architecture"];
    if (!isRecord(arch)) throw invalidOutput(`${what} scope.architecture requires an object`);
    checkKeys(arch, ["id", "revision"], `${what} scope.architecture`);
    if (arch["id"] !== "ARCH") throw invalidOutput(`${what} scope.architecture.id must be "ARCH"`);
    scope.architecture = { id: "ARCH", revision: positiveInt(arch["revision"], `${what} scope.architecture revision`) };
  }
  if (value["sections"] !== undefined) {
    const raw = value["sections"];
    if (!Array.isArray(raw)) throw invalidOutput(`${what} scope.sections requires an array`);
    scope.sections = raw.map((entry, index) => {
      if (!isRecord(entry)) throw invalidOutput(`${what} scope.sections[${index}] requires an object`);
      checkKeys(entry, ["id", "revision"], `${what} scope.sections[${index}]`);
      const id = nonEmptyString(entry["id"], `${what} scope.sections[${index}].id`);
      const revision = positiveInt(entry["revision"], `${what} scope.sections[${index}] revision`);
      return { id: SectionIDBrand(id), revision };
    });
  }
  if (scope.architecture === undefined && scope.sections === undefined) {
    throw invalidOutput(`${what} scope must identify the architecture and/or at least one section`);
  }
  return scope;
}

function parseFinding(value: unknown, index: number): ValidatorFindingDraft {
  const what = `findings[${index}]`;
  if (!isRecord(value)) throw invalidOutput(`${what} requires an object`);
  checkKeys(value, ["category", "statement", "scope", "manifestItem", "sources"], what);
  if ("id" in value) {
    throw invalidOutput(`${what} must not carry an id — the Harness assigns finding ids`);
  }
  const category = value["category"];
  if (typeof category !== "string" || !(SEMANTIC_FINDING_CATEGORIES as readonly string[]).includes(category)) {
    throw invalidOutput(`${what} category must be one of ${SEMANTIC_FINDING_CATEGORIES.join(", ")}`);
  }
  const finding: ValidatorFindingDraft = {
    category: category as (typeof SEMANTIC_FINDING_CATEGORIES)[number],
    statement: nonEmptyString(value["statement"], what),
    scope: parseScope(value["scope"], what),
  };
  if (value["manifestItem"] !== undefined) {
    finding.manifestItem = parseManifestItem(value["manifestItem"], what);
  }
  if (value["sources"] !== undefined) {
    const raw = value["sources"];
    if (!Array.isArray(raw)) throw invalidOutput(`${what} sources requires an array`);
    finding.sources = raw.map((source, sourceIndex) => parseSourceRef(source, `${what}.sources[${sourceIndex}]`));
  }
  return finding;
}

/**
 * Parse the raw validator text into the strict wire draft. The whole trimmed
 * output must be exactly one JSON object; there is NO permissive fallback
 * extraction (§17: "Do not recover a valid-looking object from invalid
 * surrounding text").
 */
export function parseValidatorOutput(raw: string): ValidationReportDraft {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw invalidOutput("output is empty");
  }
  if (raw.includes("```")) {
    throw invalidOutput("markdown fences are forbidden — reply with a bare JSON document");
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw invalidOutput("output must be exactly one JSON object (no surrounding prose)");
  }
  const parsed = parseStrictJSON(trimmed);
  if (!isRecord(parsed)) throw invalidOutput("top-level document must be an object");
  checkKeys(parsed, ["result", "findings"], "document");
  const result = parsed["result"];
  if (result !== "clean" && result !== "findings") {
    throw invalidOutput('result must be "clean" or "findings"');
  }
  const rawFindings = parsed["findings"];
  if (!Array.isArray(rawFindings)) throw invalidOutput("findings must be an array");
  if (result === "clean" && rawFindings.length > 0) {
    throw invalidOutput('result "clean" requires an empty findings array');
  }
  if (result === "findings" && rawFindings.length === 0) {
    throw invalidOutput('result "findings" requires at least one finding');
  }
  return { result, findings: rawFindings.map((finding, index) => parseFinding(finding, index)) };
}
