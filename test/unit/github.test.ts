import { describe, it, expect, afterEach } from "vitest";
import { GitHubActionsProvider } from "../../src/providers/github-actions.js";
import {
  HTTP_TIMEOUT_MS,
  allLogsFailed,
  firstLogError,
  logFetchPlaceholder,
} from "../../src/core/github.js";

describe("GitHubActionsProvider.matches", () => {
  it("matches run URLs only", () => {
    const p = new GitHubActionsProvider();
    expect(p.matches("https://github.com/o/r/actions/runs/123")).toBe(true);
    expect(p.matches("./failure.log")).toBe(false);
  });
});

describe("HTTP timeout", () => {
  it("is a bounded, non-trivial timeout", () => {
    expect(HTTP_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(HTTP_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });
});

describe("log fetch placeholder protocol", () => {
  it("embeds only the job id, so a colon in a job name cannot corrupt the reason", () => {
    const placeholder = logFetchPlaceholder(42, "HTTP 403: forbidden");
    expect(placeholder).toBe("(could not fetch logs for job 42: HTTP 403: forbidden)");
    expect(firstLogError(new Map([["42", placeholder]]))).toBe("HTTP 403: forbidden");
  });

  it("recognizes all-failed and reports the first reason", () => {
    const logs = new Map([
      ["1", logFetchPlaceholder(1, "timeout")],
      ["2", logFetchPlaceholder(2, "token missing")],
    ]);
    expect(allLogsFailed(logs)).toBe(true);
    expect(firstLogError(logs)).toBe("timeout");
  });

  it("is not all-failed when at least one log downloaded", () => {
    const logs = new Map([
      ["1", logFetchPlaceholder(1, "timeout")],
      ["2", "real log output"],
    ]);
    expect(allLogsFailed(logs)).toBe(false);
  });

  it("treats an empty map as failed (nothing was fetched)", () => {
    expect(allLogsFailed(new Map())).toBe(true);
    expect(firstLogError(new Map())).toBe("unknown log fetch error");
  });
});

describe("GitHub requests carry a timeout", () => {
  const savedFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it("getJson passes an AbortSignal to fetch", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }) as typeof fetch;
    const { fetchRun } = await import("../../src/core/github.js");
    await fetchRun("o", "r", "1");
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
  });
});
