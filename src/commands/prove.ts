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
import { verifyBundle, type VerifyResult } from "./verify.js";
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

export function formatProveHuman(r: ProveResult): string {
  const lines = [
    "ActionRepro proof",
    `  bundle: ${r.bundleDir}`,
    `  log: ${r.logFile || "(none)"}`,
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
