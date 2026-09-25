import { describe, expect, it } from "vitest";

import {
  parseLoopbackWsEndpoint,
  scanLoopbackWsEndpoints,
  stripAnsiEscapes,
} from "../src/runtime/endpoint-parser.js";

describe("stripAnsiEscapes", () => {
  it("removes CSI color sequences around an endpoint", () => {
    const input = "\x1b[2m[info]\x1b[0m listening \x1b[1mws://127.0.0.1:40001\x1b[0m";
    expect(stripAnsiEscapes(input)).toBe("[info] listening ws://127.0.0.1:40001");
  });

  it("removes OSC sequences (window title)", () => {
    const input = "\x1b]0;codex title\x07ws://127.0.0.1:40002";
    expect(stripAnsiEscapes(input)).toBe("ws://127.0.0.1:40002");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsiEscapes("listening on: ws://127.0.0.1:1")).toBe(
      "listening on: ws://127.0.0.1:1",
    );
  });
});

describe("parseLoopbackWsEndpoint", () => {
  it("extracts a valid loopback endpoint (no prefix required)", () => {
    const endpoint = parseLoopbackWsEndpoint("some startup text ws://127.0.0.1:53142 other text");
    expect(endpoint).not.toBeNull();
    expect(endpoint?.host).toBe("127.0.0.1");
    expect(endpoint?.port).toBe(53_142);
    expect(endpoint?.wsUrl).toBe("ws://127.0.0.1:53142");
    expect(endpoint?.httpBaseUrl).toBe("http://127.0.0.1:53142");
  });

  it("extracts the endpoint from a realistic app-server banner", () => {
    const banner = [
      "codex app-server (WebSockets)",
      "  listening on: ws://127.0.0.1:49958",
      "  readyz: http://127.0.0.1:49958/readyz",
      "  healthz: http://127.0.0.1:49958/healthz",
    ].join("\n");
    expect(parseLoopbackWsEndpoint(banner)?.port).toBe(49_958);
  });

  it("handles ANSI-decorated output", () => {
    const decorated = "\x1b[36mcodex\x1b[0m listening \x1b[4mws://127.0.0.1:40001\x1b[0m ok";
    expect(parseLoopbackWsEndpoint(decorated)?.port).toBe(40_001);
  });

  it("finds the endpoint among unrelated log lines before and after", () => {
    const noisy = [
      "2026-09-25T00:00:00Z INFO starting app-server",
      "config loaded from ~/.codex/config.toml",
      "endpoint ws://127.0.0.1:41000",
      "experimental api enabled",
    ].join("\n");
    expect(parseLoopbackWsEndpoint(noisy)?.port).toBe(41_000);
  });

  it("rejects port 0", () => {
    expect(parseLoopbackWsEndpoint("listening on: ws://127.0.0.1:0")).toBeNull();
  });

  it("rejects non-loopback IPv4 addresses", () => {
    expect(parseLoopbackWsEndpoint("ws://192.168.1.10:1234")).toBeNull();
  });

  it("rejects 0.0.0.0", () => {
    expect(parseLoopbackWsEndpoint("ws://0.0.0.0:1234")).toBeNull();
  });

  it("rejects hostnames", () => {
    expect(parseLoopbackWsEndpoint("ws://example.com:1234")).toBeNull();
    expect(parseLoopbackWsEndpoint("ws://localhost:1234")).toBeNull();
  });

  it("rejects wss scheme", () => {
    expect(parseLoopbackWsEndpoint("wss://127.0.0.1:1234")).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(parseLoopbackWsEndpoint("ws://127.0.0.1:")).toBeNull();
    expect(parseLoopbackWsEndpoint("ws://127.0.0.1:abc")).toBeNull();
    expect(parseLoopbackWsEndpoint("ws://127.0.0.1")).toBeNull();
    expect(parseLoopbackWsEndpoint("not a url at all")).toBeNull();
    expect(parseLoopbackWsEndpoint("")).toBeNull();
  });

  it("rejects out-of-range ports", () => {
    expect(parseLoopbackWsEndpoint("ws://127.0.0.1:99999")).toBeNull();
    expect(parseLoopbackWsEndpoint("ws://127.0.0.1:65536")).toBeNull();
  });

  it("accepts the full port range boundary 65535", () => {
    expect(parseLoopbackWsEndpoint("ws://127.0.0.1:65535")?.port).toBe(65_535);
  });

  it("does not match tokens embedded in longer words", () => {
    expect(parseLoopbackWsEndpoint("xws://127.0.0.1:53142")).toBeNull();
    expect(parseLoopbackWsEndpoint("see docs at /guides/ws://127.0.0.1:53142")).toBeNull();
  });

  it("is not confused by http URLs", () => {
    expect(parseLoopbackWsEndpoint("readyz: http://127.0.0.1:49958/readyz")).toBeNull();
  });

  it("accepts an endpoint token with a trailing path", () => {
    expect(parseLoopbackWsEndpoint("ws://127.0.0.1:53142/healthz")?.port).toBe(53_142);
  });
});

describe("scanLoopbackWsEndpoints", () => {
  it("records port-0 tokens as rejected candidates and skips to a valid one", () => {
    const result = scanLoopbackWsEndpoints(
      "fallback ws://127.0.0.1:0 then real ws://127.0.0.1:53000",
    );
    expect(result.endpoint?.port).toBe(53_000);
    expect(result.rejected).toEqual([
      { token: "ws://127.0.0.1:0", reason: "port_zero" },
    ]);
  });

  it("records out-of-range ports as rejected candidates", () => {
    const result = scanLoopbackWsEndpoints("bad ws://127.0.0.1:70000 only");
    expect(result.endpoint).toBeNull();
    expect(result.rejected).toEqual([
      { token: "ws://127.0.0.1:70000", reason: "port_out_of_range" },
    ]);
  });

  it("returns no rejections for structurally invalid input", () => {
    const result = scanLoopbackWsEndpoints("wss://example.com:1 ws://0.0.0.0:2");
    expect(result.endpoint).toBeNull();
    expect(result.rejected).toEqual([]);
  });
});
