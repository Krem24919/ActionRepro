import { describe, it, expect } from "vitest";
import { McpServer, SERVER_NAME } from "../../src/mcp/server.js";
import { MCP_TOOLS } from "../../src/mcp/tools.js";
import { MAX_LINE_BYTES } from "../../src/mcp/protocol.js";
import { VERSION } from "../../src/utils/version.js";

const server = new McpServer();
const call = async (msg: unknown) => {
  const out = await server.handleLine(
    typeof msg === "string" ? msg : JSON.stringify(msg),
  );
  return out === null ? null : JSON.parse(out);
};

describe("McpServer.handleLine", () => {
  it("answers initialize with the server name and version", async () => {
    const r = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(r.id).toBe(1);
    expect(r.result.serverInfo).toEqual({ name: SERVER_NAME, version: VERSION });
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(typeof r.result.instructions).toBe("string");
  });

  it("initialize without params uses the preferred protocol version", async () => {
    const r = await call({ jsonrpc: "2.0", id: 2, method: "initialize" });
    expect(typeof r.result.protocolVersion).toBe("string");
  });

  it("ping returns an empty result", async () => {
    expect(await call({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });
  });

  it("tools/list exposes every tool with name, description and schema", async () => {
    const r = await call({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual(
      MCP_TOOLS.map((t) => t.name),
    );
    for (const t of r.result.tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
    }
  });

  it("notifications produce no response", async () => {
    expect(
      await call({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
  });

  it("an unknown method returns MethodNotFound (-32601)", async () => {
    const r = await call({ jsonrpc: "2.0", id: 5, method: "nope/nope" });
    expect(r.error.code).toBe(-32601);
    expect(r.error.message).toContain("nope/nope");
  });

  it("invalid JSON returns ParseError (-32700) with a null id", async () => {
    const r = await call("{not json");
    expect(r.error.code).toBe(-32700);
    expect(r.id).toBeNull();
  });

  it("a non-request JSON value returns InvalidRequest (-32600)", async () => {
    const r = await call({ hello: "world" });
    expect(r.error.code).toBe(-32600);
  });

  it("an oversize line is rejected before parsing", async () => {
    const huge = `{"jsonrpc":"2.0","id":9,"method":"ping","pad":"${"x".repeat(MAX_LINE_BYTES)}"}`;
    const r = await call(huge);
    expect(r.error.code).toBe(-32700);
    expect(r.error.message).toMatch(/size limit/);
  });

  it("tools/call with a non-string name is a tool error result, not a protocol error", async () => {
    const r = await call({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: 42 },
    });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/string "name"/);
  });

  it("tools/call with params that are not an object is a tool error result", async () => {
    const r = await call({ jsonrpc: "2.0", id: 7, method: "tools/call", params: [1, 2] });
    expect(r.result.isError).toBe(true);
  });

  it("tools/call with an unknown tool is a JSON-RPC InvalidParams error", async () => {
    const r = await call({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "does_not_exist" },
    });
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toContain("does_not_exist");
  });

  it("tools/call with non-object arguments is a tool error result", async () => {
    const name = MCP_TOOLS[0].name;
    const r = await call({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name, arguments: "oops" },
    });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/must be an object/);
  });

  it("requests are answered even before initialize", async () => {
    expect((await call({ jsonrpc: "2.0", id: 11, method: "ping" })).result).toEqual({});
  });

  it("enqueue serializes concurrent requests and keeps order", async () => {
    const results = await Promise.all([
      server.enqueue(JSON.stringify({ jsonrpc: "2.0", id: "a", method: "ping" })),
      server.enqueue(JSON.stringify({ jsonrpc: "2.0", id: "b", method: "ping" })),
      server.enqueue(JSON.stringify({ jsonrpc: "2.0", id: "c", method: "ping" })),
    ]);
    expect(results.map((r) => JSON.parse(r as string).id)).toEqual(["a", "b", "c"]);
  });
});
