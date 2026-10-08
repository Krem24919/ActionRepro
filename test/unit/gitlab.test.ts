import { describe, it, expect, afterEach } from "vitest";
import {
  GitLabProvider,
  mapGitLabStatus,
  parseGitLabUrl,
  resolveGitLabToken,
} from "../../src/providers/gitlab.js";
import { findProvider, resolveProviderToken } from "../../src/providers/registry.js";
import { allLogsFailed, firstLogError } from "../../src/core/github.js";

const ENV_KEY = "GITLAB_TOKEN";
const savedEnv = process.env[ENV_KEY];
const savedFetch = globalThis.fetch;

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  globalThis.fetch = savedFetch;
});

type Handler = (url: string, init?: RequestInit) => unknown;

function stubFetch(handler: Handler): {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return handler(String(url), init as RequestInit);
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  } as Response;
}

const PIPELINE = {
  id: 77,
  sha: "abc123def",
  ref: "main",
  status: "failed",
  web_url: "https://gitlab.com/g/sub/r/-/pipelines/77",
  created_at: "2026-10-01T00:00:00.000Z",
};
const JOBS = [
  { id: 1, name: "lint", status: "success", web_url: "https://gitlab.com/x/-/jobs/1" },
  { id: 2, name: "test", status: "failed", web_url: "https://gitlab.com/x/-/jobs/2" },
];

function pipelineHandler(): Handler {
  return (url: string) => {
    if (url.endsWith("/pipelines/77")) return jsonResponse(PIPELINE);
    if (url.includes("/pipelines/77/jobs")) return jsonResponse(JOBS);
    if (url.endsWith("/jobs/1/trace")) return jsonResponse("lint ok\n");
    if (url.endsWith("/jobs/2/trace")) return jsonResponse("FAIL: boom\n");
    throw new Error(`unexpected URL: ${url}`);
  };
}

describe("parseGitLabUrl", () => {
  it("parses pipeline and job URLs incl. subgroups and self-hosted hosts", () => {
    expect(parseGitLabUrl("https://gitlab.com/g/r/-/pipelines/77")).toEqual({
      base: "https://gitlab.com",
      project: "g%2Fr",
      kind: "pipeline",
      id: "77",
    });
    expect(parseGitLabUrl("https://gitlab.com/g/sub/r/-/jobs/9")).toMatchObject({
      project: "g%2Fsub%2Fr",
      kind: "job",
      id: "9",
    });
    expect(parseGitLabUrl("https://git.example.com/a/b/-/pipelines/3/")).toMatchObject({
      base: "https://git.example.com",
      id: "3",
    });
  });

  it("rejects non-pipeline URLs", () => {
    expect(parseGitLabUrl("https://github.com/o/r/actions/runs/1")).toBeNull();
    expect(parseGitLabUrl("https://gitlab.com/g/r")).toBeNull();
    expect(parseGitLabUrl("./failure.log")).toBeNull();
    expect(parseGitLabUrl("")).toBeNull();
  });
});

describe("mapGitLabStatus + resolveGitLabToken", () => {
  it("normalizes statuses to the shared vocabulary", () => {
    expect(mapGitLabStatus("failed")).toBe("failure");
    expect(mapGitLabStatus("success")).toBe("success");
    expect(mapGitLabStatus("canceled")).toBe("cancelled");
    expect(mapGitLabStatus("running")).toBe("running");
    expect(mapGitLabStatus(undefined)).toBeUndefined();
  });

  it("prefers explicit token, then env", () => {
    delete process.env[ENV_KEY];
    expect(resolveGitLabToken()).toBeUndefined();
    process.env[ENV_KEY] = "env-token";
    expect(resolveGitLabToken()).toBe("env-token");
    expect(resolveGitLabToken("flag-token")).toBe("flag-token");
  });
});

describe("GitLabProvider", () => {
  it("matches GitLab URLs only", () => {
    const p = new GitLabProvider();
    expect(p.id).toBe("gitlab");
    expect(p.matches("https://gitlab.com/g/r/-/pipelines/77")).toBe(true);
    expect(p.matches("https://github.com/o/r/actions/runs/1")).toBe(false);
    expect(p.matches("./failure.log")).toBe(false);
  });

  it("fetches a pipeline: metadata, mapped jobs, concatenated traces", async () => {
    const { calls } = stubFetch(pipelineHandler());
    const r = await new GitLabProvider().fetch(
      "https://gitlab.com/g/sub/r/-/pipelines/77",
      {},
    );
    expect(r.run.id).toBe(77);
    expect(r.run.headSha).toBe("abc123def");
    expect(r.run.headBranch).toBe("main");
    expect(r.run.conclusion).toBe("failure");
    expect(r.jobs.map((j) => [j.name, j.conclusion])).toEqual([
      ["lint", "success"],
      ["test", "failure"],
    ]);
    expect(r.logsByJob.get("1")).toContain("lint ok");
    expect(r.logsByJob.get("2")).toContain("FAIL: boom");
    expect(r.combinedLogs).toContain("job: test");
    // No token configured: no auth header sent.
    expect(
      calls.every(
        (c) => !((c.init?.headers ?? {}) as Record<string, string>)["PRIVATE-TOKEN"],
      ),
    ).toBe(true);
  });

  it("resolves job URLs through their pipeline and sends the token", async () => {
    const { calls } = stubFetch((url: string) => {
      if (url.endsWith("/jobs/2")) {
        return jsonResponse({
          id: 2,
          name: "test",
          status: "failed",
          pipeline: { id: 77 },
        });
      }
      return pipelineHandler()(url);
    });
    const r = await new GitLabProvider().fetch("https://gitlab.com/g/r/-/jobs/2", {
      token: "secret-token",
    });
    expect(r.run.id).toBe(77);
    expect(r.jobs).toHaveLength(2);
    const authCalls = calls.filter(
      (c) =>
        ((c.init?.headers ?? {}) as Record<string, string>)["PRIVATE-TOKEN"] ===
        "secret-token",
    );
    expect(authCalls.length).toBeGreaterThan(0);
  });
  it("reports auth and missing failures with actionable errors", async () => {
    stubFetch(() => jsonResponse({ message: "401" }, 401));
    await expect(
      new GitLabProvider().fetch("https://gitlab.com/g/r/-/pipelines/1", {}),
    ).rejects.toThrow(/GITLAB_TOKEN/);
    stubFetch(() => jsonResponse({ message: "404" }, 404));
    await expect(
      new GitLabProvider().fetch("https://gitlab.com/g/r/-/pipelines/1", {}),
    ).rejects.toThrow(/404/);
  });

  it("marks undownloadable traces with the shared fetch-failure protocol", async () => {
    stubFetch((url: string) => {
      if (url.endsWith("/pipelines/77")) return jsonResponse(PIPELINE);
      if (url.includes("/pipelines/77/jobs")) return jsonResponse(JOBS);
      return jsonResponse({ message: "no trace" }, 404);
    });
    const r = await new GitLabProvider().fetch(
      "https://gitlab.com/g/r/-/pipelines/77",
      {},
    );
    expect(allLogsFailed(r.logsByJob)).toBe(true);
    expect(firstLogError(r.logsByJob)).toMatch(/HTTP 404/);
  });
});

describe("provider registry", () => {
  it("dispatches github vs gitlab vs unknown", () => {
    expect(findProvider("https://github.com/o/r/actions/runs/1")?.id).toBe(
      "github-actions",
    );
    expect(findProvider("https://gitlab.com/g/r/-/pipelines/1")?.id).toBe("gitlab");
    expect(findProvider("./failure.log")).toBeUndefined();
  });

  it("resolves tokens per provider without touching the other source", () => {
    delete process.env[ENV_KEY];
    expect(resolveProviderToken("gitlab", "flag")).toBe("flag");
    process.env[ENV_KEY] = "gl-token";
    expect(resolveProviderToken("gitlab")).toBe("gl-token");
  });
});
