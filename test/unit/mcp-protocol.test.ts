import { describe, it, expect } from "vitest";
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  PREFERRED_PROTOCOL_VERSION,
  ErrorCodes,
  classifyMessage,
  splitLines,
  negotiateVersion,
  successLine,
  errorLine,
} from "../../src/mcp/protocol.js";

describe("negotiateVersion", () => {
  it.each(SUPPORTED_PROTOCOL_VERSIONS)("echoes supported version %s", (v) => {
    expect(negotiateVersion(v)).toBe(v);
  });

  it("falls back to preferred for unknown, missing, or non-string versions", () => {
    expect(negotiateVersion("1999-01-01")).toBe(PREFERRED_PROTOCOL_VERSION);
    expect(negotiateVersion(undefined)).toBe(PREFERRED_PROTOCOL_VERSION);
    expect(negotiateVersion(42)).toBe(PREFERRED_PROTOCOL_VERSION);
    expect(negotiateVersion(null)).toBe(PREFERRED_PROTOCOL_VERSION);
  });
});

describe("splitLines", () => {
  it("splits complete lines and keeps the partial tail", () => {
    expect(splitLines("a\nb\npartial")).toEqual({ lines: ["a", "b"], rest: "partial" });
    expect(splitLines("")).toEqual({ lines: [], rest: "" });
    expect(splitLines("x\n")).toEqual({ lines: ["x"], rest: "" });
  });
});

describe("classifyMessage", () => {
  it("recognizes requests", () => {
    const m = classifyMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(m).toEqual({ kind: "request", id: 1, method: "ping", params: undefined });
  });

  it("recognizes string ids and notifications", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: "a", method: "x" }).kind).toBe(
      "request",
    );
    expect(
      classifyMessage({ jsonrpc: "2.0", method: "notifications/initialized" }).kind,
    ).toBe("notification");
  });

  it("rejects garbage, arrays, and wrong versions", () => {
    expect(classifyMessage(null).kind).toBe("invalid");
    expect(classifyMessage("x").kind).toBe("invalid");
    expect(classifyMessage([1, 2]).kind).toBe("invalid");
    expect(classifyMessage({ jsonrpc: "2.0" }).kind).toBe("invalid");
    expect(classifyMessage({ jsonrpc: "1.0", id: 1, method: "x" }).kind).toBe("invalid");
    expect(classifyMessage({ jsonrpc: "2.0", id: null, method: "x" }).kind).toBe(
      "notification",
    );
  });
});

describe("response lines", () => {
  it("are single-line JSON-RPC with the right shapes", () => {
    const ok = successLine(7, { a: 1 });
    expect(ok).not.toContain("\n");
    expect(JSON.parse(ok)).toEqual({ jsonrpc: "2.0", id: 7, result: { a: 1 } });
    const err = errorLine("x", ErrorCodes.MethodNotFound, "nope");
    expect(err).not.toContain("\n");
    expect(JSON.parse(err)).toEqual({
      jsonrpc: "2.0",
      id: "x",
      error: { code: -32601, message: "nope" },
    });
  });
});
