# ActionRepro review log

Branch: `arena/54eaaebb-actionrepro` (session branch; `arena.fix` could not be created here).
Baseline: `ec66a64` on `main`.

This log records each confirmed issue, how it was fixed, and the impact that was
**measured** (not assumed). "Before" numbers come from running the baseline build
(`git archive ec66a64`, built with `tsc`) on the same inputs. "After" numbers come
from the current `dist/`.

## 1. Results at a glance

| Check                                       | Baseline `ec66a64`                 | This branch                                                                      |
| ------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `npm run typecheck`                         | pass                               | pass                                                                             |
| `npm run lint` (`--max-warnings 0`)         | pass                               | pass                                                                             |
| `npm run format`                            | pass                               | pass                                                                             |
| `npm run build`                             | pass (TS6133 seen mid-work, fixed) | pass, clean                                                                      |
| `npm test`                                  | 182 / 182 (26 files)               | **267 / 267 (32 files)**                                                         |
| Touched test files run against baseline src | —                                  | **42 tests fail on baseline** (new tests plus one updated existing test); see §4 |
| `npm run bench`                             | PASS 9/9 (measured)                | PASS 9/9                                                                         |
| `npm run smoke`                             | —                                  | all steps pass except `doctor`'s network check (see §5, environment)             |

Diff size: 30 tracked files changed, +664 / −292 lines, plus 1 new source file (`src/core/selection.ts`), 6 new test files, and this report.

## 2. Measured behavior changes (same inputs, baseline vs. branch)

| #   | Scenario                                                                                                   | Baseline                                                                          | This branch                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| M1  | `bash -n` on the generated `reproduce.sh` for a pip log                                                    | exit 2 (syntax error at line 44)                                                  | exit 0                                                            |
| M2  | `prove <bundle> silent.log` where the fresh log is `Process completed with exit code 7.` and nothing else  | exit **0**, `state: fixed`                                                        | exit **2**, `state: inconclusive`                                 |
| M3  | `prove <bundle> --run` where dependency setup fails (`python3` returns 3)                                  | exit **0**, `state: fixed`                                                        | exit **2**, `state: unable-to-reproduce`                          |
| M4  | `reproduce <log> --run` where the CI command is `node -e "process.exit(5)"` (GitHub `##[group]Run` header) | exit 0, repro command `# see failure.txt …` (nothing runs)                        | exit **5**, repro command `node -e "process.exit(5)"`             |
| M5  | Jest log with a `+ Received` diff line under `##[group]Run npx jest`                                       | repro command = `Received` (would be executed)                                    | repro command = `npx jest`                                        |
| M6  | `TypeError: cannot read properties of undefined` in a CI log                                               | summary `Failure: ##[error]Process completed with exit code 1.`                   | summary `Failure: TypeError: cannot read properties of undefined` |
| M7  | `verify <bundle> silent.log --json` (INCONCLUSIVE verdict)                                                 | exit **0**                                                                        | exit **2**                                                        |
| M8  | `verify <bundle> ok.log --json` (NOT_REPRODUCED verdict)                                                   | exit **0**                                                                        | exit **1** (same as text mode)                                    |
| M9  | `redactText("Basic authentication failed for registry")`                                                   | `Basic [REDACTED] failed for registry`                                            | unchanged                                                         |
| M10 | `redactText("Bearer authentication required")`                                                             | `Bearer [REDACTED] required`                                                      | unchanged                                                         |
| M11 | `prove --run` temp directories left behind per run (captured, unredacted CI output)                        | 1 per run                                                                         | 0                                                                 |
| M12 | GitLab pipeline with 230 jobs                                                                              | one request `jobs?per_page=100`, no `page` parameter, so jobs 101+ are never seen | paginated, up to 10 pages of 100                                  |

Earlier probe (this session, before the MCP change): `reproduce --run` through MCP wrote
13 of 16 stdout lines that were not JSON-RPC. After the change, child output goes to a
temp file and only a redacted tail is returned (`runOutputTail`). The MCP test now checks
that nothing else reaches `process.stdout`.

## 3. Issues found, fixes, and impact (per file)

### Exit-code handling

1. **`verify` gave NOT_REPRODUCED for a silent failure.** A non-zero exit with no
   recognizable diagnostic was reported as "the failure is gone", so `prove` said `fixed`.
   _Fix:_ `verifyBundle` returns INCONCLUSIVE in that case, with a reason.
   _Impact:_ M2 (exit 0 "fixed" → exit 2 "inconclusive").
   _Limitation (kept on purpose):_ a command that fails with the same exit code but prints no
   diagnostic can never be REPRODUCED. That is the conservative choice.

2. **`prove --run` reported `fixed` when the bundle never ran.** Exit codes 3/4/5 were treated
   as "not a failure". _Fix:_ `scriptNotRunReason(code)` maps 3/4/5 to `unable-to-reproduce`, but
   only when the script's `REPRODUCED:` / `NOT REPRODUCED:` line is absent. A repro command that
   itself exits 3/4/5 is still verified, which fixes the collision.
   _Impact:_ M3 (exit 0 "fixed" → exit 2 "unable-to-reproduce"). `reproduce --run` with a
   command that exits 5 is still reported as REPRODUCED (exit 5), not as "no command".

3. **`prove --run` with a relative bundle path plus `--cwd` ran nothing and called it fixed.**
   The script path was relative to the repo under test, so bash returned 127. _Fix:_ the runner
   resolves the bundle to an absolute path and throws on spawn errors. `prove` also refuses to
   return `fixed` when a non-zero exit comes with no script header (the script never started).
   _Impact:_ on the build before this fix, the same path returned `run exit code: 127, state: fixed`.
   The new integration test covers it.

4. **`verify --json` and `prove --json` ignored the verdict for the exit code** (always 0). _Fix:_
   `cli.ts` sets the exit code in both modes, and `prove` catches errors. _Impact:_ M7, M8.

5. **`reproduce --run` ignored the bundle's exit code.** _Fix:_ the exit code is propagated in
   both the subcommand and the shorthand paths. _Impact:_ M4 (exit 0 → exit 5).

6. **Install failures were not one contract.** Each install line had its own `|| exit $?`,
   so a failure exited with that command's code and some did not fail at all. _Fix:_ the install
   block runs in a subshell and a failure exits 3 (`INSTALL_FAILED`). The pip syntax bug came with
   this change: the per-line suffix was appended to multi-line `if/elif/else`. A missing toolchain
   (`TOOL_MISSING`, previously exit 2) now also exits 3, which is the documented "environment, not a
   repro" code. _Impact:_ M1 and M3. Simulated failing `python3` → `exit 3` and `INSTALL_FAILED`.

7. **A bundle with no runnable command printed `NOT REPRODUCED` and exited 0**, having run nothing.
   _Fix:_ exit 5 with `NO REPRO COMMAND`, in both `sh` and `ps1`. _Impact:_ M4-style cases now exit 5.

### Log extraction and repro command selection

8. **GitHub's real `##[group]Run <cmd>` header was not used** (only plain `Run` lines). _Fix:_
   `RUN_LINE_RES` accepts it. _Impact:_ M4.

9. **A Jest/diff `+` line was taken as the repro command**, and the command would have been
   executed. _Fix:_ the `+` trace is accepted only for an allowlist of tools. _Impact:_ M5.

10. **`TypeError`, `ReferenceError`, `SyntaxError` and other `<Name>Error:` lines were not
    recognized** (`\bError:` has no word boundary inside `TypeError`). _Fix:_ a named-error pattern
    (weight 60). _Impact:_ M6.

11. **`commandsAgree` treated `go test` and `go testify` as the same command** (plain prefix match).
    _Fix:_ the match requires a space boundary. _Test:_ `workflow.test.ts` (baseline fails this).

12. **The failing step could come from a different job** than the failing job in URL mode
    (`pickFailingStep` ran over all jobs). _Fix:_ `src/core/selection.ts` `selectFailure()`, used by
    `reproduce`, `inspect`, and the MCP tools. _Test:_ `selection.test.ts`.

### Redaction

13. **`Basic` and `Bearer` followed by any word were redacted** (M9, M10). _Fix:_ a value counts as a
    credential only if it is at least 10 characters with a digit or token punctuation, or at least 24
    pure letters. _Residual risk:_ base64 with no digits, symbols, or `=`, shorter than 24 characters,
    is not redacted. This is a deliberate trade-off against false positives.

### Bundle generation and scripts

14. **Generated scripts were never syntax-checked by the tests** (the CI smoke only checked that
    `reproduce.sh` exists, which is how M1 shipped). _Fix:_ `bash -n` tests for every fixture
    (through the built CLI) and for each ecosystem install block, plus dangerous repro commands.
    `pwsh` is not available in this sandbox, so PowerShell output is checked by content only.

15. **The `package.json` `types` field pointed at `dist/index.d.js`** (no such file). _Fix:_ `dist/index.d.ts`.

16. **The generated README and the exit-code text were out of date** (no exit 5). _Fix:_ updated in
    the bundle templates, `README.md`, and `ARCHITECTURE.md`.

### MCP server

17. **`reproduce` with `run:true` wrote unrelated child output to stdout** (M-probe: 13 of 16 lines
    were not JSON-RPC). _Fix:_ output is captured to a temp file, a redacted tail is returned, and the
    temp directory is removed. _Test:_ `mcp-tools.test.ts` checks that nothing else reaches `process.stdout`.

### Providers

18. **GitLab fetched only the first 100 jobs** (M12). _Fix:_ paginated `listPipelineJobs` (page size
    100, max 10 pages).

19. **GitLab placeholder was `(could not fetch logs for job <id>/<name>: …)`**. A `:` in a job name
    broke `firstLogError`. _Fix:_ the placeholder carries only the job id (`logFetchPlaceholder`).

20. **HTTP calls had no timeout** (GitHub and GitLab could hang forever). _Fix:_ 60-second
    `AbortSignal.timeout` on every request. `doctor`'s network check had a timer that was not cleared
    on error; it now uses `AbortSignal.timeout` too.

### Dead code and duplication

21. **`localProjectFiles` was copied five times.** _Fix:_ one `listCwdFiles` in `utils/fs.ts`. _Impact:_
    5 definitions → 0.

22. **Dead code removed** (zero call sites, verified by grep): `commandExists` (always false),
    `fetchJobLogsById`, `pickFailingJob` / `pickFailingStep`, `failingJobName` / `failingStepName`,
    `shQuote` (a no-op), `redactLines`, `looksClean`, `containsTokenShape`, `writeFileAtomic`,
    `fileExists`, `dirExists`, `ecosystemInstallFallback`, `isCiReproUrl`, `safeTruncate`,
    `toRunHtmlUrl`, `logsFromText`.

23. **`hashBundleFiles` comparator returned 1 on ties** (inconsistent sort). _Fix:_ returns 0 on ties.
    _Impact:_ no change on the fixtures; it removes a determinism risk.

### Known issues found but NOT fixed (need a decision or more verification)

- **Repro scripts run the CI command without a prompt when stdin is not a TTY.** Maintainer decision: keep
  as is (see §6).
- **`reproduce --run` and MCP `run:true` run the bundle's install step in the current directory.**
  For npm repos that is `npm ci`, which deletes `node_modules` first. This caused the incident in §5.
  Consider requiring an explicit `--cwd` for `--run`.
- `action.yml`: `OUT_DIR` is interpolated into a `node -e` string (command-injection risk). Not verified or changed.
- `runner.ts`: `spawnSync` has no timeout, so a hung repro hangs the CLI. Not changed.
- `github.ts`: `fetchJobs` stops after 10 pages (1000 jobs). `fetchWorkflowFile` does not URL-encode the path.
- `history.ts`: `legacyEntries` is hard-coded to 0.
- `bundle.ts`: `repro.json` contains `generatedAt` although the README says otherwise. Bundle files are re-redacted after `bundle.sha256` is computed, so the hash can diverge from disk.
- `adapters.ts` and `ecosystems.ts` both define the install commands, and the Gradle commands differ.
- Scoring in `ecosystems.ts` double-counts evidence.
- `url.ts` rejects GitHub Enterprise hosts.
- `workflow.ts` uses a hand-rolled YAML parser that handles only 2-space job indentation.
- `mcp/server.ts` buffers input with string concatenation and parses leftover chunks after an oversized line.
- `runtime.ts` regexes are loose. `providers/registry.ts` is first-match-wins.
- `index.ts` exports `McpServer` and `runMcpStdio` with no versioning.
- Windows (`reproduce.ps1`, `powershell` in `runner.ts`, `.\gradlew.bat`): not exercised (no `pwsh` here).

## 4. Tests added

- `test/unit/redact-rules.test.ts` (12): Basic/Bearer false positives and true positives, other rules, idempotence.
- `test/unit/extract-groups.test.ts` (6): `##[group]Run` extraction, the `+` allowlist, and a failing-step-only case.
- `test/unit/selection.test.ts` (4): failing job and its own step; no cross-job step; fallback; empty.
- `test/unit/prove.test.ts` (10): exit 3/4/5 mapping and the messages.
- `test/unit/verify.test.ts` (8): INCONCLUSIVE branches, NOT_REPRODUCED, REPRODUCED, and error cases.
- `test/unit/github.test.ts` (+6): timeout, placeholder protocol.
- `test/unit/gitlab.test.ts` (+4): pagination (230 jobs, 3 pages), placeholder with `:` in the name.
- `test/unit/repro-script.test.ts` (+21): `bash -n` for dangerous commands and every ecosystem install block; PS1 exit-code contract.
- `test/unit/workflow.test.ts` (+1): word boundary in `commandsAgree`.
- `test/unit/mcp-tools.test.ts` (+1): MCP `run:true` captures output and keeps stdout clean.
- `test/integration/exit-codes.test.ts` (12): fixtures produce valid bash; install failure → 3; no command → 5; command's own exit 5 propagates; prove mapping (install-fail, no-command, command-exit-5, relative path); temp-dir cleanup; verify exit codes with and without `--json`.
- `test/integration/prove.test.ts`: updated for the new `runOutputTail` contract (the captured log is removed).

Run against the baseline source, 42 tests in the touched files fail (out of 119 in those files). Some
fail only because the function or export does not exist yet (for example `scriptNotRunReason`,
`HTTP_TIMEOUT_MS`), so they show "missing", not "wrong behavior". The behavior-level evidence is the
M-table in §2.

## 5. Incident during this work (disclosed)

While running the MCP `reproduce --run` test, the bundle ran `npm ci` in the repository root
(`process.cwd()`), which deleted `node_modules` and failed. The test now runs from a temp directory
(`process.chdir`), and `npm ci` restored `node_modules` from `package-lock.json` (121 top-level entries).
No tracked file was affected (`git status` shows only intended changes). The baseline comparison copy
in `/tmp/base` hit the same issue and was rebuilt from scratch.

`npm run smoke` fails at `doctor`'s network check in this sandbox. Node's `fetch` fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` (TLS interception with a CA Node does not trust), while `curl`
succeeds. This is environmental and comes from the same `fetch` call as before the change. The rest of
the smoke script passes when that one step is skipped.

## 6. Decision on the no-TTY auto-run

Repro scripts auto-run the CI command without a prompt when stdin is not a TTY (`[ -t 0 ]` check).
That is documented, but in CI or any non-interactive environment it executes untrusted CI text.
The fail-closed change (require `CI_REPRO_YES=1` when there is no TTY) was proposed and **the
maintainer chose to keep the current behavior**. It is unchanged in this branch. Revisit it if the
threat model changes.
