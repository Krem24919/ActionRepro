/**
 * MCP server over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout,
 * all logging on stderr (the spec allows stdio servers to use stderr).
 *
 * Supported methods: initialize, ping, tools/list, tools/call.
 * Everything else: MethodNotFound (-32601). Tool-level failures
 * (bad arguments, unreadable files) are Tool Execution Errors
 * ({isError:true} results), never protocol errors.
 */

import { VERSION } from "../utils/version.js";
import {
  ErrorCodes,
  MAX_LINE_BYTES,
  PREFERRED_PROTOCOL_VERSION,
  classifyMessage,
  errorLine,
  negotiateVersion,
  splitLines,
  successLine,
} from "./protocol.js";
import {
  MCP_TOOLS,
  toolResultOrError,
  type McpToolDef,
  type ToolResult,
} from "./tools.js";

export const SERVER_NAME = "actionrepro";

const INSTRUCTIONS =
  "ActionRepro turns failed GitHub Actions runs into redacted local reproducibility bundles. " +
  "Typical agent loop: inspect a failure, reproduce it into a bundle, edit code, re-run the bundle command, verify the fresh log. " +
  "Never pass run:true to reproduce without the principal's explicit approval.";

export class McpServer {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly tools: McpToolDef[] = MCP_TOOLS) {}

  /** Handle one complete input line; returns the response line, or null for notifications. */
  async handleLine(line: string): Promise<string | null> {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      return errorLine(null, ErrorCodes.ParseError, "Message exceeds size limit.");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return errorLine(null, ErrorCodes.ParseError, "Invalid JSON.");
    }
    const msg = classifyMessage(value);
    if (msg.kind === "invalid") {
      return errorLine(null, ErrorCodes.InvalidRequest, "Not a JSON-RPC 2.0 request.");
    }
    if (msg.kind === "notification") {
      // notifications/initialized and anything else: acknowledge silently.
      // Requests are answered even before `initialize` (lenient by design).
      return null;
    }
    switch (msg.method) {
      case "initialize":
        return successLine(msg.id, this.handleInitialize(msg.params));
      case "ping":
        return successLine(msg.id, {});
      case "tools/list":
        return successLine(msg.id, {
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call":
        try {
          return successLine(msg.id, await this.handleToolCall(msg.params));
        } catch (err) {
          if (err instanceof McpProtocolError) {
            return errorLine(msg.id, ErrorCodes.InvalidParams, err.message);
          }
          throw err;
        }
      default:
        return errorLine(
          msg.id,
          ErrorCodes.MethodNotFound,
          `Unknown method: ${msg.method}.`,
        );
    }
  }

  private handleInitialize(params: unknown): Record<string, unknown> {
    const version =
      params !== null && typeof params === "object" && "protocolVersion" in params
        ? negotiateVersion((params as Record<string, unknown>)["protocolVersion"])
        : PREFERRED_PROTOCOL_VERSION;
    return {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions: INSTRUCTIONS,
    };
  }

  private async handleToolCall(params: unknown): Promise<ToolResult> {
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return toolErrorResult(
        "tools/call params must be an object with name and arguments.",
      );
    }
    const p = params as Record<string, unknown>;
    if (typeof p["name"] !== "string") {
      return toolErrorResult('tools/call requires a string "name".');
    }
    const tool = this.tools.find((t) => t.name === p["name"]);
    if (!tool) {
      // Unknown tool: this is a protocol-level addressing error, not a tool failure.
      throw new McpProtocolError(`Unknown tool: ${p["name"]}.`);
    }
    const args =
      p["arguments"] === undefined || p["arguments"] === null ? {} : p["arguments"];
    if (typeof args !== "object" || Array.isArray(args)) {
      return toolErrorResult('tools/call "arguments" must be an object.');
    }
    return toolResultOrError(tool.handler(args as Record<string, unknown>));
  }

  /** Serialize handling so concurrent arrivals never interleave stdout writes. */
  enqueue(line: string): Promise<string | null> {
    const run = this.queue.then(() => this.handleLine(line));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Internal marker: unknown tool names surface as JSON-RPC errors, not tool results. */
export class McpProtocolError extends Error {}

function toolErrorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Run the server on stdio. Resolves when stdin closes. Logs go to stderr;
 * stdout carries exactly one JSON-RPC message per line.
 */
export async function runMcpStdio(server: McpServer = new McpServer()): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  // After an oversized message we answer once, then drop the rest of that message up to its
  // newline. Without this, the tail of the message would be parsed as a second, bogus request.
  let discarding = false;
  const flushLine = async (line: string): Promise<void> => {
    if (line === "") return;
    // handleLine only throws on unexpected internal failures; protocol-level
    // problems always come back as response lines (with the request id).
    const out = await server.enqueue(line);
    if (out !== null) process.stdout.write(`${out}\n`);
  };
  for await (const chunk of process.stdin) {
    let data = chunk as string;
    if (discarding) {
      const nl = data.indexOf("\n");
      if (nl === -1) continue; // still inside the oversized message
      data = data.slice(nl + 1);
      discarding = false;
    }
    const { lines, rest } = splitLines(buffer + data);
    buffer = rest;
    for (const line of lines) await flushLine(line);
    // Code units are a lower bound for UTF-8 bytes, so only measure bytes when the length is close.
    if (
      buffer.length * 3 > MAX_LINE_BYTES &&
      Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES
    ) {
      process.stdout.write(
        `${errorLine(null, ErrorCodes.ParseError, "Input exceeds size limit.")}\n`,
      );
      buffer = "";
      discarding = true;
    }
  }
  if (discarding) return;
  const tail = buffer.trim();
  if (tail) await flushLine(tail);
}
