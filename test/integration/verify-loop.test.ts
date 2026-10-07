import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The documented loop, end to end:
 *
 *   actionrepro reproduce ./ci-failure.log --out ./actionrepro
 *   bash actionrepro/reproduce.sh > ./local-run.log 2>&1
 *   actionrepro verify ./actionrepro ./local-run.log
 *
 * This is the promise the README makes, and it used to fail: the bundle's own
 * banner echoes the CI failure text, extraction anchored on that echo, so a
 * fresh log always produced a different fingerprint — and a *fixed* run was
 * indistinguishable from a broken one. The stub npm below prints the failure
 * locally exactly like CI did, so REPRODUCED is the only correct verdict.
 */

const ROOT = process.cwd();
const CLI = path.join(ROOT, "dist/cli.js");

const CI_LOG = [
  "2026-10-07T09:00:00.0000000Z ##[group]Run npm ci",
  "2026-10-07T09:00:01.0000000Z Run npm ci",
  "2026-10-07T09:00:02.0000000Z added 1 package in 0.2s",
  "2026-10-07T09:00:02.5000000Z ##[endgroup]",
  "2026-10-07T09:00:03.0000000Z ##[group]Run npm test",
  "2026-10-07T09:00:03.5000000Z Run npm test",
  "2026-10-07T09:00:04.0000000Z > demo@1.0.0 test",
  "2026-10-07T09:00:04.1000000Z > vitest run",
  "2026-10-07T09:00:04.2000000Z  FAIL  src/add.test.ts > adds numbers",
  "2026-10-07T09:00:04.3000000Z AssertionError: expected 3 to equal 4",
  "2026-10-07T09:00:04.4000000Z  npm ERR! code ELIFECYCLE",
  "2026-10-07T09:00:04.5000000Z ##[error]Process completed with exit code 1.",
  "",
].join("\n");

const LOCAL_FAILURE = [
  "> demo@1.0.0 test",
  "> vitest run",
  "",
  " FAIL  src/add.test.ts > adds numbers",
  "AssertionError: expected 3 to equal 4",
  " npm ERR! code ELIFECYCLE",
  " npm ERR! Exit status 1",
  "",
].join("\n");

let tmp = "";
let stubBin = "";

/** A fake npm: `npm ci` always succeeds, `npm test` fails while fail.txt exists. */
function writeStub(): void {
  stubBin = path.join(tmp, "stubbin");
  fs.mkdirSync(stubBin, { recursive: true });
  const npm = path.join(stubBin, "npm");
  fs.writeFileSync(
    npm,
    [
      "#!/bin/sh",
      'if [ "$1" = "ci" ]; then echo "added 1 package"; exit 0; fi',
      `if [ -f fail.txt ]; then cat fail.txt; exit 1; fi`,
      'echo "Tests: 2 passed, 2 total"',
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(npm, 0o755);
  fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}\n");
}

function runCli(args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      cwd: tmp,
      timeout: 30000,
    });
    return { status: 0, out: String(out) };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      status: err.status ?? 99,
      out: `${String(err.stdout ?? "")}\n${String(err.stderr ?? "")}`,
    };
  }
}

function runBundle(outDir: string, logFile: string): number {
  const env = { ...process.env, CI_REPRO_YES: "1" } as Record<string, string>;
  env.PATH = `${stubBin}${path.delimiter}${process.env.PATH ?? ""}`;
  const fd = fs.openSync(logFile, "w");
  try {
    execFileSync("bash", [path.join(outDir, "reproduce.sh")], {
      cwd: tmp,
      stdio: ["ignore", fd, fd],
      timeout: 30000,
      env,
    });
    return 0;
  } catch (e: unknown) {
    return (e as { status?: number }).status ?? 99;
  } finally {
    fs.closeSync(fd);
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-loop-"));
  writeStub();
  fs.writeFileSync(path.join(tmp, "fail.txt"), LOCAL_FAILURE);
  fs.writeFileSync(path.join(tmp, "ci-failure.log"), CI_LOG);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("documented verify loop (reproduce -> run -> verify)", () => {
  it("reports REPRODUCED when the same failure happens locally", () => {
    fs.writeFileSync(path.join(tmp, "fail.txt"), LOCAL_FAILURE);
    const bundle = path.join(tmp, "actionrepro");
    const build = runCli(["reproduce", "ci-failure.log", "--out", bundle]);
    expect(build.status).toBe(0);
    expect(build.out).toContain("AssertionError: expected 3 to equal 4");

    const log = path.join(tmp, "local-run.log");
    expect(runBundle(bundle, log)).toBe(1); // the failure reproduced

    const verify = runCli(["verify", bundle, log]);
    expect(verify.out).toContain("verdict: REPRODUCED");
    expect(verify.status).toBe(0);
  });

  it("reports NOT_REPRODUCED when the fix works (banner must not self-confirm)", () => {
    // Same bundle as a broken run: the recorded summary (containing
    // "AssertionError") is echoed by the script's own banner. Without frame
    // filtering the echo alone would produce a false REPRODUCED.
    const bundle = path.join(tmp, "actionrepro");
    runCli(["reproduce", "ci-failure.log", "--out", bundle]);

    fs.rmSync(path.join(tmp, "fail.txt")); // "fix" applied
    const log = path.join(tmp, "local-run-fixed.log");
    expect(runBundle(bundle, log)).toBe(0);

    const verify = runCli(["verify", bundle, log]);
    expect(verify.out).toContain("verdict: NOT_REPRODUCED");
    expect(verify.out).toMatch(/no failure evidence/i);
    expect(verify.status).toBe(1);
  });

  it("reports NOT_REPRODUCED when a different failure happens locally", () => {
    const bundle = path.join(tmp, "actionrepro");
    runCli(["reproduce", "ci-failure.log", "--out", bundle]);

    fs.writeFileSync(
      path.join(tmp, "fail.txt"),
      "TypeError: cannot read properties of undefined\n",
    );
    const log = path.join(tmp, "local-run-other.log");
    expect(runBundle(bundle, log)).toBe(1);

    const verify = runCli(["verify", bundle, log]);
    expect(verify.out).toContain("verdict: NOT_REPRODUCED");
    expect(verify.status).toBe(1);
  });

  it("is INCONCLUSIVE for a bundle from an older fingerprint algorithm", () => {
    const bundle = path.join(tmp, "actionrepro");
    runCli(["reproduce", "ci-failure.log", "--out", bundle]);
    const metaPath = path.join(bundle, "repro.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    meta.fingerprintVersion = "sha256-v1";
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const log = path.join(tmp, "local-run.log");
    runBundle(bundle, log);
    const verify = runCli(["verify", bundle, log]);
    expect(verify.out).toContain("verdict: INCONCLUSIVE");
    expect(verify.status).toBe(2);
  });
});
