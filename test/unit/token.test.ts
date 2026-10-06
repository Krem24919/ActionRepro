import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveToken, resolveTokenWithSource } from "../../src/core/github.js";

const SAVED: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Create a stub `gh` executable from raw shell body lines. Returns its dir. */
function stubGh(lines: string[], exitCode = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-gh-"));
  const gh = path.join(dir, "gh");
  fs.writeFileSync(gh, `#!/bin/sh\n${lines.join("\n")}\nexit ${exitCode}\n`);
  fs.chmodSync(gh, 0o755);
  return dir;
}

function withPath(dir: string): void {
  setEnv({ PATH: `${dir}${path.delimiter}${SAVED.PATH ?? ""}` });
}

beforeEach(() => {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "PATH"]) SAVED[k] = process.env[k];
  setEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined });
});

afterEach(() => {
  setEnv(SAVED);
});

describe("resolveToken", () => {
  it("prefers the explicit flag over everything", () => {
    setEnv({ GITHUB_TOKEN: "env-token-1" });
    expect(resolveToken("flag-token")).toBe("flag-token");
    expect(resolveTokenWithSource("flag-token")).toMatchObject({ source: "flag" });
  });

  it("uses GITHUB_TOKEN then GH_TOKEN from env", () => {
    setEnv({ GITHUB_TOKEN: "env-token-1", GH_TOKEN: "env-token-2" });
    expect(resolveTokenWithSource()).toMatchObject({
      token: "env-token-1",
      source: "env",
    });
    setEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: "env-token-2" });
    expect(resolveTokenWithSource()).toMatchObject({
      token: "env-token-2",
      source: "env",
    });
  });

  it("falls back to the gh CLI when no env token exists", () => {
    const dir = stubGh(["printf '%s' 'ghp_faketoken123'"]);
    withPath(dir);
    expect(resolveTokenWithSource()).toMatchObject({
      token: "ghp_faketoken123",
      source: "gh",
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores gh failures", () => {
    const dir = stubGh(["printf '%s' 'x'"], 1);
    withPath(dir);
    expect(resolveTokenWithSource()).toMatchObject({ source: "none" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects multiline gh output", () => {
    const dir = stubGh(["printf 'line1\\nline2\\n'"]);
    withPath(dir);
    expect(resolveToken()).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns none when gh is not on PATH", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-empty-"));
    setEnv({ PATH: empty });
    expect(resolveTokenWithSource()).toMatchObject({ source: "none" });
    expect(resolveToken()).toBeUndefined();
    setEnv({ PATH: SAVED.PATH });
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
