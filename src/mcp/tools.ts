/**
 * MCP tool catalog for ActionRepro. Each tool is a thin, strictly-validated
 * wrapper over the same command functions the CLI uses, so agents and humans
 * can never disagree about what a target means.
 *
 * Safety contract (also stated in every tool description):
 * - Nothing is executed unless the caller passes run:true to `reproduce`,
 *   and even then only after the principal (human) approves: MCP sessions
 *   are non-interactive, so the terminal confirmation gate is skipped there.
 * - Tokens are only ever sent to api.github.com and never appear in outputs.
 * - All log-derived text in outputs is already secret-redacted (best-effort).
 */

import fs from "node:fs";
import { inspectTarget } from "../commands/inspect.js";
import { reproduceTarget } from "../commands/reproduce.js";
import { verifyBundle } from "../commands/verify.js";
import { doctor } from "../commands/doctor.js";
import { loadLogsFromFile } from "../core/logs.js";
import { redactText } from "../core/redact.js";
import { extractFailure } from "../core/extract.js";
import { detectEcosystem } from "../core/ecosystems.js";
import { fingerprintFailure } from "../core/fingerprint.js";
import {
  lookup as historyLookup,
  markFixed as historyMarkFixed,
  recordBundle as historyRecordBundle,
  recordLog as historyRecordLog,
  stats as historyStats,
} from "../commands/history.js";
import { proveFix } from "../commands/prove.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: TextBlock[];
  isError?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** Thrown for bad tool arguments / tool-level failures → returned as isError result. */
export class ToolError extends Error {}

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function needStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ToolError(`"${key}" must be a non-empty string.`);
  }
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string.`);
  return v;
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolError(`"${key}" must be a boolean.`);
  return v;
}

function localProjectFiles(): string[] {
  try {
    return fs.readdirSync(process.cwd());
  } catch {
    return [];
  }
}

async function handleInspect(args: Record<string, unknown>): Promise<ToolResult> {
  const r = await inspectTarget({
    target: needStr(args, "target"),
    token: optStr(args, "token"),
  });
  return ok(r);
}

async function handleReproduce(args: Record<string, unknown>): Promise<ToolResult> {
  const r = await reproduceTarget({
    target: needStr(args, "target"),
    outDir: optStr(args, "outDir") ?? "actionrepro",
    run: optBool(args, "run") ?? false,
    token: optStr(args, "token"),
  });
  return ok(r);
}

async function handleVerify(args: Record<string, unknown>): Promise<ToolResult> {
  const r = await verifyBundle({
    bundleDir: needStr(args, "bundleDir"),
    logFile: needStr(args, "logFile"),
  });
  return ok(r);
}

async function handleFingerprint(args: Record<string, unknown>): Promise<ToolResult> {
  const logFile = needStr(args, "logFile");
  let loaded: { raw: string };
  try {
    loaded = loadLogsFromFile(logFile);
  } catch (err) {
    throw new ToolError(
      `Cannot read log file "${logFile}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const red = redactText(loaded.raw);
  const lines = red.text.split(/\r?\n/);
  const failure = extractFailure(lines);
  if (failure.errorLines.length === 0) {
    throw new ToolError(`No failure content found in "${logFile}".`);
  }
  const eco = detectEcosystem(lines, localProjectFiles());
  const fp = fingerprintFailure({
    ecosystem: eco.id,
    reproCommand: failure.reproCommand ?? eco.testCommand,
    exitCode: failure.exitCode,
    anchor: failure.anchor,
    errorKind: failure.errorKind,
  });
  const MAX_LINES = 20;
  return ok({
    logFile,
    fingerprint: fp,
    ecosystem: eco.id,
    ecosystemConfidence: eco.confidence,
    summary: failure.summary,
    reproCommand: failure.reproCommand ?? eco.testCommand,
    reproCommandSource: failure.reproCommand ? "log" : "ecosystem-default",
    exitCode: failure.exitCode ?? null,
    errorLines: failure.errorLines.slice(0, MAX_LINES),
    errorLinesTruncated: failure.errorLines.length > MAX_LINES,
    redactions: red.redactions,
  });
}

async function handleDoctor(args: Record<string, unknown>): Promise<ToolResult> {
  if (Object.keys(args).length > 0) {
    throw new ToolError(`"doctor" takes no arguments.`);
  }
  return ok(await doctor());
}

type HistoryAction = "lookup" | "stats" | "record_log" | "record_bundle" | "mark_fixed";

async function handleHistory(args: Record<string, unknown>): Promise<ToolResult> {
  const action = args["action"];
  if (
    action !== "lookup" &&
    action !== "stats" &&
    action !== "record_log" &&
    action !== "record_bundle" &&
    action !== "mark_fixed"
  ) {
    throw new ToolError(
      `"action" must be one of: lookup, stats, record_log, record_bundle, mark_fixed.`,
    );
  }
  const historyFile = optStr(args, "historyFile");
  const a: HistoryAction = action;
  if (a === "stats") return ok(historyStats(historyFile));
  if (a === "lookup") return ok(historyLookup(historyFile, needStr(args, "fingerprint")));
  if (a === "mark_fixed")
    return ok(historyMarkFixed(historyFile, needStr(args, "fingerprint")));
  if (a === "record_log") {
    return ok(
      historyRecordLog(historyFile, needStr(args, "logFile"), optStr(args, "source")),
    );
  }
  return ok(historyRecordBundle(historyFile, needStr(args, "bundleDir")));
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "inspect",
    description:
      "Analyze a failed GitHub Actions run URL or a local failure log WITHOUT writing files. " +
      "Returns ecosystem, failure summary, failing job/step, exit code, closest repro command, and redaction count. " +
      "Use this first to understand a failure. A 'token' argument (or GITHUB_TOKEN / GITLAB_TOKEN env) is only needed to download logs for run URLs; it is never echoed back.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "GitHub Actions run URL or local log file path.",
        },
        token: {
          type: "string",
          description: "GitHub token for private repos / log downloads. Optional.",
        },
      },
      required: ["target"],
    },
    handler: handleInspect,
  },
  {
    name: "reproduce",
    description:
      "Build a redacted local reproducibility bundle (reproduce.sh, reproduce.ps1, README, failure.txt, environment.txt, repro.json, bundle.sha256) for a failed run URL or log file. " +
      "Returns the bundle directory, files, summary, repro command, and failure fingerprint. " +
      "Set run:true ONLY with the principal's explicit approval: it executes the reproduced command on this machine without prompting (MCP sessions are non-interactive, so the terminal confirmation gate is skipped). Default run:false only writes files.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "GitHub Actions run URL or local log file path.",
        },
        outDir: {
          type: "string",
          description: "Bundle output directory. Default: actionrepro.",
        },
        run: {
          type: "boolean",
          description:
            "Execute the bundle after generating. Default false. Requires principal approval.",
        },
        token: {
          type: "string",
          description: "GitHub token for private repos / log downloads. Optional.",
        },
      },
      required: ["target"],
    },
    handler: handleReproduce,
  },
  {
    name: "verify",
    description:
      "Compare a fresh local log against a bundle's recorded failure fingerprint. " +
      "Verdicts: REPRODUCED (same failure), NOT_REPRODUCED (different failure — the fix may have worked or the failure changed), INCONCLUSIVE (bundle or log unreadable). " +
      "After attempting a fix, re-run the bundle command, save the output, and call this to check the result.",
    inputSchema: {
      type: "object",
      properties: {
        bundleDir: {
          type: "string",
          description: "Bundle directory created by the reproduce tool.",
        },
        logFile: {
          type: "string",
          description: "Fresh log file from a local re-run.",
        },
      },
      required: ["bundleDir", "logFile"],
    },
    handler: handleVerify,
  },
  {
    name: "fingerprint",
    description:
      "Compute the stable failure fingerprint (sha256 over ecosystem, command, exit code, normalized error lines) of a local log file without building a bundle. " +
      "Use it to compare two failures for sameness (equal fingerprints = same failure) or to track a failure across runs.",
    inputSchema: {
      type: "object",
      properties: {
        logFile: { type: "string", description: "Local failure log file path." },
      },
      required: ["logFile"],
    },
    handler: handleFingerprint,
  },
  {
    name: "doctor",
    description:
      "Check local requirements: Node/Python/Go/Rust toolchains, network reachability, and token presence. " +
      "Call this when runs fail for environmental reasons or before starting a reproduce/verify loop.",
    inputSchema: { type: "object", properties: {} },
    handler: handleDoctor,
  },
  {
    name: "history",
    description:
      "Failure history across runs, keyed by fingerprint. Actions: " +
      "lookup (occurrences, first/last seen, fixes, still-failing, what changed), " +
      "stats (whole-log summary with most frequent failures), " +
      "record_log (fingerprint a log file and store it as a failure), " +
      "record_bundle (store an existing bundle's fingerprint as a failure), " +
      "mark_fixed (record that a fingerprint was fixed). " +
      "Use lookup to answer 'is this the same failure as before?' before re-investigating.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "One of: lookup, stats, record_log, record_bundle, mark_fixed.",
        },
        fingerprint: {
          type: "string",
          description: "Required for lookup and mark_fixed.",
        },
        logFile: {
          type: "string",
          description: "Required for record_log: local failure log path.",
        },
        bundleDir: {
          type: "string",
          description: "Required for record_bundle: existing bundle directory.",
        },
        source: {
          type: "string",
          description: "Optional source label for record_log.",
        },
        historyFile: {
          type: "string",
          description: "History file path. Default ~/.actionrepro/history.jsonl.",
        },
      },
      required: ["action"],
    },
    handler: handleHistory,
  },
  {
    name: "prove",
    description:
      "Close the fix loop in one call: optionally execute the bundle (run:true, captured), " +
      "verify the fresh log against it, record the outcome in history, and report one state: " +
      "fixed, still-failing, changed-failure, inconclusive, or unable-to-reproduce. " +
      "The agent edits code between reproduce and prove; prove never edits code itself. " +
      "Set run:true ONLY with the principal's explicit approval (executes locally, non-interactive).",
    inputSchema: {
      type: "object",
      properties: {
        bundleDir: {
          type: "string",
          description: "Bundle directory created by the reproduce tool.",
        },
        logFile: {
          type: "string",
          description: "Fresh log file. Required unless run:true.",
        },
        run: {
          type: "boolean",
          description:
            "Execute the bundle and verify its output. Default false. Requires principal approval.",
        },
        runCwd: {
          type: "string",
          description: "Working directory for run (the repo under test).",
        },
        historyFile: {
          type: "string",
          description: "History file path. Default ~/.actionrepro/history.jsonl.",
        },
      },
      required: ["bundleDir"],
    },
    handler: async (args) =>
      ok(
        await proveFix({
          bundleDir: needStr(args, "bundleDir"),
          logFile: optStr(args, "logFile"),
          run: optBool(args, "run") ?? false,
          runCwd: optStr(args, "runCwd"),
          historyFile: optStr(args, "historyFile"),
        }),
      ),
  },
];

export function toolResultOrError(p: Promise<ToolResult>): Promise<ToolResult> {
  return p.catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

export { ok, fail };
