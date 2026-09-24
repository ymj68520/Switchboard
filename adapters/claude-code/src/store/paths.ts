/**
 * Canonical Plan Store path resolution (frozen plan §4, architecture §25.1).
 *
 * The database lives at exactly `${CLAUDE_PLUGIN_DATA}/store/phase-plan.sqlite3`.
 * No production code may hardcode user directories; everything derives from
 * the plugin data root handed in by the caller (the runtime resolves it from
 * the environment).
 */

import * as path from "node:path";

import { STORE_DB_FILENAME } from "./constants.js";

export interface StorePaths {
  /** The plugin data root this store layout hangs off. */
  pluginDataRoot: string;
  /** `${root}/store` — canonical database directory. */
  storeDir: string;
  /** `${root}/store/phase-plan.sqlite3` — the canonical database. */
  databasePath: string;
  /** `${root}/backups` — pre-migration backups. */
  backupsDir: string;
  /** `${root}/blobs` — content-addressed observation payloads (later phase). */
  blobsDir: string;
  /** `${root}/exports` — generated projections (later phase). */
  exportsDir: string;
}

/** Resolve the frozen store layout under a plugin data root. Pure function. */
export function resolveStorePaths(pluginDataRoot: string): StorePaths {
  const root = path.resolve(pluginDataRoot);
  const storeDir = path.join(root, "store");
  return {
    pluginDataRoot: root,
    storeDir,
    databasePath: path.join(storeDir, STORE_DB_FILENAME),
    backupsDir: path.join(root, "backups"),
    blobsDir: path.join(root, "blobs"),
    exportsDir: path.join(root, "exports"),
  };
}
