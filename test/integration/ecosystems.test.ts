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

const CASES: Array<{ log: string; ecosystem: string; install: string; command: string }> =
  [
    {
      log: "maven-fail.log",
      ecosystem: "maven",
      install: "mvn -B dependency:resolve",
      command: "mvn -B test",
    },
    {
      log: "gradle-fail.log",
      ecosystem: "gradle",
      install: "gradlew",
      command: "./gradlew test",
    },
    {
      log: "dotnet-fail.log",
      ecosystem: "dotnet",
      install: "dotnet restore",
      command: "dotnet test",
    },
    {
      log: "ruby-fail.log",
      ecosystem: "ruby",
      install: "bundle install",
      command: "bundle exec rspec",
    },
  ];

describe("new ecosystems end to end (local fixtures, no network)", () => {
  it.each(CASES)(
    "reproduces $log as $ecosystem",
    ({ log, ecosystem, install, command }) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-eco-"));
      const outDir = path.join(tmp, "bundle");
      try {
        const out = runCli(["reproduce", fx(log), "--out", outDir, "--json"]);
        const body = JSON.parse(out) as { ecosystem: string; reproCommand: string };
        expect(body.ecosystem).toBe(ecosystem);
        expect(body.reproCommand).toContain(command);
        const sh = fs.readFileSync(path.join(outDir, "reproduce.sh"), "utf8");
        expect(sh).toContain(install);
        expect(fs.existsSync(path.join(outDir, "reproduce.ps1"))).toBe(true);
        const meta = JSON.parse(
          fs.readFileSync(path.join(outDir, "repro.json"), "utf8"),
        ) as {
          ecosystem: string;
        };
        expect(meta.ecosystem).toBe(ecosystem);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
