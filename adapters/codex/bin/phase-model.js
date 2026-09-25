#!/usr/bin/env node
/**
 * phase-model — managed Codex CLI session launcher (production entry).
 *
 * Thin wrapper: all logic lives in the built adapter
 * (src/launcher/cli.ts → dist/launcher/cli.js). Run `npm run build -w
 * @switchboard/codex` before using.
 */
import { runLauncher } from "../dist/launcher/cli.js";

process.exit(await runLauncher(process.argv.slice(2)));
