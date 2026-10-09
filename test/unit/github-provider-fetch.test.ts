import { describe, it, expect, afterEach, vi } from "vitest";
import { GitHubActionsProvider } from "../../src/providers/github-actions.js";

/** Stub fetch by URL. Every request is recorded with its Authorization header. */
function routes(map: Record<string, (url: string) => Response>) {
  const seen: Array<{ url: string; auth?: string }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
      seen.push({ url, auth });
      for (const [pattern, fn] of Object.entries(map)) {
        if (url.includes(pattern)) return fn(url);
      }
      return new Response("missing", { status: 404 });
    },
  );
  return seen;
}

const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const RUN = {
  id: 555,
  name: "CI",
  head_branch: "main",
  head_sha: "deadbeef",
  event: "push",
  conclusion: "failure",
  html_url: "https://github.com/o/r/actions/runs/555",
  created_at: "2026-01-02T03:04:05Z",
};

const JOBS = {
  total_count: 1,
  jobs: [
    {
      id: 900,
      name: "test (20.x)",
      conclusion: "failure",
      runner_name: "GitHub Actions 3",
      runner_os: "Linux",
      runner_arch: "X64",
      steps: [{ name: "Run npm test", number: 4, conclusion: "failure" }],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GH_HOST;
});

describe("GitHubActionsProvider.fetch", () => {
  it("maps the run, jobs, steps and logs into a CiFetchResult", async () => {
    routes({
      "/actions/runs/555/jobs": () => jsonRes(JOBS),
      "/actions/jobs/900/logs": () =>
        new Response("##[error]Process completed with exit code 1.", { status: 200 }),
      "/actions/runs/555": () => jsonRes(RUN),
    });
    const res = await new GitHubActionsProvider().fetch(
      "https://github.com/o/r/actions/runs/555",
      {
        token: "tok",
      },
    );
    expect(res.run).toEqual({
      id: 555,
      name: "CI",
      workflowName: "CI",
      headBranch: "main",
      headSha: "deadbeef",
      event: "push",
      conclusion: "failure",
      htmlUrl: "https://github.com/o/r/actions/runs/555",
      createdAt: "2026-01-02T03:04:05Z",
    });
    expect(res.jobs).toEqual([
      {
        id: 900,
        name: "test (20.x)",
        conclusion: "failure",
        steps: [{ name: "Run npm test", number: 4, conclusion: "failure" }],
        runnerName: "GitHub Actions 3",
        runnerOs: "Linux",
        runnerArch: "X64",
      },
    ]);
    expect(res.logsByJob.get("900")).toContain("exit code 1");
    expect(res.combinedLogs).toContain("===== JOB: test (20.x)");
  });

  it("sends the token to api.github.com for github.com runs", async () => {
    const seen = routes({
      "/actions/runs/555": () => jsonRes(RUN),
      "/jobs": () => jsonRes({ total_count: 0, jobs: [] }),
    });
    await new GitHubActionsProvider().fetch("https://github.com/o/r/actions/runs/555", {
      token: "tok",
    });
    expect(seen[0].url).toBe("https://api.github.com/repos/o/r/actions/runs/555");
    expect(seen[0].auth).toBe("Bearer tok");
  });

  it("calls the Enterprise REST API and withholds the token unless GH_HOST is set", async () => {
    const seen = routes({
      "/actions/runs/555": () => jsonRes(RUN),
      "/jobs": () => jsonRes({ total_count: 0, jobs: [] }),
    });
    await new GitHubActionsProvider().fetch(
      "https://ghe.example.com/o/r/actions/runs/555",
      { token: "tok" },
    );
    expect(seen[0].url).toBe("https://ghe.example.com/api/v3/repos/o/r/actions/runs/555");
    expect(seen[0].auth).toBeUndefined();
  });

  it("sends the token to the Enterprise host when GH_HOST names it", async () => {
    process.env.GH_HOST = "ghe.example.com";
    const seen = routes({
      "/actions/runs/555": () => jsonRes(RUN),
      "/jobs": () => jsonRes({ total_count: 0, jobs: [] }),
    });
    await new GitHubActionsProvider().fetch(
      "https://ghe.example.com/o/r/actions/runs/555",
      { token: "tok" },
    );
    expect(seen[0].auth).toBe("Bearer tok");
  });

  it("rejects input that is not a run URL", async () => {
    await expect(new GitHubActionsProvider().fetch("./local.log", {})).rejects.toThrow(
      /Not a GitHub Actions run URL/,
    );
  });

  it("propagates a 404 from the run endpoint", async () => {
    routes({});
    await expect(
      new GitHubActionsProvider().fetch("https://github.com/o/r/actions/runs/1", {}),
    ).rejects.toThrow(/GitHub API 404/);
  });
});
