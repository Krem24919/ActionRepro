import { describe, it, expect } from "vitest";
import { selectFailure } from "../../src/core/selection.js";

describe("selectFailure", () => {
  it("returns the failing job and ITS failing step", () => {
    const sel = selectFailure([
      {
        name: "lint",
        conclusion: "success",
        steps: [{ name: "Lint", conclusion: "success" }],
      },
      {
        name: "test",
        conclusion: "failure",
        steps: [
          { name: "Setup", conclusion: "success" },
          { name: "Unit tests", conclusion: "failure" },
        ],
      },
    ]);
    expect(sel).toEqual({ failingJob: "test", failingStep: "Unit tests" });
  });

  it("never names a step from a different job than the failing job", () => {
    // Job A failed at the job level without a failed step; job B has a failed
    // step. The step must not be attributed to job A.
    const sel = selectFailure([
      {
        name: "A",
        conclusion: "failure",
        steps: [{ name: "ok", conclusion: "success" }],
      },
      {
        name: "B",
        conclusion: "success",
        steps: [{ name: "boom", conclusion: "failure" }],
      },
    ]);
    expect(sel.failingJob).toBe("A");
    expect(sel.failingStep).toBeUndefined();
  });

  it("falls back to the first job with a failed step when no job failed", () => {
    const sel = selectFailure([
      { name: "one", conclusion: "success", steps: [] },
      { name: "two", conclusion: null, steps: [{ name: "Run", conclusion: "failure" }] },
    ]);
    expect(sel).toEqual({ failingJob: "two", failingStep: "Run" });
  });

  it("returns an empty selection when nothing failed", () => {
    expect(selectFailure([{ name: "ok", conclusion: "success" }])).toEqual({});
    expect(selectFailure([])).toEqual({});
  });
});
