import { spawnSync, type StdioOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RunOptions {
  cwd?: string;
  shell?: string;
  /**
   * Capture script stdout+stderr into this file instead of inheriting stdio.
   * Used by `prove --run` to keep the fresh log for verification.
   */
  outputFile?: string;
}

export function runReproduceScript(outDir: string, opts: RunOptions = {}): number {
  const isWin = process.platform === "win32";
  // Absolute: the script runs with cwd = the repo under test, so a relative
  // bundle path (e.g. `actionrepro/`) would no longer resolve.
  const dir = path.resolve(outDir);
  const script = isWin ? path.join(dir, "reproduce.ps1") : path.join(dir, "reproduce.sh");
  if (!fs.existsSync(script)) {
    throw new Error(`Reproduce script not found: ${script}`);
  }
  let outputFd: number | undefined;
  try {
    if (opts.outputFile) outputFd = fs.openSync(opts.outputFile, "w");
    const stdio: StdioOptions =
      outputFd !== undefined ? ["ignore", outputFd, outputFd] : "inherit";
    if (isWin) {
      const r = spawnSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", script], {
        stdio,
        cwd: opts.cwd ?? dir,
      });
      return r.status ?? 1;
    }
    const shell = opts.shell ?? "bash";
    const r = spawnSync(shell, [script], {
      stdio,
      cwd: opts.cwd ?? process.cwd(),
    });
    if (r.error) throw r.error;
    return r.status ?? 1;
  } finally {
    if (outputFd !== undefined) fs.closeSync(outputFd);
  }
}
