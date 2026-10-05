import { describe, it, expect } from "vitest";
import { sanitizeActionsOutput } from "../../src/utils/log.js";

describe("sanitizeActionsOutput", () => {
  it("neutralizes workflow-command markers", () => {
    expect(sanitizeActionsOutput("##[error]Process completed with exit code 1.")).toBe(
      "## [error]Process completed with exit code 1.",
    );
    expect(sanitizeActionsOutput("Run ##[group]name ##[endgroup] done")).toBe(
      "Run ## [group]name ## [endgroup] done",
    );
  });

  it("leaves clean text byte-identical (deterministic)", () => {
    const clean = "failure: npm ERR! Exit status 1\nrepro command: npm test";
    expect(sanitizeActionsOutput(clean)).toBe(clean);
  });

  it("handles empty input", () => {
    expect(sanitizeActionsOutput("")).toBe("");
  });
});
