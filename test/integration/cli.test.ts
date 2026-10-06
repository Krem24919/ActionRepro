import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const CLI = path.join(ROOT, "dist/cli.js");
const fx = (n: string) => path.join(ROOT, "fixtures/logs", n);

function runCli(args: string[], cwd?: string): string {
  return execFileSync("node", [CLI, ...args], { encoding: "utf8", cwd, timeout: 30000 });
}

describe("CLI integration (local fixtures, no network)", () => {
  it("inspect analyzes a local log file", () => {
    const out = runCli(["inspect", fx("npm-fail.log")]);
    expect(out).toMatch(/ecosystem: npm/);
    expect(out).toMatch(/repro command: npm test/);
    expect(out.split("\n")[0]).toBe("ActionRepro inspection");
  });

  it("reproduce creates a bundle from a local log file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-cli-"));
    const outDir = path.join(tmp, "actionrepro");
    const out = runCli(["reproduce", fx("python-fail.log"), "--out", outDir]);
    expect(out).toMatch(/bundle:/);
    expect(out.split("\n")[0]).toBe("ActionRepro result");
    for (const f of [
      "reproduce.sh",
      "README.md",
      "failure.txt",
      "environment.txt",
      "repro.json",
      "reproduce.ps1",
    ]) {
      expect(fs.existsSync(path.join(outDir, f))).toBe(true);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("default command creates a bundle (shorthand)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-cli2-"));
    const outDir = path.join(tmp, "out");
    runCli([fx("go-fail.log"), "--out", outDir]);
    expect(fs.existsSync(path.join(outDir, "reproduce.sh"))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("never leaks secrets into bundle or stdout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-cli3-"));
    const outDir = path.join(tmp, "out");
    const out = runCli(["reproduce", fx("secrets.log"), "--out", outDir]);
    expect(out).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    const failure = fs.readFileSync(path.join(outDir, "failure.txt"), "utf8");
    expect(failure).not.toContain("hunter2-secret-value");
    expect(failure).toContain("[REDACTED]");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("verify reports REPRODUCED for the same log", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-verify-"));
    const outDir = path.join(tmp, "bundle");
    runCli(["reproduce", fx("npm-fail.log"), "--out", outDir]);
    const out = runCli(["verify", outDir, fx("npm-fail.log")]);
    expect(out).toMatch(/verdict: REPRODUCED/);
    expect(out).toMatch(/CI exit code: 1/);
    expect(out).toMatch(/fresh exit code: 1/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("verify reports NOT_REPRODUCED for a different failure", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-verify2-"));
    const outDir = path.join(tmp, "bundle");
    runCli(["reproduce", fx("npm-fail.log"), "--out", outDir]);
    try {
      runCli(["verify", outDir, fx("go-fail.log")]);
      expect.unreachable("mismatch should exit 1");
    } catch (e) {
      const err = e as { status?: number; stdout?: unknown };
      expect(err.status).toBe(1);
      expect(String(err.stdout ?? "")).toMatch(/verdict: NOT_REPRODUCED/);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("verify is inconclusive for a missing bundle", () => {
    try {
      runCli(["verify", "/nonexistent-bundle-xyz", fx("npm-fail.log")]);
      expect.unreachable("should have failed");
    } catch (e) {
      const err = e as { status?: number };
      expect(err.status).not.toBe(0);
    }
  });

  it("routes the verify subcommand (not the default shorthand)", () => {
    const out = runCli(["verify", "--help"]);
    expect(out).toMatch(/REPRODUCED/);
  });

  it("doctor passes required checks", () => {
    const out = runCli(["doctor"]);
    expect(out).toMatch(/doctor:/);
  }, 20000);
});
