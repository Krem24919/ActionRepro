import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "../../src/mcp/server.js";
import { MCP_TOOLS } from "../../src/mcp/tools.js";
import { ErrorCodes } from "../../src/mcp/protocol.js";

const fx = (n: string) => path.join(process.cwd(), "fixtures/logs", n);

function req(id: number | string, method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });
}

function resOf(line: string | null): Record<string, unknown> {
  expect(line).not.toBeNull();
  return JSON.parse(line as string) as Record<string, unknown>;
}

describe("tool catalog", () => {
  it("exposes exactly the seven documented tools in stable order", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      "inspect",
      "reproduce",
      "verify",
      "fingerprint",
      "doctor",
      "history",
      "prove",
    ]);
  });

  it("gives every tool a description and a valid input schema", () => {
    for (const t of MCP_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeTypeOf("object");
    }
  });
});

describe("handshake", () => {
  it("negotiates versions and advertises tools capability", async () => {
    const s = new McpServer();
    const r = resOf(
      await s.handleLine(
        req(1, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        }),
      ),
    );
    const result = r["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2024-11-05");
    expect(result["capabilities"]).toEqual({ tools: {} });
    expect((result["serverInfo"] as Record<string, unknown>)["name"]).toBe("actionrepro");
  });

  it("answers ping and swallows notifications", async () => {
    const s = new McpServer();
    expect(resOf(await s.handleLine(req(2, "ping")))["result"]).toEqual({});
    expect(
      await s.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
    ).toBeNull();
  });

  it("lists the tools", async () => {
    const s = new McpServer();
    const r = resOf(await s.handleLine(req(3, "tools/list")));
    const tools = (r["result"] as Record<string, unknown>)["tools"] as Array<{
      name: string;
    }>;
    expect(tools.map((t) => t.name)).toEqual([
      "inspect",
      "reproduce",
      "verify",
      "fingerprint",
      "doctor",
      "history",
      "prove",
    ]);
  });
});

describe("protocol errors", () => {
  it("reports garbage, unknown methods, and unknown tools with ids", async () => {
    const s = new McpServer();
    expect(resOf(await s.handleLine("not json"))).toMatchObject({
      id: null,
      error: { code: ErrorCodes.ParseError },
    });
    expect(resOf(await s.handleLine(req(4, "nope/method")))).toMatchObject({
      id: 4,
      error: { code: ErrorCodes.MethodNotFound },
    });
    expect(
      resOf(await s.handleLine(req(5, "tools/call", { name: "nope", arguments: {} }))),
    ).toMatchObject({ id: 5, error: { code: ErrorCodes.InvalidParams } });
  });
});

describe("tool calls", () => {
  it("inspects a fixture log", async () => {
    const s = new McpServer();
    const r = resOf(
      await s.handleLine(
        req(10, "tools/call", {
          name: "inspect",
          arguments: { target: fx("npm-fail.log") },
        }),
      ),
    );
    const text = (
      (r["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>
    )[0].text;
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body["ecosystem"]).toBe("npm");
    expect(body["reproCommand"]).toBe("npm test");
  });

  it("fingerprints a fixture log with a stable hex id", async () => {
    const s = new McpServer();
    const again = new McpServer();
    const call = (srv: McpServer) =>
      srv.handleLine(
        req(11, "tools/call", {
          name: "fingerprint",
          arguments: { logFile: fx("npm-fail.log") },
        }),
      );
    const a = JSON.parse(
      (
        (resOf(await call(s))["result"] as Record<string, unknown>)["content"] as Array<{
          text: string;
        }>
      )[0].text,
    ) as Record<string, unknown>;
    const b = JSON.parse(
      (
        (resOf(await call(again))["result"] as Record<string, unknown>)[
          "content"
        ] as Array<{ text: string }>
      )[0].text,
    ) as Record<string, unknown>;
    expect(a["fingerprint"]).toMatch(/^[0-9a-f]{16}$/);
    expect(a["fingerprint"]).toBe(b["fingerprint"]);
    expect(a["exitCode"]).toBe(1);
  });

  it("reproduces into a bundle and verifies it, without executing", async () => {
    const s = new McpServer();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-mcp-"));
    const outDir = path.join(tmp, "bundle");
    const rep = resOf(
      await s.handleLine(
        req(12, "tools/call", {
          name: "reproduce",
          arguments: { target: fx("npm-fail.log"), outDir },
        }),
      ),
    );
    const repBody = JSON.parse(
      (
        (rep["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>
      )[0].text,
    ) as Record<string, unknown>;
    expect(repBody["outDir"]).toBe(outDir);
    expect(repBody["exitCode"]).toBeUndefined();
    expect(fs.existsSync(path.join(outDir, "repro.json"))).toBe(true);

    const ver = resOf(
      await s.handleLine(
        req(13, "tools/call", {
          name: "verify",
          arguments: { bundleDir: outDir, logFile: fx("npm-fail.log") },
        }),
      ),
    );
    const verBody = JSON.parse(
      (
        (ver["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>
      )[0].text,
    ) as Record<string, unknown>;
    expect(verBody["verdict"]).toBe("REPRODUCED");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("runs doctor and returns structured checks", async () => {
    const s = new McpServer();
    const r = resOf(
      await s.handleLine(req(14, "tools/call", { name: "doctor", arguments: {} })),
    );
    const body = JSON.parse(
      ((r["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>)[0]
        .text,
    ) as Record<string, unknown>;
    expect(typeof body["ok"]).toBe("boolean");
    expect(Array.isArray(body["checks"])).toBe(true);
  });

  it("returns isError results for bad arguments, never leaks tokens", async () => {
    const s = new McpServer();
    const bad = resOf(
      await s.handleLine(req(15, "tools/call", { name: "inspect", arguments: {} })),
    );
    expect((bad["result"] as Record<string, unknown>)["isError"]).toBe(true);

    const sentinel = "SENTINEL-TOKEN-XYZ-123";
    const r = resOf(
      await s.handleLine(
        req(16, "tools/call", {
          name: "inspect",
          arguments: { target: fx("npm-fail.log"), token: sentinel },
        }),
      ),
    );
    expect(JSON.stringify(r)).not.toContain(sentinel);
  });

  it("answers history lookup/stats/record/mark_fixed without touching HOME", async () => {
    const s = new McpServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-mcphist-"));
    const historyFile = path.join(dir, "h.jsonl");
    const call = async (id: number, args: Record<string, unknown>) => {
      const r = resOf(
        await s.handleLine(req(id, "tools/call", { name: "history", arguments: args })),
      );
      return JSON.parse(
        (
          (r["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>
        )[0].text,
      ) as Record<string, unknown>;
    };
    try {
      const st0 = await call(20, { action: "stats", historyFile });
      expect(st0["failureEvents"]).toBe(0);
      const rec = await call(21, {
        action: "record_log",
        logFile: fx("npm-fail.log"),
        historyFile,
      });
      const fp = (rec as Record<string, unknown>)["fingerprint"] as string;
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      const lk = await call(22, { action: "lookup", fingerprint: fp, historyFile });
      expect(lk["failures"]).toBe(1);
      expect(lk["stillFailing"]).toBe(true);
      await call(23, { action: "mark_fixed", fingerprint: fp, historyFile });
      const lk2 = await call(24, { action: "lookup", fingerprint: fp, historyFile });
      expect(lk2["stillFailing"]).toBe(false);
      const bad = resOf(
        await s.handleLine(
          req(25, "tools/call", { name: "history", arguments: { action: "lookup" } }),
        ),
      );
      expect((bad["result"] as Record<string, unknown>)["isError"]).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("proves still-failing and fixed through the server", async () => {
    const s = new McpServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-mcpprove-"));
    const historyFile = path.join(dir, "h.jsonl");
    const cleanLog = path.join(dir, "clean.log");
    fs.writeFileSync(cleanLog, "All tests passed.\n");
    const call = async (id: number, args: Record<string, unknown>) => {
      const r = resOf(
        await s.handleLine(req(id, "tools/call", { name: "prove", arguments: args })),
      );
      return JSON.parse(
        (
          (r["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>
        )[0].text,
      ) as Record<string, unknown>;
    };
    try {
      const rep = resOf(
        await s.handleLine(
          req(30, "tools/call", {
            name: "reproduce",
            arguments: { target: fx("npm-fail.log"), outDir: path.join(dir, "bundle") },
          }),
        ),
      );
      const outDir = (
        JSON.parse(
          (
            (rep["result"] as Record<string, unknown>)["content"] as Array<{
              text: string;
            }>
          )[0].text,
        ) as Record<string, unknown>
      )["outDir"] as string;
      const still = await call(31, {
        bundleDir: outDir,
        logFile: fx("npm-fail.log"),
        historyFile,
      });
      expect(still["state"]).toBe("still-failing");
      expect(still["historyRecorded"]).toBe(true);
      const fixed = await call(32, { bundleDir: outDir, logFile: cleanLog, historyFile });
      expect(fixed["state"]).toBe("fixed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reproduce run:true over MCP keeps stdout for JSON-RPC only", () => {
  it("captures the script output, returns its tail, and writes nothing else to stdout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-mcp-"));
    const log = path.join(dir, "exit5.log");
    fs.writeFileSync(
      log,
      [
        '2024-05-02T11:00:03.0000000Z ##[group]Run node -e "process.exit(5)"',
        '2024-05-02T11:00:03.0000000Z node -e "process.exit(5)"',
        "2024-05-02T11:00:04.0000000Z ##[error]Process completed with exit code 5.",
        "",
      ].join("\n"),
    );
    // The bundle installs dependencies in the current directory (npm ci for an
    // npm repo). Run from the temp dir so the repo under test is never touched.
    const repoCwd = process.cwd();
    process.chdir(dir);
    const writes: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const s = new McpServer();
      const r = resOf(
        await s.handleLine(
          req(9, "tools/call", {
            name: "reproduce",
            arguments: { target: log, outDir: path.join(dir, "bundle"), run: true },
          }),
        ),
      );
      const text = JSON.stringify(r);
      expect(text).toContain("REPRODUCED: command exited with code 5");
      const payload = JSON.parse(
        (
          (r["result"] as { content: Array<{ text: string }> }).content[0] as {
            text: string;
          }
        ).text,
      ) as { runOutputTail?: string; exitCode?: number };
      expect(payload.exitCode).toBe(5);
      expect(payload.runOutputTail).toContain("result: exit_code=5");
    } finally {
      (process.stdout as { write: unknown }).write = realWrite;
      process.chdir(repoCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(writes.join("")).not.toMatch(/REPRODUCED|actionrepro\] running/);
  });
});
