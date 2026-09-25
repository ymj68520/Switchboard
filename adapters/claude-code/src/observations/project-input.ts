/**
 * Typed normalized tool-input provenance (Phase 9 §14) + secret-field
 * exclusion (§15) + workspace-relative path normalization (§74).
 *
 * The projection is deliberately SMALL and tolerant: known fields are read
 * with runtime type guards, unknown host fields are ignored (host schemas
 * evolve forward), and only the projection is persisted — raw unrestricted
 * tool input never reaches the store.
 */

import * as path from "node:path";

import { comparisonKey } from "../workspace/canonical-path.js";
import { RuntimeError } from "../runtime/errors.js";
import type { ObservationClass, ObservationInputProjection } from "./types.js";

/** Defense-in-depth: authority/secret-shaped fields are excluded, always (§15). */
const SECRET_FIELD_PATTERN = /hostcontext|entryintent|apikey|api_key|authorization|password|secret|token|cookie/i;

function captureFailed(message: string, cause?: string): RuntimeError {
  return new RuntimeError("OBSERVATION_CAPTURE_FAILED", message, cause === undefined ? {} : { cause });
}

function optionalString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined) {
      return typeof value === "string" && value.trim() !== "" ? value : undefined;
    }
  }
  return undefined;
}

function optionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Drop secret-shaped fields from a projection record (no-op in practice for
 * evidence-capable tools; the boundary must not depend on that, §15). */
function withoutSecretFields<T extends Record<string, unknown>>(projection: T): T {
  const out: Record<string, unknown> = {};
  let mutated = false;
  for (const [key, value] of Object.entries(projection)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      mutated = true;
      continue;
    }
    out[key] = value;
  }
  return (mutated ? out : projection) as T;
}

/**
 * Workspace-relative normalized path (§74): forward slashes, portable across
 * machines. Paths outside the workspace are stored as observed (rare; still
 * exact provenance, just not portable).
 */
export function relativizeWorkspacePath(observedPath: string, workspaceRoot: string | undefined): string {
  if (workspaceRoot === undefined) return observedPath;
  const observedKey = comparisonKey(observedPath);
  const rootKey = comparisonKey(workspaceRoot);
  if (observedKey === rootKey) return ".";
  if (observedKey.startsWith(`${rootKey}\\`) || observedKey.startsWith(`${rootKey}/`)) {
    const rest = observedPath.slice(workspaceRoot.length).replace(/^[\\/]/, "");
    return rest.split("\\").join("/");
  }
  return observedPath;
}

/** Absolute path for filesystem reads when the observed path is relative. */
export function resolveAgainstWorkspace(observedPath: string, workspaceRoot: string | undefined): string {
  if (path.isAbsolute(observedPath) || workspaceRoot === undefined) return observedPath;
  return path.join(workspaceRoot, observedPath);
}

export function projectToolInput(
  toolName: string,
  observationClass: ObservationClass,
  input: Record<string, unknown>,
  workspaceRoot: string | undefined,
): ObservationInputProjection {
  if (observationClass === "source") {
    const rawPath = optionalString(input, "file_path", "path", "notebook_path");
    if (rawPath === undefined) {
      throw captureFailed(
        `cannot project ${toolName} input: no file path field observed (host schema drift)`,
        "source observations require an exact file path (§14)",
      );
    }
    const offset = optionalInteger(input, "offset");
    const limit = optionalInteger(input, "limit");
    return withoutSecretFields({
      kind: "source" as const,
      path: relativizeWorkspacePath(rawPath, workspaceRoot),
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    });
  }
  if (observationClass === "locator") {
    const pattern = optionalString(input, "pattern");
    if (pattern === undefined) {
      throw captureFailed(
        `cannot project ${toolName} input: no pattern field observed (host schema drift)`,
        "locator observations require the search pattern (§14)",
      );
    }
    const root = optionalString(input, "path");
    const glob = optionalString(input, "glob");
    return withoutSecretFields({
      kind: "locator" as const,
      tool: toolName === "Grep" ? ("Grep" as const) : ("Glob" as const),
      pattern,
      ...(root === undefined ? {} : { path: relativizeWorkspacePath(root, workspaceRoot) }),
      ...(glob === undefined ? {} : { glob }),
    });
  }
  const command = optionalString(input, "command");
  if (command === undefined) {
    throw captureFailed(
      `cannot project ${toolName} input: no command field observed (host schema drift)`,
      "execution observations require the executed command (§14)",
    );
  }
  return withoutSecretFields({ kind: "execution" as const, command });
}
