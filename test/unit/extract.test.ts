import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractFailure } from "../../src/core/extract.js";

function fixture(name: string): string[] {
  const p = path.join(process.cwd(), "fixtures/logs", name);
  return fs.readFileSync(p, "utf8").split("\n");
}

describe("extractFailure", () => {
  it("extracts npm failure with repro command", () => {
    const f = extractFailure(fixture("npm-fail.log"));
    // The anchor is the real diagnostic, never the runner's exit-code line.
    expect(f.summary).toContain("AssertionError: expected 3 to equal 4");
    expect(f.summary).not.toMatch(/##\[error\]/);
    expect(f.matched).toBe(true);
    expect(f.errorKind).toBe("assertion error");
    expect(f.anchor).toBe("AssertionError: expected 3 to equal 4");
    expect(f.reproCommand).toBe("npm test");
    expect(f.exitCode).toBe(1);
    expect(f.errorLines.length).toBeGreaterThan(0);
  });

  it("summarizes every fixture with a real diagnostic, not the exit marker", () => {
    const cases: Array<[string, string, string]> = [
      ["npm-fail.log", "assertion error", "AssertionError: expected 3 to equal 4"],
      ["python-fail.log", "assertion error", "AssertionError: assert 6 == 7"],
      ["cargo-fail.log", "rustc error", "error[E0308]: mismatched types"],
      ["go-fail.log", "test/compiler diagnostic", "add_test.go:10: got 3, want 4"],
      ["pnpm-fail.log", "pnpm error", "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL"],
      ["maven-fail.log", "assertion diff", "expected:<4> but was:<3>"],
      ["gradle-fail.log", "assertion diff", "expected:<4> but was:<3>"],
      ["dotnet-fail.log", "assertion failure", "Assert.Equal() Failure: Values differ"],
      ["ruby-fail.log", "RSpec failure", "Failure/Error: expect(result).to eq(4)"],
      ["node-test-fail.log", "TAP test failure", "not ok 1 - adds numbers"],
    ];
    for (const [file, kind, needle] of cases) {
      const f = extractFailure(fixture(file));
      expect(f.matched, file).toBe(true);
      expect(f.errorKind, file).toBe(kind);
      expect(f.anchor, file).toContain(needle);
      expect(f.summary, file).not.toContain("Process completed with exit code");
    }
  });

  it("never anchors on the runner exit-code restatement alone", () => {
    const f = extractFailure([
      "Run npm test",
      "npm ERR! code ELIFECYCLE",
      "##[error]Process completed with exit code 1.",
    ]);
    // Only bookkeeping lines exist -> nothing "matched", but the exit code is read.
    expect(f.matched).toBe(false);
    expect(f.exitCode).toBe(1);
  });

  it("ignores actionrepro's own script frame", () => {
    const f = extractFailure([
      "==> [actionrepro] failure: Failure: AssertionError: old recorded failure",
      "==> [actionrepro] running: npm test",
      "not ok 1 - adds numbers",
    ]);
    expect(f.anchor).toBe("not ok 1 - adds numbers");
    expect(f.summary).not.toContain("old recorded failure");
  });

  it("reports success logs as unmatched instead of inventing a failure", () => {
    const f = extractFailure(fixture("yarn-success.log"));
    expect(f.matched).toBe(false);
  });

  it("extracts python traceback", () => {
    const f = extractFailure(fixture("python-fail.log"));
    expect(f.reproCommand).toBe("pytest");
    expect(f.exitCode).toBe(1);
    expect(f.errorLines.join("\n")).toMatch(/AssertionError/);
  });

  it("extracts cargo error", () => {
    const f = extractFailure(fixture("cargo-fail.log"));
    expect(f.reproCommand).toBe("cargo test");
    expect(f.exitCode).toBe(101);
  });

  it("extracts go failure", () => {
    const f = extractFailure(fixture("go-fail.log"));
    expect(f.reproCommand).toBe("go test ./...");
  });

  it("handles success logs deterministically", () => {
    const f = extractFailure(fixture("yarn-success.log"));
    expect(f.summary).toBeDefined();
    // No failure pattern matched strongly; repro falls back to nearest Run line.
    expect(typeof f.summary).toBe("string");
  });

  it("is deterministic: same input -> same output", () => {
    const a = extractFailure(fixture("npm-fail.log"));
    const b = extractFailure(fixture("npm-fail.log"));
    expect(a).toEqual(b);
  });
});
