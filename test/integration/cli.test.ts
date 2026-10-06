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

  it("doctor passes required checks", () => {
    const out = runCli(["doctor"]);
    expect(out).toMatch(/doctor:/);
  }, 20000);
});
