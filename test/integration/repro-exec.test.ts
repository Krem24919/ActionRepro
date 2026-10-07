import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBundle } from "../../src/core/bundle.js";
import { fingerprintFailure } from "../../src/core/fingerprint.js";
import type { BundleInput } from "../../src/core/bundle.js";

let tmp = "";
let stubBin = "";

function bundleInput(reproCommand: string, summary = "Failure: boom"): BundleInput {
  const failure = {
    summary,
    errorLines: ["boom"],
    reproCommand,
    hint: "h",
    matched: true,
    anchor: "boom",
  };
  return {
    sourceDisplay: "fixtures/logs/x.log",
    ecosystem: {
      id: "npm",
      confidence: "high",
      evidence: ["t"],
      installCommand: "npm ci",
      testCommand: "npm test",
      runHint: "h",
    },
    runtime: {},
    failure,
    redactedLogs: "boom",
    redactions: 0,
    fingerprint: fingerprintFailure({
      ecosystem: "npm",
      reproCommand,
      errorLines: failure.errorLines,
    }),
  };
}

function writeStub(installRc: number, testRc: number): void {
  stubBin = path.join(tmp, "stubbin");
  fs.mkdirSync(stubBin, { recursive: true });
  const npm = path.join(stubBin, "npm");
  fs.writeFileSync(
    npm,
    `#!/bin/sh\nif [ "$1" = "ci" ]; then exit ${installRc}; else exit ${testRc}; fi\n`,
  );
  fs.chmodSync(npm, 0o755);
  fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}\n");
}

function runScript(
  outDir: string,
  extraEnv: Record<string, string> = {},
): { status: number; out: string } {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.CI_REPRO_YES;
  Object.assign(env, extraEnv);
  try {
    const out = execFileSync("bash", [path.join(outDir, "reproduce.sh")], {
      cwd: tmp,
      timeout: 30000,
      encoding: "utf8",
      env: {
        ...env,
        PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    return { status: 0, out: String(out) };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      status: err.status ?? 99,
      out: `${String(err.stdout ?? "")}\n${String(err.stderr ?? "")}`,
    };
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-exec-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("generated reproduce.sh execution", () => {
  const YES = { CI_REPRO_YES: "1" };

  it("passes the repro command exit code through with REPRODUCED marker", () => {
    writeStub(0, 1);
    const outDir = path.join(tmp, "b");
    createBundle(bundleInput("npm test"), outDir);
    const r = runScript(outDir, YES);
    expect(r.status).toBe(1);
    expect(r.out).toContain("REPRODUCED");
    expect(r.out).toContain("dependencies ready");
  });

  it("reports exit 0 as NOT REPRODUCED (never claims a false success)", () => {
    writeStub(0, 0);
    const outDir = path.join(tmp, "b");
    createBundle(bundleInput("npm test"), outDir);
    const r = runScript(outDir, YES);
    expect(r.status).toBe(0);
    expect(r.out).toContain("NOT REPRODUCED");
  });

  it("reports install failure as exit 3 with INSTALL_FAILED (not a repro)", () => {
    writeStub(1, 0);
    const outDir = path.join(tmp, "b");
    createBundle(bundleInput("npm test"), outDir);
    const r = runScript(outDir, YES);
    expect(r.status).toBe(3);
    expect(r.out).toContain("INSTALL_FAILED");
    expect(r.out).toContain("NOT a reproduction");
    expect(r.out).not.toContain("REPRODUCED:");
  });

  it("does not execute substitutions hidden in metadata", () => {
    writeStub(0, 0);
    const marker = path.join(tmp, "PWNED_MARKER");
    const outDir = path.join(tmp, "b");
    createBundle(
      bundleInput("npm test", `x $(touch ${marker}) \`touch ${marker}.2\``),
      outDir,
    );
    const r = runScript(outDir, YES);
    expect(r.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(`${marker}.2`)).toBe(false);
  });

  it("runs without prompting when stdin is not a TTY", () => {
    writeStub(0, 0);
    const outDir = path.join(tmp, "b");
    createBundle(bundleInput("npm test"), outDir);
    const r = runScript(outDir); // no TTY here and no CI_REPRO_YES: must not hang
    expect(r.out).not.toContain("Run it now?");
    expect(r.status).toBe(0);
  });
});
