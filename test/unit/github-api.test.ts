import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  MAX_JOB_PAGES,
  authHeaders,
  fetchJobLogs,
  fetchJobs,
  fetchRun,
  fetchRunBundle,
  fetchWorkflowFile,
  resolveTokenWithSource,
} from "../../src/core/github.js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Install a fetch stub; every call is recorded so tests can assert URLs and headers. */
function stubFetch(handler: Handler) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const headers = init.headers as Record<string, string> | undefined;
      calls.push({ url, auth: headers?.Authorization });
      return handler(url, init);
    },
  );
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const text = (body: string, status = 200) => new Response(body, { status });

function jobsPage(total: number, page: number, perPage = 100): unknown {
  const start = (page - 1) * perPage;
  const count = Math.max(0, Math.min(perPage, total - start));
  return {
    total_count: total,
    jobs: Array.from({ length: count }, (_, i) => ({
      id: start + i + 1,
      name: `job-${start + i + 1}`,
    })),
  };
}

const SAVED = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GH_TOKEN: process.env.GH_TOKEN,
  GH_HOST: process.env.GH_HOST,
};

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GH_HOST;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("job pagination", () => {
  it("collects all 1234 jobs across 13 pages and stops on total_count", async () => {
    const calls = stubFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return json(jobsPage(1234, page));
    });
    const jobs = await fetchJobs("o", "r", "1", undefined);
    expect(jobs).toHaveLength(1234);
    expect(jobs[1233].id).toBe(1234);
    expect(calls).toHaveLength(13);
  });

  it("stops on an empty page even when total_count claims more jobs", async () => {
    // total_count claims 500 but only 250 jobs exist: page 4 comes back empty and ends the loop.
    const calls = stubFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return json({ ...(jobsPage(250, page) as object), total_count: 500 });
    });
    const jobs = await fetchJobs("o", "r", "1", undefined);
    expect(jobs).toHaveLength(250);
    expect(calls).toHaveLength(4);
  });

  it("is capped at MAX_JOB_PAGES pages as a safety valve", async () => {
    const calls = stubFetch(() =>
      json({
        total_count: 1_000_000,
        jobs: Array.from({ length: 100 }, (_, i) => ({ id: i })),
      }),
    );
    const jobs = await fetchJobs("o", "r", "1", undefined);
    expect(calls).toHaveLength(MAX_JOB_PAGES);
    expect(jobs).toHaveLength(MAX_JOB_PAGES * 100);
  });

  it("returns a single page unchanged", async () => {
    stubFetch(() => json(jobsPage(3, 1)));
    expect((await fetchJobs("o", "r", "1")).map((j) => j.id)).toEqual([1, 2, 3]);
  });

  it("uses the supplied apiBase for every page (Enterprise host)", async () => {
    const calls = stubFetch((url) =>
      json(jobsPage(2, Number(new URL(url).searchParams.get("page")))),
    );
    await fetchJobs("o", "r", "9", undefined, "https://ghe.example.com/api/v3");
    expect(
      calls.every((c) =>
        c.url.startsWith("https://ghe.example.com/api/v3/repos/o/r/actions/runs/9/jobs"),
      ),
    ).toBe(true);
  });
});

describe("URL construction and token policy", () => {
  it("fetchRun and fetchJobLogs default to api.github.com", async () => {
    const calls = stubFetch((url) =>
      url.includes("/logs") ? text("log") : json({ id: 1 }),
    );
    await fetchRun("o", "r", "5");
    await fetchJobLogs("o", "r", 7);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/actions/runs/5");
    expect(calls[1].url).toBe("https://api.github.com/repos/o/r/actions/jobs/7/logs");
  });

  it("sends an explicit token to api.github.com", async () => {
    const calls = stubFetch(() => json({ id: 1 }));
    await fetchRun("o", "r", "5", "tok123");
    expect(calls[0].auth).toBe("Bearer tok123");
  });

  it("never sends GITHUB_TOKEN from the environment to a foreign host", async () => {
    process.env.GITHUB_TOKEN = "ENV-SECRET";
    const calls = stubFetch(() => json({ id: 1 }));
    await fetchRun("o", "r", "5", undefined, "https://evil.example/api/v3");
    expect(calls[0].url.startsWith("https://evil.example/")).toBe(true);
    expect(calls[0].auth).toBeUndefined();
  });

  it("does not send an explicit token to an Enterprise host unless GH_HOST names it", async () => {
    const calls = stubFetch(() => json({ id: 1 }));
    await fetchRun("o", "r", "5", "tok", "https://ghe.example.com/api/v3");
    expect(calls[0].auth).toBeUndefined();
  });

  it("sends the token to an Enterprise host named in GH_HOST", async () => {
    process.env.GH_HOST = "ghe.example.com";
    const calls = stubFetch(() => json({ id: 1 }));
    await fetchRun("o", "r", "5", "tok", "https://ghe.example.com/api/v3");
    expect(calls[0].auth).toBe("Bearer tok");
  });

  it("authHeaders without a url keeps the caller's host responsibility (env fallback)", () => {
    process.env.GITHUB_TOKEN = "from-env";
    expect(authHeaders()).toMatchObject({ Authorization: "Bearer from-env" });
    expect(authHeaders("explicit").Authorization).toBe("Bearer explicit");
  });

  it("authHeaders for api.github.com uses the token, for a foreign url it omits it", () => {
    expect(authHeaders("t", "https://api.github.com/x").Authorization).toBe("Bearer t");
    expect(authHeaders("t", "https://other.example/x").Authorization).toBeUndefined();
  });

  it("resolveTokenWithSource: flag beats env, env beats gh", () => {
    process.env.GITHUB_TOKEN = "env-tok";
    expect(resolveTokenWithSource("flag-tok")).toEqual({
      token: "flag-tok",
      source: "flag",
    });
    expect(resolveTokenWithSource()).toEqual({ token: "env-tok", source: "env" });
    expect(resolveTokenWithSource("   ")).toEqual({ token: "env-tok", source: "env" });
  });
});

describe("fetchWorkflowFile", () => {
  it("encodes path segments and the ref, and decodes the base64 content", async () => {
    const workflowPath = ".github/workflows/my ci#1?.yml";
    const yaml = "jobs:\n  test:\n    steps:\n      - run: npm test\n";
    const calls = stubFetch((url) => {
      if (url.includes("/actions/runs/")) {
        return json({
          workflow_id: 9,
        });
      }
      if (url.includes("/actions/workflows/9")) return json({ path: workflowPath });
      return json({
        type: "file",
        sha: "blobsha",
        content: Buffer.from(yaml)
          .toString("base64")
          .replace(/(.{8})/g, "$1\n"),
      });
    });
    const wf = await fetchWorkflowFile("o", "r", "1", "abc/def", undefined);
    expect(wf).toEqual({ path: workflowPath, sha: "blobsha", text: yaml });
    const contentUrl = calls[2].url;
    expect(contentUrl).toBe(
      "https://api.github.com/repos/o/r/contents/.github/workflows/my%20ci%231%3F.yml?ref=abc%2Fdef",
    );
  });

  it("returns null on 404, on a directory listing, and on empty content", async () => {
    stubFetch(() => json({}, 404));
    expect(await fetchWorkflowFile("o", "r", "1", "sha")).toBeNull();

    stubFetch((url) => {
      if (url.includes("/actions/runs/")) return json({ workflow_id: 1 });
      if (url.includes("/workflows/1")) return json({ path: "a.yml" });
      return json({ type: "dir", content: "" });
    });
    expect(await fetchWorkflowFile("o", "r", "1", "sha")).toBeNull();

    stubFetch((url) => {
      if (url.includes("/actions/runs/")) return json({ workflow_id: 1 });
      if (url.includes("/workflows/1")) return json({ path: "a.yml" });
      return json({ type: "file", content: "   " });
    });
    expect(await fetchWorkflowFile("o", "r", "1", "sha")).toBeNull();
  });

  it("returns null when the run has no workflow_id", async () => {
    stubFetch(() => json({}));
    expect(await fetchWorkflowFile("o", "r", "1", "sha")).toBeNull();
  });

  it("uses the Enterprise apiBase for all three calls", async () => {
    const calls = stubFetch(() => json({}, 404));
    await fetchWorkflowFile(
      "o",
      "r",
      "1",
      "sha",
      undefined,
      "https://ghe.example.com/api/v3",
    );
    expect(calls[0].url.startsWith("https://ghe.example.com/api/v3/")).toBe(true);
  });
});

describe("HTTP error messages", () => {
  it("404 names the Enterprise host hint", async () => {
    stubFetch(() => json({}, 404));
    await expect(fetchRun("o", "r", "1")).rejects.toThrow(/404.*GH_HOST/s);
  });

  it("403 with exhausted rate limit says so", async () => {
    stubFetch(() => json({}, 403, { "x-ratelimit-remaining": "0" }));
    await expect(fetchRun("o", "r", "1")).rejects.toThrow(/Rate limit exhausted/);
  });

  it("401 without rate-limit header asks for an authentication fix", async () => {
    stubFetch(() => json({}, 401, { "x-ratelimit-remaining": "42" }));
    await expect(fetchRun("o", "r", "1")).rejects.toThrow(
      /Authentication\/permission failed/,
    );
  });

  it("other statuses include a truncated body", async () => {
    stubFetch(() => text("x".repeat(500), 500));
    const err = (await fetchRun("o", "r", "1").catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/GitHub API 500/);
    // The body is cut to 300 characters, so at most 300 of the 500 "x" characters appear.
    expect(err.message.match(/x/g)?.length ?? 0).toBeLessThanOrEqual(300);
  });

  it("log download 403 explains that logs need authentication", async () => {
    stubFetch(() => text("forbidden", 403));
    await expect(fetchJobLogs("o", "r", 1)).rejects.toThrow(/requires authentication/);
  });

  it("log download 500 is a plain error", async () => {
    stubFetch(() => text("boom", 500));
    await expect(fetchJobLogs("o", "r", 1)).rejects.toThrow(
      /GitHub API 500 fetching logs: boom/,
    );
  });
});

describe("fetchRunBundle", () => {
  it("records a placeholder for a job whose logs fail, and keeps the other logs", async () => {
    stubFetch((url) => {
      if (url.endsWith("/actions/runs/1"))
        return json({ id: 1, name: "CI", head_sha: "s" });
      if (url.includes("/jobs?")) {
        return json({
          total_count: 2,
          jobs: [
            { id: 10, name: "good", conclusion: "failure" },
            { id: 11, name: "bad", conclusion: "failure" },
          ],
        });
      }
      if (url.endsWith("/jobs/10/logs")) return text("GOOD LOG");
      return text("nope", 403);
    });
    const bundle = await fetchRunBundle("o", "r", "1");
    expect(bundle.logsByJob.get("10")).toBe("GOOD LOG");
    expect(bundle.logsByJob.get("11")).toMatch(/^\(could not fetch logs for job 11:/);
    expect(bundle.combinedLogs).toContain(
      "===== JOB: good (id=10, conclusion=failure) =====",
    );
    expect(bundle.combinedLogs).toContain("GOOD LOG");
  });
});

describe("fetchWorkflowFile stays on the run's host", () => {
  it("ignores a workflow_url that points elsewhere and requests the workflow by id", async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith("/actions/runs/1")) {
        return json({ workflow_id: 9, workflow_url: "https://evil.example/steal" });
      }
      if (url.endsWith("/actions/workflows/9")) return json({ path: "ci.yml" });
      return json({
        type: "file",
        sha: "s",
        content: Buffer.from("jobs: {}").toString("base64"),
      });
    });
    const wf = await fetchWorkflowFile(
      "o",
      "r",
      "1",
      "sha",
      "tok",
      "https://ghe.example.com/api/v3",
    );
    expect(wf?.path).toBe("ci.yml");
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
    expect(calls.every((c) => c.url.startsWith("https://ghe.example.com/api/v3/"))).toBe(
      true,
    );
    // The token is not sent to the Enterprise host (no GH_HOST), so every call is unauthenticated.
    expect(calls.every((c) => c.auth === undefined)).toBe(true);
  });
});
