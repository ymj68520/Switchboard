/**
 * Type surface of scripts/claude-release-lib.mjs (Phase 18 release pipeline).
 */

export declare const RELEASE_ALLOWLIST: readonly string[];

export interface StagedFile {
  relPath: string;
  sourcePath: string;
  stagedPath: string;
  bytes: number;
}

export interface TreeFile {
  relPath: string;
  absPath: string;
}

export declare function resetDir(dir: string): Promise<void>;
export declare function stageReleaseTree(adapterRoot: string, outDir: string): Promise<StagedFile[]>;
export declare function listTree(root: string): Promise<TreeFile[]>;
export declare function scanReleaseTree(
  stagingRoot: string,
  stagedFiles?: Array<{ relPath: string; stagedPath: string }>,
): Promise<string[]>;

export interface ZipEntry {
  relPath: string;
  bytes: Buffer;
}

export declare function createDeterministicZip(entries: ZipEntry[]): Buffer;
