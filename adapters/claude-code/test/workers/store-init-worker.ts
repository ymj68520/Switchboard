/**
 * Multi-process store initialization worker (frozen plan §36).
 *
 * Bundled to plain ESM by the multi-process test (esbuild) and spawned as
 * real processes against one shared database:
 *
 *   node store-init-worker.mjs <pluginDataRoot> <busyTimeoutMs>
 *
 * Prints one JSON line: { ok, storeId?, schemaVersion? } or
 * { ok: false, code, message }.
 */

import { initializePlanStore } from "../../src/store/sqlite-store.js";
import { isRuntimeError } from "../../src/runtime/errors.js";

const pluginDataRoot = process.argv[2] ?? "";
const busyTimeoutMs = Number(process.argv[3] ?? "2000");

try {
  const store = await initializePlanStore({ pluginDataRoot, busyTimeoutMs });
  const metadata = store.getStoreMetadata();
  const schemaVersion = store.getSchemaVersion();
  store.close();
  process.stdout.write(
    `${JSON.stringify({ ok: true, storeId: metadata.storeId, schemaVersion })}\n`,
  );
} catch (err) {
  const code = isRuntimeError(err) ? err.code : "UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
}
