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

/** Normalize the path so layer-prefix checks work on win32 separators. */
function layerOf(file: string): string {
  return file.replaceAll("\\", "/");
}

describe("production boundary scans", () => {
  it("sends thread/settings/update from EXACTLY ONE production site (the narrow primitive)", () => {
    // Phase 4 legitimizes the settings mutation — but only as the narrow
    // `{threadId, model}` primitive inside the controller. No other
    // production module may reference the method.
    const offenders = productionSources()
      .filter(({ file }) => !file.endsWith("model-controller.ts"))
      .filter(({ text }) => /thread\/settings\/update(?![dD])/.test(stripComments(text)));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("routes no turn interception and no model/list through production code", () => {
    const offenders = productionSources().filter(({ text }) =>
      /turn\/(start|started|completed)(?![a-zA-Z])|model\/list/.test(stripComments(text)),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("the switcher never mutates settings other than the model", () => {
    // The outbound params object is behaviorally pinned to exactly
    // {threadId, model}; here we pin that no OTHER settings field is even
    // named as an outbound key in the switcher layer.
    const offenders = productionSources()
      .filter(({ file }) => file.endsWith("phase-model-switcher.ts") || file.endsWith("routing.ts"))
      .filter(({ text }) =>
        /["'](collaborationMode|reasoningEffort|effort|sandboxPolicy|approvalPolicy|permissions|serviceTier|cwd|personality)["']/.test(
          stripComments(text),
        ),
      );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("contains no model routing vocabulary outside the user-facing config surface", () => {
    // Phase 5 introduces the user-facing configuration schema whose
    // spelling is FROZEN by Architecture SPEC §25 (planning_model /
    // execution_model snake_case in the config file and CLI usage text).
    // The config/ and launcher/ layers carry that deliberate schema; the
    // runtime/transport/controller/switcher layers must never use the
    // routing vocabulary.
    const offenders = productionSources()
      .filter(({ file }) => { const f = layerOf(file); return !f.startsWith("config/") && !f.startsWith("launcher/"); })
      .filter(({ text }) =>
        /planning_model|execution_model|model_for\s*\(/.test(stripComments(text)),
      );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("launcher owns no second process-tree kill implementation (Phase 5 §29)", () => {
    const offenders = productionSources()
      .filter(({ file }) => layerOf(file).startsWith("launcher/"))
      .filter(({ text }) => /taskkill/i.test(stripComments(text)));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("launcher never reads TUI output streams (Phase 5 §19 terminal ownership)", () => {
    const offenders = productionSources()
      .filter(({ file }) => layerOf(file).startsWith("launcher/"))
      .filter(({ text }) => /stdoutStream|stderrStream/.test(stripComments(text)));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("launcher adds no protocol surface beyond the frozen components (Phase 5 §0)", () => {
    const offenders = productionSources()
      .filter(({ file }) => { const f = layerOf(file); return f.startsWith("launcher/") || f.startsWith("config/"); })
      .filter(({ text }) =>
        /thread\/(started|settings\/updated|settings\/update|resume|unsubscribe)|"initialize"/.test(
          stripComments(text),
        ),
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
