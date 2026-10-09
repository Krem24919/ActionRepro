import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectTarget, formatInspectHuman } from "../../src/commands/inspect.js";
import { reproduceTarget } from "../../src/commands/reproduce.js";

const NPM_FAIL = path.join(process.cwd(), "fixtures/logs/npm-fail.log");
const SECRETS = path.join(process.cwd(), "fixtures/logs/secrets.log");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};

describe("inspectTarget", () => {
  it("analyses a local log without writing any files", async () => {
    const before = fs.readdirSync(process.cwd());
    const r = await inspectTarget({ target: NPM_FAIL });
    expect(r.ecosystem).toBe("npm");
    expect(r.summary.length).toBeGreaterThan(0);
    expect(r.hint.length).toBeGreaterThan(0);
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.source).toContain("npm-fail.log");
    expect(fs.readdirSync(process.cwd())).toEqual(before);
  });

  it("reports the redaction count for a log with secrets, and the secret is absent from the summary", async () => {
    const r = await inspectTarget({ target: SECRETS });
    expect(r.redactions).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });

  it("json-mode input does not change the analysis", async () => {
    const a = await inspectTarget({ target: NPM_FAIL, json: true });
    const b = await inspectTarget({ target: NPM_FAIL });
    expect(a.summary).toBe(b.summary);
  });

  it("throws for a missing local file", async () => {
    await expect(inspectTarget({ target: "/no/such/file.log" })).rejects.toThrow();
  });
});

describe("formatInspectHuman", () => {
  it("prints the source, ecosystem, summary and hint", async () => {
    const r = await inspectTarget({ target: NPM_FAIL });
    const text = formatInspectHuman(r);
    expect(text).toContain(r.summary);
    expect(text).toContain(r.ecosystem);
    expect(text).toContain(r.hint);
  });
});

describe("reproduceTarget without --run", () => {
  it("writes the bundle files and reports the ecosystem and summary", async () => {
    const out = path.join(tmp("actionrepro-rep-"), "bundle");
    const r = await reproduceTarget({ target: NPM_FAIL, outDir: out });
    expect(r.outDir).toBe(out);
    expect(r.ecosystem).toBe("npm");
    expect(r.summary.length).toBeGreaterThan(0);
    for (const f of [
      "reproduce.sh",
      "reproduce.ps1",
      "repro.json",
      "failure.txt",
      "environment.txt",
      "bundle.sha256",
    ]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
      expect(r.files.map((x) => path.basename(x))).toContain(f);
    }
    expect(r.exitCode).toBeUndefined();
  });

  it("does not execute anything when run is not requested", async () => {
    const out = path.join(tmp("actionrepro-rep-"), "bundle");
    const r = await reproduceTarget({ target: NPM_FAIL, outDir: out, run: false });
    expect(r.exitCode).toBeUndefined();
  });

  it("the written repro.json has no raw secret from the secrets fixture", async () => {
    const out = path.join(tmp("actionrepro-rep-"), "bundle");
    await reproduceTarget({ target: SECRETS, outDir: out });
    for (const f of fs.readdirSync(out)) {
      const p = path.join(out, f);
      if (fs.statSync(p).isFile()) {
        expect(fs.readFileSync(p, "utf8"), f).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      }
    }
  });

  it("throws for a target that is neither a URL nor an existing file", async () => {
    await expect(
      reproduceTarget({
        target: "/definitely/not/here.log",
        outDir: tmp("actionrepro-rep-"),
      }),
    ).rejects.toThrow();
  });
});
