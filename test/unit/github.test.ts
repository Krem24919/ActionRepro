import { describe, it, expect } from "vitest";
import { GitHubActionsProvider } from "../../src/providers/github-actions.js";

describe("GitHubActionsProvider.matches", () => {
  it("matches run URLs only", () => {
    const p = new GitHubActionsProvider();
    expect(p.matches("https://github.com/o/r/actions/runs/123")).toBe(true);
    expect(p.matches("./failure.log")).toBe(false);
  });
});
