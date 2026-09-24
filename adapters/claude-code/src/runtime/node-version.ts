/**
 * Node.js runtime prerequisite (frozen architecture §26.1: Node.js 24.15+ is
 * an explicit runtime prerequisite). Version comparison is full semver-core —
 * never major-only — and the required floor lives only here.
 */

export const REQUIRED_NODE_VERSION = "24.15.0";

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/**
 * Parse a semver core ("24.15.0", optionally with prerelease/build suffixes).
 * Returns null for anything that is not a valid numeric core.
 */
export function parseSemver(input: string): ParsedSemver | null {
  const buildStripped = input.split("+")[0] ?? "";
  const [core, prereleasePart] = buildStripped.split("-", 2);
  const coreNumbers = (core ?? "").split(".");
  if (coreNumbers.length !== 3) {
    return null;
  }
  const numbers: number[] = [];
  for (const part of coreNumbers) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    numbers.push(Number(part));
  }
  const [major, minor, patch] = numbers as [number, number, number];
  const prerelease = prereleasePart === undefined ? [] : prereleasePart.split(".").filter((p) => p.length > 0);
  return { major, minor, patch, prerelease };
}

function comparePrerelease(a: string[], b: string[]): number {
  // A version without prerelease outranks one with it.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === bi) continue;
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) return Number(ai) - Number(bi);
    if (aNum) return -1;
    if (bNum) return 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

/** Full semver comparison: negative when a < b, 0 when equal, positive when a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) {
    throw new Error(`invalid semver: ${pa === null ? a : b}`);
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

export function isNodeVersionSupported(detected: string, required: string = REQUIRED_NODE_VERSION): boolean {
  const parsed = parseSemver(detected);
  if (parsed === null) {
    // An unreadable runtime version is fail-closed: never assume supported.
    return false;
  }
  return compareSemver(detected, required) >= 0;
}
