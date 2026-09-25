import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static production-boundary scans (Phase 3 directive §2/§20/§23).
 *
 * The controller is a passive observer: it must never answer server
 * requests, never send `thread/settings/update`, and never contain model
 * routing. These scans pin those boundaries against quiet regression —
 * the behavioral counterpart lives in subscription-convergence.test.ts.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

function productionSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push({ file: path.relative(SRC_DIR, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

/** Strip block and line comments so doc prose cannot trip the scans. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

describe("production boundary scans", () => {
  it("never sends thread/settings/update (the settings mutation RPC)", () => {
    const offenders = productionSources().filter(({ text }) =>
      // "thread/settings/updated" (the notification) is fine; the bare
      // request method is not.
      /thread\/settings\/update(?![dD])/.test(stripComments(text)),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("contains no model routing vocabulary", () => {
    const offenders = productionSources().filter(({ text }) =>
      /planning_model|execution_model|model_for\s*\(/.test(stripComments(text)),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("never answers server requests with respondError", () => {
    // The transport keeps a generic respondError primitive (tested at the
    // RPC layer); the CONTROLLER must never call it. The wiring point is
    // model-controller.ts — scan it (and only it) for calls.
    const offenders = productionSources()
      .filter(({ file }) => file.endsWith("model-controller.ts"))
      .filter(({ text }) => /respondError\s*\(/.test(text));
    expect(offenders).toEqual([]);
  });

  it("keeps the passive-subscriber rule documented at the implementation point", () => {
    const controller = productionSources().find(({ file }) =>
      file.endsWith("model-controller.ts"),
    );
    expect(controller).toBeDefined();
    expect(controller?.text).toContain("Passive Subscriber Rule");
    expect(controller?.text).toContain("can race");
  });
});
