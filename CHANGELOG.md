# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.2.0] - 2026-10-06

### Added

- `actionrepro verify <bundle> <logfile>`: compares a fresh local log against
  the bundle's recorded failure fingerprint and reports REPRODUCED /
  NOT_REPRODUCED / INCONCLUSIVE (exits 0/1/2). No probabilities, no guessing.
- Failure fingerprints (stable sha256 over ecosystem, command, exit code, and
  normalized error lines) recorded in every bundle, plus `bundle.sha256`
  integrity hashes over the bundle content files.
- Workflow cross-check for GitHub URLs: the workflow file is fetched at the
  exact run SHA and the CI-defined step command is compared against the log
  evidence (match / conflict / unknown), recorded in `repro.json`.

## [0.1.1] - 2026-10-06

### Added

- GitHub CLI token fallback: when no `--token` flag or `GITHUB_TOKEN`/`GH_TOKEN`
  env var is set, the authenticated `gh` CLI token is used automatically
  (local subprocess only, validated, never printed). `doctor` reports the
  active token source.

### Changed

- Visual pass: CLI output uses `ActionRepro <command>` headers with grouped
  indentation; generated bundle README leads with run instructions;
  main README gained CI/license badges, a contents index, a logo, and
  terminal demo images (`assets/`).
  No behavior or output-contract changes (`--json` untouched).
- Renamed the project from `ci-repro` to `ActionRepro` (npm package + CLI
  `actionrepro`, default bundle directory `actionrepro/`).

### Security

- Treat CI-extracted repro commands as untrusted: `reproduce.sh`/`reproduce.ps1`
  now show a security notice, print the exact command, and ask for
  confirmation on interactive terminals (`CI_REPRO_YES=1` skips it;
  non-interactive shells never hang). Exit codes distinguish setup failure
  (`3`) from user abort (`4`) from the command's own exit code.
- Escape log-derived metadata (`$`, backticks, quotes) embedded in generated
  scripts so hostile log text can never execute at script run time; the repro
  command itself stays byte-identical.
- Reject unsafe owner/repo URL segments before any API call.

- `release.yml` split: tag pushes always verify + create the GitHub Release;
  npm publishing is opt-in (`NPM_PUBLISH_ENABLED=true` + `NPM_TOKEN`) and can
  no longer block a release.
- Bundle scripts report `INSTALL_FAILED` / `REPRODUCED` / `NOT REPRODUCED`
  explicitly; install problems are never presented as reproduction results.
- Docs: install-from-source until first npm publish, fixed invalid action
  example, removed unimplemented comment-posting claims, redaction described
  as best-effort everywhere.

### Fixed

- Corrected the job-logs endpoint to the official
  `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` (was missing
  `owner/repo`, found by testing against a real failed run).
- `reproduce <RUN_URL>` now fails fast with a redacted, actionable error when
  no job logs could be downloaded (e.g. missing `GITHUB_TOKEN`) instead of
  writing an empty bundle; `inspect` still reports failing job/step metadata.
- Documented that downloading Actions logs requires authentication even for
  public repos (verified live: unauthenticated log download returns
  `403 Must have admin rights`).
- Sanitize `##[` workflow-command markers in human stdout (and in the
  reusable action's echoed summary) so failure text copied from CI logs can
  never be parsed by the runner into phantom failure annotations. `--json`
  output and bundle files stay byte-identical.

## [0.1.0] - 2026-10-05

### Added

- Initial MVP: `actionrepro <RUN_URL|file>`, `inspect`, `reproduce`, `doctor` commands.
- Official GitHub API fetching (run + jobs + per-job logs) with optional `GITHUB_TOKEN`, public repos work tokenless.
- Deterministic failure extraction (weighted error patterns + nearest `Run <cmd>`), no LLM.
- Ecosystem detection + tailored scripts for npm, pnpm, yarn, pip/uv, cargo, go.
- Redacted `actionrepro/` bundle: `reproduce.sh`, `reproduce.ps1`, `README.md`, `failure.txt`, `environment.txt`, `repro.json`.
- Secret redaction for tokens, key=value pairs, URL creds, PEM blocks, sensitive env names.
- Optional reusable GitHub Action (`action.yml`) with artifact + safe comment.
- Full package hygiene: README with before/after, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, LICENSE, unit + integration tests, fixtures, CI + release workflows, ESLint + Prettier + tsc.
