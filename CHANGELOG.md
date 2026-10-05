# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed

- Renamed the project from `ci-repro` to `ActionRepro` (npm package + CLI
  `actionrepro`, default bundle directory `actionrepro/`).

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
