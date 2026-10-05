import { describe, it, expect } from "vitest";
import { parseGitHubRunUrl, isGitHubRunUrl } from "../../src/core/url.js";

describe("parseGitHubRunUrl", () => {
  it("parses standard run URL", () => {
    expect(parseGitHubRunUrl("https://github.com/OWNER/REPO/actions/runs/12345")).toEqual(
      {
        owner: "OWNER",
        repo: "REPO",
        runId: "12345",
      },
    );
  });

  it("parses URL with job fragment and query", () => {
    const p = parseGitHubRunUrl(
      "https://github.com/octocat/hello/actions/runs/98765/job/123?check_suite_focus=true",
    );
    expect(p).toMatchObject({ owner: "octocat", repo: "hello", runId: "98765" });
  });

  it("rejects non-run URLs", () => {
    expect(parseGitHubRunUrl("https://github.com/OWNER/REPO")).toBeNull();
    expect(parseGitHubRunUrl("./failure.log")).toBeNull();
    expect(isGitHubRunUrl("https://github.com/o/r/actions/runs/1")).toBe(true);
    expect(isGitHubRunUrl("not a url")).toBe(false);
  });
});
