import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const CLI = path.join(ROOT, "dist/cli.js");
const fx = (n: string) => path.join(ROOT, "fixtures/logs", n);

function runCli(args: string[]): string {
  return execFileSync("node", [CLI, ...args], { encoding: "utf8", timeout: 30000 });
}

function runCliCode(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: runCli(args) };
  } catch (e) {
    const err = e as { status?: number; stdout?: unknown };
    return { code: err.status ?? 99, out: String(err.stdout ?? "") };
  }
}

describe("prove CLI (isolated history file, no network)", () => {
  it("reports still-failing, changed-failure, and fixed with the right exits", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-prove-"));
    const hf = path.join(tmp, "h.jsonl");
    const outDir = path.join(tmp, "bundle");
    try {
      runCli(["reproduce", fx("npm-fail.log"), "--out", outDir]);

      const same = runCliCode([
        "prove",
        outDir,
        fx("npm-fail.log"),
        "--history-file",
        hf,
      ]);
      expect(same.code).toBe(1);
      expect(same.out).toMatch(/state: still-failing/);

      const diff = runCliCode(["prove", outDir, fx("go-fail.log"), "--history-file", hf]);
      expect(diff.code).toBe(1);
      expect(diff.out).toMatch(/state: changed-failure/);

      const cleanLog = path.join(tmp, "clean.log");
      fs.writeFileSync(cleanLog, "All tests passed.\nDone in 1.2s.\n");
      const fixed = runCliCode(["prove", outDir, cleanLog, "--history-file", hf]);
      expect(fixed.code).toBe(0);
      expect(fixed.out).toMatch(/state: fixed/);

      const s = JSON.parse(
        runCli(["history", "--history-file", hf, "--stats", "--json"]),
      ) as { failureEvents: number; fixedEvents: number };
      expect(s.failureEvents).toBe(2);
      expect(s.fixedEvents).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports unable-to-reproduce for missing inputs", () => {
    const r = runCliCode([
      "prove",
      "/nonexistent-bundle-xyz",
      "/nonexistent-log-xyz.log",
    ]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/state: unable-to-reproduce/);
  });

  it("runs the bundle with --run and captures the log", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-proverun-"));
    const hf = path.join(tmp, "h.jsonl");
    const outDir = path.join(tmp, "bundle");
    try {
      runCli(["reproduce", fx("npm-fail.log"), "--out", outDir]);
      // Replace the bundle scripts with harmless stand-ins (exit 0, no
      // failure). Both flavors: Windows runs reproduce.ps1, rest run .sh.
      fs.writeFileSync(outDir + "/reproduce.sh", "#!/bin/sh\necho all-green\n");
      fs.writeFileSync(outDir + "/reproduce.ps1", 'Write-Output "all-green"\n');
      const r = runCliCode([
        "prove",
        outDir,
        "--run",
        "--cwd",
        tmp,
        "--history-file",
        hf,
        "--json",
      ]);
      expect(r.code).toBe(0);
      const body = JSON.parse(r.out) as {
        state: string;
        runExitCode: number;
        logFile: string;
      };
      expect(body.state).toBe("fixed");
      expect(body.runExitCode).toBe(0);
      expect(fs.readFileSync(body.logFile, "utf8")).toContain("all-green");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("routes the prove subcommand (not the default shorthand)", () => {
    const r = runCliCode(["prove", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Verify a fix/);
  });
});
