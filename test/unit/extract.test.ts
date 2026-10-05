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
    expect(f.summary).toMatch(/exit code 1/i);
    expect(f.reproCommand).toBe("npm test");
    expect(f.exitCode).toBe(1);
    expect(f.errorLines.length).toBeGreaterThan(0);
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
