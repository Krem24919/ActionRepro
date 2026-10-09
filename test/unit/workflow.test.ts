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

  it("finds unnamed run steps via the API's 'Run <cmd>' display name", () => {
    const y = `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test -- --runInBand
`;
    expect(extractStepScript(y, "Run npm test -- --runInBand")?.script).toBe(
      "npm test -- --runInBand",
    );
    expect(extractStepScript(y, "Run npm test")).toBeNull();
  });

  it("prefers an exact - name: match over a Run-style match", () => {
    const y = `jobs:
  test:
    steps:
      - name: Run npm test
        run: npm run ci-test
      - run: npm test
`;
    expect(extractStepScript(y, "Run npm test")?.script).toBe("npm run ci-test");
  });
});

describe("extractStepScript job scoping", () => {
  const MULTI = `name: CI
on: [push]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - name: Run tests
        run: npm run lint
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Run tests
        run: npm test -- --runInBand
`;

  it("picks the step from the failing job when names repeat", () => {
    expect(extractStepScript(MULTI, "Run tests", "test")?.script).toBe(
      "npm test -- --runInBand",
    );
    expect(extractStepScript(MULTI, "Run tests", "lint")?.script).toBe("npm run lint");
  });

  it("matches matrix/slice suffixed API job names", () => {
    expect(extractStepScript(MULTI, "Run tests", "test (20.x)")?.script).toBe(
      "npm test -- --runInBand",
    );
  });

  it("matches a custom job display name", () => {
    const y = `jobs:
  unit:
    name: Unit tests
    steps:
      - name: Run tests
        run: npm run unit
  other:
    steps:
      - name: Run tests
        run: npm run other
`;
    expect(extractStepScript(y, "Run tests", "Unit tests")?.script).toBe("npm run unit");
  });

  it("falls back to the first match for unknown or ambiguous jobs", () => {
    expect(extractStepScript(MULTI, "Run tests", "nope")?.script).toBe("npm run lint");
    expect(extractStepScript(MULTI, "Run tests")?.script).toBe("npm run lint");
    const ambiguous = `jobs:
  test:
    steps:
      - name: Run tests
        run: npm run unit
  e2e:
    name: test (20.x)
    steps:
      - name: Run tests
        run: npm run e2e
`;
    expect(extractStepScript(ambiguous, "Run tests", "test (20.x)")?.script).toBe(
      "npm run unit",
    );
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

  it("does not treat a longer word as an expansion (go test vs go testify)", () => {
    expect(commandsAgree("go test", "go testify")).toBe(false);
    expect(commandsAgree("npm test", "npm testing-tool")).toBe(false);
  });

  it("returns null when either side is empty", () => {
    expect(commandsAgree("", "npm test")).toBeNull();
    expect(commandsAgree("npm test", "")).toBeNull();
  });
});
