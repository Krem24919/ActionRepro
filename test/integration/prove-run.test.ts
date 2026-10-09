import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proveFix } from "../../src/commands/prove.js";
import { reproduceTarget } from "../../src/commands/reproduce.js";

/**
 * `prove --run`: execute the bundle's reproduce script in a scratch project, capture its output,
 * and verify the captured log against the recorded fingerprint. Uses an isolated history file.
 */
const NPM_FAIL = path.join(process.cwd(), "fixtures/logs/npm-fail.log");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};

describe("proveFix with run:true (end-to-end)", () => {
  it("re-runs the bundle, captures its output, and reports the verdict with a redacted tail", async () => {
    const work = tmp("actionrepro-prove-");
    const bundle = path.join(work, "bundle");
    const history = path.join(work, "history.jsonl");
    // A scratch project with no package.json: the failing npm command reproduces the same failure.
    const project = tmp("actionrepro-project-");
    // The bundle's install step needs a package.json (npm errors without one: exit 3, setup failed).
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "scratch", version: "1.0.0" }),
    );
    await reproduceTarget({ target: NPM_FAIL, outDir: bundle });
    const r = await proveFix({
      bundleDir: bundle,
      run: true,
      runCwd: project,
      historyFile: history,
    });
    expect(r.runExitCode).toBeDefined();
    expect(r.runExitCode).not.toBe(0);
    expect(typeof r.runOutputTail).toBe("string");
    // The scratch project's output is not the recorded CI failure, so the verdict is a
    // non-"fixed" state; the exact state depends on the fingerprint match.
    expect(["still-failing", "changed-failure", "inconclusive"]).toContain(r.state);
    // The captured temp log is removed after verification.
    // npm install may add a package-lock.json; nothing else (no capture file) is left behind.
    const extra = fs
      .readdirSync(project)
      .filter((f) => !["package.json", "package-lock.json", "node_modules"].includes(f));
    expect(extra).toEqual([]);
  }, 180000);
});
