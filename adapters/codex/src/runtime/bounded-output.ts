/**
 * Bounded startup-output accumulator.
 *
 * Collects app-server stderr/stdout text for endpoint scanning while keeping
 * only a bounded tail for diagnostics (Phase 1 directive §10: enough context
 * to diagnose, never an unbounded stderr dump inside an error object).
 *
 * The accumulator keeps RAW text; ANSI stripping happens at scan time in the
 * endpoint parser so escape sequences split across chunk boundaries are
 * handled over the concatenated buffer.
 */

const MAX_RETAINED_BYTES = 64 * 1024;

export class BoundedStartupOutput {
  private raw = "";

  /** Append a decoded chunk (stderr or stdout) to the buffer. */
  append(chunk: string): void {
    this.raw += chunk;
    if (this.raw.length > MAX_RETAINED_BYTES) {
      this.raw = this.raw.slice(this.raw.length - MAX_RETAINED_BYTES);
    }
  }

  /** Current retained raw text (oldest content already trimmed). */
  text(): string {
    return this.raw;
  }

  /** Last `maxChars` characters, for compact error details. */
  tail(maxChars: number): string {
    if (this.raw.length <= maxChars) {
      return this.raw;
    }
    return this.raw.slice(this.raw.length - maxChars);
  }
}
