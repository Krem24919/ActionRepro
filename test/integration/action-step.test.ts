import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

/**
 * Runs the real "Generate redacted repro bundle" step from action.yml, the same way the
 * Actions runner would: the step's `run` script under bash, with the step's env. This is the
 * end-to-end check of the composite action's glue (outputs, quoting, cleanup).
 */
const ROOT = process.cwd();
const ACTION = YAML.parse(fs.readFileSync(path.join(ROOT, "action.yml"), "utf8"));
const STEP = ACTION.runs.steps.find((s: { id?: string }) => s.id === "repro");
const LOG = path.join(ROOT, "fixtures/logs/npm-fail.log");

let work: string;
beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-step-"));
});
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

interface StepRun {
  status: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  leftoverJson: string[];
}

/** Execute the step with `inputs` (env names as in action.yml). Returns exit status and outputs. */
function runStep(inputs: Record<string, string>, cwd: string): StepRun {
  const runtemp = fs.mkdtempSync(path.join(work, "runtemp-"));
  const ghOutput = path.join(runtemp, "github_output");
  fs.writeFileSync(ghOutput, "");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? work,
    RUNNER_TEMP: runtemp,
    GITHUB_OUTPUT: ghOutput,
    ACTIONREPRO_URL: "",
    ACTIONREPRO_LOG: "",
    ACTIONREPRO_OUT: "actionrepro",
    ACTIONREPRO_RUN: "false",
    ...inputs,
  };
  const script = String(STEP.run).replaceAll("${{ github.action_path }}", ROOT);
  const r = spawnSync("bash", ["-c", script], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  const outputs: Record<string, string> = {};
  const raw = fs.readFileSync(ghOutput, "utf8");
  // Multi-line format: name<<DELIM \n value \n DELIM
  const re = /^([a-z-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) outputs[m[1]] = m[3];
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    outputs,
    leftoverJson: fs.readdirSync(runtemp).filter((f) => f.endsWith(".json")),
  };
}

describe("action.yml repro step (end-to-end)", () => {
  it("the step is found and uses the composite shell", () => {
    expect(STEP).toBeDefined();
    expect(STEP.shell).toBe("bash");
    expect(String(STEP.run)).toContain("json_field");
  });

  it("log-file mode writes the bundle and publishes the three outputs", () => {
    const cwd = fs.mkdtempSync(path.join(work, "run-"));
    const r = runStep({ ACTIONREPRO_LOG: LOG, ACTIONREPRO_OUT: "bundle" }, cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(cwd, "bundle", "reproduce.sh"))).toBe(true);
    // The CLI reports the absolute bundle path.
    expect(r.outputs["out-dir"]).toBe(path.join(cwd, "bundle"));
    expect(r.outputs["summary"].length).toBeGreaterThan(0);
    expect(r.outputs["repro-command"].length).toBeGreaterThan(0);
  });

  it("the temp JSON file is removed after the step", () => {
    const cwd = fs.mkdtempSync(path.join(work, "run-"));
    const r = runStep({ ACTIONREPRO_LOG: LOG, ACTIONREPRO_OUT: "b2" }, cwd);
    expect(r.status).toBe(0);
    expect(r.leftoverJson).toEqual([]);
  });

  it("a failing log-file run still removes the temp JSON (the rm after the outputs is skipped)", () => {
    const cwd = fs.mkdtempSync(path.join(work, "run-"));
    const r = runStep(
      { ACTIONREPRO_LOG: path.join(cwd, "no-such.log"), ACTIONREPRO_OUT: "b3" },
      cwd,
    );
    expect(r.status).not.toBe(0);
    expect(r.leftoverJson).toEqual([]);
  });

  it("a failing run-url (unreachable API, no network needed) still removes the temp JSON", () => {
    const cwd = fs.mkdtempSync(path.join(work, "run-"));
    // Port 9 on loopback refuses the connection at once; the step must fail and clean up.
    const r = runStep(
      {
        ACTIONREPRO_URL: "https://127.0.0.1:9/acme/app/actions/runs/1",
        ACTIONREPRO_OUT: "b4",
      },
      cwd,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.leftoverJson).toEqual([]);
  });

  it("missing both run-url and log-file exits 2 with a clear message", () => {
    const cwd = fs.mkdtempSync(path.join(work, "run-"));
    const r = runStep({}, cwd);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("provide the 'run-url' or 'log-file' input");
  });

  it("an out path with an apostrophe works (the old JS interpolation broke here)", () => {
    const cwd = fs.mkdtempSync(path.join(work, "run-"));
    const r = runStep({ ACTIONREPRO_LOG: LOG, ACTIONREPRO_OUT: "Bob's dir" }, cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs["out-dir"]).toBe(path.join(cwd, "Bob's dir"));
    expect(fs.existsSync(path.join(cwd, "Bob's dir", "reproduce.sh"))).toBe(true);
  });

  it("command substitution in the out path is passed literally and never executed", () => {
    const cwd = fs.mkdtempSync(path.join(work, "run-"));
    const payload = "inj$(touch pwned-by-out)";
    const r = runStep({ ACTIONREPRO_LOG: LOG, ACTIONREPRO_OUT: payload }, cwd);
    expect(fs.existsSync(path.join(cwd, "pwned-by-out"))).toBe(false);
    expect(r.outputs["out-dir"]).toBe(path.join(cwd, payload));
  });

  it("ACTIONREPRO_RUN=false never executes the generated script", () => {
    const cwd = fs.mkdtempSync(path.join(work, "run-"));
    const r = runStep(
      { ACTIONREPRO_LOG: LOG, ACTIONREPRO_OUT: "b3", ACTIONREPRO_RUN: "false" },
      cwd,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("reproduce script exited");
  });

  it("the summary is printed with workflow-command markers neutralised", () => {
    const cwd = fs.mkdtempSync(path.join(work, "run-"));
    const r = runStep({ ACTIONREPRO_LOG: LOG, ACTIONREPRO_OUT: "b4" }, cwd);
    expect(r.stdout).toContain("--- actionrepro summary (redacted) ---");
    expect(r.stdout).not.toMatch(/^##\[/m);
  });
});
