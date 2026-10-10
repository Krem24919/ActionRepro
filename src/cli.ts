#!/usr/bin/env node
import { Command } from "commander";
import { inspectTarget, formatInspectHuman } from "./commands/inspect.js";
import { reproduceTarget } from "./commands/reproduce.js";
import { verifyBundle, formatVerifyHuman } from "./commands/verify.js";
import { doctor, formatDoctorHuman } from "./commands/doctor.js";
import { runMcpStdio } from "./mcp/server.js";
import {
  lookup as historyLookup,
  markFixed as historyMarkFixed,
  recordBundle as historyRecordBundle,
  recordLog as historyRecordLog,
  stats as historyStats,
  formatLookupHuman,
  formatStatsHuman,
} from "./commands/history.js";
import { proveFix, formatProveHuman } from "./commands/prove.js";
import { VERSION } from "./utils/version.js";
import { redactText } from "./core/redact.js";
import { sanitizeActionsOutput } from "./utils/log.js";

const program = new Command();
program
  .name("actionrepro")
  .description("Turn a failed GitHub Actions run into a local reproducibility bundle.")
  .version(VERSION);

// `--token` puts the secret in argv, visible to other users via `ps`.
// Nudge toward the environment-variable chain instead (never printed either).
export function warnArgvToken(): void {
  console.error(
    "warning: --token exposes the secret in the process list; " +
      "prefer the GITHUB_TOKEN / GITLAB_TOKEN environment variable.",
  );
}
program.hook("preAction", (_thisCommand, actionCommand) => {
  if (actionCommand.opts().token) warnArgvToken();
});

program
  .command("inspect <target>")
  .description("Analyze only: print failure summary without writing files.")
  .option(
    "--token <token>",
    "API token: GitHub (or GITHUB_TOKEN) / GitLab (or GITLAB_TOKEN). Never printed.",
  )
  .option("--json", "print machine-readable JSON", false)
  .action(async (target: string, opts: { token?: string; json: boolean }) => {
    try {
      const r = await inspectTarget({ target, token: opts.token, json: opts.json });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...r }, null, 2));
      else console.log(sanitizeActionsOutput(formatInspectHuman(r)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(sanitizeActionsOutput(`error: ${redactText(msg).text}`));
      process.exitCode = 1;
    }
  });

program
  .command("reproduce <target>")
  .description("Create the actionrepro bundle, optionally execute it.")
  .option("--out <dir>", "output directory", "actionrepro")
  .option("--run", "execute reproduce.sh after generating", false)
  .option(
    "--token <token>",
    "API token: GitHub (or GITHUB_TOKEN) / GitLab (or GITLAB_TOKEN). Never printed.",
  )
  .option("--json", "print machine-readable JSON", false)
  .action(
    async (
      target: string,
      opts: { out: string; run: boolean; token?: string; json: boolean },
    ) => {
      try {
        if (opts.run) printRunWarning();
        const res = await reproduceTarget({
          target,
          outDir: opts.out,
          run: opts.run,
          token: opts.token,
        });
        if (opts.json) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
        else {
          printResultHead();
          console.log(`  failure: ${safeOut(res.summary)}`);
          console.log(`  ecosystem: ${res.ecosystem}`);
          console.log(`  repro command: ${safeOut(res.reproCommand ?? "(none)")}`);
          console.log(`  bundle: ${res.outDir}/`);
          for (const f of res.files) console.log(`    - ${f}`);
          console.log(`  redactions: ${res.redactions}`);
          if (opts.run) console.log(`  reproduce exit code: ${res.exitCode ?? "?"}`);
        }
        // With --run the bundle's exit code is the command's exit code (see
        // ARCHITECTURE.md "Exit codes are a contract"); CI can gate on it.
        if (opts.run && res.exitCode !== undefined) process.exitCode = res.exitCode;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(sanitizeActionsOutput(`error: ${redactText(msg).text}`));
        process.exitCode = 1;
      }
    },
  );

program
  .command("doctor")
  .description("Check local requirements (toolchains, network, token presence).")
  .option("--json", "print machine-readable JSON", false)
  .action(async (opts: { json: boolean }) => {
    const r = await doctor();
    if (opts.json) console.log(JSON.stringify({ ok: r.ok, checks: r.checks }, null, 2));
    else {
      console.log(sanitizeActionsOutput(formatDoctorHuman(r)));
      if (!r.ok) process.exitCode = 1;
    }
  });

program
  .command("verify <bundle> <logfile>")
  .description(
    "Compare a fresh local log against a bundle fingerprint: REPRODUCED, NOT_REPRODUCED, or INCONCLUSIVE.",
  )
  .option("--json", "print machine-readable JSON", false)
  .action(async (bundle: string, logfile: string, opts: { json: boolean }) => {
    try {
      const r = await verifyBundle({ bundleDir: bundle, logFile: logfile });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...r }, null, 2));
      else console.log(sanitizeActionsOutput(formatVerifyHuman(r)));
      // Same exit contract for humans and machines: --json must not change CI gating.
      process.exitCode =
        r.verdict === "REPRODUCED" ? 0 : r.verdict === "NOT_REPRODUCED" ? 1 : 2;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(sanitizeActionsOutput(`error: ${redactText(msg).text}`));
      process.exitCode = 1;
    }
  });

program
  .command("mcp")
  .description("Run as an MCP server over stdio (for coding agents).")
  .action(async () => {
    await runMcpStdio();
  });

program
  .command("prove <bundle> [logfile]")
  .description(
    "Verify a fix: optionally run the bundle, verify the fresh log, record history, report the state.",
  )
  .option("--run", "execute the bundle and verify its captured output", false)
  .option("--cwd <dir>", "working directory for --run (the repo under test)")
  .option("--history-file <file>", "history file (default ~/.actionrepro/history.jsonl)")
  .option("--json", "print machine-readable JSON", false)
  .action(
    async (
      bundle: string,
      logfile: string | undefined,
      opts: { run: boolean; cwd?: string; historyFile?: string; json: boolean },
    ) => {
      try {
        const r = await proveFix({
          bundleDir: bundle,
          logFile: logfile,
          run: opts.run,
          runCwd: opts.cwd,
          historyFile: opts.historyFile,
        });
        if (opts.json) console.log(JSON.stringify({ ok: true, ...r }, null, 2));
        else console.log(sanitizeActionsOutput(formatProveHuman(r)));
        process.exitCode =
          r.state === "fixed"
            ? 0
            : r.state === "inconclusive" || r.state === "unable-to-reproduce"
              ? 2
              : 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(sanitizeActionsOutput(`error: ${redactText(msg).text}`));
        process.exitCode = 1;
      }
    },
  );

program
  .command("history")
  .description("Record and query failure history across runs.")
  .option("--history-file <file>", "history file (default ~/.actionrepro/history.jsonl)")
  .option("--lookup <fingerprint>", "show occurrences of a fingerprint")
  .option("--stats", "summarize the whole history", false)
  .option("--record-log <file>", "fingerprint a log and record it as a failure")
  .option("--record-bundle <dir>", "record an existing bundle's fingerprint as a failure")
  .option("--mark-fixed <fingerprint>", "record a fix for a fingerprint")
  .option("--source <label>", "source label for --record-log")
  .option("--json", "print machine-readable JSON", false)
  .action(
    async (opts: {
      historyFile?: string;
      lookup?: string;
      stats: boolean;
      recordLog?: string;
      recordBundle?: string;
      markFixed?: string;
      source?: string;
      json: boolean;
    }) => {
      try {
        const picked = [
          opts.lookup && "lookup",
          opts.stats && "stats",
          opts.recordLog && "record-log",
          opts.recordBundle && "record-bundle",
          opts.markFixed && "mark-fixed",
        ].filter(Boolean);
        const action = picked.length === 0 ? "stats" : picked[0];
        if (picked.length > 1) {
          throw new Error(
            `Pick one history action (${picked.join(", ")} given). See --help.`,
          );
        }
        if (action === "lookup") {
          const r = historyLookup(opts.historyFile, opts.lookup as string);
          if (opts.json) console.log(JSON.stringify({ ok: true, ...r }, null, 2));
          else console.log(sanitizeActionsOutput(formatLookupHuman(r)));
        } else if (action === "stats") {
          const r = historyStats(opts.historyFile);
          if (opts.json) console.log(JSON.stringify({ ok: true, ...r }, null, 2));
          else console.log(sanitizeActionsOutput(formatStatsHuman(r)));
        } else if (action === "record-log") {
          const r = historyRecordLog(
            opts.historyFile,
            opts.recordLog as string,
            opts.source,
          );
          if (opts.json) console.log(JSON.stringify({ ok: true, entry: r }, null, 2));
          else console.log(`recorded failure ${r.fingerprint} (${r.ts})`);
        } else if (action === "record-bundle") {
          const r = historyRecordBundle(opts.historyFile, opts.recordBundle as string);
          if (opts.json) console.log(JSON.stringify({ ok: true, entry: r }, null, 2));
          else console.log(`recorded failure ${r.fingerprint} (${r.ts})`);
        } else {
          const r = historyMarkFixed(opts.historyFile, opts.markFixed as string);
          if (opts.json) console.log(JSON.stringify({ ok: true, entry: r }, null, 2));
          else console.log(`recorded fix for ${r.fingerprint} (${r.ts})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(sanitizeActionsOutput(`error: ${redactText(msg).text}`));
        process.exitCode = 1;
      }
    },
  );

// Default shorthand: `actionrepro <url|file> [--out dir] [--run] [--token T] [--json]`
// Handled manually (not via commander program-action) because a program-level
// action+options breaks subcommand option parsing in commander.
// IMPORTANT: every `program.command(...)` name below MUST also appear in
// KNOWN_SUBCOMMANDS, or the shorthand dispatcher will swallow it as a target.
const KNOWN_SUBCOMMANDS = [
  "inspect",
  "reproduce",
  "doctor",
  "verify",
  "mcp",
  "history",
  "prove",
];
async function handleDefaultShorthand(argv: string[]): Promise<boolean> {
  const first = argv[0];
  if (!first) return false;
  if ([...KNOWN_SUBCOMMANDS, "help", "-h", "--help", "-V", "--version"].includes(first)) {
    return false;
  }
  if (first.startsWith("-")) return false;
  const parsed = parseDefaultArgs(argv);
  try {
    if (parsed.run) printRunWarning();
    if (parsed.token) warnArgvToken();
    const res = await reproduceTarget({
      target: parsed.target,
      outDir: parsed.out,
      run: parsed.run,
      token: parsed.token,
    });
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, ...res, files: res.files }, null, 2));
    } else {
      printResultHead();
      console.log(`  failure: ${safeOut(res.summary)}`);
      console.log(`  ecosystem: ${res.ecosystem}`);
      console.log(`  repro command: ${safeOut(res.reproCommand ?? "(none)")}`);
      console.log(`  bundle: ${res.outDir}/`);
      for (const f of res.files) console.log(`    - ${f}`);
      console.log(`  redactions: ${res.redactions}`);
      if (parsed.run) console.log(`  reproduce exit code: ${res.exitCode ?? "?"}`);
      else
        console.log(
          sanitizeActionsOutput(
            `  tip: run ${displayScriptPath(res.outDir)}  (or: actionrepro reproduce "${parsed.target}" --run)`,
          ),
        );
    }
    if (parsed.run && res.exitCode !== undefined) process.exitCode = res.exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(sanitizeActionsOutput(`error: ${redactText(msg).text}`));
    process.exitCode = 1;
  }
  return true;
}

function parseDefaultArgs(argv: string[]): {
  target: string;
  out: string;
  run: boolean;
  token?: string;
  json: boolean;
} {
  let target = "";
  let out = "actionrepro";
  let run = false;
  let token: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" && i + 1 < argv.length) {
      out = argv[++i];
    } else if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
    } else if (a === "--run") {
      run = true;
    } else if (a === "--token" && i + 1 < argv.length) {
      token = argv[++i];
    } else if (a.startsWith("--token=")) {
      token = a.slice("--token=".length);
    } else if (a === "--json") {
      json = true;
    } else if (!a.startsWith("-") && !target) {
      target = a;
    }
  }
  if (!target) {
    console.error(
      "error: missing target. Provide a GitHub Actions run URL or log file path.",
    );
    process.exit(1);
  }
  return { target, out, run, token, json };
}

function safeOut(s: string): string {
  return sanitizeActionsOutput(redactText(s).text);
}

function printResultHead(): void {
  console.log("ActionRepro result");
}

function printRunWarning(): void {
  console.log(
    sanitizeActionsOutput(
      "warning: --run executes the CI-extracted command on this machine. " +
        "The script asks for confirmation on interactive terminals; " +
        "non-interactive shells run without prompting (set CI_REPRO_YES=1 to pre-approve).",
    ),
  );
}

function stripDotSlash(p: string): string {
  return p.replace(/^\.\//, "");
}

function displayScriptPath(outDir: string): string {
  const clean = stripDotSlash(outDir);
  const script = `${clean}/reproduce.sh`;
  return clean.startsWith("/") ? script : `./${script}`;
}

// Avoid printing token if Node passes it through env in stack traces.
process.on("uncaughtException", (e) => {
  console.error(
    sanitizeActionsOutput(`error: ${redactText(String(e?.message ?? e)).text}`),
  );
  process.exit(1);
});

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw.length === 0) {
    program.help();
    return;
  }
  if (await handleDefaultShorthand(raw)) return;
  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error(
    sanitizeActionsOutput(`error: ${redactText(String(e?.message ?? e)).text}`),
  );
  process.exit(1);
});
