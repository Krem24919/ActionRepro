import fs from "node:fs";
import { ensureDir } from "../utils/fs.js";
import { redactText } from "./redact.js";
import { hashBundleFiles, FINGERPRINT_ALGO } from "./fingerprint.js";
import type { EcosystemInfo } from "./ecosystems.js";
import type { FailureInfo } from "./extract.js";
import type { RuntimeInfo } from "./runtime.js";
import { formatEnvironment } from "./runtime.js";

export interface BundleInput {
  sourceDisplay: string;
  sourceUrl?: string;
  ecosystem: EcosystemInfo;
  runtime: RuntimeInfo;
  failure: FailureInfo;
  redactedLogs: string;
  redactions: number;
  /** Stable identity of this exact failure (see fingerprint.ts). */
  fingerprint: string;
  /** Workflow definition cross-check (URL mode, best-effort, may be absent). */
  workflow?: {
    path: string;
    sha: string;
    stepCommand?: string;
    /** true = CI definition agrees with log evidence, false = conflict, null = unknown. */
    agree: boolean | null;
    /** Where the bundle's repro command came from: the CI workflow definition
     * (confirmed by log evidence), the log-derived command, or a fallback. */
    commandSource: "workflow" | "log" | "fallback";
  };
  runMeta?: {
    workflow?: string;
    branch?: string;
    sha?: string;
    job?: string;
    conclusion?: string;
  };
}

export interface BundleResult {
  outDir: string;
  files: string[];
}

/**
 * Escape arbitrary log-derived text for embedding inside a double-quoted
 * bash string. Without this, `$(...)`/backticks from hostile CI logs would
 * execute when the generated script runs. The repro command itself is NEVER
 * passed through here — it stays verbatim so its semantics are preserved.
 */
export function shDq(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

/** PowerShell `"..."` escaping for log-derived metadata (never the command). */
export function psDq(s: string): string {
  return s.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"');
}

/**
 * Display-only escaping for generated scripts: shell-safe AND neutralized
 * for CI-runner log parsers (`##[` would otherwise become a phantom workflow
 * command when the script's own output is shown in Actions logs).
 */
function shText(s: string): string {
  return shDq(s).replace(/##\[/g, "## [");
}

function psText(s: string): string {
  return psDq(s).replace(/##\[/g, "## [");
}

function installBlock(eco: EcosystemInfo): string {
  switch (eco.id) {
    case "npm":
      return ["if [ -f package-lock.json ]; then npm ci; else npm install; fi"].join(
        "\n",
      );
    case "pnpm":
      return [
        'if ! command -v pnpm >/dev/null 2>&1; then echo "TOOL_MISSING: pnpm not found. Install it first: npm install -g pnpm (Termux: npm install -g pnpm)"; exit 2; fi',
        "if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi",
      ].join("\n");
    case "yarn":
      return [
        'if ! command -v yarn >/dev/null 2>&1; then echo "TOOL_MISSING: yarn not found. Install it first: npm install -g yarn"; exit 2; fi',
        "if [ -f yarn.lock ]; then yarn install --frozen-lockfile; else yarn install; fi",
      ].join("\n");
    case "pip":
      return [
        "python3 -m pip install --upgrade pip",
        "if [ -f requirements.txt ]; then python3 -m pip install -r requirements.txt;",
        'elif [ -f pyproject.toml ]; then python3 -m pip install -e ".[test]" 2>/dev/null || python3 -m pip install -e . 2>/dev/null || echo "(no installable package; continuing)";',
        'else echo "(no requirements.txt/pyproject.toml found; skipping install)"; fi',
      ].join("\n");
    case "uv":
      return [
        'if ! command -v uv >/dev/null 2>&1; then echo "TOOL_MISSING: uv not found. Install it first: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 2; fi',
        'uv sync || echo "WARNING: uv sync failed or is partial (continuing anyway)"',
      ].join("\n");
    case "cargo":
      return [
        'if ! command -v cargo >/dev/null 2>&1; then echo "TOOL_MISSING: cargo not found. Install Rust: https://rustup.rs (Termux: pkg install rust)"; exit 2; fi',
        'cargo fetch || echo "WARNING: cargo fetch failed (continuing anyway)"',
      ].join("\n");
    case "go":
      return [
        'if ! command -v go >/dev/null 2>&1; then echo "TOOL_MISSING: go not found. Install Go (Termux: pkg install golang)"; exit 2; fi',
        'go mod download || echo "WARNING: go mod download failed (continuing anyway)"',
      ].join("\n");
    case "maven":
      return [
        'if ! command -v mvn >/dev/null 2>&1; then echo "TOOL_MISSING: mvn not found. Install Maven (Termux: pkg install maven)"; exit 2; fi',
        "mvn -B dependency:resolve",
      ].join("\n");
    case "gradle":
      return [
        "if [ -f gradlew ]; then ./gradlew -q dependencies; else gradle -q dependencies; fi",
      ].join("\n");
    case "dotnet":
      return [
        'if ! command -v dotnet >/dev/null 2>&1; then echo "TOOL_MISSING: dotnet not found. Install the .NET SDK"; exit 2; fi',
        "dotnet restore",
      ].join("\n");
    case "ruby":
      return [
        'if ! command -v bundle >/dev/null 2>&1; then echo "TOOL_MISSING: bundle not found. Install Ruby + Bundler (Termux: pkg install ruby)"; exit 2; fi',
        "bundle install",
      ].join("\n");
    default:
      return 'echo "(unknown ecosystem) install your dependencies manually, then re-run the failing command below."';
  }
}

function reproCommandFor(eco: EcosystemInfo, failure: FailureInfo): string {
  // Verbatim: the command is embedded as-is into the generated script.
  return failure.reproCommand ? failure.reproCommand : eco.testCommand;
}

/**
 * Unknown ecosystem + no command found yields a shell comment placeholder
 * (`# see failure.txt ...`). Executing it would "succeed" and report NOT
 * REPRODUCED without running anything, so such bundles fail loudly instead.
 */
export function hasRunnableCommand(cmd: string): boolean {
  return cmd.trim() !== "" && !cmd.trimStart().startsWith("#");
}

/** Exit codes a generated script reports for its own states (see README). */
export const EXIT_SETUP_FAILED = 3;
export const EXIT_ABORTED = 4;
export const EXIT_NO_COMMAND = 5;

export function buildReproduceSh(input: BundleInput): string {
  const cmd = reproCommandFor(input.ecosystem, input.failure);
  const src = shText(input.sourceDisplay);
  const ecoLine = `${input.ecosystem.id} (confidence: ${input.ecosystem.confidence})`;
  const evidence = shText(input.ecosystem.evidence.join("; ") || "n/a");
  const summary = shText(singleLine(input.failure.summary));
  const cmdDisplay = shText(cmd);
  const ciExit =
    input.failure.exitCode !== undefined
      ? `echo "==> [actionrepro] CI exit code: ${input.failure.exitCode}"`
      : `echo "==> [actionrepro] CI exit code: unknown"`;
  const installLines = installBlock(input.ecosystem)
    .split("\n")
    .map((l) => (l.trim() === "" ? l : `  ${l}`))
    .join("\n");
  const hasCommand = hasRunnableCommand(cmd);
  const step2 = hasCommand
    ? `echo "==> [actionrepro] running: ${cmdDisplay}"
set +e
${cmd}
REPRO_RC=$?
set -e
if [ "$REPRO_RC" -ne 0 ]; then
  echo "==> [actionrepro] REPRODUCED: command exited with code $REPRO_RC. Compare it with the CI failure shown above."
  echo "==> [actionrepro] result: exit_code=$REPRO_RC"
  exit "$REPRO_RC"
else
  echo "==> [actionrepro] NOT REPRODUCED: command exited with code 0. The failure may be fixed, flaky, or specific to the CI environment."
  echo "==> [actionrepro] result: exit_code=0"
fi`
    : `echo "==> [actionrepro] NO REPRO COMMAND: no runnable command could be identified in the CI logs. Nothing was executed."
echo "==> [actionrepro] Run the failing command manually, then verify its output with actionrepro verify."
echo "==> [actionrepro] result: exit_code=${EXIT_NO_COMMAND}"
exit ${EXIT_NO_COMMAND}`;
  return `#!/usr/bin/env bash
# Auto-generated by actionrepro. Replays a failed CI step locally.
# Source: ${src}
# Ecosystem: ${ecoLine}
# SECURITY NOTICE: the command in Step 2/2 came from CI output and is
#   treated as UNTRUSTED input. Review it before running — it will execute
#   with YOUR user privileges. Secrets were redacted heuristically (${input.redactions} replacements); verify before sharing.
#   Skip the confirmation prompt with: CI_REPRO_YES=1 ./reproduce.sh
# Exit codes: 3 = dependency setup failed (environment problem, not a repro),
#   4 = aborted at the confirmation prompt, 5 = no runnable repro command
#   was identified (nothing executed), anything else = the repro
#   command's own exit code.
# All status lines this script prints are prefixed with "==> [actionrepro]".
# actionrepro verify ignores those lines, so piping this output into a log file
# cannot make the script's own summary look like a new failure. The final
# "result: exit_code=N" line reports the command's exit code.
set -euo pipefail

echo "==> [actionrepro] ecosystem=${ecoLine}"
echo "==> [actionrepro] evidence: ${evidence}"
echo "==> [actionrepro] failure: ${summary}"
${ciExit}
echo ""
echo "==> [actionrepro] command to run: ${cmdDisplay}"
echo "==> [actionrepro] WARNING: this command came from CI output (untrusted). Review it, then confirm."
if [ "\${CI_REPRO_YES:-}" != "1" ] && [ -t 0 ]; then
  printf "Run it now? [y/N] "
  ACTIONREPRO_ANSWER=""
  read -r ACTIONREPRO_ANSWER || true
  case "\${ACTIONREPRO_ANSWER}" in
    [yY]*) ;;
    *)
      echo "Aborted by user (exit 4). Re-run with CI_REPRO_YES=1 to skip this prompt."
      exit 4
      ;;
  esac
fi
unset ACTIONREPRO_ANSWER

echo ""
echo "==> [actionrepro] Step 1/2: install dependencies"
INSTALL_RC=0
(
${installLines}
) || INSTALL_RC=$?
if [ "$INSTALL_RC" -ne 0 ]; then
  echo "==> [actionrepro] INSTALL_FAILED: dependency setup exited with code $INSTALL_RC." >&2
  echo "==> [actionrepro] This is an environment problem, NOT a reproduction of the CI failure." >&2
  echo "==> [actionrepro] Fix your toolchain/dependencies (see messages above) and re-run this script." >&2
  exit 3
fi
echo "==> [actionrepro] dependencies ready"

echo ""
echo "==> [actionrepro] Step 2/2: reproduce failure"
${step2}
`;
}

export function buildReproducePs1(input: BundleInput): string {
  const cmd = reproCommandFor(input.ecosystem, input.failure);
  const installPs = psInstall(input.ecosystem);
  const src = psText(input.sourceDisplay);
  const summary = psText(singleLine(input.failure.summary));
  const evidence = psText(input.ecosystem.evidence.join("; ") || "n/a");
  const cmdDisplay = psText(cmd);
  const hasCommand = hasRunnableCommand(cmd);
  return `# Auto-generated by actionrepro (Windows PowerShell). Replays a failed CI step locally.
# Source: ${src}
# Ecosystem: ${input.ecosystem.id} (confidence: ${input.ecosystem.confidence})
# SECURITY NOTICE: the command in Step 2/2 came from CI output and is
#   treated as UNTRUSTED input. Review it before running - it will execute
#   with YOUR user privileges. Secrets were redacted heuristically (${input.redactions} replacements); verify before sharing.
#   Skip the confirmation prompt with: $env:CI_REPRO_YES = "1"
# Exit codes: 3 = dependency setup failed (environment problem, not a repro),
#   4 = aborted at the confirmation prompt, 5 = no runnable repro command
#   was identified (nothing executed), anything else = the repro
#   command's own exit code.
# All status lines this script prints are prefixed with "==> [actionrepro]".
# actionrepro verify ignores those lines, so piping this output into a log file
# cannot make the script's own summary look like a new failure.
$ErrorActionPreference = "Stop"
Write-Host "==> [actionrepro] ecosystem=${input.ecosystem.id} confidence=${input.ecosystem.confidence}"
Write-Host "==> [actionrepro] evidence: ${evidence}"
Write-Host "==> [actionrepro] failure: ${summary}"
Write-Host "==> [actionrepro] CI exit code: ${(input.failure.exitCode ?? "unknown").toString()}"
Write-Host ""
Write-Host "==> [actionrepro] command to run: ${cmdDisplay}"
Write-Host "==> [actionrepro] WARNING: this command came from CI output (untrusted). Review it, then confirm."
if ($env:CI_REPRO_YES -ne "1" -and -not [Console]::IsInputRedirected) {
  $answer = Read-Host "Run it now? [y/N]"
  if ($answer -notmatch "^[yY]") { Write-Host "Aborted by user (exit 4)."; exit 4 }
}
Write-Host ""
Write-Host "==> [actionrepro] Step 1/2: install dependencies"
${installPs}
if ($LASTEXITCODE -ne 0) {
  Write-Host "==> [actionrepro] INSTALL_FAILED: dependency setup exited with code $LASTEXITCODE."
  Write-Host "==> [actionrepro] This is an environment problem, NOT a reproduction of the CI failure."
  exit 3
}
Write-Host "==> [actionrepro] dependencies ready"
Write-Host ""
Write-Host "==> [actionrepro] Step 2/2: reproduce failure"
${hasCommand ? psStep2(cmd, cmdDisplay) : psNoCommand()}
`;
}

function psStep2(cmd: string, cmdDisplay: string): string {
  return `Write-Host "==> [actionrepro] running: ${cmdDisplay}"
# Single evaluation pass on purpose: the lines below execute exactly as shown
# above after your confirmation. Never wrap this in Invoke-Expression — that
# would evaluate the text twice (once as an expandable string, once as code).
${cmd}
if ($LASTEXITCODE -ne 0) {
  Write-Host "==> [actionrepro] REPRODUCED: command exited with code $LASTEXITCODE. Compare it with the CI failure shown above."
  Write-Host "==> [actionrepro] result: exit_code=$LASTEXITCODE"
  exit $LASTEXITCODE
} else {
  Write-Host "==> [actionrepro] NOT REPRODUCED: command exited with code 0. The failure may be fixed, flaky, or specific to the CI environment."
  Write-Host "==> [actionrepro] result: exit_code=0"
}`;
}

function psNoCommand(): string {
  return `Write-Host "==> [actionrepro] NO REPRO COMMAND: no runnable command could be identified in the CI logs. Nothing was executed."
Write-Host "==> [actionrepro] Run the failing command manually, then verify its output with actionrepro verify."
Write-Host "==> [actionrepro] result: exit_code=${EXIT_NO_COMMAND}"
exit ${EXIT_NO_COMMAND}`;
}

function psInstall(eco: EcosystemInfo): string {
  switch (eco.id) {
    case "npm":
      return `if (Test-Path package-lock.json) { npm ci } else { npm install }`;
    case "pnpm":
      return `pnpm install --frozen-lockfile`;
    case "yarn":
      return `yarn install --frozen-lockfile`;
    case "pip":
      return `python -m pip install --upgrade pip\nif (Test-Path requirements.txt) { python -m pip install -r requirements.txt }`;
    case "uv":
      return `uv sync`;
    case "cargo":
      return `cargo fetch`;
    case "go":
      return `go mod download`;
    case "maven":
      return `mvn -B dependency:resolve`;
    case "gradle":
      return `if (Test-Path gradlew.bat) { .\\gradlew.bat -q dependencies } else { gradle -q dependencies }`;
    case "dotnet":
      return `dotnet restore`;
    case "ruby":
      return `bundle install`;
    default:
      return `Write-Host "(unknown ecosystem) install dependencies manually."`;
  }
}

function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function buildBundleReadme(input: BundleInput): string {
  const meta = input.runMeta;
  return `# ActionRepro bundle

> ${singleLine(input.failure.summary)}

Replays a failed CI step locally: installs dependencies, then re-runs the
closest failing command. Generated deterministically (no LLM).

> SECURITY: the repro command came from CI output (untrusted input).
> Review \`reproduce.sh\`/\`reproduce.ps1\` before running. Secrets were
> redacted heuristically, not guaranteed — verify before sharing.

## Run this first

Linux / macOS / Termux (recommended):

\`\`\bash
chmod +x reproduce.sh
./reproduce.sh
\`\`\`

Windows (PowerShell):

\`\`\`powershell
.\\reproduce.ps1
\`\`\`

Termux notes:

\`\`\bash
pkg update && pkg install -y git nodejs python
# Rust: pkg install rust
# Go: pkg install golang
./reproduce.sh
\`\`\`

Reproduce scripts ask for confirmation on interactive terminals
(\`CI_REPRO_YES=1\` skips it). Exit codes from \`reproduce.sh\`: \`3\` =
dependency setup failed (environment problem, not a reproduction), \`4\` =
aborted at the prompt, \`5\` = no runnable repro command was identified
(nothing was executed), anything else = the repro command's own exit code.

Everything the script prints about itself is prefixed with
\`==> [actionrepro]\` and ends with \`result: exit_code=N\`. Those lines are
ignored by \`actionrepro verify\`, so you can safely pipe the whole run into a
log file and verify it:

\`\`\`bash
CI_REPRO_YES=1 ./reproduce.sh > ./local-run.log 2>&1
actionrepro verify . ./local-run.log
\`\`\`
${
  meta?.job
    ? `
This bundle replays the failing *step*. To re-run the whole *job* in Docker
instead (services, caches, runner image), use
[act](https://github.com/nektos/act) with this job:

\`\`\`bash
act -j "${meta.job.replace(/"/g, "'")}"
\`\`\`
`
    : ""
}
## What this does NOT do

- Does not check out your repository or any specific commit.
- Does not provide CI services, caches, artifacts, secrets, or matrix variables.
- A passing/failing result here is best-effort evidence, not proof.

## Source

- Input: \`${input.sourceDisplay}\`
${input.sourceUrl ? `- Run: ${input.sourceUrl}\n` : ""}${meta?.workflow ? `- Workflow: ${meta.workflow}\n` : ""}${meta?.job ? `- Failing job: ${meta.job}\n` : ""}${meta?.branch ? `- Branch: ${meta.branch}\n` : ""}${meta?.sha ? `- SHA: \`${meta.sha}\`\n` : ""}${input.workflow ? `- Workflow file: \`${input.workflow.path}\` @ \`${input.workflow.sha.slice(0, 12)}\`\n` : ""}- Failure fingerprint: \`${input.fingerprint}\`
## Failure

> ${singleLine(input.failure.summary)}

${input.failure.failingStep ? `- Failing step: \`${input.failure.failingStep}\`\n` : ""}${input.failure.exitCode !== undefined ? `- Exit code: \`${input.failure.exitCode}\`\n` : ""}- Closest repro command: \`${reproCommandFor(input.ecosystem, input.failure)}\`
${input.workflow?.commandSource === "workflow" ? `- Command source: CI workflow definition (\`${input.workflow.path}\`), confirmed by log evidence\n` : ""}${input.workflow && input.workflow.agree === false ? `- Command check: CI workflow defines a different command — see \`repro.json\` → \`workflow.stepCommand\` (log evidence may show a wrapper or a later step)\n` : ""}- Hint: ${input.failure.hint}

<details><summary>Error context (redacted)</summary>

\`\`\`
${input.failure.errorLines.slice(0, 40).join("\n")}
\`\`\`

</details>

## Environment (CI)

\`\`\`
${formatEnvironment(input.runtime)}
\`\`\`

- Ecosystem: \`${input.ecosystem.id}\` (confidence: ${input.ecosystem.confidence})
- Evidence: ${input.ecosystem.evidence.join("; ") || "n/a"}
- Install: \`${input.ecosystem.installCommand}\`
- Test: \`${input.ecosystem.testCommand}\`

No Docker required. No telemetry. Secrets were redacted heuristically (${input.redactions} replacements); review the bundle before sharing — redaction is best-effort, not a guarantee.

## Files

- \`reproduce.sh\` — bash reproduction script
- \`reproduce.ps1\` — PowerShell reproduction script
- \`failure.txt\` — redacted failure excerpt + full error context
- \`environment.txt\` — CI runner/runtime details
- \`repro.json\` — machine-readable metadata (redacted)
- \`bundle.sha256\` — integrity hash over the content files
- \`README.md\` — this file
`;
}

export function buildFailureTxt(input: BundleInput): string {
  const meta = input.runMeta;
  const header = [
    `source: ${input.sourceDisplay}`,
    input.sourceUrl ? `run: ${input.sourceUrl}` : null,
    meta?.workflow ? `workflow: ${meta.workflow}` : null,
    meta?.job ? `job: ${meta.job}` : null,
    input.failure.failingStep ? `step: ${input.failure.failingStep}` : null,
    input.failure.exitCode !== undefined ? `exit-code: ${input.failure.exitCode}` : null,
    `ecosystem: ${input.ecosystem.id}`,
    `repro: ${reproCommandFor(input.ecosystem, input.failure)}`,
    `redactions: ${input.redactions}`,
    ``,
    `summary: ${singleLine(input.failure.summary)}`,
    `hint: ${input.failure.hint}`,
    ``,
    `--- error context (redacted) ---`,
  ].filter((x): x is string => x !== null);
  return header.join("\n") + "\n" + input.failure.errorLines.join("\n") + "\n";
}

export function buildEnvironmentTxt(input: BundleInput): string {
  return [
    `source: ${input.sourceDisplay}`,
    input.sourceUrl ? `run: ${input.sourceUrl}` : null,
    ``,
    formatEnvironment(input.runtime),
    ``,
    `ecosystem: ${input.ecosystem.id} (confidence: ${input.ecosystem.confidence})`,
    `evidence: ${input.ecosystem.evidence.join("; ") || "n/a"}`,
    `install: ${input.ecosystem.installCommand}`,
    `test: ${input.ecosystem.testCommand}`,
    `hint: ${input.ecosystem.runHint}`,
    ``,
    `Generated by actionrepro. Secrets redacted heuristically (best-effort, ${input.redactions} replacements).`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

export function createBundle(input: BundleInput, outDir: string): BundleResult {
  ensureDir(outDir);
  const files: string[] = [];

  const sh = buildReproduceSh(input);
  const ps1 = buildReproducePs1(input);
  const readme = buildBundleReadme(input);
  const failure = buildFailureTxt(input);
  const envTxt = buildEnvironmentTxt(input);
  // Integrity hash covers the content files. repro.json is excluded on
  // purpose: it carries this hash, so including it would be circular.
  // (Redaction is idempotent on already-redacted content, so the hash also
  // matches the bytes on disk after the final safety pass in write().)
  const bundleSha256 = hashBundleFiles([
    { name: "reproduce.sh", content: sh },
    { name: "reproduce.ps1", content: ps1 },
    { name: "failure.txt", content: failure },
    { name: "environment.txt", content: envTxt },
  ]);
  const meta = {
    tool: "actionrepro",
    source: input.sourceDisplay,
    runUrl: input.sourceUrl ?? null,
    ecosystem: input.ecosystem.id,
    ecosystemConfidence: input.ecosystem.confidence,
    evidence: input.ecosystem.evidence,
    fingerprint: input.fingerprint,
    fingerprintVersion: FINGERPRINT_ALGO,
    bundleSha256,
    workflow: input.workflow ?? null,
    failure: {
      summary: singleLine(input.failure.summary),
      failingJob: input.failure.failingJob ?? input.runMeta?.job ?? null,
      failingStep: input.failure.failingStep ?? null,
      exitCode: input.failure.exitCode ?? null,
      reproCommand: reproCommandFor(input.ecosystem, input.failure),
      hint: input.failure.hint,
    },
    runtime: input.runtime,
    redactions: input.redactions,
    generatedAt: new Date().toISOString(),
  };

  // Final safety: redact every file once more before writing.
  const write = (name: string, content: string, executable = false) => {
    const safe = redactText(content).text;
    const fp = `${outDir}/${name}`;
    fs.writeFileSync(fp, safe, "utf8");
    if (executable) {
      try {
        fs.chmodSync(fp, 0o755);
      } catch {
        /* Windows: ignore chmod */
      }
    }
    files.push(fp);
  };

  write("reproduce.sh", sh, true);
  write("reproduce.ps1", ps1);
  write("README.md", readme);
  write("failure.txt", failure);
  write("environment.txt", envTxt);
  write("repro.json", JSON.stringify(meta, null, 2) + "\n");
  write(
    "bundle.sha256",
    `# actionrepro bundle integrity: sha256 over reproduce.sh, reproduce.ps1,\n# failure.txt and environment.txt (sorted by name, in that framing).\n${bundleSha256}\nreproduce.sh\nreproduce.ps1\nfailure.txt\nenvironment.txt\n`,
  );

  return { outDir, files };
}
