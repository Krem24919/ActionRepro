# ActionRepro

<p align="center">
  <img src="assets/logo.png" alt="ActionRepro logo — reproduce CI failures locally" width="640" />
</p>

[![CI](https://github.com/Krem24919/ActionRepro/actions/workflows/ci.yml/badge.svg)](https://github.com/Krem24919/ActionRepro/actions/workflows/ci.yml)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Turn a failed **GitHub Actions** run into a **local reproducibility bundle** — deterministically, with no LLM, no backend, no telemetry.

```bash
actionrepro https://github.com/OWNER/REPO/actions/runs/RUN_ID
# or from a saved log file (no network needed):
actionrepro ./failure.log
```

It fetches the workflow run + jobs + logs via the official GitHub API, detects the ecosystem (`npm` / `node --test` / `pnpm` / `yarn` / `pip` / `uv` / `cargo` / `go` / `maven` / `gradle` / `dotnet` / `ruby`), extracts the most likely failure cause and the closest repro command, redacts secrets heuristically, and writes a ready-to-run `actionrepro/` folder.

## Before / after

**Before:** CI fails and you scroll raw logs on your phone.

```
Run npm test
FAIL src/add.test.ts > adds numbers → expected 3 to equal 4
npm ERR! Exit status 1
##[error]Process completed with exit code 1.
```

**After:** one command gives you a runnable bundle.

![actionrepro reproduce demo](assets/demo-reproduce.svg)

(`## [error]` — with a space — is intentional: it stops CI runners from
parsing our output into phantom annotations.)

Local-file mode is identical, minus the network:

```bash
actionrepro ./failure.log --out ./actionrepro
cat actionrepro/failure.txt
```

## Contents

- [Before / after](#before--after)
- [Install](#install)
- [Usage](#usage)
- [What the bundle contains](#what-the-bundle-contains)
- [Verifying a fix (`verify`)](#verifying-a-fix-verify)
- [Coding agents (MCP)](#coding-agents-mcp)
- [Security: secret redaction](#security-secret-redaction)
- [GitHub Action (optional, for other repos)](#github-action-optional-for-other-repos)
- [How failure extraction works (no LLM)](#how-failure-extraction-works-no-llm)
- [Project layout](#project-layout)
- [Development](#development)
- [Troubleshooting / FAQ](#troubleshooting--faq)
- [License](#license)

## Install

Requires **Node.js ≥ 18**. No Docker required. Best experience on Linux and Termux.

From source (works today):

```bash
git clone https://github.com/Krem24919/ActionRepro.git
cd ActionRepro
npm install
npm run build
node dist/cli.js --help
# put it on your PATH:
npm install -g .
actionrepro --help
```

> Distribution is source-only by design — there is no registry package
> and none is planned. Clone, build, and optionally `npm install -g .`
> to put `actionrepro` on your PATH.
>
> **Versioning:** tags `v0.1.0`–`v0.2.0` were early builds, now published as
> Alpha prereleases (`v0.1.0-alpha.1` … `v0.1.0-alpha.3`). Numbering restarts
> at 0.1.0 for the production-grade rebuild.

Termux (from source):

```bash
pkg update && pkg install -y git nodejs python
git clone https://github.com/Krem24919/ActionRepro.git
cd ActionRepro && npm install && npm run build
node dist/cli.js ./failure.log
```

## Usage

```bash
# Full flow: fetch + analyze + write bundle
actionrepro https://github.com/OWNER/REPO/actions/runs/RUN_ID [--out actionrepro] [--run]

# Analyze only (no files written)
actionrepro inspect https://github.com/OWNER/REPO/actions/runs/RUN_ID [--json]
actionrepro inspect ./failure.log

# Create bundle (+ optionally execute it)
actionrepro reproduce ./failure.log --out ./actionrepro
actionrepro reproduce <RUN_URL> --out ./actionrepro --run

# Verify a local re-run against the recorded CI fingerprint
actionrepro verify ./actionrepro ./local-run.log [--json]
# verdict: REPRODUCED (exit 0), NOT_REPRODUCED (exit 1), INCONCLUSIVE (exit 2)

# Prove a fix in one step (runs the bundle, verifies, records history)
actionrepro prove ./actionrepro ./local-run.log [--json]
actionrepro prove ./actionrepro --run [--cwd ./my-repo]
# state: fixed (exit 0), still-failing / changed-failure (exit 1),
# inconclusive / unable-to-reproduce (exit 2)

# Check toolchains / network / token
actionrepro doctor
actionrepro doctor --json
```

![actionrepro inspect demo](assets/demo-inspect.svg)

Private repos and higher rate limits:

```bash
export GITHUB_TOKEN=ghp_...   # never printed; only sent to api.github.com
actionrepro https://github.com/ORG/PRIVATE/actions/runs/ID
```

No token handy but have the GitHub CLI? If `gh` is installed and authenticated,
its token is used automatically — no flags needed:

```bash
gh auth login
actionrepro https://github.com/ORG/PRIVATE/actions/runs/ID
```

Token precedence: `--token` flag, then `GITHUB_TOKEN`/`GH_TOKEN` env, then
`gh auth token` (runs locally, output validated, never printed). `doctor`
shows which source is active.

GitLab CI works the same way — pass a pipeline or job URL instead of a run
URL (self-hosted hosts included):

```bash
actionrepro https://gitlab.com/GROUP/PROJECT/-/pipelines/123
actionrepro https://gitlab.com/GROUP/PROJECT/-/jobs/456
export GITLAB_TOKEN=glpat-...   # private projects (or --token); never printed
```

GitLab notes: statuses map to the same vocabulary (`failed` → `failure`);
GitLab jobs expose no per-step API, so the failing step comes from log
extraction alone, and the workflow cross-check is GitHub-only for now.

Authentication notes (verified against the live GitHub API):

- Run/job metadata (including the failing job and step) is public — `inspect`
  works on public runs with no token.
- Downloading logs requires authentication **even for public repos** (GitHub
  returns `403 Must have admin rights` otherwise). Any token with no scopes
  works for public repos; private repos need a token with repo access.
- Without usable logs, `reproduce <RUN_URL>` fails fast with a redacted,
  actionable error instead of writing an empty bundle — set `GITHUB_TOKEN`
  and retry, or download the logs manually and run `actionrepro ./failure.log`.

## What the bundle contains

| File              | Purpose                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `reproduce.sh`    | Bash repro script (Linux/macOS/Termux/Git Bash), `chmod +x` ready                                              |
| `reproduce.ps1`   | PowerShell repro script for Windows                                                                            |
| `README.md`       | Human summary: source, failure, env, how to run                                                                |
| `failure.txt`     | Redacted failure excerpt + error context                                                                       |
| `environment.txt` | Runner OS/arch, Node/Python/Go/Rust versions, PM hint                                                          |
| `repro.json`      | Machine-readable redacted metadata (incl. whether the repro command came from the log or an ecosystem default) |
| `bundle.sha256`   | Integrity hash over the bundle content files                                                                   |

Each bundle also records a **failure fingerprint** (stable hash of ecosystem,
command, exit code, error kind, and the failure anchor line — the single most
diagnostic line, never a context window) and, for GitHub URLs, the
**workflow file at the exact run SHA**: when the CI-defined step command
agrees with the log evidence, the bundle replays the exact CI `run:` script
(the log stays as evidence); otherwise the log-derived command is kept and
the disagreement is recorded (`repro.json → workflow`, including which
source won). Step lookup is scoped to the failing job, so repeat step names
in other jobs can't mislead it. `verify` compares a fresh local log against
the recorded fingerprint — no probabilities, just match / differ / unreadable.

The script is ecosystem-aware:

- `npm` → `npm ci` (fallback `npm install`) then `npm test` (or the exact failing command)
- `node` → `npm ci` (if `package.json` exists) then `node --test`
- `pnpm` → `pnpm install --frozen-lockfile` then `pnpm test`
- `yarn` → `yarn install --frozen-lockfile` then `yarn test`
- `pip` → `pip install -r requirements.txt` then `pytest`
- `uv` → `uv sync` then `uv run pytest`
- `cargo` → `cargo fetch` then `cargo test`
- `go` → `go mod download` then `` `go test ./...` ``
- `maven` → `mvn -B dependency:resolve` then `mvn -B test`
- `gradle` → `./gradlew -q dependencies` then `./gradlew test`
- `dotnet` → `dotnet restore` then `dotnet test`
- `ruby` → `bundle install` then `bundle exec rspec`

Scope: the bundle replays dependency install + the closest failing command with your user privileges. It does not check out any commit, and does not provide CI services, caches, artifacts, secrets, or matrix variables — a pass/fail here is best-effort evidence, not proof.`

## Verifying a fix (`verify`)

Fixed something and want proof the failure is gone? Re-run the bundle's
command locally, save the output, and compare it against the fingerprint
recorded from CI:

```bash
actionrepro reproduce ./ci-failure.log --out ./actionrepro
bash actionrepro/reproduce.sh > ./local-run.log 2>&1
actionrepro verify ./actionrepro ./local-run.log
```

Real output (same failure → still broken; different log → fixed or changed):

```
ActionRepro verification
  recorded fingerprint: 448b198fe15ef98f
  fresh fingerprint: 448b198fe15ef98f
  CI exit code: 1
  fresh exit code: 1
  verdict: REPRODUCED
  reason: Fresh failure fingerprint matches the recorded CI fingerprint.
```

```
  verdict: NOT_REPRODUCED
  reason: Fresh failure fingerprint differs from the recorded CI fingerprint.
```

Exit codes are CI-friendly: `0` = REPRODUCED, `1` = NOT_REPRODUCED,
`2` = INCONCLUSIVE (bundle or log unreadable). Add `--json` for the
machine-readable form. The comparison is a stable hash over ecosystem,
command, exit code, error kind, and the failure anchor line — no
probabilities, just match / differ / unreadable.

Verdicts in practice:

- `REPRODUCED` — the fresh log contains the same failure anchor.
- `NOT_REPRODUCED` — either a different failure, **or no failure at all**
  (the command exited 0: that is what "my fix worked" looks like).
- `INCONCLUSIVE` — the fresh log is missing/empty/unreadable, or the bundle
  was created before 0.1.0 (older fingerprints hashed a context window and
  cannot be compared with the current algorithm — re-create the bundle).

Lines that the bundle's own script prints start with `==> [actionrepro]` and
are ignored during comparison, so piping the script's output into the fresh
log is safe — the script's own summary can never make a fixed run look
reproduced. The script's last line, `result: exit_code=N`, is the exit code
`verify` records for the re-run.

## Coding agents (MCP)

`actionrepro mcp` speaks the Model Context Protocol over stdio (spec
2025-11-25; older versions negotiated), exposing seven tools with structured
JSON results: `inspect`, `reproduce`, `verify`, `fingerprint`, `doctor`,
`history`, `prove`. Same functions as the CLI — agents and humans can never disagree about what
a failure means.

Claude Code (project `.mcp.json`, or `claude mcp add actionrepro -- node
/path/to/ActionRepro/dist/cli.js mcp`):

```json
{
  "mcpServers": {
    "actionrepro": {
      "command": "node",
      "args": ["/path/to/ActionRepro/dist/cli.js", "mcp"]
    }
  }
}
```

Suggested agent loop: `history lookup` to check whether this failure is
already known → `inspect` the failure → `reproduce` it into a bundle
→ edit code → `prove` the bundle (`--run` to execute, or pass a fresh log)
which verifies, records history, and reports fixed / still-failing /
changed-failure (`mark_fixed` when it stays green).
`reproduce` defaults to files-only; pass `run: true` only with the user's
explicit approval (MCP sessions are non-interactive, so the terminal
confirmation gate is skipped there). Tokens go only to `api.github.com`
and are never echoed; all outputs are secret-redacted best-effort.

## Security: secret redaction

Every log line, summary, file, and error message passes through deterministic, pattern-based redaction before it is printed or written. It is best-effort, not a guarantee — always review a bundle before sharing:

- `ghp_/gho_/ghu_/ghs_/ghr_`, `github_pat_`, `xox*`, `sk_live/test`, `AKIA…`
- `Bearer …` / `Basic …`, `_authToken=…`, PEM private-key blocks
- `password=…` / `token=…` / `api_key=…` style pairs (key name kept, value → `[REDACTED]`)
- URL-embedded creds (`https://user:pass@host` → `https://[REDACTED]@host`)
- Values of `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `*_SECRET`, `*_PASSWORD`, etc.

There is no tracking or telemetry. The only network calls are to `api.github.com`, and only when you pass a GitHub URL. See [SECURITY.md](SECURITY.md).

## GitHub Action (optional, for other repos)

Attach a safe reproduction bundle to every failed run:

```yaml
# .github/workflows/actionrepro.yml in YOUR repo
name: actionrepro
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

permissions:
  actions: read
  contents: read

jobs:
  repro:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 20
      - name: Build repro bundle (redacted)
        uses: Krem24919/ActionRepro@main # temporary: pinned to a release tag once 0.1.0 ships
        with:
          run-url: ${{ github.event.workflow_run.html_url }}
          out: actionrepro
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - uses: actions/upload-artifact@v4
        with:
          name: actionrepro-bundle
          path: actionrepro/
```

The composite action (`action.yml`) builds itself from the pinned tag's
source (self-contained — no registry package involved), runs `reproduce --json` with redaction,
and uploads `actionrepro/` as an artifact. It never prints `GITHUB_TOKEN`
and never posts raw logs. Pass `run-url` for a run, or `log-file` (a path
in your checkout) for a saved log — see [action.yml](action.yml). Our own
CI dogfoods it on every push (`.github/workflows/dogfood.yml`).

## How failure extraction works (no LLM)

1. Normalize lines (strip ANSI + `2024-…Z` timestamps) and drop the bundle's own `==> [actionrepro]` frame.
2. Score each line against weighted error patterns (tracebacks, `error[E…]`, `panic:`, `not ok N`, `ERR_PNPM_…`, `FAILED/FAIL`, `npm ERR!`, …). The runner's own restatements — `Process completed with exit code N`, `npm ERR! Exit status`/`code ELIFECYCLE`/`errno` — are bookkeeping: they supply the exit code and only become the anchor when nothing better matched. Highest weight wins; ties go to the last occurrence.
3. Walk backwards for the nearest `Run <cmd>` / `$ <cmd>` (or `npm/pnpm/yarn/pytest/cargo/go` invocation) as the repro command.
4. Detect ecosystem from `Run …` lines + error signatures + local manifest names.
5. Detect runtime versions from `setup-node/python/go`, `rustc`, `go version`, `Operating System:` lines.

Same input → same output. Fixtures live in [`fixtures/logs/`](fixtures/logs/).

## Project layout

```
src/
  cli.ts                 # commander wiring (inspect/reproduce/doctor/verify/mcp/history/prove + shorthand)
  index.ts               # public library exports
  commands/              # inspect.ts reproduce.ts doctor.ts verify.ts history.ts prove.ts
  mcp/                   # protocol.ts tools.ts server.ts (MCP stdio server, zero deps)
  core/                  # url.ts github.ts logs.ts redact.ts extract.ts ecosystems.ts runtime.ts bundle.ts runner.ts fingerprint.ts workflow.ts history.ts
  providers/             # types.ts (CiProvider) + github-actions.ts gitlab.ts registry.ts
  ecosystems/            # adapters.ts + registry.ts + types.ts (per-ecosystem behavior)
  utils/                 # fs.ts log.ts version.ts
test/unit/ test/integration/   # vitest, deterministic fixtures
fixtures/logs/ fixtures/api/
action.yml               # reusable composite action
.github/workflows/      # ci.yml + release.yml
```

Adding a provider: implement `CiProvider` in `src/providers/` (`matches()` + `fetch()`). Adding an ecosystem: extend `detectEcosystem()` + `installBlock()` in `src/core/bundle.ts`. No backend changes needed — there is no backend.

## Development

```bash
npm install
npm run typecheck   # tsc (tests included)
npm run lint        # eslint, zero warnings
npm run format      # prettier --check
npm run build       # tsc -> dist/
npm test            # vitest (unit + integration)
npm run bench       # benchmark: accuracy, stability, verify matrix, timings
npm run ci          # typecheck + lint + format + build + test
node dist/cli.js doctor
node dist/cli.js inspect fixtures/logs/npm-fail.log
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [CHANGELOG.md](CHANGELOG.md).

## Troubleshooting / FAQ

**`reproduce <RUN_URL>` fails asking for a token on a public repo.**
Downloading Actions logs requires authentication even for public repos —
GitHub returns `403 Must have admin rights` without it. Any token works for
public repos (no scopes needed); private repos need a token with repo access.
Or download the log manually and run `actionrepro ./failure.log` (no network).

**`inspect` works but `reproduce <RUN_URL>` writes nothing.**
Same cause as above: metadata is public, logs are not. The command fails
fast with a redacted error instead of writing an empty bundle — set
`GITHUB_TOKEN` and retry.

**No token, but `gh` is installed?**
`gh auth login` once — the CLI picks up `gh auth token` automatically
(`doctor` shows the active token source).

**Can I share the bundle publicly?**
Redaction is best-effort, not a guarantee — always skim `failure.txt` and
`repro.json` before attaching a bundle to a public issue.

**Does a local pass prove CI is fixed?**
No. The bundle replays install + the failing command without CI services,
caches, artifacts, secrets, or matrix variables. Use `verify` as evidence
(REPRODUCED / NOT_REPRODUCED), not proof.

**Windows?**
Use `reproduce.ps1`. The generated scripts ask for confirmation on
interactive terminals; set `CI_REPRO_YES=1` to skip it in automation.

**How is this different from `act`?**
`act` re-executes whole workflows in Docker _before_ anything fails (great
for testing workflow files; needs Docker). ActionRepro starts _after_ a
failure: from a run URL it extracts the exact failed step, builds a
shareable redacted bundle, and verifies the fix with fingerprints. They
complement each other — every bundle with a known job even prints the exact
`act -j "<job>"` fallback for environment-shaped failures.

## License

MIT — see [LICENSE](LICENSE).
