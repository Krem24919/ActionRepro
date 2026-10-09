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
    {
      log: "node-test-fail.log",
      ecosystem: "node",
      install: "package.json",
      command: "node --test",
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

describe("repro command source transparency", () => {
  it("records log vs ecosystem-default in repro.json, failure.txt, and inspect", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-src-"));
    try {
      const outLog = path.join(tmp, "b1");
      runCli(["reproduce", fx("npm-fail.log"), "--out", outLog]);
      const meta = JSON.parse(
        fs.readFileSync(path.join(outLog, "repro.json"), "utf8"),
      ) as {
        reproCommandSource: string;
      };
      expect(meta.reproCommandSource).toBe("log");
      expect(fs.readFileSync(path.join(outLog, "failure.txt"), "utf8")).toContain(
        "repro-source: log",
      );

      const noRunLog = path.join(tmp, "norun.log");
      fs.writeFileSync(noRunLog, "something broke\nError: boom\n");
      const outDef = path.join(tmp, "b2");
      runCli(["reproduce", noRunLog, "--out", outDef]);
      const meta2 = JSON.parse(
        fs.readFileSync(path.join(outDef, "repro.json"), "utf8"),
      ) as {
        reproCommandSource: string;
        failure: { reproCommand: string };
      };
      expect(meta2.reproCommandSource).toBe("ecosystem-default");
      expect(fs.readFileSync(path.join(outDef, "failure.txt"), "utf8")).toContain(
        "repro-source: ecosystem-default",
      );

      const insp = JSON.parse(runCli(["inspect", noRunLog, "--json"])) as {
        reproCommandSource: string;
      };
      expect(insp.reproCommandSource).toBe("ecosystem-default");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
