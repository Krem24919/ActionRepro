import { spawnSync } from "node:child_process";
import fs from "node:fs";

export interface RunOptions {
  cwd?: string;
  shell?: string;
}

export function runReproduceScript(outDir: string, opts: RunOptions = {}): number {
  const isWin = process.platform === "win32";
  const script = isWin ? `${outDir}\\reproduce.ps1` : `${outDir}/reproduce.sh`;
  if (!fs.existsSync(script)) {
    throw new Error(`Reproduce script not found: ${script}`);
  }
  if (isWin) {
    const r = spawnSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", script], {
      stdio: "inherit",
      cwd: opts.cwd ?? outDir,
    });
    return r.status ?? 1;
  }
  const shell = opts.shell ?? "bash";
  const r = spawnSync(shell, [script], {
    stdio: "inherit",
    cwd: opts.cwd ?? process.cwd(),
  });
  return r.status ?? 1;
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
