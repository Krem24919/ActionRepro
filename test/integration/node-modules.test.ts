import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reproduceTarget } from "../../src/commands/reproduce.js";
import { MCP_TOOLS } from "../../src/mcp/tools.js";

/**
 * `reproduce --run` executes the bundle with cwd = the directory it is run from. The install
 * block must not wipe an existing node_modules (npm ci empties it). process.chdir keeps the
 * test away from the real repo's node_modules.
 */
const NPM_FAIL = path.join(process.cwd(), "fixtures/logs/npm-fail.log");
const savedCwd = process.cwd();
const dirs: string[] = [];

afterEach(() => {
  process.chdir(savedCwd);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function projectWithNodeModules(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-nm-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "p", version: "1.0.0" }),
  );
  fs.mkdirSync(path.join(dir, "node_modules", "keep-me"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "node_modules", "keep-me", "index.js"),
    "module.exports = 1;\n",
  );
  return dir;
}

describe("reproduce --run keeps an existing node_modules", () => {
  it("does not delete node_modules and prints the skip message", async () => {
    const project = projectWithNodeModules();
    process.chdir(project);
    const outDir = path.join(project, "bundle");
    const captured = path.join(project, "run.log");
    const res = await reproduceTarget({
      target: NPM_FAIL,
      outDir,
      run: true,
      runOutputFile: captured,
    });
    expect(fs.existsSync(path.join(project, "node_modules", "keep-me", "index.js"))).toBe(
      true,
    );
    expect(res.exitCode).toBeDefined();
    const log = fs.readFileSync(captured, "utf8");
    expect(log).toContain("node_modules exists: skipping npm install");
  }, 120000);

  it("ACTIONREPRO_REINSTALL=1 lets the install run (node_modules is rebuilt)", async () => {
    const project = projectWithNodeModules();
    process.chdir(project);
    const prev = process.env.ACTIONREPRO_REINSTALL;
    process.env.ACTIONREPRO_REINSTALL = "1";
    try {
      const captured = path.join(project, "run.log");
      await reproduceTarget({
        target: NPM_FAIL,
        outDir: path.join(project, "bundle"),
        run: true,
        runOutputFile: captured,
      });
      const log = fs.readFileSync(captured, "utf8");
      expect(log).not.toContain("skipping npm install");
      // npm install with no dependencies empties node_modules, so the sentinel package is gone.
      expect(fs.existsSync(path.join(project, "node_modules", "keep-me"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ACTIONREPRO_REINSTALL;
      else process.env.ACTIONREPRO_REINSTALL = prev;
    }
  }, 180000);
});

describe("MCP reproduce with run:true takes the same install path", () => {
  it("keeps node_modules when the tool runs the bundle from the current directory", async () => {
    const project = projectWithNodeModules();
    process.chdir(project);
    const tool = MCP_TOOLS.find((t) => t.name === "reproduce");
    expect(tool).toBeDefined();
    const result = await tool!.handler({
      target: NPM_FAIL,
      outDir: path.join(project, "mcp-bundle"),
      run: true,
    });
    // The run really happened (the captured output shows the skip) and no secret leaked into the result.
    expect(JSON.stringify(result)).toContain("skipping npm install");
    expect(JSON.stringify(result)).not.toContain("ghp_");
    expect(fs.existsSync(path.join(project, "node_modules", "keep-me", "index.js"))).toBe(
      true,
    );
  }, 120000);
});
