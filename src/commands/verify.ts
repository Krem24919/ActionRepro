import fs from "node:fs";
import path from "node:path";
import { loadLogsFromFile } from "../core/logs.js";
import { redactText } from "../core/redact.js";
import { extractFailure } from "../core/extract.js";
import { detectEcosystem } from "../core/ecosystems.js";
import {
  fingerprintFailure,
  compareFingerprints,
  type VerifyVerdict,
} from "../core/fingerprint.js";

export interface VerifyInput {
  bundleDir: string;
  logFile: string;
}

export interface VerifyResult {
  verdict: VerifyVerdict;
  bundleDir: string;
  logFile: string;
  recordedFingerprint: string;
  freshFingerprint: string | null;
  recordedExitCode: number | null;
  freshExitCode: number | null;
  recordedSummary?: string;
  freshSummary?: string;
  reason: string;
}

interface StoredMeta {
  fingerprint?: string;
  ecosystem?: string;
  failure?: { summary?: string; reproCommand?: string; exitCode?: number | null };
}

function localProjectFiles(): string[] {
  try {
    return fs.readdirSync(process.cwd());
  } catch {
    return [];
  }
}

/**
 * Verify a local reproduction: fingerprint the fresh log and compare it with
 * the fingerprint recorded in the bundle. No network, no guessing — a match
 * means the same failure, a mismatch means a different one, and anything
 * unreadable is INCONCLUSIVE (never a false claim).
 */
export async function verifyBundle(input: VerifyInput): Promise<VerifyResult> {
  const metaPath = path.join(input.bundleDir, "repro.json");
  let meta: StoredMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as StoredMeta;
  } catch {
    throw new Error(
      `Cannot verify: ${metaPath} is missing or not valid JSON. Point at a bundle directory created by actionrepro.`,
    );
  }
  const recorded = meta.fingerprint ?? "";
  if (!fs.existsSync(input.logFile) || !fs.statSync(input.logFile).isFile()) {
    return {
      verdict: "INCONCLUSIVE",
      bundleDir: input.bundleDir,
      logFile: input.logFile,
      recordedFingerprint: recorded,
      freshFingerprint: null,
      recordedExitCode: meta.failure?.exitCode ?? null,
      freshExitCode: null,
      recordedSummary: meta.failure?.summary,
      reason: `Fresh log not found: ${input.logFile}. Re-run the repro command and save its output first.`,
    };
  }
  const loaded = loadLogsFromFile(input.logFile);
  const red = redactText(loaded.raw);
  const lines = red.text.split(/\r?\n/);
  const failure = extractFailure(lines);
  if (failure.errorLines.length === 0) {
    return {
      verdict: "INCONCLUSIVE",
      bundleDir: input.bundleDir,
      logFile: input.logFile,
      recordedFingerprint: recorded,
      freshFingerprint: null,
      recordedExitCode: meta.failure?.exitCode ?? null,
      freshExitCode: failure.exitCode ?? null,
      recordedSummary: meta.failure?.summary,
      freshSummary: failure.summary,
      reason: "No failure content found in the fresh log.",
    };
  }
  const fresh = fingerprintFailure({
    ecosystem: meta.ecosystem ?? detectEcosystem(lines, localProjectFiles()).id,
    reproCommand: failure.reproCommand ?? meta.failure?.reproCommand ?? "",
    exitCode: failure.exitCode,
    errorLines: failure.errorLines,
  });
  const cmp = compareFingerprints(recorded, fresh);
  return {
    verdict: cmp.verdict,
    bundleDir: input.bundleDir,
    logFile: input.logFile,
    recordedFingerprint: cmp.recordedFingerprint,
    freshFingerprint: cmp.freshFingerprint,
    recordedExitCode: meta.failure?.exitCode ?? null,
    freshExitCode: failure.exitCode ?? null,
    recordedSummary: meta.failure?.summary,
    freshSummary: failure.summary,
    reason: cmp.reason,
  };
}

export function formatVerifyHuman(r: VerifyResult): string {
  return [
    "ActionRepro verification",
    `  bundle: ${r.bundleDir}`,
    `  fresh log: ${r.logFile}`,
    `  recorded fingerprint: ${r.recordedFingerprint || "(none)"}`,
    `  fresh fingerprint: ${r.freshFingerprint ?? "(none)"}`,
    `  CI exit code: ${r.recordedExitCode ?? "(unknown)"}`,
    `  fresh exit code: ${r.freshExitCode ?? "(unknown)"}`,
    r.recordedSummary ? `  recorded: ${r.recordedSummary}` : null,
    r.freshSummary ? `  fresh: ${r.freshSummary}` : null,
    `  verdict: ${r.verdict}`,
    `  reason: ${r.reason}`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}
