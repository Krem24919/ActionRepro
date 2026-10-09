import { describe, it, expect, afterEach, vi } from "vitest";
import { error, info, sanitizeActionsOutput, warn } from "../../src/utils/log.js";
import { listCwdFiles, ensureDir } from "../../src/utils/fs.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as api from "../../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("utils/log", () => {
  it("info writes to stdout via console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    info("hello");
    expect(spy).toHaveBeenCalledWith("hello");
  });

  it("warn prefixes 'warning:' and writes to console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn("careful");
    expect(spy).toHaveBeenCalledWith("warning: careful");
  });

  it("error prefixes 'error:' and writes to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    error("broken");
    expect(spy).toHaveBeenCalledWith("error: broken");
  });

  it("sanitizeActionsOutput neutralises every ##[ marker and leaves the rest alone", () => {
    expect(sanitizeActionsOutput("##[error]boom")).toBe("## [error]boom");
    expect(sanitizeActionsOutput("a ##[group]b ##[endgroup]")).toBe(
      "a ## [group]b ## [endgroup]",
    );
    expect(sanitizeActionsOutput("plain :: text")).toBe("plain :: text");
  });

  it("sanitizeActionsOutput is deterministic", () => {
    const s = "##[warning]x";
    expect(sanitizeActionsOutput(sanitizeActionsOutput(s))).toBe(
      sanitizeActionsOutput(s),
    );
  });
});

describe("utils/fs", () => {
  it("ensureDir creates nested directories and is idempotent", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-fs-"));
    const nested = path.join(base, "a", "b");
    ensureDir(nested);
    ensureDir(nested);
    expect(fs.statSync(nested).isDirectory()).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("listCwdFiles returns entries of the current directory", () => {
    expect(listCwdFiles()).toContain("package.json");
  });
});

describe("public API (src/index.ts)", () => {
  it("exports the documented entry points", () => {
    for (const name of [
      "inspectTarget",
      "reproduceTarget",
      "verifyBundle",
      "doctor",
      "parseGitHubRunUrl",
      "redactText",
      "detectEcosystem",
      "detectRuntime",
      "createBundle",
      "findProvider",
      "resolveProviderToken",
      "fingerprintFailure",
      "hashBundleFiles",
      "lookupHistory",
      "proveFix",
      "McpServer",
      "runMcpStdio",
      "MCP_TOOLS",
      "VERSION",
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });

  it("exports VERSION matching package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );
    expect(api.VERSION).toBe(pkg.version);
  });
});
