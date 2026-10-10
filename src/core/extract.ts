import { isActionReproFrame, normalizedLines } from "./logs.js";
import type { EcosystemId } from "./ecosystems.js";

export interface FailureInfo {
  summary: string;
  failingJob?: string;
  failingStep?: string;
  exitCode?: number;
  errorLines: string[];
  reproCommand?: string;
  hint: string;
  /**
   * True when a real diagnostic line matched — false when the log only
   * contained the runner's exit-code restatement (or nothing at all).
   * `verify` uses this to avoid calling a passing run "reproduced".
   */
  matched: boolean;
  /** Pattern label of the winning line, e.g. "npm error", "assertion error". */
  errorKind?: string;
  /** The winning diagnostic line, verbatim (timestamps/ANSI already stripped). */
  anchor?: string;
}

interface Candidate {
  index: number;
  line: string;
  weight: number;
  label: string;
  /** Runner restatement of a failure — never preferred over a real diagnostic. */
  meta: boolean;
}

/**
 * Machine-readable detail fields emitted by test runners (`name: 'Error'`,
 * `code: 'ERR_ASSERTION'`, `duration_ms: 1.4`). They mention an error but
 * carry no message, so they must not outrank the headline line.
 */
const DETAIL_FIELD_RE =
  /^\s*(?:code|name|type|duration_ms|location|failureType|expected|actual|operator|stack|message|severity|file|line|column|test|suite):\s/;

function scoreCandidate(base: number, line: string): number {
  return DETAIL_FIELD_RE.test(line) ? base - 8 : base;
}

/**
 * Weighted error patterns. Order matters: the first match on a line wins, so
 * the restatement patterns (`meta: true`) come first and downgrade the
 * runner's own bookkeeping lines — `##[error]Process completed with exit code
 * 1.` is the *last* line of every failed step and must never outrank the
 * actual diagnostic (that used to produce summaries like
 * "Failure: ##[error]Process completed with exit code 1.").
 *
 * Within the non-meta pool the highest weight wins; ties go to the last
 * occurrence. Meta lines are only used when nothing else matched.
 */
const ERROR_PATTERNS: { re: RegExp; weight: number; label: string; meta?: boolean }[] = [
  // --- Runner restatements (bookkeeping, not diagnostics) ---
  {
    re: /process completed with exit code \d+/i,
    weight: 10,
    label: "exit code marker",
    meta: true,
  },
  {
    re: /^\s*exit code\s*[:=]?\s*\d+\s*\.?\s*$/i,
    weight: 8,
    label: "exit code mention",
    meta: true,
  },
  {
    re: /^\s*npm ERR! (?:code ELIFECYCLE\b|errno \d+|Exit status \d+|command failed\b|test failed\.?|.*?:\s*`[^`]*`\s*$)/i,
    weight: 10,
    label: "npm exit restatement",
    meta: true,
  },
  {
    re: /^\s*(?:yarn|pnpm)\s+(?:ERR!|error)\b.*(?:exit status|command failed|ELIFECYCLE)/i,
    weight: 10,
    label: "package manager restatement",
    meta: true,
  },

  // --- Specific diagnostics (the useful anchor) ---
  { re: /error\[E\d+\]/, weight: 92, label: "rustc error" },
  { re: /panicked at .+:\d+:\d+/, weight: 90, label: "rust panic" },
  { re: /ERR_PNPM_\w+/, weight: 90, label: "pnpm error" },
  { re: /panic: /, weight: 88, label: "go panic" },
  { re: /ModuleNotFoundError|ImportError/, weight: 88, label: "python import error" },
  { re: /\bAssertionError\b/, weight: 88, label: "assertion error" },
  { re: /expected:.+but was:.+/i, weight: 88, label: "assertion diff" },
  { re: /\) Failure: .+/, weight: 88, label: "assertion failure" },
  { re: /error (CS|MSB)\d+/, weight: 88, label: "dotnet compiler error" },
  { re: /Failure\/Error: /, weight: 88, label: "RSpec failure" },
  {
    re: /^\s*(?:#\s*)?[\w./\\-]+\.(?:go|py|rs|ts|tsx|js|jsx|rb|java|kt|c|cc|cpp|cs|csproj|sln)(?::|:\s*line\s*)\d+(?::\d+)?:/,
    weight: 86,
    label: "test/compiler diagnostic",
  },
  {
    re: /Traceback \(most recent call last\)/,
    weight: 86,
    label: "python traceback",
  },
  { re: /test result: FAILED/i, weight: 85, label: "test result FAILED" },
  { re: /^\s*not ok\b/i, weight: 84, label: "TAP test failure" },
  {
    re: /Tests run:\s*\d+,\s*(Failures|Errors):\s*[1-9]/,
    weight: 84,
    label: "Maven test summary",
  },
  { re: /^(Failure|Error):$/, weight: 82, label: "test failure header" },
  { re: /npm ERR!|npm error/, weight: 84, label: "npm error" },
  { re: /yarn error.+|error Command failed.*yarn/i, weight: 84, label: "yarn error" },
  { re: /FAIL\s+\S+/, weight: 82, label: "go test FAIL" },
  { re: /Failed:\s*\d+,\s*Passed:/, weight: 80, label: "dotnet test summary" },
  { re: /FAILED\b/, weight: 80, label: "FAILED marker" },
  { re: /\bFAIL\b/, weight: 78, label: "FAIL marker" },
  { re: /command not found/, weight: 70, label: "command not found" },
  {
    // A process killed by a signal or the OOM killer is failure evidence, not
    // an absence of failure: without this, a fresh "Killed" log verified as
    // NOT_REPRODUCED and `prove` reported the unrelated CI failure "fixed".
    re: /\b(Killed|Segmentation fault|SIGKILL|SIGSEGV|SIGTERM|SIGABRT|SIGBUS|OOMKilled|Out of memory|heap out of memory|exit status 13[479]|exit status 134)\b/i,
    weight: 66,
    label: "process kill (signal/OOM)",
  },
  { re: /BUILD FAILURE/, weight: 70, label: "Maven build failure" },
  {
    re: /FAILURE: Build failed with an exception/,
    weight: 70,
    label: "Gradle build failure",
  },
  { re: /\bError: .+/, weight: 60, label: "Error line" },
  // Named errors: `TypeError: ...`, `ReferenceError: ...`, `SyntaxError: ...`.
  // `\bError:` alone misses them (no word boundary inside `TypeError`).
  {
    re: /\b[A-Z][A-Za-z]*(?:Error|Exception): .+/,
    weight: 60,
    label: "named error line",
  },
  { re: /✖|× .*fail/i, weight: 50, label: "cross failure glyph" },
  { re: /##\[error\]\s*\S+/, weight: 40, label: "annotation error" },
];

/**
 * Lines that announce the command of a step. ONLY the runner-emitted header
 * `##[group]Run <cmd>` is trusted (the timestamp is stripped by
 * normalization). A bare `Run <cmd>` line is NOT accepted: prose in tool
 * output routinely starts with "Run" ("Run rm -rf build to clean the
 * cache"), and accepting it turned prose into the executed repro command.
 * Pasted logs without headers fall back to `$ <cmd>` lines, direct tool
 * invocations, or the ecosystem default — all recorded via reproCommandSource.
 */
const RUN_LINE_RES = [
  /^\s*##\[group\]Run\s+(.+?)\s*$/,
  /^\s*\$\s+(.+?)\s*$/,
  // bash -x trace (`+ npm test`). Only accepted for known tools: a diff such as
  // Jest's `+ Received` must never become the repro command (it would be run).
  /^\s*\+\s+((?:npm|npx|pnpm|yarn|jest|vitest|mocha|pytest|python3?|uv|pip3?|cargo|go|make|mvn|gradle|\.\/gradlew|gradlew|dotnet|bundle|rspec|rake|ruby|node|bash|sh|\.\/[\w./-]+)\s.+?)\s*$/,
];

/**
 * Deterministic failure extraction:
 * 1. Drop actionrepro's own script frame (`==> [actionrepro] ...`), which
 *    echoes the CI failure text and would otherwise confirm itself.
 * 2. Score every line against weighted error patterns; the runner's
 *    exit-code restatements are bookkeeping and only win if nothing else did.
 * 3. Pick the highest-weight (last on ties) line as the failure anchor.
 * 4. Walk backwards for the nearest `Run <cmd>` / `$ <cmd>` as repro command.
 * 5. Parse the exit code from the marker nearest the anchor.
 */
export function extractFailure(
  rawLines: string[],
  opts: { failingJob?: string; failingStep?: string } = {},
): FailureInfo {
  const lines = normalizedLines(rawLines).filter((l) => !isActionReproFrame(l));
  const candidates: Candidate[] = [];

  lines.forEach((line, index) => {
    for (const p of ERROR_PATTERNS) {
      if (p.re.test(line)) {
        candidates.push({
          index,
          line,
          weight: scoreCandidate(p.weight, line),
          label: p.label,
          meta: p.meta === true,
        });
        break;
      }
    }
  });

  const diagnostics = candidates.filter((c) => !c.meta);
  const matched = diagnostics.length > 0;
  const pool = matched ? diagnostics : candidates;

  if (pool.length === 0) {
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
      exitCode: parseExitCode(lines, lines.length - 1, rawLines),
      errorLines,
      reproCommand: findReproCommand(lines, lines.length - 1),
      hint: "No known error pattern matched. Inspect the tail of the logs in failure.txt.",
      matched: false,
    };
  }

  pool.sort((a, b) => a.weight - b.weight || a.index - b.index);
  const anchor = pool[pool.length - 1];

  // Collect ~12 lines window ending at anchor for failure.txt context.
  const start = Math.max(0, anchor.index - 8);
  const end = Math.min(lines.length, anchor.index + 5);
  const errorLines = lines.slice(start, end).filter((l) => l.trim() !== "");

  const exitCode = parseExitCode(lines, anchor.index, rawLines);
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
    matched,
    errorKind: anchor.label,
    anchor: anchor.line,
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

/**
 * Exit code = the closest marker to the anchor, preferring the runner's
 * authoritative `Process completed with exit code N`, then the bundle's own
 * `exited with code N`, then any `exit code N` mention. `rawLines` (which
 * still contains actionrepro's frame) is consulted last, because the
 * generated script reports the local run's exit code there.
 */
function parseExitCode(
  lines: string[],
  anchorIndex: number,
  rawLines: string[] = lines,
): number | undefined {
  const groups: RegExp[] = [
    /\bresult:\s*exit_code=(\d+)/i,
    /process completed with exit code (\d+)/i,
    /exited with code (\d+)/i,
    /\bexit code\b\s*[:=]?\s*(\d+)/i,
    // Lowest priority: bare "exit status N" (Go, docker, shells). Without it
    // a bare "exit status 137" left exitCode unknown; with it such a log is
    // at worst INCONCLUSIVE, never "fixed".
    /\bexit status (\d+)/i,
  ];
  for (const source of [lines, rawLines]) {
    for (const re of groups) {
      const hits: { index: number; value: number }[] = [];
      source.forEach((line, index) => {
        const m = line.match(re);
        if (!m) return;
        const n = Number(m[1]);
        if (Number.isFinite(n)) hits.push({ index, value: n });
      });
      if (hits.length === 0) continue;
      hits.sort(
        (a, b) =>
          Math.abs(a.index - anchorIndex) - Math.abs(b.index - anchorIndex) ||
          b.index - a.index,
      );
      return hits[0].value;
    }
  }
  return undefined;
}

function buildSummary(
  anchorLine: string,
  opts: { failingJob?: string; failingStep?: string },
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
