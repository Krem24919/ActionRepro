import fs from "node:fs";
import { parseGitHubRunUrl } from "../core/url.js";
import { GitHubActionsProvider } from "../providers/github-actions.js";
import { loadLogsFromFile } from "../core/logs.js";
import { redactText } from "../core/redact.js";
import { extractFailure } from "../core/extract.js";
import { detectEcosystem } from "../core/ecosystems.js";
import { detectRuntime } from "../core/runtime.js";
import { allLogsFailed, firstLogError, resolveToken } from "../core/github.js";
import type { CiFetchResult } from "../providers/types.js";

function failingStepOf(fetched: CiFetchResult): string | undefined {
  for (const j of fetched.jobs) {
    const s = j.steps?.find((x) => x.conclusion === "failure");
    if (s) return s.name;
  }
  return undefined;
}

export interface InspectInput {
  target: string;
  token?: string;
  json?: boolean;
}

export interface InspectResult {
  source: string;
  runUrl?: string;
  ecosystem: string;
  confidence: string;
  evidence: string[];
  summary: string;
  failingJob?: string;
  failingStep?: string;
  exitCode?: number;
  reproCommand?: string;
  hint: string;
  redactions: number;
  runtime: Record<string, string | undefined>;
}

function localProjectFiles(): string[] {
  try {
    return fs.readdirSync(process.cwd());
  } catch {
    return [];
  }
}

export async function inspectTarget(input: InspectInput): Promise<InspectResult> {
  const token = resolveToken(input.token);

  // Local file mode
  if (fs.existsSync(input.target) && fs.statSync(input.target).isFile()) {
    const loaded = loadLogsFromFile(input.target);
    const red = redactText(loaded.raw);
    const lines = red.text.split(/\r?\n/);
    const failure = extractFailure(lines);
    const eco = detectEcosystem(lines, localProjectFiles());
    const runtime = detectRuntime(lines);
    return {
      source: input.target,
      ecosystem: eco.id,
      confidence: eco.confidence,
      evidence: eco.evidence,
      summary: failure.summary,
      failingJob: failure.failingJob,
      failingStep: failure.failingStep,
      exitCode: failure.exitCode,
      reproCommand: failure.reproCommand ?? eco.testCommand,
      hint: failure.hint,
      redactions: red.redactions,
      runtime: runtime as unknown as Record<string, string | undefined>,
    };
  }

  // GitHub URL mode
  const parsed = parseGitHubRunUrl(input.target);
  if (!parsed) {
    throw new Error(
      `Cannot inspect "${input.target}". Provide a GitHub Actions run URL (https://github.com/OWNER/REPO/actions/runs/ID) or a local log file path.`,
    );
  }
  const provider = new GitHubActionsProvider();
  const fetched = await provider.fetch(input.target, { token });
  const failingJob = fetched.jobs.find((j) => j.conclusion === "failure")?.name;
  if (allLogsFailed(fetched.logsByJob)) {
    return {
      source: input.target,
      runUrl: input.target,
      ecosystem: "unknown",
      confidence: "low",
      evidence: [],
      summary: `Logs unavailable: ${firstLogError(fetched.logsByJob)}`,
      failingJob,
      failingStep: failingStepOf(fetched),
      hint: "Set GITHUB_TOKEN and retry, or download the logs manually and run: actionrepro inspect ./failure.log",
      redactions: 0,
      runtime: {},
    };
  }
  const red = redactText(fetched.combinedLogs);
  const lines = red.text.split(/\r?\n/);
  const failingStep = failingStepOf(fetched);
  const failure = extractFailure(lines, { failingJob, failingStep });
  const eco = detectEcosystem(lines, localProjectFiles());
  const runtime = detectRuntime(lines);
  return {
    source: input.target,
    runUrl: input.target,
    ecosystem: eco.id,
    confidence: eco.confidence,
    evidence: eco.evidence,
    summary: failure.summary,
    failingJob: failure.failingJob ?? failingJob,
    failingStep: failure.failingStep ?? failingStep,
    exitCode: failure.exitCode,
    reproCommand: failure.reproCommand ?? eco.testCommand,
    hint: failure.hint,
    redactions: red.redactions,
    runtime: runtime as unknown as Record<string, string | undefined>,
  };
}

export function formatInspectHuman(r: InspectResult): string {
  const body = [
    `source: ${r.source}`,
    r.runUrl && r.runUrl !== r.source ? `run: ${r.runUrl}` : null,
    `ecosystem: ${r.ecosystem} (confidence: ${r.confidence})`,
    `evidence: ${r.evidence.join("; ") || "n/a"}`,
    `failure: ${r.summary}`,
    r.failingJob ? `failing job: ${r.failingJob}` : null,
    r.failingStep ? `failing step: ${r.failingStep}` : null,
    r.exitCode !== undefined ? `exit code: ${r.exitCode}` : null,
    `repro command: ${r.reproCommand ?? "(none found)"}`,
    `hint: ${r.hint}`,
    `redactions: ${r.redactions}`,
    `runtime: Node=${r.runtime.node ?? "?"} Python=${r.runtime.python ?? "?"} Go=${r.runtime.go ?? "?"} Rust=${r.runtime.rust ?? "?"} OS=${r.runtime.os ?? "?"}`,
  ].filter((x): x is string => x !== null);
  return ["ActionRepro inspection", ...body.map((line) => `  ${line}`)].join("\n");
}
