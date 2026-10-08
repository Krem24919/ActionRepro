import { spawnSync, type StdioOptions } from "node:child_process";
import fs from "node:fs";

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
  const script = isWin ? `${outDir}\\reproduce.ps1` : `${outDir}/reproduce.sh`;
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
        cwd: opts.cwd ?? outDir,
      });
      return r.status ?? 1;
    }
    const shell = opts.shell ?? "bash";
    const r = spawnSync(shell, [script], {
      stdio,
      cwd: opts.cwd ?? process.cwd(),
    });
    return r.status ?? 1;
  } finally {
    if (outputFd !== undefined) fs.closeSync(outputFd);
  }
}

export function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [cmd] : ["-v", cmd];
  try {
    const r = spawnSync(probe, args, { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}
