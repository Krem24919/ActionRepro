import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { MAX_LINE_BYTES } from "../../src/mcp/protocol.js";

const CLI = path.join(process.cwd(), "dist/cli.js");

/** Feed raw stdin text to `actionrepro mcp` and collect every stdout line until it exits. */
function session(stdin: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: string[] = [];
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP session timed out"));
    }, 60000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) if (p) out.push(p);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (buf) out.push(buf);
      resolve(out);
    });
    child.on("error", reject);
    child.stdin.end(stdin);
  });
}

describe("MCP stdio: oversize message handling (end-to-end)", () => {
  it("an 11 MiB line gets one error, its tail is not parsed as a second request, and the next request is answered", async () => {
    // Without discard mode the tail of the oversize line (`...}`) is parsed as a second request
    // and produces a stray "Invalid JSON." response.
    const pad = "x".repeat(11 * 1024 * 1024);
    const big = `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${pad}"}`;
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_LINE_BYTES);
    const lines = await session(`${big}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n`);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.error.code).toBe(-32700);
    expect(first.error.message).toMatch(/size limit/);
    const second = JSON.parse(lines[1]);
    expect(second.id).toBe(2);
    expect(second.result).toEqual({});
  }, 90000);

  it("every stdout line is valid JSON for a normal session", async () => {
    const lines = await session(
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '{"jsonrpc":"2.0","id":2,"method":"ping"}',
        "",
      ].join("\n"),
    );
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  }, 90000);
});
