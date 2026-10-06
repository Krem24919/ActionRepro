import { describe, it, expect } from "vitest";
import { extractStepScript, commandsAgree } from "../../src/core/workflow.js";

const YAML = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run npm test
        run: npm test
      - name: Build docs
        run: |
          npm run docs
          npm run linkcheck
      - name: Single quotes
        run: 'npm run special'
`;

describe("extractStepScript", () => {
  it("extracts an inline run command", () => {
    expect(extractStepScript(YAML, "Run npm test")).toEqual({
      stepName: "Run npm test",
      script: "npm test",
    });
  });

  it("extracts a block scalar script", () => {
    const s = extractStepScript(YAML, "Build docs");
    expect(s?.script).toBe("npm run docs\nnpm run linkcheck");
  });

  it("strips surrounding quotes from the step name", () => {
    expect(extractStepScript(YAML, "Single quotes")?.script).toBe("npm run special");
  });

  it("returns null for missing steps and non-run steps", () => {
    expect(extractStepScript(YAML, "Nope")).toBeNull();
    expect(extractStepScript("steps:\n  - uses: actions/checkout@v4\n", "x")).toBeNull();
    expect(extractStepScript("", "Run npm test")).toBeNull();
  });
});

describe("commandsAgree", () => {
  it("matches identical commands", () => {
    expect(commandsAgree("npm test", "npm test")).toBe(true);
  });

  it("matches prefix expansions", () => {
    expect(commandsAgree("npm test", "npm test -- --runInBand")).toBe(true);
  });

  it("flags real conflicts", () => {
    expect(commandsAgree("npm test", "npm run build")).toBe(false);
  });

  it("returns null when either side is empty", () => {
    expect(commandsAgree("", "npm test")).toBeNull();
    expect(commandsAgree("npm test", "")).toBeNull();
  });
});
