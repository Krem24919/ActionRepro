/**
 * Minimal JSON-RPC 2.0 framing plus MCP handshake constants for the
 * stdio transport. Deliberately dependency-free: MCP over stdio is
 * newline-delimited JSON-RPC, which needs no framework.
 *
 * Targets MCP 2025-11-25 (latest stable at time of writing) and accepts
 * the earlier stable versions back to 2024-11-05 during `initialize`.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Hard cap per stdio line (10 MiB) — oversized chunks are rejected, never buffered forever. */
export const MAX_LINE_BYTES = 10 * 1024 * 1024;

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Classify one parsed JSON value as a request, a notification, or invalid. */
export function classifyMessage(value: unknown):
  | { kind: "request"; id: string | number; method: string; params: unknown }
  | {
      kind: "notification";
      method: string;
      params: unknown;
    }
  | { kind: "invalid" } {
  if (
    !isRecord(value) ||
    value["jsonrpc"] !== "2.0" ||
    typeof value["method"] !== "string"
  ) {
    return { kind: "invalid" };
  }
  if (
    "id" in value &&
    (typeof value["id"] === "string" || typeof value["id"] === "number")
  ) {
    return {
      kind: "request",
      id: value["id"],
      method: value["method"],
      params: value["params"],
    };
  }
  return { kind: "notification", method: value["method"], params: value["params"] };
}

/** Split buffered stdin text into complete lines; the tail may be partial. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

/** Negotiate the MCP protocol version: echo a supported client version, else our preferred one. */
export function negotiateVersion(clientVersion: unknown): string {
  if (
    typeof clientVersion === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion)
  ) {
    return clientVersion;
  }
  return PREFERRED_PROTOCOL_VERSION;
}

function oneLine(value: unknown): string {
  return JSON.stringify(value);
}

export function successLine(id: string | number | null, result: unknown): string {
  return oneLine({ jsonrpc: "2.0", id, result });
}

export function errorLine(
  id: string | number | null,
  code: number,
  message: string,
): string {
  return oneLine({ jsonrpc: "2.0", id, error: { code, message } });
}
