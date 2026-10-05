import { normalizedLines } from "./logs.js";
import type { EcosystemId } from "./ecosystems.js";

export interface FailureInfo {
  summary: string;
  failingJob?: string;
  failingStep?: string;
  exitCode?: number;
  errorLines: string[];
  reproCommand?: string;
  hint: string;
}

interface Candidate {
  index: number;
  line: string;
  weight: number;
}

const ERROR_PATTERNS: { re: RegExp; weight: number; label: string }[] = [
  {
    re: /process completed with exit code (\d+)/i,
    weight: 100,
    label: "exit code marker",
  },
  { re: /##\[error\].+/, weight: 95, label: "annotation error" },
  { re: /npm ERR!/, weight: 90, label: "npm error" },
  { re: /ERR_PNPM_.+/, weight: 90, label: "pnpm error" },
  { re: /yarn error.+/, weight: 90, label: "yarn error" },
  { re: /FAILED\b/, weight: 80, label: "FAILED marker" },
  { re: /\bFAIL\b/, weight: 78, label: "FAIL marker" },
  { re: /test result: FAILED/i, weight: 85, label: "test result FAILED" },
  { re: /Traceback \(most recent call last\)/, weight: 85, label: "python traceback" },
  {
    re: /ModuleNotFoundError|ImportError|AssertionError/,
    weight: 88,
    label: "python error",
  },
  { re: /error\[E\d+\]/, weight: 88, label: "rustc error" },
  { re: /panicked at .+:\d+:\d+/, weight: 88, label: "rust panic" },
  { re: /panic: /, weight: 85, label: "go panic" },
  { re: /FAIL\s+\S+/, weight: 84, label: "go test FAIL" },
  { re: /\bError: .+/, weight: 60, label: "Error line" },
  { re: /command not found/, weight: 70, label: "command not found" },
  { re: /exit code \d+/, weight: 75, label: "exit code mention" },
  { re: /✖|× .*fail/i, weight: 50, label: "cross failure glyph" },
];

const RUN_LINE_RES = [/^\s*Run\s+(.+?)\s*$/, /^\s*\$\s+(.+?)\s*$/, /^\s*\+ (.+?)\s*$/];

/**
 * Deterministic failure extraction:
 * 1. Score every line against known error patterns.
 * 2. Pick the highest-weight (last on ties) line as the failure anchor.
 * 3. Walk backwards for the nearest `Run <cmd>` / `$ <cmd>` as repro command.
 * 4. Parse exit code from anchor or neighbours.
 */
export function extractFailure(
  rawLines: string[],
  opts: { failingStep?: string; failingJob?: string } = {},
): FailureInfo {
  const lines = normalizedLines(rawLines);
  const candidates: Candidate[] = [];

  lines.forEach((line, index) => {
    for (const p of ERROR_PATTERNS) {
      if (p.re.test(line)) {
        candidates.push({ index, line, weight: p.weight });
        break;
      }
    }
  });

  if (candidates.length === 0) {
    // Fallback: last non-empty line.
    const nonEmpty = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.trim() !== "");
    const last = nonEmpty[nonEmpty.length - 1];
    const errorLines = last ? [last.l] : ["(empty logs)"];
    return {
      summary: last
        ? `Unknown failure near: ${truncate(last.l, 160)}`
        : "Empty logs: no failure found",
      failingJob: opts.failingJob,
      failingStep: opts.failingStep,
      errorLines,
      reproCommand: findReproCommand(lines, lines.length - 1),
      hint: "No known error pattern matched. Inspect the tail of the logs in failure.txt.",
    };
  }

  candidates.sort((a, b) => a.weight - b.weight || a.index - b.index);
  const anchor = candidates[candidates.length - 1];

  // Collect ~12 lines window ending at anchor for failure.txt context.
  const start = Math.max(0, anchor.index - 8);
  const end = Math.min(lines.length, anchor.index + 5);
  const errorLines = lines.slice(start, end).filter((l) => l.trim() !== "");

  const exitCode = parseExitCode(lines, anchor.index);
  const reproCommand = findReproCommand(lines, anchor.index);
  const summary = buildSummary(anchor.line, opts);

  return {
    summary,
    failingJob: opts.failingJob,
    failingStep: opts.failingStep,
    exitCode,
    errorLines,
    reproCommand,
    hint: hintFor(reproCommand, anchor.line),
  };
}

export function findReproCommand(
  lines: string[],
  beforeIndex: number,
): string | undefined {
  for (let i = Math.min(beforeIndex, lines.length - 1); i >= 0; i--) {
    const line = lines[i];
    for (const re of RUN_LINE_RES) {
      const m = line.match(re);
      if (m && m[1]) {
        const cmd = m[1].trim();
        if (cmd.length < 2 || /^echo\b/i.test(cmd)) continue;
        // Skip action-internal wrappers like `actions/checkout`, keep shell commands.
        if (/^actions\//.test(cmd)) continue;
        return cmd;
      }
    }
    // npm/yarn/pnpm explicit invocation without Run prefix
    const direct = line.match(
      /^\s*((?:npm|pnpm|yarn|npx)\s+(?:run\s+\S+|test|ci|install).*?)\s*$/,
    );
    if (direct) return direct[1].trim();
    const py = line.match(/^\s*((?:python(?:3)?|pytest|uv)\s+.+?)\s*$/);
    if (py && /test|pytest|main\.py|app\.py/.test(py[1])) return py[1].trim();
    const cg = line.match(
      /^\s*((?:cargo\s+(?:test|build|run).*?|go\s+(?:test|build|run).*?))\s*$/,
    );
    if (cg) return cg[1].trim();
  }
  return undefined;
}

function parseExitCode(lines: string[], anchorIndex: number): number | undefined {
  const window = lines.slice(Math.max(0, anchorIndex - 3), anchorIndex + 4).join("\n");
  const m =
    window.match(/process completed with exit code (\d+)/i) ??
    window.match(/exit code (\d+)/i) ??
    window.match(/exited with code (\d+)/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function buildSummary(
  anchorLine: string,
  opts: { failingStep?: string; failingJob?: string },
): string {
  const where = [
    opts.failingJob ? `job "${opts.failingJob}"` : null,
    opts.failingStep ? `step "${opts.failingStep}"` : null,
  ]
    .filter(Boolean)
    .join(" / ");
  const base = truncate(anchorLine.trim(), 180);
  return where ? `Failure in ${where}: ${base}` : `Failure: ${base}`;
}

function hintFor(reproCommand: string | undefined, anchorLine: string): string {
  if (reproCommand)
    return `Re-run \`${reproCommand}\` locally after installing dependencies.`;
  if (/ModuleNotFoundError|ImportError/.test(anchorLine)) {
    return "Missing Python dependency. Install requirements first, then re-run the failing command.";
  }
  if (/command not found/.test(anchorLine)) {
    return "Missing tool on PATH. Install the toolchain from environment.txt, then re-run.";
  }
  return "See failure.txt context and reproduce with reproduce.sh.";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export type { EcosystemId };
