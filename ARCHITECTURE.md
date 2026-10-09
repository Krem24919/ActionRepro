# ActionRepro architecture

Deterministic CLI that turns failed CI runs into redacted local
reproducibility bundles. No LLM, no backend, no telemetry. One runtime
dependency (`commander`); everything else is the Node standard library.

## Layers

```
cli.ts            commander wiring + default shorthand dispatcher
commands/         inspect, reproduce, verify, prove, history, doctor, mcp wiring
  └── each command is a thin validated wrapper over core functions
core/             provider-agnostic logic: url, github, logs, redact, extract,
                  ecosystems, runtime, bundle, runner, fingerprint, workflow,
                  history
providers/        CiProvider implementations (github-actions, gitlab)
                  + registry (findProvider / resolveProviderToken)
ecosystems/       EcosystemAdapter registry (11 ecosystems)
mcp/              dependency-free MCP stdio server reusing command functions
utils/            fs, log, version
```

Rule: `commands/` may import from `core/`, `providers/`, `ecosystems/`.
`core/` never imports from `commands/` or `mcp/`. MCP tools call the same
command functions as the CLI, so agents and humans cannot disagree.

## Data flow (URL mode)

```
target URL → provider.fetch → run + jobs + per-job logs
  → redactText → extractFailure (anchor, kind, exit code, repro command)
  → detectEcosystem + detectRuntime
  → (GitHub only) workflow file at run SHA → commandSource
  → fingerprintFailure → createBundle → actionrepro/ directory
```

Local-file mode skips fetching; everything downstream is identical.

## Key contracts

- **Failure identity** is `sha256-v2` over ecosystem + command + exit code +
  error kind + anchor line. Context windows are never hashed (they differ
  between CI and local runs by construction). `repro.json` records
  `fingerprintVersion`; cross-generation comparison is `INCONCLUSIVE`,
  never a wrong verdict.
- **Exit codes are a contract**: bundle scripts use 3 = setup failed,
  4 = user aborted, 5 = no runnable command (nothing executed), else the
  command's own code. `reproduce --run` returns the script's code.
  `verify` (text and `--json` alike): 0 REPRODUCED / 1 NOT_REPRODUCED /
  2 INCONCLUSIVE. `prove` (text and `--json` alike): 0 fixed /
  1 still-failing or changed-failure / 2 inconclusive or unable-to-reproduce.
  `prove --run` treats 3/4/5 as "not reproduced" only when the script's
  `REPRODUCED:` / `NOT REPRODUCED:` line is absent, because the command itself
  may exit with those codes.
- **Log placeholder protocol**: undownloadable job logs are the string
  `(could not fetch logs for job <id>: <reason>)`, recognized by
  `allLogsFailed` / `firstLogError`. Providers must use it so callers fail
  fast instead of bundling error text.
- **History** is append-only JSONL (`~/.actionrepro/history.jsonl` default),
  keyed by fingerprint, tolerant of corrupt lines. History never breaks the
  command that consults it.
- **Redaction is best-effort**, applied to every log line, summary, file,
  and error message. Tokens go only to `api.github.com` (GitHub) or the
  GitLab host, and never appear in outputs — enforced by tests with
  sentinel tokens.
- **Generated scripts are untrusted-input runners**: confirm gate on TTYs,
  `CI_REPRO_YES=1` to skip, single evaluation pass (no `Invoke-Expression`),
  `==> [actionrepro]` frame lines ignored by extraction.
- **MCP** is newline-delimited JSON-RPC 2.0 on stdio, stdout carries only
  protocol lines, logs go to stderr. Tool failures are `isError` results,
  never protocol errors (except unknown tool/method).

## Extension points

- New CI system: implement `CiProvider` (`matches` + `fetch`), register in
  `providers/registry.ts`, add token env handling in `resolveProviderToken`.
- New ecosystem: add adapter + register, wire detection in
  `core/ecosystems.ts`, install blocks in `core/bundle.ts`, extract
  patterns in `core/extract.ts`, fixtures + tests. Never claim support
  without a realistic fixture and an end-to-end bundle test.
- New agent tool: add a definition + handler in `mcp/tools.ts` reusing a
  command function; add protocol, unit, and stdio tests.

## Non-goals

Checking out commits, providing CI services/caches/secrets/matrix,
re-executing whole workflows in containers (see `act`, documented as
complementary), probabilities or confidence scores on verdicts.

## Versioning

Numbering restarted at 0.1.0; tags `v0.1.0`–`v0.2.0` were early builds,
republished as `v0.1.0-alpha.1`…`v0.1.0-alpha.3` prereleases. See CHANGELOG.
