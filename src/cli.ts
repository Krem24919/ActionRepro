#!/usr/bin/env node
import { Command } from "commander";
import { inspectTarget, formatInspectHuman } from "./commands/inspect.js";
import { reproduceTarget } from "./commands/reproduce.js";
import { doctor, formatDoctorHuman } from "./commands/doctor.js";
import { VERSION } from "./utils/version.js";
import { redactText } from "./core/redact.js";

const program = new Command();
program
  .name("actionrepro")
  .description("Turn a failed GitHub Actions run into a local reproducibility bundle.")
  .version(VERSION);

program
  .command("inspect <target>")
  .description("Analyze only: print failure summary without writing files.")
  .option("--token <token>", "GitHub token (or set GITHUB_TOKEN). Never printed.")
  .option("--json", "print machine-readable JSON", false)
  .action(async (target: string, opts: { token?: string; json: boolean }) => {
    try {
      const r = await inspectTarget({ target, token: opts.token, json: opts.json });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...r }, null, 2));
      else console.log(formatInspectHuman(r));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`error: ${redactText(msg).text}`);
      process.exitCode = 1;
    }
  });

program
  .command("reproduce <target>")
  .description("Create the actionrepro bundle, optionally execute it.")
  .option("--out <dir>", "output directory", "actionrepro")
  .option("--run", "execute reproduce.sh after generating", false)
  .option("--token <token>", "GitHub token (or set GITHUB_TOKEN). Never printed.")
  .option("--json", "print machine-readable JSON", false)
  .action(
    async (
      target: string,
      opts: { out: string; run: boolean; token?: string; json: boolean },
    ) => {
      try {
        const res = await reproduceTarget({
          target,
          outDir: opts.out,
          run: opts.run,
          token: opts.token,
        });
        if (opts.json) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
        else {
          console.log(`failure: ${safeOut(res.summary)}`);
          console.log(`ecosystem: ${res.ecosystem}`);
          console.log(`repro command: ${res.reproCommand ?? "(none)"}`);
          console.log(`bundle: ${res.outDir}/`);
          for (const f of res.files) console.log(`  - ${f}`);
          console.log(`redactions: ${res.redactions}`);
          if (opts.run) console.log(`reproduce exit code: ${res.exitCode ?? "?"}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`error: ${redactText(msg).text}`);
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
      console.log(formatDoctorHuman(r));
      if (!r.ok) process.exitCode = 1;
    }
  });

// Default shorthand: `actionrepro <url|file> [--out dir] [--run] [--token T] [--json]`
// Handled manually (not via commander program-action) because a program-level
// action+options breaks subcommand option parsing in commander.
async function handleDefaultShorthand(argv: string[]): Promise<boolean> {
  const first = argv[0];
  if (!first) return false;
  if (
    [
      "inspect",
      "reproduce",
      "doctor",
      "help",
      "-h",
      "--help",
      "-V",
      "--version",
    ].includes(first)
  ) {
    return false;
  }
  if (first.startsWith("-")) return false;
  const parsed = parseDefaultArgs(argv);
  try {
    const res = await reproduceTarget({
      target: parsed.target,
      outDir: parsed.out,
      run: parsed.run,
      token: parsed.token,
    });
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, ...res, files: res.files }, null, 2));
    } else {
      console.log(`failure: ${safeOut(res.summary)}`);
      console.log(`ecosystem: ${res.ecosystem}`);
      console.log(`repro command: ${res.reproCommand ?? "(none)"}`);
      console.log(`bundle: ${res.outDir}/`);
      for (const f of res.files) console.log(`  - ${f}`);
      console.log(`redactions: ${res.redactions}`);
      if (parsed.run) console.log(`reproduce exit code: ${res.exitCode ?? "?"}`);
      else
        console.log(
          `tip: run ${displayScriptPath(res.outDir)}  (or: actionrepro reproduce "${parsed.target}" --run)`,
        );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${redactText(msg).text}`);
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
  return redactText(s).text;
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
  console.error(`error: ${redactText(String(e?.message ?? e)).text}`);
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
  console.error(`error: ${redactText(String(e?.message ?? e)).text}`);
  process.exit(1);
});
