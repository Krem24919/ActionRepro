# Pull request

## What changed and why

<!-- One paragraph. Link any related issue. -->

## Verification

- [ ] `npm run typecheck`, `npm run lint`, `npm run format`, `npm run build`, `npm test` all pass.
- [ ] New/changed log shapes have fixtures in `fixtures/logs/` plus tests.
- [ ] No secrets, tokens, or real credentials in code, tests, fixtures, or comments.
- [ ] Docs updated (`README.md` / `CHANGELOG.md`) if behavior changed.

## Redaction check (for parser/bundle changes)

- [ ] Ran against `fixtures/logs/secrets.log` — no fake secret survives in output or bundle.
