import { spawnSync, type StdioOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Exit code used when the repro script is stopped by the time limit (same convention as `timeout(1)`). */
export const EXIT_TIMEOUT = 124;

/** Default time limit for a repro script run: 30 minutes. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunOptions {
  cwd?: string;
  shell?: string;
  /**
   * Capture script stdout+stderr into this file instead of inheriting stdio.
   * Used by `prove --run` to keep the fresh log for verification.
   */
  outputFile?: string;
  /**
   * Time limit in milliseconds. 0 disables the limit. Defaults to the
   * `ACTIONREPRO_TIMEOUT_MS` environment variable, or 30 minutes when unset.
   */
  timeoutMs?: number;
}

/** Resolve the time limit: explicit option, then env var, then the default. Invalid env values fall back. */
export function resolveRunTimeoutMs(
  opts: RunOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (opts.timeoutMs !== undefined) return Math.max(0, Math.floor(opts.timeoutMs));
  const raw = env.ACTIONREPRO_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RUN_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RUN_TIMEOUT_MS;
  return Math.floor(n);
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
  const timeout = resolveRunTimeoutMs(opts);
  const spawnTimeout = timeout > 0 ? timeout : undefined;
  let outputFd: number | undefined;
  try {
    if (opts.outputFile) outputFd = fs.openSync(opts.outputFile, "w");
    const stdio: StdioOptions =
      outputFd !== undefined ? ["ignore", outputFd, outputFd] : "inherit";
    if (isWin) {
      const r = spawnSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", script], {
        stdio,
        cwd: opts.cwd ?? dir,
        timeout: spawnTimeout,
      });
      if (r.error && (r.error as NodeJS.ErrnoException).code !== "ETIMEDOUT")
        throw r.error;
      return exitCodeFrom(r, timeout);
    }
    const shell = opts.shell ?? "bash";
    const r = spawnSync(shell, [script], {
      stdio,
      cwd: opts.cwd ?? process.cwd(),
      timeout: spawnTimeout,
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw r.error;
    return exitCodeFrom(r, timeout);
  } finally {
    if (outputFd !== undefined) fs.closeSync(outputFd);
  }
}

function exitCodeFrom(
  r: { status: number | null; signal: NodeJS.Signals | null; error?: Error },
  timeoutMs: number,
): number {
  // Node reports a spawnSync time limit as error.code ETIMEDOUT. Other signals (for example an
  // external kill) are not our time limit and keep the generic failure code.
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    process.stderr.write(
      `==> [actionrepro] repro script stopped after ${Math.round(timeoutMs / 1000)}s (time limit; set ACTIONREPRO_TIMEOUT_MS to change, 0 disables)\n`,
    );
    return EXIT_TIMEOUT;
  }
  return r.status ?? 1;
}
