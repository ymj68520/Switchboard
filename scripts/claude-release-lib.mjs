/**
 * Phase Plan v0.1 release library (Phase 18 §7–§10, §54).
 *
 * Pure, dependency-free functions used by `scripts/claude-release.mjs` and
 * exercised directly by adapter release tests:
 *
 *   - stageReleaseTree     allowlist-only assembly of the plugin root
 *   - createDeterministicZip  byte-reproducible archive (fixed metadata)
 *   - scanReleaseTree      secret + local-machine path scan (§8/§54)
 *
 * Everything here must stay deterministic: the same input bytes always
 * produce the same archive bytes, on any host OS.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { crc32 } from "node:zlib";

/**
 * The explicit release-tree allowlist (Phase 18 §7). Paths are POSIX-style,
 * relative to the plugin root. Nothing outside this list may enter the
 * artifact — no src/, no test/, no coverage, no stores, no secrets.
 */
export const RELEASE_ALLOWLIST = Object.freeze([
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
  "skills/phase-plan/SKILL.md",
  "agents/validator.md",
  "dist/phase-plan-runtime.mjs",
  "README.md",
  "CHANGELOG.md",
]);

/** Files that must NEVER enter a release tree, by name pattern (§8). */
const FORBIDDEN_FILE_PATTERNS = [
  /\.sqlite3$/,
  /\.sqlite3-wal$/,
  /\.sqlite3-shm$/,
  /(^|\/)host-context\.key$/,
  /(^|\/)capability-proofs\.json$/,
  /(^|\/)debug\.log$/i,
  /\.log$/i,
  /(^|\/)session[a-z-]*\.json$/i,
];

/**
 * Content scan needles (§8 secrets + §54 local-machine assumptions).
 * Each pattern is (regex, label). Abstract documentation examples must not
 * match; these target real credentials and real developer-machine paths.
 */
const FORBIDDEN_CONTENT_PATTERNS = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{16,}/, label: "Anthropic API token" },
  { pattern: /ANTHROPIC_API_KEY\s*[=:]/, label: "Anthropic API key assignment" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "embedded private key" },
  { pattern: /eyJ[A-Za-z0-9_-]{24,}\.eyJ[A-Za-z0-9_-]{16,}\./, label: "JWT/OAuth token shape" },
  { pattern: /C:\\+Users\\/i, label: "Windows user profile path" },
  { pattern: /C:\/Users\//i, label: "Windows user profile path" },
  { pattern: /D:\\+Programing/i, label: "developer checkout path" },
  { pattern: /D:\/Programing/i, label: "developer checkout path" },
  { pattern: /\/home\/[a-z0-9_]/, label: "POSIX home directory path" },
  { pattern: /AppData\\+Local/, label: "developer AppData path" },
  { pattern: /AppData\/Local/, label: "developer AppData path" },
  { pattern: /MSYS_NO_PATHCONV/, label: "Git Bash harness assumption" },
  { pattern: /Author Software\\+nvm/, label: "nvm installation path" },
  { pattern: /Author Software\/nvm/, label: "nvm installation path" },
];

function toPosix(p) {
  return p.split("\\").join("/");
}

/** Remove a directory tree if it exists (idempotent). */
export async function resetDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Assemble the release plugin root at `outDir` by copying EXACTLY the
 * allowlisted files from `adapterRoot`. Returns the staged manifest.
 * Any allowlisted file that is missing fails the staging.
 */
export async function stageReleaseTree(adapterRoot, outDir) {
  await resetDir(outDir);
  const staged = [];
  for (const relPath of RELEASE_ALLOWLIST) {
    const sourcePath = path.join(adapterRoot, ...relPath.split("/"));
    let stat;
    try {
      stat = await fs.stat(sourcePath);
    } catch {
      throw new Error(`release allowlist entry missing on disk: ${relPath} (looked at ${sourcePath})`);
    }
    if (!stat.isFile()) {
      throw new Error(`release allowlist entry is not a regular file: ${relPath}`);
    }
    const stagedPath = path.join(outDir, ...relPath.split("/"));
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.copyFile(sourcePath, stagedPath);
    staged.push({ relPath, sourcePath, stagedPath, bytes: stat.size });
  }
  staged.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return staged;
}

/** Enumerate every file under `root` (POSIX-style relative paths, sorted). */
export async function listTree(root) {
  const out = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push({ relPath: toPosix(path.relative(root, abs)), absPath: abs });
      }
    }
  }
  await walk(root);
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return out;
}

/**
 * Scan staged files for secrets and local-machine assumptions.
 * Returns a list of human-readable violations; empty means clean.
 */
export async function scanReleaseTree(stagingRoot, stagedFiles = null) {
  const violations = [];
  const files = stagedFiles ?? (await listTree(stagingRoot)).map((f) => ({ relPath: f.relPath, stagedPath: f.absPath }));

  for (const file of files) {
    for (const pattern of FORBIDDEN_FILE_PATTERNS) {
      if (pattern.test(file.relPath)) {
        violations.push(`FORBIDDEN FILE NAME in release tree: ${file.relPath}`);
        break;
      }
    }
  }

  for (const file of files) {
    let text;
    try {
      text = (await fs.readFile(file.stagedPath, "utf8"));
    } catch {
      continue; // unreadable as text — filename scan already applied
    }
    for (const { pattern, label } of FORBIDDEN_CONTENT_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        const line = text.slice(0, match.index ?? 0).split("\n").length;
        violations.push(`${label} in ${file.relPath} (line ${line})`);
      }
    }
  }
  return violations;
}

// --- deterministic ZIP writer ------------------------------------------------

const DOS_EPOCH_DATE = 0x0021; // 1980-01-01 (date bits: year 0, month 1, day 1)
const DOS_EPOCH_TIME = 0x0000; // 00:00:00
const EXTERNAL_ATTRS = 0o644 << 16; // regular file, 0644 — no host umask leaks

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

/**
 * Build a byte-deterministic ZIP archive from {relPath, bytes} entries.
 * Normalization (§9): sorted entry order, fixed DOS timestamps, fixed
 * permissions, forward-slash names, UTF-8 flag, fixed deflate level, no
 * extra fields, no archive comment.
 */
export function createDeterministicZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.relPath, "utf8");
    const data = entry.bytes;
    const compressed = deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0x0800), // flags: UTF-8 names
      u16(method),
      u16(DOS_EPOCH_TIME),
      u16(DOS_EPOCH_DATE),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0), // extra length
      nameBytes,
      payload,
    ]);
    locals.push(local);

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0x0800),
      u16(method),
      u16(DOS_EPOCH_TIME),
      u16(DOS_EPOCH_DATE),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0), // extra
      u16(0), // comment
      u16(0), // disk number
      u16(0), // internal attrs
      u32(EXTERNAL_ATTRS),
      u32(offset),
      nameBytes,
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0),
    u16(sorted.length),
    u16(sorted.length),
    u32(centralDir.length),
    u32(offset),
    u16(0), // comment length
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}
