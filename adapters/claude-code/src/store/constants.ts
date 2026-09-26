/**
 * Single-source Store constants (Phase 2). Schema version, protocol version,
 * plugin version, and runtime version are DISTINCT concepts (frozen plan
 * §10): the schema version authority is SQLite's `PRAGMA user_version`, and
 * it must never be derived from the npm package version.
 */

/** The only schema version this binary can write. */
export const SUPPORTED_SCHEMA_VERSION = 7;

/**
 * Store-level protocol version (distinct from schema and plugin versions).
 * Recorded as store metadata only; Phase 2 performs no protocol negotiation.
 */
export const STORE_PROTOCOL_VERSION = 1;

/** Canonical database file name under `${CLAUDE_PLUGIN_DATA}/store/`. */
export const STORE_DB_FILENAME = "phase-plan.sqlite3";

/**
 * Bounded lock wait for every production connection (frozen plan §8). Finite
 * by design: SQLite is the coordinator and a stuck writer must surface as
 * STORE_BUSY instead of hanging the process. Tests may pass a smaller
 * per-store override; this constant is the production default.
 */
export const STORE_BUSY_TIMEOUT_MS = 5000;
