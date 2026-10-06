import fs from "node:fs";
import path from "node:path";
import { parseGitHubRunUrl } from "../core/url.js";
import { GitHubActionsProvider } from "../providers/github-actions.js";
import { loadLogsFromFile } from "../core/logs.js";
import { redactText } from "../core/redact.js";
import { extractFailure } from "../core/extract.js";
import { detectEcosystem } from "../core/ecosystems.js";
import { detectRuntime } from "../core/runtime.js";
import { createBundle } from "../core/bundle.js";
import { runReproduceScript } from "../core/runner.js";
import { allLogsFailed, firstLogError, resolveToken } from "../core/github.js";
import type { CiFetchResult } from "../providers/types.js";

function failingJobFrom(fetched: CiFetchResult): string | undefined {
  return fetched.jobs.find((j) => j.conclusion === "failure")?.name;
}

export interface ReproduceOptions {
  target: string;
  outDir?: string;
  run?: boolean;
  token?: string;
}

export interface ReproduceResult {
  outDir: string;
  files: string[];
  summary: string;
  reproCommand?: string;
  ecosystem: string;
  redactions: number;
  exitCode?: number;
}

function localProjectFiles(): string[] {
  try {
    return fs.readdirSync(process.cwd());
  } catch {
    return [];
  }
}

export async function reproduceTarget(opts: ReproduceOptions): Promise<ReproduceResult> {
  const outDir = path.resolve(opts.outDir ?? "actionrepro");
  const token = resolveToken(opts.token);

  if (fs.existsSync(opts.target) && fs.statSync(opts.target).isFile()) {
    const loaded = loadLogsFromFile(opts.target);
    const red = redactText(loaded.raw);
    const lines = red.text.split(/\r?\n/);
    const failure = extractFailure(lines);
    const eco = detectEcosystem(lines, localProjectFiles());
    const runtime = detectRuntime(lines);
    const bundle = createBundle(
      {
        sourceDisplay: opts.target,
        ecosystem: eco,
        runtime,
        failure,
        redactedLogs: red.text,
        redactions: red.redactions,
      },
      outDir,
    );
    let exitCode: number | undefined;
    if (opts.run) exitCode = runReproduceScript(outDir);
    return {
      outDir,
      files: bundle.files,
      summary: failure.summary,
      reproCommand: failure.reproCommand ?? eco.testCommand,
      ecosystem: eco.id,
      redactions: red.redactions,
      exitCode,
    };
  }

  const parsed = parseGitHubRunUrl(opts.target);
  if (!parsed) {
    throw new Error(
      `Cannot reproduce "${opts.target}". Provide a GitHub Actions run URL or a local log file path.`,
    );
  }
  const provider = new GitHubActionsProvider();
  const fetched = await provider.fetch(opts.target, { token });
  if (allLogsFailed(fetched.logsByJob)) {
    throw new Error(
      `Cannot build a bundle: ${firstLogError(fetched.logsByJob)} ` +
        `(failing job from metadata: ${failingJobFrom(fetched) ?? "unknown"}). ` +
        `Set GITHUB_TOKEN and retry, or download the logs manually and run: actionrepro ./failure.log`,
    );
  }
  const red = redactText(fetched.combinedLogs);
  const lines = red.text.split(/\r?\n/);
  const failingJob = fetched.jobs.find((j) => j.conclusion === "failure")?.name;
  let failingStep: string | undefined;
  for (const j of fetched.jobs) {
    const s = j.steps?.find((x) => x.conclusion === "failure");
    if (s) {
      failingStep = s.name;
      break;
    }
  }
  const failure = extractFailure(lines, { failingJob, failingStep });
  const eco = detectEcosystem(lines, localProjectFiles());
  const runtime = detectRuntime(lines);
  const runMeta = {
    workflow: fetched.run.workflowName ?? fetched.run.name,
    branch: fetched.run.headBranch,
    sha: fetched.run.headSha,
    job: failingJob,
    conclusion: fetched.run.conclusion ?? undefined,
  };
  const bundle = createBundle(
    {
      sourceDisplay: opts.target,
      sourceUrl: opts.target,
      ecosystem: eco,
      runtime,
      failure: {
        ...failure,
        failingJob: failure.failingJob ?? failingJob,
        failingStep: failure.failingStep ?? failingStep,
      },
      redactedLogs: red.text,
      redactions: red.redactions,
      runMeta,
    },
    outDir,
  );
  let exitCode: number | undefined;
  if (opts.run) exitCode = runReproduceScript(outDir);
  return {
    outDir,
    files: bundle.files,
    summary: failure.summary,
    reproCommand: failure.reproCommand ?? eco.testCommand,
    ecosystem: eco.id,
    redactions: red.redactions,
    exitCode,
  };
}
