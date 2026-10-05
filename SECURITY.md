# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

Open a GitHub issue with `[security]` in the title, or contact the maintainers privately if the issue involves secret handling. Please include:

- actionrepro version + command run (redact your own tokens first!)
- Expected vs actual redaction behavior
- A minimal log snippet reproducing the leak (with fake secrets, not real ones)

We aim to acknowledge within 72 hours and fix redaction bypasses as high priority.

## Secret handling guarantees

- actionrepro **never prints** `GITHUB_TOKEN`/`GH_TOKEN` or any detected credential. Tokens are only sent as an `Authorization: Bearer` header to `api.github.com`.
- All CLI output, bundle files, errors, and the optional Action comment pass through `redactText()` (`src/core/redact.ts`).
- The tool makes **no other network calls**. Local-file mode (`actionrepro ./failure.log`) makes zero network calls.
- No telemetry, no backend, no database. Nothing leaves your machine except the documented GitHub API requests.

## Using safely

- Prefer `GITHUB_TOKEN` from env / secrets over `--token` (avoids shell history).
- Review `actionrepro/failure.txt` before sharing — redaction is deterministic but heuristic; report gaps.
- The reusable Action uploads only the redacted `actionrepro/` folder as an artifact and posts only the redacted summary.
