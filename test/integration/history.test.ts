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

describe("history CLI (isolated history file, no network)", () => {
  it("records, looks up, marks fixed, and stats", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-histcli-"));
    const hf = path.join(tmp, "h.jsonl");
    try {
      const s0 = JSON.parse(
        runCli(["history", "--history-file", hf, "--stats", "--json"]),
      ) as {
        failureEvents: number;
      };
      expect(s0.failureEvents).toBe(0);

      const rec = JSON.parse(
        runCli([
          "history",
          "--history-file",
          hf,
          "--record-log",
          fx("npm-fail.log"),
          "--json",
        ]),
      ) as { entry: { fingerprint: string } };
      const fp: string = rec.entry.fingerprint;
      expect(fp).toMatch(/^[0-9a-f]{16}$/);

      const out = runCli(["history", "--history-file", hf, "--lookup", fp]);
      expect(out.split("\n")[0]).toBe("ActionRepro history");
      expect(out).toMatch(/failures: 1/);
      expect(out).toMatch(/still failing: yes/);

      runCli(["history", "--history-file", hf, "--mark-fixed", fp]);
      expect(runCli(["history", "--history-file", hf, "--lookup", fp])).toMatch(
        /still failing: no/,
      );

      const outDir = path.join(tmp, "bundle");
      runCli(["reproduce", fx("npm-fail.log"), "--out", outDir]);
      runCli(["history", "--history-file", hf, "--record-bundle", outDir]);
      const s1 = JSON.parse(
        runCli(["history", "--history-file", hf, "--stats", "--json"]),
      ) as { failureEvents: number; fixedEvents: number };
      expect(s1.failureEvents).toBe(2);
      expect(s1.fixedEvents).toBe(1);

      // Bare `history` defaults to stats.
      expect(runCli(["history", "--history-file", hf]).split("\n")[0]).toBe(
        "ActionRepro history",
      );

      // Conflicting actions are rejected.
      expect(() =>
        runCli(["history", "--history-file", hf, "--stats", "--lookup", fp]),
      ).toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("routes the history subcommand (not the default shorthand)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-histcli2-"));
    try {
      const out = runCli(["history", "--history-file", path.join(tmp, "h.jsonl")]);
      expect(out).toMatch(/failure events: 0/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
