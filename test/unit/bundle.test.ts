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
});
