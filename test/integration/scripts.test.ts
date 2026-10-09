import { describe, it, expect } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashBundleFiles } from "../../src/core/fingerprint.js";

const ROOT = process.cwd();
const CLI = path.join(ROOT, "dist/cli.js");
const LOGDIR = path.join(ROOT, "fixtures/logs");
const LOGS = fs.readdirSync(LOGDIR).filter((f) => f.endsWith(".log"));

function pwshAvailable(): boolean {
  try {
    execSync('pwsh -NoProfile -Command "$PSVersionTable.PSVersion"', {
      stdio: "ignore",
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

const HAVE_PWSH = pwshAvailable();

function checkPs1(file: string): void {
  // PowerShell parser API: returns parse errors without executing anything.
  const script = `$errs = $null; $null = [System.Management.Automation.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$errs); $errs.Count`;
  const out = execFileSync("pwsh", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 30000,
  }).trim();
  expect(out).toBe("0");
}

describe("generated scripts are valid for every fixture", () => {
  it.each(LOGS)("bash -n passes + files + sha verify for %s", (log) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-scripts-"));
    const outDir = path.join(tmp, "bundle");
    try {
      execFileSync("node", [CLI, "reproduce", path.join(LOGDIR, log), "--out", outDir], {
        encoding: "utf8",
        timeout: 30000,
      });
      // Throws on any bash syntax error (this is what caught the pip bug).
      execFileSync("bash", ["-n", path.join(outDir, "reproduce.sh")], { timeout: 15000 });
      for (const f of [
        "reproduce.sh",
        "reproduce.ps1",
        "README.md",
        "failure.txt",
        "environment.txt",
        "repro.json",
        "bundle.sha256",
      ]) {
        expect(fs.existsSync(path.join(outDir, f)), f).toBe(true);
      }
      if (HAVE_PWSH) checkPs1(path.join(outDir, "reproduce.ps1"));
      // bundle.sha256 must equal an independent recomputation over the files.
      const files = [
        "reproduce.sh",
        "reproduce.ps1",
        "failure.txt",
        "environment.txt",
      ].map((name) => ({
        name,
        content: fs.readFileSync(path.join(outDir, name), "utf8"),
      }));
      const recorded = fs
        .readFileSync(path.join(outDir, "bundle.sha256"), "utf8")
        .split("\n")[2];
      expect(hashBundleFiles(files)).toBe(recorded);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
