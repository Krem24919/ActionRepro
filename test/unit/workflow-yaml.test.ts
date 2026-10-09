import { describe, it, expect } from "vitest";
import { commandsAgree, extractStepScript } from "../../src/core/workflow.js";

const FOUR_SPACE = [
  "name: CI",
  "jobs:",
  "    lint:",
  "        steps:",
  "            - name: Run tests",
  "              run: npm run lint",
  "    test:",
  "        steps:",
  "            - name: Run tests",
  "              run: npm test -- --runInBand",
  "",
].join("\n");

describe("extractStepScript on 4-space and other indentation", () => {
  it("scopes a repeated step name to the named job (4-space indent)", () => {
    expect(extractStepScript(FOUR_SPACE, "Run tests", "test")?.script).toBe(
      "npm test -- --runInBand",
    );
    expect(extractStepScript(FOUR_SPACE, "Run tests", "lint")?.script).toBe(
      "npm run lint",
    );
  });

  it("matches a matrix-suffixed log job name to the workflow job id", () => {
    expect(extractStepScript(FOUR_SPACE, "Run tests", "test (20.x)")?.script).toBe(
      "npm test -- --runInBand",
    );
  });

  it("returns null for a step that does not exist", () => {
    expect(extractStepScript(FOUR_SPACE, "No such step", "test")).toBeNull();
  });

  it("returns null for YAML that cannot be parsed (tabs as indentation)", () => {
    expect(extractStepScript("jobs:\n\ttest:\n\t\tsteps: []\n", "x")).toBeNull();
  });

  it("returns null for an alias-expansion bomb instead of expanding it", () => {
    const bomb = [
      "a: &a [1,2]",
      "b: &b [*a,*a,*a]",
      "c: &c [*b,*b,*b]",
      "d: &d [*c,*c,*c]",
      "e: &e [*d,*d,*d]",
      "f: &f [*e,*e,*e]",
      "",
    ].join("\n");
    expect(extractStepScript(bomb, "x")).toBeNull();
  });

  it("returns null for a non-mapping document", () => {
    expect(extractStepScript("- just\n- a list\n", "x")).toBeNull();
  });

  it("falls back to the whole document when the job name matches no job", () => {
    expect(extractStepScript(FOUR_SPACE, "Run tests", "nonexistent-job")?.script).toBe(
      "npm run lint",
    );
  });

  it("keeps a multi-line block scalar as one script", () => {
    const y = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: Build docs",
      "        run: |",
      "          npm run docs",
      "          npm run linkcheck",
      "",
    ].join("\n");
    expect(extractStepScript(y, "Build docs")?.script).toBe(
      "npm run docs\nnpm run linkcheck",
    );
  });
});

describe("commandsAgree", () => {
  it("agrees on identical and whitespace-equivalent commands", () => {
    expect(commandsAgree("npm  test", "npm test")).toBe(true);
  });

  it("reports a conflict for a different command", () => {
    expect(commandsAgree("npm test", "npm run lint")).toBe(false);
  });

  it("cannot tell when one side is empty", () => {
    expect(commandsAgree("", "npm test")).toBeNull();
    expect(commandsAgree("npm test", "   ")).toBeNull();
  });
});
