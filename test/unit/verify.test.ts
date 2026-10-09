import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyBundle } from "../../src/commands/verify.js";
import { FINGERPRINT_ALGO, fingerprintFailure } from "../../src/core/fingerprint.js";
import { extractFailure } from "../../src/core/extract.js";

/**
 * Verdict contract: REPRODUCED = same failure again, NOT_REPRODUCED = the fresh
 * log shows no failure at all, INCONCLUSIVE = anything we cannot compare
 * honestly. A non-zero exit with no diagnostic must never read as "fixed".
 */
let tmp = "";
let bundle = "";

function writeBundle(meta: Record<string, unknown>): void {
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, "repro.json"), JSON.stringify(meta));
}

/**
 * Record the bundle the way `reproduce` does: fingerprint the CI log's own
 * failure. A `npm ERR! code ELIFECYCLE` line is only a restatement, so the CI
 * log carries a real diagnostic (an AssertionError) as the anchor.
 */
const CI_LOG = [
  "> demo@1.0.0 test",
  "AssertionError: expected 3 to equal 4",
  "npm ERR! code ELIFECYCLE",
  "Process completed with exit code 1.",
];

function recordedMeta(): Record<string, unknown> {
  const f = extractFailure(CI_LOG);
  const fingerprint = fingerprintFailure({
    ecosystem: "npm",
    reproCommand: "npm test",
    exitCode: f.exitCode,
    anchor: f.anchor,
    errorKind: f.errorKind,
  });
  return {
    fingerprint,
    fingerprintVersion: FINGERPRINT_ALGO,
    ecosystem: "npm",
    failure: { summary: f.summary, reproCommand: "npm test", exitCode: f.exitCode },
  };
}

function writeLog(name: string, text: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-verify-"));
  bundle = path.join(tmp, "bundle");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("verifyBundle verdicts", () => {
  it("INCONCLUSIVE when the fresh log exits non-zero with no diagnostic", async () => {
    writeBundle(recordedMeta());
    const log = writeLog(
      "fresh.log",
      "building...\nProcess completed with exit code 7.\n",
    );
    const r = await verifyBundle({ bundleDir: bundle, logFile: log });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.freshExitCode).toBe(7);
    expect(r.reason).toMatch(/no recognizable failure diagnostic/);
  });

  it("NOT_REPRODUCED when the fresh log is clean (exit 0, no failure text)", async () => {
    writeBundle(recordedMeta());
    const log = writeLog(
      "ok.log",
      "added 1 package in 0.2s\nProcess completed with exit code 0.\n",
    );
    const r = await verifyBundle({ bundleDir: bundle, logFile: log });
    expect(r.verdict).toBe("NOT_REPRODUCED");
  });

  it("INCONCLUSIVE for an empty fresh log", async () => {
    writeBundle(recordedMeta());
    const log = writeLog("empty.log", "   \n");
    expect((await verifyBundle({ bundleDir: bundle, logFile: log })).verdict).toBe(
      "INCONCLUSIVE",
    );
  });

  it("INCONCLUSIVE when the bundle has no fingerprint", async () => {
    writeBundle({ failure: {} });
    const log = writeLog("x.log", "npm ERR! code ELIFECYCLE\n");
    expect((await verifyBundle({ bundleDir: bundle, logFile: log })).verdict).toBe(
      "INCONCLUSIVE",
    );
  });

  it("INCONCLUSIVE when the fingerprint algorithm version differs", async () => {
    writeBundle({ ...recordedMeta(), fingerprintVersion: "sha256-v1" });
    const log = writeLog("x.log", "npm ERR! code ELIFECYCLE\n");
    const r = await verifyBundle({ bundleDir: bundle, logFile: log });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toMatch(/Re-create the bundle/);
  });

  it("INCONCLUSIVE when the fresh log file does not exist", async () => {
    writeBundle(recordedMeta());
    const r = await verifyBundle({
      bundleDir: bundle,
      logFile: path.join(tmp, "missing.log"),
    });
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("throws a clear error when repro.json is missing", async () => {
    fs.mkdirSync(bundle, { recursive: true });
    await expect(
      verifyBundle({ bundleDir: bundle, logFile: writeLog("x.log", "boom\n") }),
    ).rejects.toThrow(/missing or not valid JSON/);
  });

  it("REPRODUCED when the same failure appears in the fresh log", async () => {
    writeBundle(recordedMeta());
    const log = writeLog("same.log", CI_LOG.join("\n"));
    const r = await verifyBundle({ bundleDir: bundle, logFile: log });
    expect(r.verdict).toBe("REPRODUCED");
  });
});
