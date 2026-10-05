# ActionRepro

Turn a failed **GitHub Actions** run into a **local reproducibility bundle** — deterministically, with no LLM, no backend, no telemetry.

```bash
npx actionrepro https://github.com/OWNER/REPO/actions/runs/RUN_ID
# or from a saved log file (no network needed):
actionrepro ./failure.log
```

It fetches the workflow run + jobs + logs via the official GitHub API, detects the ecosystem (`npm` / `pnpm` / `yarn` / `pip` / `uv` / `cargo` / `go`), extracts the failure cause and the closest repro command, redacts secrets, and writes a ready-to-run `actionrepro/` folder.

## Before / after

**Before:** CI fails and you scroll raw logs on your phone.

```
Run npm test
FAIL src/add.test.ts > adds numbers → expected 3 to equal 4
npm ERR! Exit status 1
##[error]Process completed with exit code 1.
```

**After:** one command gives you a runnable bundle.

```bash
$ npx actionrepro https://github.com/acme/app/actions/runs/123456789
failure: Failure in job "test" / step "Run npm test": ##[error]Process completed with exit code 1.
ecosystem: npm
repro command: npm test
bundle: actionrepro/
  - actionrepro/reproduce.sh
  - actionrepro/reproduce.ps1
  - actionrepro/README.md
  - actionrepro/failure.txt
  - actionrepro/environment.txt
  - actionrepro/repro.json
redactions: 0
tip: run ./actionrepro/reproduce.sh

$ ./actionrepro/reproduce.sh
==> actionrepro: ecosystem=npm confidence=high
==> failure: Failure in job "test" / step "Run npm test": ...
==> Step 1/2: install dependencies
==> Step 2/2: reproduce failure
==> running: npm test
```

Local-file mode is identical, minus the network:

```bash
actionrepro ./failure.log --out ./actionrepro
cat actionrepro/failure.txt
```

## Install

Requires **Node.js ≥ 18**. No Docker required. Best experience on Linux and Termux.

```bash
npm install -g actionrepro
# or one-shot:
npx actionrepro --help
```

Termux:

```bash
pkg update && pkg install -y git nodejs python
npx actionrepro ./failure.log
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

# Check toolchains / network / token
actionrepro doctor
actionrepro doctor --json
```

Private repos and higher rate limits:

```bash
export GITHUB_TOKEN=ghp_...   # never printed; only sent to api.github.com
actionrepro https://github.com/ORG/PRIVATE/actions/runs/ID
```

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

| File              | Purpose                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `reproduce.sh`    | Bash repro script (Linux/macOS/Termux/Git Bash), `chmod +x` ready |
| `reproduce.ps1`   | PowerShell repro script for Windows                               |
| `README.md`       | Human summary: source, failure, env, how to run                   |
| `failure.txt`     | Redacted failure excerpt + error context                          |
| `environment.txt` | Runner OS/arch, Node/Python/Go/Rust versions, PM hint             |
| `repro.json`      | Machine-readable redacted metadata                                |

The script is ecosystem-aware:

- `npm` → `npm ci` (fallback `npm install`) then `npm test` (or the exact failing command)
- `pnpm` → `pnpm install --frozen-lockfile` then `pnpm test`
- `yarn` → `yarn install --frozen-lockfile` then `yarn test`
- `pip` → `pip install -r requirements.txt` then `pytest`
- `uv` → `uv sync` then `uv run pytest`
- `cargo` → `cargo fetch` then `cargo test`
- `go` → `go mod download` then `go test ./...`

## Security: secret redaction

Every log line, summary, file, and error message passes through deterministic redaction before it is printed or written:

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
  issues: write # only if you want the safe comment

jobs:
  repro:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: node:20
        with: {}
      - name: Build repro bundle (redacted)
        uses: ./ # or: owner/ActionRepro@v1
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

The composite action (`action.yml`) runs `npx actionrepro` with redaction and uploads `actionrepro/` as an artifact. It never prints `GITHUB_TOKEN` and never posts raw logs — the optional comment path posts only the redacted summary + repro command. See [action.yml](action.yml).

## How failure extraction works (no LLM)

1. Normalize lines (strip ANSI + `2024-…Z` timestamps).
2. Score each line against weighted error patterns (`Process completed with exit code N`, `##[error]`, `npm ERR!`, `FAILED/FAIL`, tracebacks, `error[E…]`, `panic:`, …). Highest weight wins; ties go to the last occurrence.
3. Walk backwards for the nearest `Run <cmd>` / `$ <cmd>` (or `npm/pnpm/yarn/pytest/cargo/go` invocation) as the repro command.
4. Detect ecosystem from `Run …` lines + error signatures + local manifest names.
5. Detect runtime versions from `setup-node/python/go`, `rustc`, `go version`, `Operating System:` lines.

Same input → same output. Fixtures live in [`fixtures/logs/`](fixtures/logs/).

## Project layout

```
src/
  cli.ts                 # commander wiring (default/inspect/reproduce/doctor)
  index.ts               # public library exports
  commands/              # inspect.ts reproduce.ts doctor.ts
  core/                  # url.ts github.ts logs.ts redact.ts extract.ts ecosystems.ts runtime.ts bundle.ts runner.ts
  providers/             # types.ts (CiProvider) + github-actions.ts
  ecosystems/            # reserved: per-ecosystem adapters (registry pattern)
  utils/
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
npm run ci          # typecheck + lint + format + build + test
node dist/cli.js doctor
node dist/cli.js inspect fixtures/logs/npm-fail.log
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
