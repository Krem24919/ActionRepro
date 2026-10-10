import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBundle,
  checkBundleIntegrity,
  type BundleInput,
} from "../../src/core/bundle.js";
import { verifyBundle } from "../../src/commands/verify.js";
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

describe("checkBundleIntegrity", () => {
  it("reports ok for a fresh bundle", () => {
    const out = tmp();
    createBundle(inputWithRawToken(), out);
    expect(checkBundleIntegrity(out).status).toBe("ok");
  });

  it("reports mismatch after a file is modified, with both hashes", () => {
    const out = tmp();
    createBundle(inputWithRawToken(), out);
    fs.appendFileSync(path.join(out, "reproduce.sh"), "\n# edited by hand\n");
    const r = checkBundleIntegrity(out);
    expect(r.status).toBe("mismatch");
    expect(r.expected).toMatch(/^[0-9a-f]{64}$/);
    expect(r.actual).toMatch(/^[0-9a-f]{64}$/);
    expect(r.actual).not.toBe(r.expected);
  });

  it("reports unchecked when the sha file is missing", () => {
    const out = tmp();
    createBundle(inputWithRawToken(), out);
    fs.unlinkSync(path.join(out, "bundle.sha256"));
    expect(checkBundleIntegrity(out).status).toBe("unchecked");
  });

  it("verify reports the integrity status without changing the verdict", async () => {
    const out = tmp();
    createBundle(inputWithRawToken(), out);
    const fresh = path.join(out, "fresh.log");
    fs.writeFileSync(fresh, LOG.join("\n"));
    const clean = await verifyBundle({ bundleDir: out, logFile: fresh });
    expect(clean.integrity).toBe("ok");
    fs.appendFileSync(path.join(out, "failure.txt"), "\n# edited\n");
    const tampered = await verifyBundle({ bundleDir: out, logFile: fresh });
    expect(tampered.integrity).toBe("mismatch");
    expect(tampered.verdict).toBe(clean.verdict);
    expect(tampered.reason).toMatch(/integrity: MISMATCH/i);
  });
});
