/**
 * Prove the fix: run a bundle (optionally), verify a fresh log against it,
 * record the outcome in history, and report one of five states —
 * fixed, still-failing, changed-failure, inconclusive, unable-to-reproduce.
 *
 * This is the machine half of the agent fix loop: the agent edits code
 * between `reproduce` and `prove`. `prove` never edits code itself.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReproduceScript } from "../core/runner.js";
import { EXIT_ABORTED, EXIT_NO_COMMAND, EXIT_SETUP_FAILED } from "../core/bundle.js";
import { verifyBundle, type VerifyResult } from "./verify.js";
import { redactText } from "../core/redact.js";
import {
  markFixed as historyMarkFixed,
  recordLog as historyRecordLog,
} from "./history.js";

export type ProveState =
  "fixed" | "still-failing" | "changed-failure" | "inconclusive" | "unable-to-reproduce";

export interface ProveInput {
  bundleDir: string;
  /** Fresh log file. Required unless run:true (then the bundle is executed and captured). */
  logFile?: string;
  /** Execute the bundle script and verify its captured output. */
  run?: boolean;
  /** Working directory for --run (the repo under test). Default: process.cwd(). */
  runCwd?: string;
  historyFile?: string;
}

export interface ProveResult {
  state: ProveState;
  bundleDir: string;
  logFile: string;
  runExitCode?: number;
  /**
   * Redacted tail of a `--run` capture. The captured log itself is a temp file
   * that is deleted after verification, so this is what the caller can show.
   */
  runOutputTail?: string;
  verdict?: VerifyResult["verdict"];
  recordedFingerprint: string | null;
  freshFingerprint: string | null;
  recordedSummary?: string;
  freshSummary?: string;
  historyRecorded: boolean;
  reason: string;
}

function unable(bundleDir: string, logFile: string, reason: string): ProveResult {
  return {
    state: "unable-to-reproduce",
    bundleDir,
    logFile,
    recordedFingerprint: null,
    freshFingerprint: null,
    historyRecorded: false,
    reason,
  };
}

export async function proveFix(input: ProveInput): Promise<ProveResult> {
  // The captured run output lives in a temp dir; it must not outlive this call.
  const scratch: string[] = [];
  try {
    const result = await runProve(input, scratch);
    if (scratch.length > 0 && result.logFile.startsWith(scratch[0])) {
      result.runOutputTail = redactedTail(result.logFile);
      result.logFile = "";
    }
    return result;
  } finally {
    for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runProve(input: ProveInput, scratch: string[]): Promise<ProveResult> {
  const bundleDir = input.bundleDir;
  let logFile = input.logFile ?? "";
  let runExitCode: number | undefined;

  if (input.run) {
    const script =
      process.platform === "win32"
        ? path.join(bundleDir, "reproduce.ps1")
        : path.join(bundleDir, "reproduce.sh");
    if (!fs.existsSync(script)) {
      return unable(
        bundleDir,
        logFile,
        `Cannot run bundle: script not found: ${script}.`,
      );
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-prove-"));
    scratch.push(dir);
    logFile = path.join(dir, "run.log");
    try {
      runExitCode = runReproduceScript(bundleDir, {
        cwd: input.runCwd ?? process.cwd(),
        outputFile: logFile,
      });
    } catch (err) {
      return unable(
        bundleDir,
        logFile,
        `Cannot run bundle: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The captured output tells whether the repro command itself ran. Only the
    // script prints these lines, and only after its command finished.
    const output = readOutput(logFile);
    const commandRan = /==> \[actionrepro\] (NOT )?REPRODUCED:/.test(output);
    if (!commandRan) {
      // Setup failed, the user aborted, or there was no command: the failure was
      // never reproduced. Exit codes 3/4/5 are only "script-level" when this holds,
      // because the repro command may itself exit 3/4/5.
      const notRun = scriptNotRunReason(runExitCode);
      if (notRun) return unable(bundleDir, logFile, notRun);
      // A script that exits non-zero without its header never started (missing
      // file, no shell). Exit 0 without a header simply ran; verification decides.
      if (runExitCode !== 0 && !output.includes("==> [actionrepro]")) {
        return unable(
          bundleDir,
          logFile,
          `The bundle did not start (exit ${runExitCode}, no output from reproduce.sh). Nothing was reproduced.`,
        );
      }
    }
  }

  if (!logFile) {
    return unable(
      bundleDir,
      logFile,
      "Nothing to verify: provide a fresh log file or pass --run to execute the bundle.",
    );
  }

  let v: VerifyResult;
  try {
    v = await verifyBundle({ bundleDir, logFile });
  } catch (err) {
    return unable(
      bundleDir,
      logFile,
      `Cannot verify: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const base = {
    bundleDir,
    logFile,
    runExitCode,
    verdict: v.verdict,
    recordedFingerprint: v.recordedFingerprint || null,
    freshFingerprint: v.freshFingerprint,
    recordedSummary: v.recordedSummary,
    freshSummary: v.freshSummary,
  };

  if (v.verdict === "INCONCLUSIVE") {
    return {
      ...base,
      state: "inconclusive",
      historyRecorded: false,
      reason: `Inconclusive: ${v.reason}`,
    };
  }

  // Record the outcome in history; a history failure must never sink the verdict.
  let historyRecorded = false;
  try {
    if (v.verdict === "REPRODUCED") {
      historyRecordLog(input.historyFile, logFile, `prove ${bundleDir}`);
      historyRecorded = true;
    } else if (v.freshFingerprint) {
      // A different failure reproduced: still worth tracking.
      historyRecordLog(input.historyFile, logFile, `prove ${bundleDir}`);
      historyRecorded = true;
    } else if (v.recordedFingerprint) {
      historyMarkFixed(input.historyFile, v.recordedFingerprint);
      historyRecorded = true;
    }
  } catch {
    historyRecorded = false;
  }

  if (v.verdict === "REPRODUCED") {
    return {
      ...base,
      state: "still-failing",
      historyRecorded,
      reason:
        "The recorded failure reproduced again: the fix did not work (or was not applied).",
    };
  }
  if (v.freshFingerprint) {
    return {
      ...base,
      state: "changed-failure",
      historyRecorded,
      reason:
        "A different failure reproduced instead: the original failure is gone, but something else fails now.",
    };
  }
  return {
    ...base,
    state: "fixed",
    historyRecorded,
    reason:
      "No failure evidence in the fresh log: the recorded failure did not reproduce. The fix worked (or the failure is environment-specific).",
  };
}

const RUN_TAIL_LINES = 60;

function redactedTail(logFile: string): string {
  const lines = redactText(readOutput(logFile)).text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-RUN_TAIL_LINES).join("\n");
}

function readOutput(logFile: string): string {
  try {
    return fs.readFileSync(logFile, "utf8");
  } catch {
    return "";
  }
}

/** Why a script exit code means "the failure was never reproduced", if it does. */
export function scriptNotRunReason(code: number | undefined): string | null {
  if (code === EXIT_SETUP_FAILED) {
    return (
      "The bundle's dependency setup failed (exit 3): an environment problem, not a reproduction. " +
      "Fix the toolchain or dependencies, then run the bundle again."
    );
  }
  if (code === EXIT_ABORTED) {
    return "The bundle was aborted at the confirmation prompt (exit 4): the repro command never ran.";
  }
  if (code === EXIT_NO_COMMAND) {
    return (
      "The bundle has no runnable repro command (exit 5): nothing was executed. " +
      "Run the failing command manually and verify its output instead."
    );
  }
  return null;
}

export function formatProveHuman(r: ProveResult): string {
  const lines = [
    "ActionRepro proof",
    `  bundle: ${r.bundleDir}`,
    `  log: ${r.logFile || (r.runOutputTail !== undefined ? "(captured run output; not kept)" : "(none)")}`,
    r.runExitCode !== undefined ? `  run exit code: ${r.runExitCode}` : null,
    `  state: ${r.state}`,
    r.verdict ? `  verdict: ${r.verdict}` : null,
    r.recordedFingerprint ? `  recorded fingerprint: ${r.recordedFingerprint}` : null,
    r.freshFingerprint ? `  fresh fingerprint: ${r.freshFingerprint}` : null,
    `  history recorded: ${r.historyRecorded ? "yes" : "no"}`,
    `  reason: ${r.reason}`,
  ].filter((x): x is string => x !== null);
  return lines.join("\n");
}
