import { describe, it, expect } from "vitest";
import { allLogsFailed, firstLogError } from "../../src/core/github.js";

describe("allLogsFailed / firstLogError", () => {
  it("detects empty and failed-only maps", () => {
    expect(allLogsFailed(new Map())).toBe(true);
    expect(
      allLogsFailed(
        new Map([
          ["1", "(could not fetch logs for job build: GitHub API 403 fetching logs: x)"],
          ["2", "(could not fetch logs for job test: GitHub API 403 fetching logs: y)"],
        ]),
      ),
    ).toBe(true);
  });

  it("returns false when any real logs exist", () => {
    expect(
      allLogsFailed(
        new Map([
          ["1", "(could not fetch logs for job build: boom)"],
          ["2", "Run npm test\nFAIL"],
        ]),
      ),
    ).toBe(false);
  });

  it("extracts the first error without leaking structure", () => {
    const err = firstLogError(
      new Map([
        [
          "7",
          "(could not fetch logs for job build: GitHub API 403 fetching logs: denied)",
        ],
      ]),
    );
    expect(err).toContain("GitHub API 403");
    expect(err).not.toContain("(could not fetch logs");
  });
});
