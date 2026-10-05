/**
 * Thin OpenCode plugin entry — Phase 8 §50/§51 packaging.
 *
 * The host's plugin loader treats EVERY export of the loaded module as a
 * plugin function (or a `{ server }` object). The library barrel (index.js)
 * exports types, classes, and constants, so it is NOT a valid plugin module.
 * Install the plugin through THIS entry: it default-exports only the plugin
 * function.
 *
 * opencode.json:
 *   { "plugin": ["file:///…/adapters/opencode/dist/plugin.js"] }
 * or, for the npm package, the "./plugin" subpath.
 */
export { UltraPlanPlugin as default } from "./index.js";
