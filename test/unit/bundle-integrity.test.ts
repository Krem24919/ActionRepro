import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBundle, type BundleInput } from "../../src/core/bundle.js";
import { detectEcosystem } from "../../src/core/ecosystems.js";
import { detectRuntime } from "../../src/core/runtime.js";
import { extractFailure } from "../../src/core/extract.js";
import { hashBundleFiles } from "../../src/core/fingerprint.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-integrity-"));
  dirs.push(d);
  return d;
};

const RAW_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LOG = [
  "##[group]Run npm test",
  `npm ERR! auth failed with token ${RAW_TOKEN}`,
  "npm ERR! Test failed.",
  "##[error]Process completed with exit code 1.",
];

/** Build a bundle input where the raw token reaches the builder (as it would in a library call). */
function inputWithRawToken(): BundleInput {
  const failure = extractFailure(LOG);
  return {
    sourceDisplay: "test.log",
    ecosystem: detectEcosystem(LOG, ["package.json"]),
    runtime: detectRuntime(LOG),
    failure: {
      ...failure,
      summary: `auth failed with ${RAW_TOKEN}`,
      errorLines: [...failure.errorLines, `token=${RAW_TOKEN}`],
    },
    redactedLogs: LOG.join("\n"),
    redactions: 0,
    fingerprint: "fp-test",
  };
}

describe("bundle integrity hash", () => {
  it("equals the hash of the files as they are on disk, even when a raw token reached the builder", () => {
    const out = tmp();
    createBundle(inputWithRawToken(), out);
    const names = ["reproduce.sh", "reproduce.ps1", "failure.txt", "environment.txt"];
    const onDisk = names.map((name) => ({
      name,
      content: fs.readFileSync(path.join(out, name), "utf8"),
    }));
    const meta = JSON.parse(fs.readFileSync(path.join(out, "repro.json"), "utf8"));
    expect(meta.bundleSha256).toBe(hashBundleFiles(onDisk));
  });

  it("the raw token is absent from every content file", () => {
    const out = tmp();
    createBundle(inputWithRawToken(), out);
    for (const name of [
      "reproduce.sh",
      "reproduce.ps1",
      "failure.txt",
      "environment.txt",
      "README.md",
    ]) {
      const p = path.join(out, name);
      if (fs.existsSync(p))
        expect(fs.readFileSync(p, "utf8"), name).not.toContain(RAW_TOKEN);
    }
  });

  it("bundle.sha256 records the same digest as repro.json", () => {
    const out = tmp();
    createBundle(inputWithRawToken(), out);
    const meta = JSON.parse(fs.readFileSync(path.join(out, "repro.json"), "utf8"));
    expect(fs.readFileSync(path.join(out, "bundle.sha256"), "utf8")).toContain(
      meta.bundleSha256,
    );
  });
});

describe("generated install block skips an existing node_modules", () => {
  it("POSIX script keeps node_modules unless ACTIONREPRO_REINSTALL is set", () => {
    const out = tmp();
    createBundle(inputWithRawToken(), out);
    const sh = fs.readFileSync(path.join(out, "reproduce.sh"), "utf8");
    expect(sh).toContain("[ -d node_modules ]");
    expect(sh).toContain("ACTIONREPRO_REINSTALL");
    expect(sh).toContain("skipping npm install");
  });

  it("PowerShell script has the same guard", () => {
    const out = tmp();
    createBundle(inputWithRawToken(), out);
    const ps1 = fs.readFileSync(path.join(out, "reproduce.ps1"), "utf8");
    expect(ps1).toContain("Test-Path node_modules");
    expect(ps1).toContain("ACTIONREPRO_REINSTALL");
  });
});
