import { describe, it, expect, afterEach, vi } from "vitest";
import {
  findProvider,
  PROVIDERS,
  resolveProviderToken,
} from "../../src/providers/registry.js";
import { GitHubActionsProvider } from "../../src/providers/github-actions.js";

const SAMPLES = [
  "https://github.com/o/r/actions/runs/1",
  "https://api.github.com/repos/o/r/actions/runs/1",
  "https://ghe.example.com/o/r/actions/runs/1",
  "https://gitlab.com/group/project/-/pipelines/123",
  "https://gitlab.example.com/group/sub/project/-/jobs/9",
  "./fixtures/logs/npm-fail.log",
  "https://example.com/not-a-ci-url",
  "",
];

describe("findProvider", () => {
  it("routes GitHub run URLs to github-actions", () => {
    expect(findProvider("https://github.com/o/r/actions/runs/1")?.id).toBe(
      "github-actions",
    );
    expect(findProvider("https://ghe.example.com/o/r/actions/runs/1")?.id).toBe(
      "github-actions",
    );
  });

  it("routes GitLab pipeline URLs to gitlab", () => {
    expect(findProvider("https://gitlab.com/group/project/-/pipelines/123")?.id).toBe(
      "gitlab",
    );
  });

  it("returns undefined for local files and unknown URLs", () => {
    expect(findProvider("./fixtures/logs/npm-fail.log")).toBeUndefined();
    expect(findProvider("https://example.com/not-a-ci-url")).toBeUndefined();
  });

  it("no sample input matches more than one provider (the guard never fires today)", () => {
    for (const input of SAMPLES) {
      const n = PROVIDERS.filter((p) => p.matches(input)).length;
      expect(n, input).toBeLessThanOrEqual(1);
    }
  });

  it("throws when two providers claim the same input (ambiguity guard)", () => {
    const spy = vi
      .spyOn(GitHubActionsProvider.prototype, "matches")
      .mockImplementation(() => true);
    try {
      expect(() =>
        findProvider("https://gitlab.com/group/project/-/pipelines/1"),
      ).toThrow(/Ambiguous CI provider.*github-actions.*gitlab/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("resolveProviderToken", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("an explicit token always wins for either provider", () => {
    process.env.GITLAB_TOKEN = "gl-env";
    expect(resolveProviderToken("gitlab", "flag")).toBe("flag");
    expect(resolveProviderToken("github-actions", "flag")).toBe("flag");
  });

  it("gitlab reads GITLAB_TOKEN", () => {
    process.env.GITLAB_TOKEN = "gl-env";
    expect(resolveProviderToken("gitlab")).toBe("gl-env");
  });

  it("github reads GITHUB_TOKEN", () => {
    process.env.GITHUB_TOKEN = "gh-env";
    expect(resolveProviderToken("github-actions")).toBe("gh-env");
  });
});
