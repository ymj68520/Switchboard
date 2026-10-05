/**
 * E8 §49 — Directive protocol/hash compatibility (E8-T1..T7).
 *
 * Historical v1 Directives keep their EXACT pre-E8 hashes forever (E8 §4/§5);
 * new Directives are protocol v2 and hash the verification policy (E8 §6/§7);
 * policy columns are immutable once written; the revision rules allow
 * batchable → immediate but forbid the downgrade, and a v1 → v2 revision must
 * conservatively adopt `immediate`; an unattempted v1 implementation Directive
 * cannot start (E8 §9).
 */
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  attemptInput,
  codeOf,
  directiveInput,
  issueDirective,
  makeActiveExecutionWorld,
  startAttempt,
  type E4World,
} from "./execution-protocol-helpers.js";
import { canonicalDirectiveV1, executionDirectiveHash } from "../src/core/execution-directive.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import {
  dropSchema21Objects,
  publishedBackups,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

let world: E4World | null = null;

async function freshWorld(): Promise<E4World> {
  world = await makeActiveExecutionWorld(`DP-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E8 directive protocol v2 (§4–§9)", () => {
  it("E8-T2: new Directives carry the current protocol and the hash binds protocol version + policy", async () => {
    const w = await freshWorld();
    const directive = issueDirective(w, {
      directiveId: "DIR-V2",
      verificationPolicy: { implementationRequirement: "batchable" },
    });
    // A1 §20 — ALL newly issued Directives carry protocol version 4.
    expect(directive.protocolVersion).toBe(4);
    expect(directive.verificationPolicy).toEqual({ implementationRequirement: "batchable" });
    expect(directive.hash).toBe(executionDirectiveHash(directive));
    // The v2 canonical payload adds protocolVersion + verificationPolicy: the
    // same logical content under v1 canonicalization hashes differently.
    const v1Shape = executionDirectiveHash({ ...directive, protocolVersion: 1, verificationPolicy: null });
    expect(directive.hash).not.toBe(v1Shape);
    // The v1 canonical content is unchanged from the pre-E8 algorithm.
    expect(canonicalDirectiveV1({ ...directive, protocolVersion: 1, verificationPolicy: null })).toContain(
      '"directiveId":"DIR-V2"',
    );
  });

  it("E8-T1 + T3: a real pre-E8 world rewinds to v20 and re-migrates with byte-identical directive hashes", async () => {
    const w = await freshWorld();
    const issued = issueDirective(w, { directiveId: "DIR-HIST", verificationPolicy: { implementationRequirement: "batchable" } });
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = storePathsFor(root).databasePath;
    const beforeRows = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT directive_id AS id, revision, directive_hash AS hash, body FROM execution_directives ORDER BY directive_id, revision").all(),
    );
    w.ctx.store.close();
    // Present a genuine pre-v21 world (drop the E8 columns/objects), then let
    // the normal open re-migrate — the E8 §46 preservation contract.
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema21Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 21");
      raw.exec("PRAGMA user_version = 20");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      const afterRows = reopened.withRead(
        (tx) => tx.prepare("SELECT directive_id AS id, revision, directive_hash AS hash, body FROM execution_directives ORDER BY directive_id, revision").all(),
      );
      expect(afterRows).toEqual(beforeRows);
      // The re-migrated row parses as v1 with NULL policy and the SAME hash.
      const reopenedDirective = reopened.withRead((tx) => {
        const row = tx
          .prepare("SELECT directive_id AS directiveId, revision, directive_hash AS hash, protocol_version AS protocolVersion, verification_requirement AS verificationRequirement FROM execution_directives WHERE directive_id = 'DIR-HIST' AND revision = 1")
          .get() as { protocolVersion: number; verificationRequirement: string | null };
        return row;
      });
      expect(reopenedDirective.protocolVersion).toBe(1);
      expect(reopenedDirective.verificationRequirement).toBeNull();
      void issued;
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
      world = null;
    }
  });

  it("E8-T4: the persisted policy is immutable (no update path)", async () => {
    const w = await freshWorld();
    issueDirective(w, { directiveId: "DIR-IMM", verificationPolicy: { implementationRequirement: "immediate" } });
    const message = (() => {
      try {
        w.ctx.store.withWrite((tx) =>
          tx.prepare("UPDATE execution_directives SET verification_requirement = 'batchable' WHERE directive_id = 'DIR-IMM'").run(),
        );
        return "no-error";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    })();
    expect(message).toContain("execution_directives is immutable");
  });

  it("E8-T5 + T6: batchable → immediate revision is allowed; immediate → batchable is the forbidden downgrade", async () => {
    const w = await freshWorld();
    const first = issueDirective(w, { directiveId: "DIR-REV", verificationPolicy: { implementationRequirement: "batchable" } });
    const second = issueDirective(w, { directiveId: "DIR-REV", verificationPolicy: { implementationRequirement: "immediate" } });
    expect(second.revision).toBe(2);
    expect(first.verificationPolicy).toEqual({ implementationRequirement: "batchable" });
    expect(second.verificationPolicy).toEqual({ implementationRequirement: "immediate" });
    expect(
      codeOf(() => issueDirective(w, { directiveId: "DIR-REV", verificationPolicy: { implementationRequirement: "batchable" } })),
    ).toBe("VERIFICATION_REQUIREMENT_DOWNGRADE");
  });

  it("E8-T7: an unattempted v1 implementation Directive cannot start until a v2 revision exists", async () => {
    const w = await freshWorld();
    issueDirective(w, { directiveId: "DIR-LEG", verificationPolicy: { implementationRequirement: "batchable" } });
    // Present a genuine pre-v21 world: the directive becomes v1-by-definition
    // with NULL policy and no attempt.
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = storePathsFor(root).databasePath;
    w.ctx.store.close();
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema21Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 21");
      raw.exec("PRAGMA user_version = 20");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    const reopenedWorld: E4World = { ...w, ctx: { ...w.ctx, store: reopened } };
    try {
      const directive = reopenedWorld.ctx.store.withRead((tx) => {
        const raw_row = tx
          .prepare("SELECT directive_id AS id, revision, directive_hash AS hash FROM execution_directives WHERE directive_id = 'DIR-LEG' AND revision = 1")
          .get() as { id: string; revision: number; hash: string };
        return raw_row;
      });
      expect(directive).not.toBeNull();
      // Starting the unattempted v1 implementation revision fails closed.
      expect(
        codeOf(() => startAttempt(reopenedWorld, { directiveId: directive!.id, revision: directive!.revision, hash: directive!.hash })),
      ).toBe("DIRECTIVE_POLICY_UPGRADE_REQUIRED");
      // The v2 revision of the same logical Directive MUST adopt immediate.
      expect(
        codeOf(() =>
          issueDirective(reopenedWorld, {
            directiveId: "DIR-LEG",
            verificationPolicy: { implementationRequirement: "batchable" },
          }),
        ),
      ).toBe("VERIFICATION_POLICY_INVALID");
      const upgraded = issueDirective(reopenedWorld, {
        directiveId: "DIR-LEG",
        verificationPolicy: { implementationRequirement: "immediate" },
      });
      // A1 §20 — post-A1 revisions are v4 (the v1→v2/v3-era upgrade test
      // asserts the CURRENT revision-law: new revisions use the newest protocol).
      expect(upgraded.protocolVersion).toBe(4);
      // …and the v2 revision starts (fresh candidate, no pressure yet).
      expect(() => startAttempt(reopenedWorld, upgraded)).not.toThrow();
      void attemptInput;
      void directiveInput;
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
      world = null;
    }
  });

  it("E8-T1b: the migration 20→21 backup is named for the transition", async () => {
    const w = await freshWorld();
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = storePathsFor(root).databasePath;
    w.ctx.store.close();
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema21Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 21");
      raw.exec("PRAGMA user_version = 20");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    reopened.close();
    const backups = publishedBackups(storePathsFor(root).backupsDir).map((p) => path.basename(p));
    expect(backups.some((name) => name.includes("pre-schema-20-"))).toBe(true);
  });
});


