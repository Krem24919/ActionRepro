import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const CLI = path.join(ROOT, "dist/cli.js");
const FX = path.join(ROOT, "fixtures/logs/npm-fail.log");

/** Run a full MCP-over-stdio session against the built CLI; resolves response lines. */
function mcpSession(lines: string[], timeoutMs = 60000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: string[] = [];
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP session timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) if (p) out.push(p);
    });
    child.stderr.setEncoding("utf8");
    let errText = "";
    child.stderr.on("data", (d: string) => {
      errText += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) out.push(buf.trim());
      if (code !== 0) {
        reject(new Error(`mcp exited ${code}: ${errText.slice(0, 500)}`));
        return;
      }
      resolve(out);
    });
    for (const l of lines) child.stdin.write(`${l}\n`);
    child.stdin.end();
  });
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
};

describe("MCP over stdio (built CLI)", () => {
  it("completes handshake, lists tools, and inspects a fixture", async () => {
    const out = await mcpSession([
      JSON.stringify(init),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "inspect", arguments: { target: FX } },
      }),
    ]);
    expect(out.length).toBe(3);
    const hello = JSON.parse(out[0]) as Record<string, unknown>;
    expect((hello["result"] as Record<string, unknown>)["protocolVersion"]).toBe(
      "2025-11-25",
    );
    const list = JSON.parse(out[1]) as Record<string, unknown>;
    const names = (
      (list["result"] as Record<string, unknown>)["tools"] as Array<{ name: string }>
    ).map((t) => t.name);
    expect(names).toContain("verify");
    const call = JSON.parse(out[2]) as Record<string, unknown>;
    const text = (
      (call["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>
    )[0].text;
    expect(JSON.parse(text) as Record<string, unknown>).toMatchObject({
      ecosystem: "npm",
    });
  });

  it("stdout carries only JSON-RPC (logs stay on stderr)", async () => {
    const out = await mcpSession([
      JSON.stringify(init),
      "this is not json",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "bogus" },
      }),
    ]);
    expect(out.length).toBe(3);
    for (const l of out) expect(() => JSON.parse(l)).not.toThrow();
    expect((JSON.parse(out[1]) as Record<string, unknown>)["error"]).toBeDefined();
    expect((JSON.parse(out[2]) as Record<string, unknown>)["error"]).toBeDefined();
  });
});
