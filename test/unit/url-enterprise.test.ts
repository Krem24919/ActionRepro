import { describe, it, expect, afterEach } from "vitest";
import {
  apiBaseFor,
  isGitHubRunUrl,
  parseGitHubRunUrl,
  tokenAllowedFor,
} from "../../src/core/url.js";

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

describe("parseGitHubRunUrl: hosts and API base", () => {
  it("maps github.com to api.github.com", () => {
    expect(parseGitHubRunUrl("https://github.com/o/r/actions/runs/1")).toMatchObject({
      host: "github.com",
      apiBase: "https://api.github.com",
    });
  });

  it("maps api.github.com REST URLs back to github.com", () => {
    expect(parseGitHubRunUrl("https://api.github.com/repos/o/r/actions/runs/77")).toEqual(
      {
        owner: "o",
        repo: "r",
        runId: "77",
        host: "github.com",
        apiBase: "https://api.github.com",
      },
    );
  });

  it("accepts a GitHub Enterprise host and derives /api/v3", () => {
    expect(
      parseGitHubRunUrl("https://ghe.example.com/team/app/actions/runs/42/job/9"),
    ).toMatchObject({
      owner: "team",
      repo: "app",
      runId: "42",
      host: "ghe.example.com",
      apiBase: "https://ghe.example.com/api/v3",
    });
  });

  it("keeps a port on an Enterprise host", () => {
    const p = parseGitHubRunUrl("https://ghe.internal:8443/o/r/actions/runs/3");
    expect(p?.apiBase).toBe("https://ghe.internal:8443/api/v3");
  });

  it("lowercases the host", () => {
    expect(parseGitHubRunUrl("https://GHE.Example.COM/o/r/actions/runs/3")?.host).toBe(
      "ghe.example.com",
    );
  });

  it("strips a trailing .git from the repo name", () => {
    expect(parseGitHubRunUrl("https://github.com/o/repo.git/actions/runs/3")?.repo).toBe(
      "repo",
    );
  });

  it("accepts query strings and fragments", () => {
    expect(
      parseGitHubRunUrl("https://github.com/o/r/actions/runs/3?pr=4#step:1:2")?.runId,
    ).toBe("3");
  });

  it("rejects non-run pages on any host", () => {
    expect(parseGitHubRunUrl("https://ghe.example.com/o/r/pulls/1")).toBeNull();
    expect(parseGitHubRunUrl("https://ghe.example.com/o/r/actions")).toBeNull();
  });

  it("rejects dot segments and unsafe owner/repo characters", () => {
    expect(parseGitHubRunUrl("https://github.com/../r/actions/runs/1")).toBeNull();
    expect(parseGitHubRunUrl("https://github.com/o/../actions/runs/1")).toBeNull();
    expect(parseGitHubRunUrl("https://github.com/o%20x/r/actions/runs/1")).toBeNull();
  });

  it("rejects a non-numeric run id", () => {
    expect(parseGitHubRunUrl("https://github.com/o/r/actions/runs/abc")).toBeNull();
  });

  it("rejects a malformed host", () => {
    expect(parseGitHubRunUrl("https://ghe_bad!/o/r/actions/runs/1")).toBeNull();
  });

  it("isGitHubRunUrl agrees with the parser", () => {
    expect(isGitHubRunUrl("https://ghe.example.com/o/r/actions/runs/1")).toBe(true);
    expect(isGitHubRunUrl("./failure.log")).toBe(false);
  });
});

describe("apiBaseFor", () => {
  it("returns the public API for github.com and /api/v3 for others", () => {
    expect(apiBaseFor("github.com")).toBe("https://api.github.com");
    expect(apiBaseFor("GitHub.com")).toBe("https://api.github.com");
    expect(apiBaseFor("corp.example")).toBe("https://corp.example/api/v3");
  });
});

describe("tokenAllowedFor (token policy)", () => {
  it("always allows github.com", () => {
    expect(tokenAllowedFor("github.com", {})).toBe(true);
  });

  it("denies an Enterprise host when GH_HOST is unset", () => {
    expect(tokenAllowedFor("ghe.example.com", {})).toBe(false);
  });

  it("allows exactly the host named in GH_HOST", () => {
    expect(tokenAllowedFor("ghe.example.com", { GH_HOST: "ghe.example.com" })).toBe(true);
    expect(tokenAllowedFor("GHE.example.com", { GH_HOST: "ghe.example.com" })).toBe(true);
  });

  it("tolerates a scheme and trailing slash in GH_HOST", () => {
    expect(
      tokenAllowedFor("ghe.example.com", { GH_HOST: "https://ghe.example.com/" }),
    ).toBe(true);
  });

  it("denies a different host, a suffix-lookalike, and a prefix-lookalike", () => {
    const env = { GH_HOST: "ghe.example.com" };
    expect(tokenAllowedFor("evil.example", env)).toBe(false);
    expect(tokenAllowedFor("ghe.example.com.evil.example", env)).toBe(false);
    expect(tokenAllowedFor("evil-ghe.example.com", env)).toBe(false);
  });

  it("defaults to process.env when no env object is passed", () => {
    process.env.GH_HOST = "ghe.example.com";
    expect(tokenAllowedFor("ghe.example.com")).toBe(true);
    delete process.env.GH_HOST;
    expect(tokenAllowedFor("ghe.example.com")).toBe(false);
  });

  it("an empty GH_HOST allows nothing beyond github.com", () => {
    expect(tokenAllowedFor("ghe.example.com", { GH_HOST: "  " })).toBe(false);
  });
});
