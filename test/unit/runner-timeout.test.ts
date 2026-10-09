import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  EXIT_TIMEOUT,
  resolveRunTimeoutMs,
  runReproduceScript,
} from "../../src/core/runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function bundleWith(sh: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-timeout-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "reproduce.sh"), `#!/bin/sh\n${sh}\n`);
  return dir;
}

describe("resolveRunTimeoutMs", () => {
  it("defaults to 30 minutes", () => {
    expect(resolveRunTimeoutMs({}, {})).toBe(DEFAULT_RUN_TIMEOUT_MS);
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it("an explicit option beats the environment variable", () => {
    expect(
      resolveRunTimeoutMs({ timeoutMs: 5000 }, { ACTIONREPRO_TIMEOUT_MS: "100" }),
    ).toBe(5000);
  });

  it("reads ACTIONREPRO_TIMEOUT_MS when no option is given", () => {
    expect(resolveRunTimeoutMs({}, { ACTIONREPRO_TIMEOUT_MS: "2500" })).toBe(2500);
  });

  it("0 disables the limit", () => {
    expect(resolveRunTimeoutMs({ timeoutMs: 0 }, {})).toBe(0);
    expect(resolveRunTimeoutMs({}, { ACTIONREPRO_TIMEOUT_MS: "0" })).toBe(0);
  });

  it.each(["abc", "-5", "NaN", "Infinity"])(
    "invalid env value %j falls back to the default",
    (raw) => {
      expect(resolveRunTimeoutMs({}, { ACTIONREPRO_TIMEOUT_MS: raw })).toBe(
        DEFAULT_RUN_TIMEOUT_MS,
      );
    },
  );

  it("a blank env value falls back to the default", () => {
    expect(resolveRunTimeoutMs({}, { ACTIONREPRO_TIMEOUT_MS: "   " })).toBe(
      DEFAULT_RUN_TIMEOUT_MS,
    );
  });

  it("fractions are floored and negative explicit values clamp to 0", () => {
    expect(resolveRunTimeoutMs({ timeoutMs: 1234.9 }, {})).toBe(1234);
    expect(resolveRunTimeoutMs({ timeoutMs: -3 }, {})).toBe(0);
  });
});

describe("runReproduceScript time limit", () => {
  it("stops a hanging script and returns EXIT_TIMEOUT (124)", () => {
    const dir = bundleWith("sleep 30");
    const started = Date.now();
    const code = runReproduceScript(dir, { timeoutMs: 400 });
    expect(code).toBe(EXIT_TIMEOUT);
    expect(EXIT_TIMEOUT).toBe(124);
    expect(Date.now() - started).toBeLessThan(15000);
  }, 30000);

  it("still creates the capture file when the run is stopped", () => {
    const dir = bundleWith("sleep 30");
    const out = path.join(dir, "run.log");
    runReproduceScript(dir, { timeoutMs: 300, outputFile: out });
    // The capture file is opened before the run, so a stopped run still leaves it behind.
    expect(fs.existsSync(out)).toBe(true);
  }, 30000);

  it("a fast script is not affected by the limit", () => {
    const dir = bundleWith("echo fine; exit 7");
    expect(runReproduceScript(dir, { timeoutMs: 20000 })).toBe(7);
  });

  it("timeoutMs 0 runs without a limit", () => {
    const dir = bundleWith("exit 0");
    expect(runReproduceScript(dir, { timeoutMs: 0 })).toBe(0);
  });

  it("throws a clear error when the script is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-noscript-"));
    dirs.push(dir);
    expect(() => runReproduceScript(dir, { timeoutMs: 1000 })).toThrow(
      /Reproduce script not found/,
    );
  });
});
