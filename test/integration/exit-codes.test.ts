import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The exit-code contract, end to end through the built CLI (dist/cli.js):
 *   reproduce.sh: 3 = dependency setup failed, 4 = aborted at prompt,
 *                 5 = no runnable command, else = the repro command's own code.
 *   prove:        fixed 0, still-failing/changed 1, inconclusive/unable 2.
 *   verify:       REPRODUCED 0, NOT_REPRODUCED 1, INCONCLUSIVE 2 (also with --json).
 * Each test isolates TMPDIR so temp-dir cleanup can be checked exactly.
 */

const ROOT = process.cwd();
const CLI = path.join(ROOT, "dist/cli.js");

let base = "";
let tmpdir = "";
let fakeBin = "";
let repo = "";

interface Run {
  code: number;
  out: string;
}

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      cwd: opts.cwd ?? base,
      env: { ...process.env, TMPDIR: tmpdir, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      code: err.status ?? 99,
      out: String(err.stdout ?? "") + String(err.stderr ?? ""),
    };
  }
}

function writeLog(name: string, lines: string[]): string {
  const p = path.join(base, name);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

const PIP_CI_LOG = [
  "2024-05-02T11:00:03.0000000Z ##[group]Run python -m pip install -r requirements.txt",
  "2024-05-02T11:00:03.0000000Z python -m pip install -r requirements.txt",
  "2024-05-02T11:00:04.0000000Z ERROR: Could not find a version that satisfies the requirement foo==9.9",
  "2024-05-02T11:00:05.0000000Z ##[error]Process completed with exit code 1.",
];

const NO_COMMAND_LOG = [
  "2024-05-02T11:00:05.0000000Z ##[error]Process completed with exit code 1.",
];

const ASSERT_LOG = [
  '2024-05-02T11:00:03.0000000Z ##[group]Run node -e "throw new Error(1)"',
  "2024-05-02T11:00:04.0000000Z AssertionError: expected 3 to equal 4",
  "2024-05-02T11:00:05.0000000Z ##[error]Process completed with exit code 1.",
];

const EXIT5_LOG = [
  '2024-05-02T11:00:03.0000000Z ##[group]Run node -e "process.exit(5)"',
  '2024-05-02T11:00:03.0000000Z node -e "process.exit(5)"',
  "2024-05-02T11:00:04.0000000Z ##[error]Process completed with exit code 5.",
];

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-exit-"));
  tmpdir = path.join(base, "tmp");
  fs.mkdirSync(tmpdir);
  fakeBin = path.join(base, "bin");
  fs.mkdirSync(fakeBin);
  // A python3 that always fails: simulates a broken toolchain during install.
  fs.writeFileSync(path.join(fakeBin, "python3"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "requirements.txt"), "foo==9.9\n");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("generated scripts: every fixture produces valid bash", () => {
  it("reproduce + bash -n for each fixture log", () => {
    const logs = fs
      .readdirSync(path.join(ROOT, "fixtures/logs"))
      .filter((f) => f.endsWith(".log"));
    expect(logs.length).toBeGreaterThan(5);
    for (const log of logs) {
      const out = path.join(base, `b-${log}`);
      const r = run(["reproduce", path.join(ROOT, "fixtures/logs", log), "--out", out]);
      expect(r.code, `reproduce ${log}: ${r.out}`).toBe(0);
      execFileSync("bash", ["-n", path.join(out, "reproduce.sh")], { stdio: "pipe" });
      expect(fs.existsSync(path.join(out, "reproduce.ps1"))).toBe(true);
    }
  });
});

describe("reproduce.sh exit codes", () => {
  it("exit 3 with INSTALL_FAILED when dependency setup fails, without running the repro", () => {
    const log = writeLog("pip.log", PIP_CI_LOG);
    const out = path.join(base, "bundle");
    expect(run(["reproduce", log, "--out", out]).code).toBe(0);
    const script = fs.readFileSync(path.join(out, "reproduce.sh"), "utf8");
    expect(script).toMatch(/INSTALL_FAILED/);
    // Run it where requirements.txt exists so the install step actually runs.
    fs.copyFileSync(path.join(out, "reproduce.sh"), path.join(repo, "reproduce.sh"));
    const r = spawnBash(path.join(repo, "reproduce.sh"), {
      CI_REPRO_YES: "1",
      PATH: `${fakeBin}:${process.env.PATH}`,
    });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/INSTALL_FAILED: dependency setup exited with code 3/);
    expect(r.out).not.toMatch(/Step 2\/2/);
  });

  it("exit 5 and never execute anything when no runnable command exists", () => {
    const log = writeLog("nocmd.log", NO_COMMAND_LOG);
    const out = path.join(base, "nocmd");
    expect(run(["reproduce", log, "--out", out]).code).toBe(0);
    const r = spawnBash(path.join(out, "reproduce.sh"), { CI_REPRO_YES: "1" });
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/NO REPRO COMMAND/);
  });

  it("propagates the repro command's own exit code through reproduce --run", () => {
    const log = writeLog("exit5.log", EXIT5_LOG);
    const r = run(["reproduce", log, "--out", path.join(base, "b5"), "--run"]);
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/REPRODUCED: command exited with code 5/);
  });
});

describe("prove --run exit mapping and cleanup", () => {
  it("maps an install failure to unable-to-reproduce (exit 2), not fixed", () => {
    const log = writeLog("pip.log", PIP_CI_LOG);
    const out = path.join(base, "bundle");
    run(["reproduce", log, "--out", out]);
    const hf = path.join(base, "h.jsonl");
    const env = { PATH: `${fakeBin}:${process.env.PATH}` };
    const text = run(["prove", out, "--run", "--cwd", repo, "--history-file", hf], {
      env,
    });
    expect(text.code).toBe(2);
    expect(text.out).toMatch(/state: unable-to-reproduce/);
    expect(text.out).not.toMatch(/state: fixed/);
    const json = run(
      ["prove", out, "--run", "--json", "--cwd", repo, "--history-file", hf],
      { env },
    );
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out).state).toBe("unable-to-reproduce");
  });

  it("maps a no-command bundle to unable-to-reproduce (exit 2)", () => {
    const log = writeLog("nocmd.log", NO_COMMAND_LOG);
    const out = path.join(base, "nocmd");
    run(["reproduce", log, "--out", out]);
    const r = run([
      "prove",
      out,
      "--run",
      "--cwd",
      repo,
      "--history-file",
      path.join(base, "h.jsonl"),
    ]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no runnable repro command/);
  });

  it("does not report fixed when the command itself exits 5 but reproduces the failure", () => {
    const log = writeLog("exit5.log", EXIT5_LOG);
    const out = path.join(base, "b5");
    run(["reproduce", log, "--out", out]);
    const r = run([
      "prove",
      out,
      "--run",
      "--cwd",
      repo,
      "--history-file",
      path.join(base, "h.jsonl"),
    ]);
    expect(r.out).not.toMatch(/state: fixed/);
    expect(r.code).not.toBe(0);
  });

  it("accepts a relative bundle path together with --cwd (script is resolved absolutely)", () => {
    const log = writeLog("exit5.log", EXIT5_LOG);
    run(["reproduce", log, "--out", "relbundle"]);
    const r = run(
      [
        "prove",
        "relbundle",
        "--run",
        "--cwd",
        repo,
        "--history-file",
        path.join(base, "h.jsonl"),
      ],
      {
        cwd: base,
      },
    );
    expect(r.out).not.toMatch(/did not start/);
    expect(r.out).toMatch(/run exit code: 5/);
  });

  it("removes its captured-output temp directory after every run", () => {
    const log = writeLog("exit5.log", EXIT5_LOG);
    const out = path.join(base, "b5");
    run(["reproduce", log, "--out", out]);
    const before = fs
      .readdirSync(tmpdir)
      .filter((n) => n.startsWith("actionrepro-prove-"));
    run([
      "prove",
      out,
      "--run",
      "--cwd",
      repo,
      "--history-file",
      path.join(base, "h.jsonl"),
    ]);
    run([
      "prove",
      out,
      "--run",
      "--json",
      "--cwd",
      repo,
      "--history-file",
      path.join(base, "h.jsonl"),
    ]);
    const after = fs
      .readdirSync(tmpdir)
      .filter((n) => n.startsWith("actionrepro-prove-"));
    expect(after).toEqual(before);
  });
});

describe("verify exit codes are the same with and without --json", () => {
  function bundleFor(name: string, lines: string[]): { out: string; log: string } {
    const log = writeLog(`${name}.log`, lines);
    const out = path.join(base, `v-${name}`);
    run(["reproduce", log, "--out", out]);
    return { out, log };
  }

  it("REPRODUCED → 0 for text and JSON", () => {
    const { out, log } = bundleFor("same", ASSERT_LOG);
    expect(run(["verify", out, log]).code).toBe(0);
    expect(run(["verify", out, log, "--json"]).code).toBe(0);
  });

  it("NOT_REPRODUCED → 1 for text and JSON", () => {
    const { out } = bundleFor("nr", PIP_CI_LOG);
    const clean = writeLog("clean.log", [
      "added 1 package in 0.2s",
      "Process completed with exit code 0.",
    ]);
    expect(run(["verify", out, clean]).code).toBe(1);
    const j = run(["verify", out, clean, "--json"]);
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out).verdict).toBe("NOT_REPRODUCED");
  });

  it("INCONCLUSIVE → 2 for text and JSON (silent non-zero exit)", () => {
    const { out } = bundleFor("inc", PIP_CI_LOG);
    const silent = writeLog("silent.log", [
      "building",
      "Process completed with exit code 7.",
    ]);
    expect(run(["verify", out, silent]).code).toBe(2);
    const j = run(["verify", out, silent, "--json"]);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.out).verdict).toBe("INCONCLUSIVE");
  });
});

function spawnBash(script: string, env: Record<string, string>): Run {
  try {
    const out = execFileSync("bash", [script], {
      encoding: "utf8",
      cwd: path.dirname(script),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      code: err.status ?? 99,
      out: String(err.stdout ?? "") + String(err.stderr ?? ""),
    };
  }
}
