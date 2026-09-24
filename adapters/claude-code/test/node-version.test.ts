import { describe, expect, it } from "vitest";

import {
  compareSemver,
  isNodeVersionSupported,
  parseSemver,
  REQUIRED_NODE_VERSION,
} from "../src/runtime/node-version.js";

describe("parseSemver", () => {
  it("parses plain cores", () => {
    expect(parseSemver("24.15.0")).toEqual({ major: 24, minor: 15, patch: 0, prerelease: [] });
    expect(parseSemver("25.3.1")).toEqual({ major: 25, minor: 3, patch: 1, prerelease: [] });
  });

  it("parses prerelease and build metadata", () => {
    expect(parseSemver("24.0.0-nightly20260101")?.prerelease).toEqual(["nightly20260101"]);
    expect(parseSemver("24.0.0-rc.1+build.5")?.patch).toBe(0);
    expect(parseSemver("24.0.0-rc.1+build.5")?.prerelease).toEqual(["rc", "1"]);
  });

  it("rejects non-semver input", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("22")).toBeNull();
    expect(parseSemver("22.x.y")).toBeNull();
    expect(parseSemver("v22.23.2")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders full cores, not just majors", () => {
    expect(compareSemver("24.15.0", "24.14.9")).toBeGreaterThan(0);
    expect(compareSemver("24.15.0", "24.15.0")).toBe(0);
    expect(compareSemver("24.15.1", "24.15.0")).toBeGreaterThan(0);
    expect(compareSemver("23.99.99", "24.0.0")).toBeLessThan(0);
    expect(compareSemver("25.0.0", "24.99.99")).toBeGreaterThan(0);
  });

  it("rejects unparseable versions", () => {
    expect(() => compareSemver("abc", "1.0.0")).toThrow();
  });
});

describe("isNodeVersionSupported", () => {
  it("enforces the frozen 24.15.0 floor exactly", () => {
    expect(REQUIRED_NODE_VERSION).toBe("24.15.0");
    expect(isNodeVersionSupported("24.14.9")).toBe(false);
    expect(isNodeVersionSupported("24.15.0")).toBe(true);
    expect(isNodeVersionSupported("24.15.1")).toBe(true);
    expect(isNodeVersionSupported("24.21.0")).toBe(true);
    expect(isNodeVersionSupported("25.0.0")).toBe(true);
    expect(isNodeVersionSupported("22.23.2")).toBe(false);
  });

  it("fails closed on unparseable versions", () => {
    expect(isNodeVersionSupported("unknown")).toBe(false);
    expect(isNodeVersionSupported("")).toBe(false);
  });
});
