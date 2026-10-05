# Contributing to ActionRepro

Thanks for helping! This project is intentionally small, deterministic, and dependency-light.

## Ground rules

- No LLM calls, no backend, no database, no tracking/telemetry. Keep it that way.
- No secrets in code, logs, tests, or comments. Use fixtures with fake tokens only.
- Keep the CLI cross-platform (Linux/macOS/Windows) with best effort on Termux. No Docker requirement.
- Deterministic extraction: same input → same output. Add a fixture + test for new patterns.

## Setup

```bash
npm install
npm run typecheck
npm run lint
npm run build
npm test
```

Node ≥ 18 required.

## Workflow

1. Fork + branch (`feat/...`, `fix/...`).
2. Add/update code in `src/` (modular: `core/`, `providers/`, `commands/`).
3. Add a fixture in `fixtures/logs/` for new log shapes + unit test in `test/unit/`.
4. Run the full gate: `npm run ci` (typecheck + lint + format + build + test).
5. Open a PR with before/after CLI output and the redaction check.

## Adding a CI provider

1. Implement `CiProvider` from `src/providers/types.ts` (`matches()` + `fetch()`).
2. Wire it in `src/commands/inspect.ts` and `src/commands/reproduce.ts` provider selection.
3. Add fixtures + tests. No changes to redaction/bundle needed.

## Adding a package ecosystem

1. Extend `detectEcosystem()` in `src/core/ecosystems.ts` (explicit `Run …` signal + error signature + manifest file).
2. Extend `installBlock()` / `psInstall()` in `src/core/bundle.ts`.
3. Add success + failure fixtures and bundle assertions.

## Redaction rules

- New secret shapes go in `src/core/redact.ts` `PATTERNS` or `SECRET_ENV_NAMES`, with a unit test proving the value disappears but output stays debuggable.
- Never `console.log` tokens, `Authorization` headers, or raw env. All errors pass through `redactText()` in `src/cli.ts`.

## Release

Maintainers tag `vX.Y.Z` → `.github/workflows/release.yml` builds, tests, and publishes to npm with provenance. Update [CHANGELOG.md](CHANGELOG.md).
