import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReproduceScript } from "../../src/core/runner.js";

function scriptDir(lines: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-runner-"));
  fs.writeFileSync(path.join(dir, "reproduce.sh"), `#!/bin/sh\n${lines}\n`);
  return dir;
}

describe("runReproduceScript outputFile", () => {
  it("captures stdout+stderr to a file and returns the exit code", () => {
    const dir = scriptDir("echo out-line; echo err-line >&2");
    const out = path.join(dir, "run.log");
    try {
      expect(runReproduceScript(dir, { outputFile: out, cwd: dir })).toBe(0);
      const text = fs.readFileSync(out, "utf8");
      expect(text).toContain("out-line");
      expect(text).toContain("err-line");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates non-zero exits and throws for a missing script", () => {
    const dir = scriptDir("exit 3");
    const out = path.join(dir, "run.log");
    try {
      expect(runReproduceScript(dir, { outputFile: out, cwd: dir })).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-runner-empty-"));
    try {
      expect(() => runReproduceScript(empty, { cwd: empty })).toThrow(/not found/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
