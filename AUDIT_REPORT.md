# ActionRepro review log

Branch: `arena/54eaaebb-actionrepro` (the session branch. The requested `arena.fix` name could not be used here).
Baseline: `ec66a64` on `main`. Round-one head: `950d21d`.

Every issue below has a status, a fix (or an explicit decision), and an impact that was **measured**, not assumed.
"BASE" means the baseline build (`git archive <commit>`, built with `tsc`). "PREV" means `950d21d`. "NOW" means the current branch.
Each fix is a separate commit. The commit subjects and bodies carry the same measurements.

## 0. Summary

- Two rounds of work. Round one (`bc646c0`, `724bd89`, `950d21d`) covered exit codes, log extraction, redaction, bundle scripts, MCP output, and GitLab pagination. Round two covers everything still open in §3: scoring, dead code, action glue, runner timeout, node_modules, GitHub pagination and encoding, history, bundle integrity, MCP buffering, runtime parsing, workflow parsing, redaction, Enterprise hosts with a token policy, and the registry guard.
- **Security:** one issue was found by measurement while implementing Enterprise support. An environment `GITHUB_TOKEN` would have been sent to any host once arbitrary hosts were accepted. It was caught and fixed before it was committed, so no released version has it. The baseline never sent a token off `github.com`, because the baseline rejected every other host. See §2 R28 to R30 and §3 item 36.
- **Regression found and fixed:** round one (`950d21d`) let `Authorization: Basic dXNlcjpwYXNz` through unredacted, while the baseline redacted it (R20). Fixed in `02d1588`. Round one's claim that the Basic rule was safe was wrong, and this report corrects it.
- **Verified:** typecheck, lint, format, build, and 471 of 471 tests (53 files). `bench` passes 9 of 9. `smoke` passes every step when the sandbox CA bundle is set (`NODE_EXTRA_CA_CERTS`). Each of the 14 round-two commits compiles on its own (`tsc --noEmit` on `git archive` of each commit).
- **Coverage** (vitest 2.1.9 with v8, measured ad hoc, not committed): statements 70.4% → 84.2%, branches 77.0% → 84.1%, functions 84.9% → 97.0%.
- **Behaviour changes that you should review** (listed in §7): the default `reproduce --run` no longer reinstalls an existing `node_modules`; the runner has a 30-minute default limit; tokens for Enterprise hosts need `GH_HOST`; `history record` refuses blank logs; the ecosystem threshold moved from 10 to 8.
- **Still open** (§8): Windows is untested. A bare lowercase 16-character secret without a header is not redacted. Detached grandchildren are not killed on timeout. The no-TTY auto-run is kept as you decided.

## 1. Results at a glance

| Check                                      | Baseline `ec66a64`   | Round one `950d21d`                                  | This branch                                                                                                                                           |
| ------------------------------------------ | -------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                        | pass                 | pass                                                 | **pass**                                                                                                                                              |
| `npm run lint` (`--max-warnings 0`)        | pass                 | pass                                                 | **pass**                                                                                                                                              |
| `npm run format`                           | pass                 | pass                                                 | **pass**                                                                                                                                              |
| `npm run build`                            | pass                 | pass                                                 | **pass**                                                                                                                                              |
| `npx vitest run`                           | 182 / 182 (26 files) | 267 / 267 (32 files)                                 | **471 / 471 (53 files)**                                                                                                                              |
| Coverage statements / branches / functions | not measured         | 70.4% / 77.0% / 84.9%                                | **84.2% / 84.1% / 97.0%**                                                                                                                             |
| `npm run bench`                            | PASS 9/9             | not re-run                                           | **PASS 9/9** (avg ms: inspect 88, reproduce 97, verify 87)                                                                                            |
| `npm run smoke`                            | not run              | fails only at `doctor`'s network check (sandbox TLS) | **all steps pass** with `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`; without it, the sandbox's TLS interception fails `doctor` as before |
| Commits compile on their own               | —                    | —                                                    | **14 of 14** round-two commits (`tsc --noEmit` on each commit's `git archive`)                                                                        |

Baseline counts are from `ec66a64`, the baseline test suite. The round-one "48 of 152 touched tests fail on baseline" figure is kept in §4 for history.

Still not tested: **Windows** (`reproduce.ps1`, `powershell` in `runner.ts`). No `pwsh` is available here. The PowerShell output is checked by content and by exit-code contract tests only. The README now says so.

## 2. Measured behaviour changes (same inputs, baseline vs. this branch)

### 2a. Round one (carried over, measured against `ec66a64`)

| #   | Scenario                                                                                                   | Baseline                                                        | This branch                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| M1  | `bash -n` on the generated `reproduce.sh` for a pip log                                                    | exit 2 (syntax error at line 44)                                | exit 0                                                            |
| M2  | `prove <bundle> silent.log`, where the fresh log is `Process completed with exit code 7.` only             | exit **0**, `state: fixed`                                      | exit **2**, `state: inconclusive`                                 |
| M3  | `prove <bundle> --run` where dependency setup fails (`python3` returns 3)                                  | exit **0**, `state: fixed`                                      | exit **2**, `state: unable-to-reproduce`                          |
| M4  | `reproduce <log> --run` where the CI command is `node -e "process.exit(5)"` (GitHub `##[group]Run` header) | exit 0, repro command `# see failure.txt …` (nothing runs)      | exit **5**, repro command `node -e "process.exit(5)"`             |
| M5  | Jest log with a `+ Received` diff line under `##[group]Run npx jest`                                       | repro command = `Received` (would be executed)                  | repro command = `npx jest`                                        |
| M6  | `TypeError: cannot read properties of undefined` in a CI log                                               | summary `Failure: ##[error]Process completed with exit code 1.` | summary `Failure: TypeError: cannot read properties of undefined` |
| M7  | `verify <bundle> silent.log --json` (INCONCLUSIVE verdict)                                                 | exit **0**                                                      | exit **2**                                                        |
| M8  | `verify <bundle> ok.log --json` (NOT_REPRODUCED verdict)                                                   | exit **0**                                                      | exit **1** (same as text mode)                                    |
| M9  | `redactText("Basic authentication failed for registry")`                                                   | `Basic [REDACTED] failed for registry`                          | unchanged (see R11)                                               |
| M10 | `redactText("Bearer authentication required")`                                                             | `Bearer [REDACTED] required`                                    | unchanged (see R11)                                               |
| M11 | `prove --run` temp directories left behind per run (captured, unredacted CI output)                        | 1 per run                                                       | 0                                                                 |
| M12 | GitLab pipeline with 230 jobs                                                                              | one request `jobs?per_page=100`, jobs 101+ never seen           | paginated: 100 of 230 → 230 of 230 (3 requests)                   |

Round one also re-measured the MCP `reproduce` with `run:true` on a failing exit-5 log: BASE wrote 13 of 15 stdout lines that were not JSON-RPC. This branch writes 0 of 2.

### 2b. Round two (measured against PREV `950d21d`, and BASE where it applies)

| #   | Scenario                                                                                                                                                                     | BASE `ec66a64`                                                                 | PREV `950d21d`                                                     | NOW                                                                                                                      | Commit    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------- |
| R1  | `fixtures/ecosystems/cargo-with-pip-setup.log` (pip setup line in a cargo job)                                                                                               | not measured                                                                   | pip, high                                                          | **cargo, high**                                                                                                          | `a9ab6c1` |
| R2  | Other 14 scoring fixtures (before/after table, 950d21d vs. now)                                                                                                              | —                                                                              | —                                                                  | **unchanged** (threshold: high ≥ 8)                                                                                      | `a9ab6c1` |
| R3  | Repro script that hangs (`sleep 30`)                                                                                                                                         | not comparable: the baseline never reaches the `##[group]Run` command (§2a M4) | killed by the shell at 20 s                                        | **exit 124 in about 3 s**, message `repro script stopped after 3s`                                                       | `4334e25` |
| R4  | `node_modules/sentinel` present, `reproduce --run` in that project                                                                                                           | sentinel **deleted**, exit 0 (M4 also applied)                                 | sentinel **deleted**, exit 5                                       | sentinel **kept**, exit 5, skip message printed                                                                          | `24d6964` |
| R5  | Same project, `ACTIONREPRO_REINSTALL=1`                                                                                                                                      | —                                                                              | —                                                                  | sentinel removed, npm reinstall runs                                                                                     | `24d6964` |
| R6  | 1234 jobs in pages of 100 (stubbed API)                                                                                                                                      | 1000 of 1234 jobs in 10 requests                                               | same as BASE                                                       | **1234 of 1234 in 13 requests**                                                                                          | `7bbb4c6` |
| R7  | Workflow path `.github/workflows/my ci#1?.yml`                                                                                                                               | URL truncated at `#`                                                           | same                                                               | encoded (`%23`, `%3F`, `%20`)                                                                                            | `7bbb4c6` |
| R8  | History entry without `fpv`, looked up with a new fingerprint                                                                                                                | `legacyEntries = 0`                                                            | same                                                               | **`legacyEntries = 1`**                                                                                                  | `76e2fe9` |
| R9  | Blank log passed to `history record`                                                                                                                                         | —                                                                              | recorded as a failure, summary `Empty logs: no failure found`      | **refused** with `no failure content found`                                                                              | `76e2fe9` |
| R10 | Bundle hash, library call with a raw token in `failure.summary` and `errorLines`                                                                                             | differs from disk                                                              | differs from disk                                                  | **matches disk**; raw token absent from every file                                                                       | `ee7686d` |
| R11 | Bundle hash, CLI call with `secrets.log`                                                                                                                                     | matches                                                                        | matches                                                            | matches (the CLI redacts earlier)                                                                                        | —         |
| R12 | 11 MiB stdin line followed by `ping` id 2                                                                                                                                    | 3 response lines (error, a stray `Invalid JSON.` from the tail, ping result)   | —                                                                  | **2 lines** (error, ping result)                                                                                         | `8ad104e` |
| R13 | GitHub log banner `Operating System` / `  Ubuntu` / `  20.04.5` / `  LTS`                                                                                                    | OS `null`                                                                      | —                                                                  | **`Ubuntu 20.04.5 LTS`**                                                                                                 | `5737c43` |
| R14 | Unindented runner-image block, inline `Operating System Ubuntu 24.04.3 LTS`, `Running on Ubuntu 22.04 runner`                                                                | `null`, `null`, `Ubuntu`                                                       | —                                                                  | `Ubuntu 24.04.1 LTS`, `Ubuntu 24.04.3 LTS`, `Ubuntu 22.04 runner`                                                        | `5737c43` |
| R15 | `cargo build --target x86_64-unknown-linux-gnu` (no runner arch line)                                                                                                        | arch `x86_64`                                                                  | —                                                                  | **arch unset**                                                                                                           | `5737c43` |
| R16 | `Architecture: X64` / `Architecture: amd64`                                                                                                                                  | `null` / `null`                                                                | —                                                                  | `x64` / `x64`                                                                                                            | `5737c43` |
| R17 | 4-space workflow, two jobs with a step named `Run tests`                                                                                                                     | `npm run lint` (wrong job)                                                     | —                                                                  | **`npm test -- --runInBand`**                                                                                            | `d6be1c5` |
| R18 | Log job `test (20.x)` against a 4-space workflow                                                                                                                             | `npm run lint` (wrong job)                                                     | —                                                                  | **`npm test`**                                                                                                           | `d6be1c5` |
| R19 | 2-space, block scalars, unnamed run, tab-invalid YAML                                                                                                                        | as before                                                                      | —                                                                  | unchanged; invalid or alias-bomb YAML → `null`                                                                           | `d6be1c5` |
| R20 | `Authorization: Basic dXNlcjpwYXNz`                                                                                                                                          | redacted                                                                       | **not redacted** (regression from round one, shipped in `950d21d`) | redacted (header form, scheme kept)                                                                                      | `02d1588` |
| R21 | `Authorization: token ghx_short`                                                                                                                                             | **not redacted**                                                               | —                                                                  | `Authorization: token [REDACTED]`                                                                                        | `02d1588` |
| R22 | `Authorization: Digest username="x", realm="r", response="abcdef1234"`                                                                                                       | **not redacted** (whole header visible)                                        | **not redacted**                                                   | whole value redacted (`Authorization: Digest [REDACTED]`)                                                                | `02d1588` |
| R23 | `Basic authentication failed for registry`, `Bearer token rejected by server`, `Basic Authentication failed`, `Bearer Authentication required`, `Basic configuration loaded` | BASE mangled the scheme word                                                   | —                                                                  | **unchanged**                                                                                                            | `02d1588` |
| R24 | Bare `Basic dXNlcjpwYXNz`                                                                                                                                                    | redacted                                                                       | —                                                                  | redacted (an intermediate tightening had broken this; it was reverted)                                                   | `02d1588` |
| R25 | `Bearer abcdefghijklmnop` (bare, all lowercase, no header)                                                                                                                   | not redacted                                                                   | —                                                                  | not redacted: **documented limit** (§8)                                                                                  | —         |
| R26 | `action.yml` step, out-dir `Bob's dir`                                                                                                                                       | exit 1 (Node syntax error)                                                     | exit 1                                                             | **exit 0**, output `…/Bob's dir`                                                                                         | `5e0709f` |
| R27 | `action.yml` step, out-dir `inj$(touch pwned-by-out)`                                                                                                                        | the payload did not run only because of `??` short-circuit                     | same                                                               | **literal path**, no file created                                                                                        | `5e0709f` |
| R28 | `reproduce <url>` for a GHE run, no `GH_HOST`                                                                                                                                | URL rejected (0 requests)                                                      | same                                                               | parsed; requests go to `https://<host>/api/v3`; **token not sent**                                                       | `7bbb4c6` |
| R29 | Same, with `GH_HOST=<host>`                                                                                                                                                  | —                                                                              | —                                                                  | token sent to that host only                                                                                             | `7bbb4c6` |
| R30 | URL on an unknown host, `GITHUB_TOKEN=ENV-SECRET` in the environment                                                                                                         | 0 requests (rejected)                                                          | —                                                                  | 1 request, **no Authorization**. The first draft of the Enterprise change sent `Authorization` to that host (§3 item 36) | `7bbb4c6` |
| R31 | Registry ambiguity: 8 sample inputs                                                                                                                                          | —                                                                              | first match only                                                   | at most one provider per input; two matches now throw                                                                    | `b11e8ab` |

Carried-over checks for round two: every fixture log still produces valid bash (`bash -n`), and the 15 original workflow and ecosystem tests still pass.

## 3. Issues found, fixes, and impact (per file)

Status: **Fixed** means the fix is committed and measured. **Decision** means the behaviour was kept on purpose. **Limit** means a known, documented boundary.

### Exit-code handling (round one)

1. **`verify` gave NOT_REPRODUCED for a silent failure.** Fixed: `verifyBundle` returns INCONCLUSIVE with a reason. Impact M2. _Limit (kept on purpose):_ a command that fails with the same exit code but prints no diagnostic can never be REPRODUCED.
2. **`prove --run` reported `fixed` when the bundle never ran.** Fixed: `scriptNotRunReason(code)` maps 3/4/5 to `unable-to-reproduce`, unless the script printed its own `REPRODUCED:` / `NOT REPRODUCED:` line. Impact M3.
3. **`prove --run` with a relative bundle path plus `--cwd` ran nothing and reported fixed** (bash returned 127). Fixed: the bundle path is absolute, and spawn errors throw. Covered by an integration test.
4. **`verify --json` and `prove --json` always exited 0.** Fixed: the exit code follows the verdict in both modes. Impact M7, M8.
5. **`reproduce --run` ignored the bundle's exit code.** Fixed: the exit code is propagated. Impact M4.
6. **Install failures had no single contract.** Fixed: the install block runs in a subshell, and a failure exits 3 (`INSTALL_FAILED`). Impact M1 and M3.
7. **A bundle with no runnable command printed `NOT REPRODUCED` and exited 0.** Fixed: exit 5 with `NO REPRO COMMAND`, in `sh` and `ps1`.

### Log extraction and repro command selection (round one)

8. **GitHub's `##[group]Run <cmd>` header was not used.** Fixed. Impact M4.
9. **A Jest or diff `+` line was taken as the repro command and would have been executed.** Fixed: the `+` trace is accepted only for an allowlist of tools. Impact M5.
10. **`TypeError`, `ReferenceError`, `SyntaxError` and other `<Name>Error:` lines were not recognized.** Fixed (named-error pattern, weight 60). Impact M6.
11. **`commandsAgree` treated `go test` and `go testify` as the same command.** Fixed: the match requires a space boundary.
12. **The failing step could come from a different job than the failing job in URL mode.** Fixed: `src/core/selection.ts` `selectFailure()`, used by `reproduce`, `inspect`, and the MCP tools.

### Redaction

13. **`Basic` and `Bearer` followed by any word were redacted** (M9, M10). Fixed in round one with a shape rule, then tightened in round two (item 38).

### Bundle generation and scripts (round one)

14. **Generated scripts were never syntax-checked by the tests.** Fixed: `bash -n` tests for every fixture and each ecosystem install block. PowerShell is checked by content only.
15. **The `package.json` `types` field pointed at `dist/index.d.js`** (no such file). Fixed: `dist/index.d.ts`.
16. **The generated README and the exit-code text were out of date** (no exit 5). Fixed in the templates, `README.md`, and `ARCHITECTURE.md`.

### MCP server (round one)

17. **`reproduce` with `run:true` wrote unrelated child output to stdout** (13 of 15 lines were not JSON-RPC on BASE). Fixed: output is captured to a temp file, a redacted tail is returned, and the temp directory is removed. `test/unit/mcp-tools.test.ts` checks that nothing else reaches `process.stdout`.

### Providers (round one)

18. **GitLab fetched only the first 100 jobs** (M12). Fixed: paginated, page size 100, max 10 pages.
19. **The GitLab placeholder broke on a `:` in a job name.** Fixed: the placeholder carries only the job id (`logFetchPlaceholder`).
20. **HTTP calls had no timeout.** Fixed: 60-second `AbortSignal.timeout` on every request.

### Dead code and duplication (round one)

21. **`localProjectFiles` was copied five times.** Fixed: one `listCwdFiles` in `utils/fs.ts`.
22. **Dead code removed** (zero call sites, verified by grep): `commandExists`, `fetchJobLogsById`, `pickFailingJob` / `pickFailingStep`, `failingJobName` / `failingStepName`, `shQuote`, `redactLines`, `looksClean`, `containsTokenShape`, `writeFileAtomic`, `fileExists`, `dirExists`, `ecosystemInstallFallback`, `isCiReproUrl`, `safeTruncate`, `toRunHtmlUrl`, `logsFromText`.
23. **`hashBundleFiles` comparator returned 1 on ties.** Fixed: returns 0 on ties. No change on the fixtures.

### Round two

24. **Ecosystem scoring double-counted evidence.** A pip setup line inside a cargo job outscored the cargo failure, because evidence was summed per kind. _Fixed_ (`a9ab6c1`): each kind takes its strongest line, and the high threshold is 8. Measured: R1 and R2. The first try at threshold 10 dropped `pytest-only` to medium, which is why it is 8. Tests: `test/unit/ecosystems-scoring.test.ts`, with 5 fixtures in `fixtures/ecosystems/`.

25. **`src/ecosystems/` was a second, disagreeing copy of the ecosystem data.** It had no importers (grep found self-references only), and its Gradle commands differed from `core/ecosystems.ts`. _Fixed_ (`cbdcacb`): deleted. The `ARCHITECTURE.md` and `README.md` tree entries were removed too.

26. **`action.yml` spliced `OUT_DIR` into a `node -e` JavaScript string.** Measured: a payload in the out-dir input did not run only because of a `??` short-circuit, and an apostrophe made the step fail with exit 1. This is fragile and latent (it would run if `outDir` were ever absent), and it is not an active injection today. _Fixed_ (`5e0709f`): inputs pass through `env` and argv, `GITHUB_OUTPUT` uses random heredoc delimiters, the JSON goes to `RUNNER_TEMP` and is deleted. Measured: R26, R27. Test: `test/integration/action-step.test.ts` runs the real step script.

27. **`runner.ts` had no time limit.** A hung repro hung the CLI. _Fixed_ (`4334e25`): default 30 minutes, `ACTIONREPRO_TIMEOUT_MS` overrides (`0` disables), exit 124. Measured: R3. _Limit:_ only the direct bash child is killed. Detached grandchildren keep running. Test: `test/unit/runner-timeout.test.ts`.

28. **`reproduce --run` and MCP `run:true` wiped an existing `node_modules`.** The install block runs in the current directory, and `npm ci` deletes `node_modules` first. This is the mechanism of the incident in §5. _Fixed_ (`24d6964`): an existing `node_modules` is kept and the install is skipped, unless `ACTIONREPRO_REINSTALL=1`. Measured: R4, R5. The MCP path was confirmed as well: `MCP run:true` calls `reproduceTarget` with `runOutputFile`, the same runner and the same bundle script. A test checks it (`test/integration/node-modules.test.ts`). **Behaviour change:** see §7.

29. **`fetchJobs` stopped after 10 pages (1000 jobs).** _Fixed_ (`7bbb4c6`): loop until `total_count`, with a safety cap of 100 pages. Measured: R6.

30. **`fetchWorkflowFile` did not encode the workflow path or the ref.** _Fixed_ (`7bbb4c6`): each path segment and the ref are encoded. Measured: R7.

31. **`history.ts`: `legacyEntries` was hard-coded to 0**, so a failure recorded under an older fingerprint algorithm looked "never seen". _Fixed_ (`76e2fe9`). Measured: R8. Also, `history record` on a blank log recorded a placeholder failure. _Fixed_ in the same commit: R9.

32. **`bundle.ts`: `bundle.sha256` was computed before the final redaction pass.** A raw token that reached the builder made the hash differ from disk. _Fixed_ (`ee7686d`): the hash is computed over the same redacted strings that are written. Measured: R10, R11. Test: `test/unit/bundle-integrity.test.ts`.

33. **`mcp/server.ts` parsed the tail of an oversized line as a second request.** _Fixed_ (`8ad104e`): discard mode until the next newline, plus a cheap length check before `Buffer.byteLength`. Measured: R12.

34. **`runtime.ts` read the OS only from one `Operating System:` form that real logs do not use, and read arch from any bare `x86_64`.** _Fixed_ (`5737c43`): `operatingSystem()` handles the block, inline, and `Running on` layouts; arch comes only from a labelled line, with `amd64` normalised to `x64`. Measured: R13 to R16. Source of the log layouts: actions/runner-images issues #6958 and #13189.

35. **`workflow.ts` used a hand-rolled parser that handled only 2-space job indentation**, so a 4-space workflow matched the wrong job. _Fixed_ (`d6be1c5`): the `yaml` package (`^2.9.1`) with `maxAliasCount: 100`. Measured: R17 to R19. Dependency churn: the newer local npm added `libc` fields to `package-lock.json`.

36. **GitHub Enterprise and token policy.** The baseline accepted only `github.com` and `api.github.com` URLs, so Enterprise runs could not be read at all. _Fixed_ (`7bbb4c6`): any https host parses, and the API base is `https://<host>/api/v3`. **Token policy:** `tokenAllowedFor(host)` allows github.com, plus the single host named in `GH_HOST`. `authHeaders(token, url)` enforces it for every request, and it never falls back to the environment for other hosts. **Found during measurement, before it shipped:** the first draft of this change fell back to `GITHUB_TOKEN`/`GH_TOKEN` from the environment for any URL. The provider passes no explicit token to a host that is not allowed, so the fallback was the only source. Measured with the draft (`ghe-measure`, unknown-host case): an `Authorization` header was sent to `evil.example`. This sandbox has both variables set, so the case is real here. After the fix: no Authorization header for that host, and with `GITHUB_TOKEN=ENV-SECRET` set explicitly, one request and no Authorization (BASE: 0 requests, because it rejected the URL). The baseline was not exposed, because it rejected such URLs. Measured also: R28, R29.

37. **`providers/registry.ts`: `findProvider` returned the first match silently; `index.ts` did not export `VERSION`.** _Fixed_ (`b11e8ab`): two matching providers throw. Current providers do not overlap (R31). `VERSION` is exported. The `McpServer` and `runMcpStdio` exports still have no separate versioning contract.

38. **Redaction: a header value was partly redacted, and prose was mangled.** _Fixed_ (`02d1588`): an `Authorization:` header with Basic, Bearer, Token or Digest redacts its value and keeps the header and scheme. Digest takes the rest of the line. Bare Basic and Bearer values need digits, symbols, inner case changes, all caps, or 24 or more letters. Measured: R20 to R24. **Regression disclosed:** round one (`950d21d`) had made `Authorization: Basic dXNlcjpwYXNz` leak (R20, PREV column). The baseline redacted it. This commit restores it.

39. **`repro.json` `generatedAt` and the README.** The baseline README says the tool is "deterministic". The analysis is deterministic. The bundle's `repro.json` contains a wall-clock `generatedAt`, so the file is not byte-identical between runs. `bundle.sha256` does not cover `repro.json`, so the integrity check is not affected. _Decision:_ the field is kept. The README table now documents it (`README.md`).

40. **Documentation gaps found while fixing the above.** The README said tokens go only to `api.github.com`, and it did not mention `GH_HOST`, the timeout, or `ACTIONREPRO_REINSTALL`. _Fixed:_ README and ARCHITECTURE describe the token policy, the timeout, the reinstall override, and the Enterprise setup.

## 4. Tests added

Round one (carried over): `redact-rules` (12), `extract-groups` (6), `selection` (4), `prove` (10), `verify` (8), `github` (+6), `gitlab` (+4), `repro-script` (+21), `workflow` (+1), `mcp-tools` (+1), `integration/exit-codes` (12), `integration/prove` (updated for `runOutputTail`). Round one also measured that 44 of 148 loaded tests and all 4 `selection` tests fail on the baseline source, because several functions did not exist there.

Round two, new files (test counts from the final run):

| File                                           | Tests | Covers                                                                                          |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| `test/unit/ecosystems-scoring.test.ts`         | 10    | per-kind scoring, 5 regression fixtures, stacking                                               |
| `test/unit/runner-timeout.test.ts`             | 15    | `resolveRunTimeoutMs`, exit 124 on a hung script, missing script                                |
| `test/unit/bundle-integrity.test.ts`           | 5     | hash equals disk with a raw token, no raw token in files, install guard text                    |
| `test/unit/history-command.test.ts`            | 16    | `recordLog`, `markFixed`, `lookup`, `stats`, legacy counts, formatters                          |
| `test/unit/mcp-server.test.ts`                 | 15    | every JSON-RPC branch, oversize, ordering                                                       |
| `test/unit/runtime-os.test.ts`                 | 10    | banner layouts, arch labels, build flags                                                        |
| `test/unit/workflow-yaml.test.ts`              | 11    | 4-space scoping, matrix suffix, invalid and alias-bomb YAML                                     |
| `test/unit/redact-header.test.ts`              | 10    | header rule, Digest, quoted JSON, idempotence, shape rules, documented limit                    |
| `test/unit/url-enterprise.test.ts`             | 20    | host parsing, API base, token policy                                                            |
| `test/unit/github-api.test.ts`                 | 25    | pagination (1234 jobs, empty page, cap), encoding, token policy, error messages, workflow by id |
| `test/unit/github-provider-fetch.test.ts`      | 6     | the provider maps run, jobs, steps, logs; token policy                                          |
| `test/unit/commands-url-mode.test.ts`          | 6     | inspect and reproduce on a stubbed run: workflow cross-check, log failure, Enterprise           |
| `test/unit/registry.test.ts`                   | 8     | routing, no overlap, ambiguity guard, token resolution                                          |
| `test/unit/utils-log-index.test.ts`            | 9     | log helpers, `ensureDir`, public exports, `VERSION`                                             |
| `test/unit/commands-inspect-reproduce.test.ts` | 9     | inspect, reproduce, formatter, no secrets in outputs                                            |
| `test/unit/prove-format.test.ts`               | 13    | `scriptNotRunReason`, every state's output                                                      |
| `test/unit/doctor-format.test.ts`              | 2     | PASS/FAIL output                                                                                |
| `test/integration/action-step.test.ts`         | 8     | the real `action.yml` step: inputs, quoting, injection, cleanup, GITHUB_OUTPUT                  |
| `test/integration/mcp-oversize.test.ts`        | 2     | 11 MiB line over stdio; normal session stdout is JSON                                           |
| `test/integration/node-modules.test.ts`        | 3     | node_modules kept, reinstall override, MCP `run:true` path                                      |
| `test/integration/prove-run.test.ts`           | 1     | `prove --run` end to end in a scratch project                                                   |

Existing files changed in round two: `test/unit/url.test.ts` (expectation now includes `host` and `apiBase`).

Coverage gaps that remain (statements): `src/cli.ts` 0% in unit coverage, because the CLI runs as a subprocess in `test/integration/*` and the coverage tool does not follow child processes. `commands/prove.ts` 70%, `commands/history.ts` 76%, `mcp/server.ts` 73% (its `runMcpStdio` loop is exercised by the spawned integration tests, not counted here). Coverage tooling is not a committed dependency; the numbers were measured with `@vitest/coverage-v8@2.1.9` installed with `--no-save`.

## 5. Incident during this work (disclosed)

While running the MCP `reproduce --run` test, the bundle ran `npm ci` in the repository root (`process.cwd()`). That deleted `node_modules` and failed. The tests now use `process.chdir` to a temp directory, and `npm ci` restored `node_modules` from `package-lock.json`. The mechanism was reproduced in isolation: `npm ci` (with a lockfile) and `npm install` (without one) both remove an extraneous `node_modules/sentinel` package. The product-level fix is R4 and R5 (§2b, commit `24d6964`). No tracked file was affected. The baseline copy used for comparison was rebuilt from `git archive`.

The sandbox's Node `fetch` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` because the sandbox intercepts TLS with a CA that Node does not trust. `curl` works. This is environmental. With `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`, `doctor` and the whole `smoke` script pass.

## 6. Decision on the no-TTY auto-run

Repro scripts run the CI command without a prompt when stdin is not a TTY (`[ -t 0 ]` check). That is documented, but in CI or any non-interactive environment it executes CI text. The fail-closed change (require `CI_REPRO_YES=1` when there is no TTY) was proposed, and **the maintainer chose to keep the current behaviour**. It is unchanged on this branch.

## 7. Behaviour changes for review

These follow from the fixes. Each one is deliberate, and each one is in a commit message.

1. **`reproduce --run` and `prove --run` no longer reinstall an existing `node_modules`** (`24d6964`). Set `ACTIONREPRO_REINSTALL=1` to get the old reinstall. A clean checkout still installs as before.
2. **The runner has a 30-minute default limit** (`4334e25`). A repro that legitimately takes longer is killed with exit 124. Set `ACTIONREPRO_TIMEOUT_MS` (or `0`) to change it.
3. **Enterprise tokens need `GH_HOST`** (`7bbb4c6`). Without it, a GitHub Enterprise run is read anonymously, and public runs are the only ones that can be read.
4. **`history record` refuses a blank log** (`76e2fe9`).
5. **The ecosystem high threshold is 8, not 10** (`a9ab6c1`). Some ambiguous logs may now be classified as high confidence.
6. **An oversized MCP line produces one error and the rest of that line is discarded** (`8ad104e`).
7. **`yaml` is a runtime dependency** (`d6be1c5`). `package-lock.json` also gained `libc` fields from the newer local npm.
8. **The library exports `VERSION`** (`b11e8ab`).

## 8. Still open, or limits

- **Windows is untested.** `reproduce.ps1`, the `powershell` call in `runner.ts`, and `.\gradlew.bat` have not run on Windows. The README says so.
- **Bare lowercase base64-like secrets without a header** are not redacted, for example `Bearer abcdefghijklmnop` (R25). The header form is always redacted. This is a deliberate trade-off against prose false positives.
- **Timeouts do not kill detached grandchildren** (`runner.ts`). Only the direct bash child is stopped.
- **A successful log is recorded as an unknown failure** when passed to `history record`. The extractor always returns a fallback line, and the tool cannot yet tell a passing log from an unknown failure. Blank logs are refused (R9).
- **Repro scripts auto-run on non-TTY stdin** (§6, maintainer decision).
- **`McpServer` and `runMcpStdio` have no separate versioning contract**, beyond the package version.
- **Sandbox TLS** prevents `doctor`'s network check from passing without `NODE_EXTRA_CA_CERTS`. This is environmental, not a code issue.
- **`cli.ts` coverage** is measured only through the integration tests (§4).

## 9. How to verify

```bash
npm ci
npm run typecheck && npm run lint && npm run format && npm run build
npx vitest run                       # 471 tests, 53 files
npm run bench                        # PASS 9/9
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm run smoke   # sandbox TLS only
```

Baselines are rebuilt with `git archive <commit> | tar -x -C <dir>` and `tsc`, using the same `node_modules`. Per-commit compilation was checked with `tsc --noEmit` on each commit's archive.
