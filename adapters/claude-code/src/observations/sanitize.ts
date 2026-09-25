/**
 * Conservative sanitization boundary for captured results (Phase 9 §15).
 *
 * Execution observations are the high-risk data plane: environment dumps,
 * tokens, and host-context material that merely PASS THROUGH a tool result
 * must never be permanently written into the Plan Store. This module is
 * defense-in-depth, NOT a secret detector: anything detectable is dropped
 * (payload bytes are never persisted and the observation stays unpromotable),
 * and the documentation states plainly that users must not promote secrets
 * into Evidence.
 *
 * Byte-level redaction of ordinary payloads is deliberately NOT attempted:
 * the payload must remain the exact result the host delivered (§9/§80), so
 * the only safe transform for a suspect result is to not persist its bytes.
 */

import type { ObservationCaptureEvent } from "./types.js";
import { SANITIZED_ENV_DUMP } from "./types.js";

/**
 * Detectable environment/secret dump command shapes. Single-variable reads
 * (`$env:PATH`, `[Environment]::GetEnvironmentVariable("X")`) are NOT flagged
 * — they are common benign provenance — while whole-environment dumps are.
 */
const ENV_DUMP_PATTERNS: RegExp[] = [
  /(^|[;&|(]\s*|\|\s*|&&\s*)printenv(\s|$)/i,
  /(^|[;&|(]\s*|\|\s*|&&\s*)env(\s+(?:-\S+\s+)*)?$/i,
  /(^|[;&|(]\s*|\|\s*|&&\s*)set(\s*$|\s+&)/i,
  /get-childitem\s+env:/i,
  /(^|\s)gci\s+env:/i,
  /(^|\s)dir\s+env:/i,
  /getenvironmentvariables?\s*\(/i,
];

export function detectEnvDumpCommand(command: string): boolean {
  return ENV_DUMP_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Sanitization decision for one capture event. Returns the sanitizer marker
 * when the result payload must be OMITTED (never persisted), or null when the
 * exact bytes may be stored.
 */
export function payloadSanitizerMarker(event: ObservationCaptureEvent): string | null {
  if (typeof event.toolInput.command === "string" && detectEnvDumpCommand(event.toolInput.command)) {
    return SANITIZED_ENV_DUMP;
  }
  return null;
}
