import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactText } from "../../src/core/redact.js";
import { extractFailure } from "../../src/core/extract.js";
import { detectEcosystem } from "../../src/core/ecosystems.js";
import { detectRuntime } from "../../src/core/runtime.js";
import { createBundle } from "../../src/core/bundle.js";
import { fingerprintFailure } from "../../src/core/fingerprint.js";

const fx = (n: string) =>
  fs.readFileSync(path.join(process.cwd(), "fixtures/logs", n), "utf8");

describe("createBundle", () => {
  it("creates all required files with redaction", () => {
    const raw = fx("secrets.log");
    const red = redactText(raw);
    const lines = red.text.split("\n");
    const failure = extractFailure(lines);
    const eco = detectEcosystem(lines);
    const runtime = detectRuntime(lines);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-bundle-"));
    const res = createBundle(
      {
        sourceDisplay: "fixtures/logs/secrets.log",
        ecosystem: eco,
        runtime,
        failure,
        redactedLogs: red.text,
        redactions: red.redactions,
        fingerprint: fingerprintFailure({
          ecosystem: eco.id,
          reproCommand: failure.reproCommand,
          exitCode: failure.exitCode,
          errorLines: failure.errorLines,
        }),
      },
      out,
    );
    const names = res.files.map((f) => path.basename(f));
    expect(names).toContain("reproduce.sh");
    expect(names).toContain("README.md");
    expect(names).toContain("failure.txt");
    expect(names).toContain("environment.txt");
    // No credential leaks in any file.
    for (const f of res.files) {
      const content = fs.readFileSync(f, "utf8");
      expect(content).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
      expect(content).not.toContain("hunter2-secret-value");
      expect(content).not.toContain("MIIEpAIBAAKCAQEA7b");
    }
    const sh = fs.readFileSync(path.join(out, "reproduce.sh"), "utf8");
    expect(sh.startsWith("#!/usr/bin/env bash")).toBe(true);
    const readme = fs.readFileSync(path.join(out, "README.md"), "utf8");
    // Run-first layout: usage comes before source details and file list.
    expect(readme.indexOf("## Run this first")).toBeLessThan(readme.indexOf("## Source"));
    expect(readme.indexOf("## Source")).toBeLessThan(readme.indexOf("## Files"));
    // Bundle identity: sha file exists, repro.json carries the fingerprint.
    expect(names).toContain("bundle.sha256");
    const sha = fs.readFileSync(path.join(out, "bundle.sha256"), "utf8");
    expect(sha).toMatch(/^[0-9a-f]{64}$/m);
    const meta = JSON.parse(fs.readFileSync(path.join(out, "repro.json"), "utf8")) as {
      fingerprint?: string;
      bundleSha256?: string;
    };
    expect(meta.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(meta.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("npm bundle contains npm ci + npm test", () => {
    const raw = fx("npm-fail.log");
    const red = redactText(raw);
    const lines = red.text.split("\n");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-npm-"));
    createBundle(
      {
        sourceDisplay: "npm",
        ecosystem: detectEcosystem(lines),
        runtime: detectRuntime(lines),
        failure: extractFailure(lines),
        redactedLogs: red.text,
        redactions: red.redactions,
        fingerprint: "test-fingerprint",
      },
      out,
    );
    const sh = fs.readFileSync(path.join(out, "reproduce.sh"), "utf8");
    expect(sh).toMatch(/npm/);
    expect(sh).toMatch(/npm test/);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("points at act with the exact job when known, stays silent otherwise", () => {
    const raw = fx("npm-fail.log");
    const red = redactText(raw);
    const lines = red.text.split("\n");
    const base = {
      sourceDisplay: "npm",
      ecosystem: detectEcosystem(lines),
      runtime: detectRuntime(lines),
      failure: extractFailure(lines),
      redactedLogs: red.text,
      redactions: red.redactions,
      fingerprint: "test-fingerprint",
    };
    const withJob = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-act-"));
    createBundle({ ...base, runMeta: { job: "test (20.x)" } }, withJob);
    const readme = fs.readFileSync(path.join(withJob, "README.md"), "utf8");
    expect(readme).toContain("act -j 'test (20.x)'");
    expect(readme).toContain("nektos/act");
    // A hostile job name must paste literally: single-quoted, never executed.
    const hostile = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-actx-"));
    createBundle({ ...base, runMeta: { job: "evil$(touch pwned)`id`!ok" } }, hostile);
    const hostileReadme = fs.readFileSync(path.join(hostile, "README.md"), "utf8");
    const hint = hostileReadme.split("\n").find((l) => l.startsWith("act -j "));
    expect(hint).toBe("act -j 'evil$(touch pwned)`id`'\\!'ok'");
    // Embedded single quotes are closed, escaped, and reopened.
    const quoted = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-actq-"));
    createBundle({ ...base, runMeta: { job: "it's" } }, quoted);
    const quotedReadme = fs.readFileSync(path.join(quoted, "README.md"), "utf8");
    expect(quotedReadme.split("\n").find((l) => l.startsWith("act -j "))).toBe(
      "act -j 'it'\\''s'",
    );
    // Newlines collapse: a broken hint line would execute its tail on paste.
    const nlJob = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-actn-"));
    createBundle(
      { ...base, runMeta: { job: `a${String.fromCharCode(10)}touch pwned` } },
      nlJob,
    );
    const nlReadme = fs.readFileSync(path.join(nlJob, "README.md"), "utf8");
    expect(nlReadme.split("\n").find((l) => l.startsWith("act -j "))).toBe(
      "act -j 'a touch pwned'",
    );
    fs.rmSync(nlJob, { recursive: true, force: true });
    fs.rmSync(hostile, { recursive: true, force: true });
    fs.rmSync(quoted, { recursive: true, force: true });
    const noJob = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-noact-"));
    createBundle(base, noJob);
    expect(fs.readFileSync(path.join(noJob, "README.md"), "utf8")).not.toContain(
      "act -j",
    );
    fs.rmSync(withJob, { recursive: true, force: true });
    fs.rmSync(noJob, { recursive: true, force: true });
  });
});

describe("sourceDisplay sanitization (H1: newline breakout)", () => {
  it("collapses newlines so metadata cannot add executable script lines", () => {
    const NL = String.fromCharCode(10);
    const raw = fx("npm-fail.log");
    const red = redactText(raw);
    const lines = red.text.split("\n");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-h1unit-"));
    try {
      createBundle(
        {
          sourceDisplay: `evil${NL}touch h1-pwned${NL}.log`,
          ecosystem: detectEcosystem(lines),
          runtime: detectRuntime(lines),
          failure: extractFailure(lines),
          redactedLogs: red.text,
          redactions: red.redactions,
          fingerprint: "test-fingerprint",
        },
        out,
      );
      for (const name of ["reproduce.sh", "reproduce.ps1"]) {
        const text = fs.readFileSync(path.join(out, name), "utf8");
        expect(
          text.split("\n").some((l) => l.trim() === "touch h1-pwned"),
          name,
        ).toBe(false);
      }
      const sh = fs.readFileSync(path.join(out, "reproduce.sh"), "utf8");
      const src = sh.split("\n").find((l) => l.startsWith("# Source:"));
      expect(src).toBeDefined();
      // Collapsed onto one inert comment line (still informative, unexecutable).
      expect(src).toContain("evil");
      expect(src).toContain(".log");
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
