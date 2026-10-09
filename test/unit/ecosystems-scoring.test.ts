import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { detectEcosystem } from "../../src/core/ecosystems.js";

const CASES_DIR = path.join(process.cwd(), "fixtures/ecosystems");
const readCase = (name: string) =>
  fs.readFileSync(path.join(CASES_DIR, name), "utf8").split(/\r?\n/);

// Expected ids and confidence are the measured results after the per-kind scoring change
// (before the change, cargo-with-pip-setup.log was reported as pip).
const EXPECTED: Array<[string, string, string]> = [
  ["cargo-with-pip-setup.log", "cargo", "high"],
  ["gradle-with-pytest-docs.log", "gradle", "high"],
  ["npm-mentions-pip-install.log", "npm", "high"],
  ["npm-runs-python-helper.log", "npm", "high"],
  ["pytest-only.log", "pip", "high"],
];

describe("ecosystem scoring regression fixtures", () => {
  it.each(EXPECTED)("%s is classified as %s (%s)", (file, id, confidence) => {
    const r = detectEcosystem(readCase(file), []);
    expect({ id: r.id, confidence: r.confidence }).toEqual({ id, confidence });
  });

  it("a pip setup step does not outrank a cargo test failure", () => {
    const r = detectEcosystem(readCase("cargo-with-pip-setup.log"), ["Cargo.toml"]);
    expect(r.id).toBe("cargo");
    expect(r.testCommand).toBe("cargo test");
  });
});

describe("file evidence and log evidence stack", () => {
  it("a lockfile alone gives low confidence but still names the ecosystem", () => {
    const r = detectEcosystem(["something went wrong"], ["go.mod"]);
    expect(r.id).toBe("go");
    expect(r.confidence).toBe("low");
  });

  it("a Cargo.toml plus a Rust failure line in the log stacks into high confidence", () => {
    const r = detectEcosystem(
      [
        "   Compiling app v0.1.0",
        "Running `cargo test --all`",
        "test result: FAILED. 0 passed; 1 failed; 0 ignored",
      ],
      ["Cargo.toml"],
    );
    expect(r.id).toBe("cargo");
    expect(r.confidence).toBe("high");
    expect(r.evidence).toContain("project has Cargo.toml");
  });

  it("no evidence at all yields unknown with a placeholder command", () => {
    const r = detectEcosystem(["hello"], []);
    expect(r.id).toBe("unknown");
    expect(r.confidence).toBe("low");
  });

  it("an explicit 'Run npm ...' line is high-confidence npm even with no files", () => {
    const r = detectEcosystem(["##[group]Run npm test", "npm ERR! Test failed."], []);
    expect(r.id).toBe("npm");
  });
});
