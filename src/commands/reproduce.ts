import fs from "node:fs";
import path from "node:path";
import { parseGitHubRunUrl } from "../core/url.js";
import { findProvider, resolveProviderToken } from "../providers/registry.js";
import { loadLogsFromFile } from "../core/logs.js";
import { redactText } from "../core/redact.js";
import { extractFailure } from "../core/extract.js";
import { detectEcosystem } from "../core/ecosystems.js";
import { detectRuntime } from "../core/runtime.js";
import { createBundle } from "../core/bundle.js";
import { runReproduceScript } from "../core/runner.js";
import { allLogsFailed, firstLogError, fetchWorkflowFile } from "../core/github.js";
import { fingerprintFailure } from "../core/fingerprint.js";
import { extractStepScript, commandsAgree } from "../core/workflow.js";
import type { BundleInput } from "../core/bundle.js";
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
  reproCommandSource: "log" | "ecosystem-default" | "workflow";
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

  if (fs.existsSync(opts.target) && fs.statSync(opts.target).isFile()) {
    const loaded = loadLogsFromFile(opts.target);
    const red = redactText(loaded.raw);
    const lines = red.text.split(/\r?\n/);
    const failure = extractFailure(lines);
    const eco = detectEcosystem(lines, localProjectFiles());
    const runtime = detectRuntime(lines);
    const reproCommand = failure.reproCommand ?? eco.testCommand;
    const bundle = createBundle(
      {
        sourceDisplay: opts.target,
        ecosystem: eco,
        runtime,
        failure,
        redactedLogs: red.text,
        redactions: red.redactions,
        reproCommandSource: failure.reproCommand ? "log" : "ecosystem-default",
        fingerprint: fingerprintFailure({
          ecosystem: eco.id,
          reproCommand,
          exitCode: failure.exitCode,
          anchor: failure.anchor,
          errorKind: failure.errorKind,
        }),
      },
      outDir,
    );
    let exitCode: number | undefined;
    if (opts.run) exitCode = runReproduceScript(outDir);
    return {
      outDir,
      files: bundle.files,
      summary: failure.summary,
      reproCommand,
      reproCommandSource: failure.reproCommand ? "log" : "ecosystem-default",
      ecosystem: eco.id,
      redactions: red.redactions,
      exitCode,
    };
  }

  const provider = findProvider(opts.target);
  if (!provider) {
    throw new Error(
      `Cannot reproduce "${opts.target}". Provide a GitHub Actions run URL, a GitLab pipeline/job URL, or a local log file path.`,
    );
  }
  const token = resolveProviderToken(provider.id, opts.token);
  const fetched = await provider.fetch(opts.target, { token });
  const tokenHint =
    provider.id === "gitlab"
      ? "Set GITLAB_TOKEN and retry, or download the job trace manually and run: actionrepro ./failure.log"
      : "Set GITHUB_TOKEN and retry, or download the logs manually and run: actionrepro ./failure.log";
  if (allLogsFailed(fetched.logsByJob)) {
    throw new Error(
      `Cannot build a bundle: ${firstLogError(fetched.logsByJob)} ` +
        `(failing job from metadata: ${failingJobFrom(fetched) ?? "unknown"}). ` +
        tokenHint,
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
  let reproCommand = failure.reproCommand ?? eco.testCommand;
  let commandSource: "workflow" | "log" | "fallback" = failure.reproCommand
    ? "log"
    : "fallback";
  // Best-effort cross-check against the workflow definition at the exact SHA.
  // GitHub-only: other providers have no workflow-file API wired yet.
  // When the CI-defined step command agrees with the log evidence, the
  // workflow text becomes the repro source and the log stays as evidence.
  let workflow: BundleInput["workflow"];
  const ghParsed =
    provider.id === "github-actions" ? parseGitHubRunUrl(opts.target) : null;
  if (ghParsed && fetched.run.headSha && failingStep) {
    const wf = await fetchWorkflowFile(
      ghParsed.owner,
      ghParsed.repo,
      ghParsed.runId,
      fetched.run.headSha,
      token,
    );
    if (wf) {
      const step = extractStepScript(wf.text, failingStep, failingJob);
      const agree = step ? commandsAgree(step.script, reproCommand) : null;
      if (agree === true && step?.script.trim()) {
        reproCommand = step.script;
        commandSource = "workflow";
      }
      workflow = {
        path: wf.path,
        sha: wf.sha,
        stepCommand: step?.script,
        agree,
        commandSource,
      };
    }
  }
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
        reproCommand,
        failingJob: failure.failingJob ?? failingJob,
        failingStep: failure.failingStep ?? failingStep,
      },
      redactedLogs: red.text,
      redactions: red.redactions,
      reproCommandSource:
        commandSource === "workflow"
          ? "workflow"
          : failure.reproCommand
            ? "log"
            : "ecosystem-default",
      fingerprint: fingerprintFailure({
        ecosystem: eco.id,
        reproCommand,
        exitCode: failure.exitCode,
        anchor: failure.anchor,
        errorKind: failure.errorKind,
      }),
      workflow,
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
    reproCommand,
    reproCommandSource:
      commandSource === "workflow"
        ? "workflow"
        : failure.reproCommand
          ? "log"
          : "ecosystem-default",
    ecosystem: eco.id,
    redactions: red.redactions,
    exitCode,
  };
}
