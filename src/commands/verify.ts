import fs from "node:fs";
import path from "node:path";
import { loadLogsFromFile } from "../core/logs.js";
import { redactText } from "../core/redact.js";
import { extractFailure } from "../core/extract.js";
import { detectEcosystem } from "../core/ecosystems.js";
import {
  FINGERPRINT_ALGO,
  fingerprintFailure,
  compareFingerprints,
  type VerifyVerdict,
} from "../core/fingerprint.js";
import { listCwdFiles } from "../utils/fs.js";
import { checkBundleIntegrity } from "../core/bundle.js";

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
  /** bundle.sha256 check over the content files (see checkBundleIntegrity). */
  integrity: "ok" | "mismatch" | "unchecked";
}

interface StoredMeta {
  fingerprint?: string;
  fingerprintVersion?: string;
  ecosystem?: string;
  failure?: { summary?: string; reproCommand?: string; exitCode?: number | null };
}

function inconclusive(
  input: VerifyInput,
  meta: StoredMeta,
  recorded: string,
  reason: string,
  extra: Partial<VerifyResult> = {},
): VerifyResult {
  return {
    verdict: "INCONCLUSIVE",
    bundleDir: input.bundleDir,
    logFile: input.logFile,
    recordedFingerprint: recorded,
    freshFingerprint: null,
    recordedExitCode: meta.failure?.exitCode ?? null,
    freshExitCode: null,
    recordedSummary: meta.failure?.summary,
    reason,
    integrity: checkBundleIntegrity(input.bundleDir).status,
    ...extra,
  };
}

/**
 * Verify a local reproduction: fingerprint the fresh log and compare it with
 * the fingerprint recorded in the bundle. No network, no guessing — a match
 * means the same failure, a mismatch means a different one, and anything
 * unreadable is INCONCLUSIVE (never a false claim).
 *
 * A fresh log with no failure evidence at all (the command exited 0) is
 * NOT_REPRODUCED: that is exactly the "my fix worked" case. Lines printed by
 * the bundle's own script (`==> [actionrepro] ...`) are ignored during
 * extraction, so a piped script run can never verify itself from its own
 * echoed summary.
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
  if (!recorded) {
    return inconclusive(
      input,
      meta,
      recorded,
      "Bundle has no recorded fingerprint (created by an older version?). Re-create the bundle to verify.",
    );
  }
  // Fingerprint algorithm changed in 0.1.0 (context window -> failure anchor).
  // Comparing across algorithms would produce a meaningless NOT_REPRODUCED.
  const version = meta.fingerprintVersion ?? "";
  if (version !== FINGERPRINT_ALGO) {
    return inconclusive(
      input,
      meta,
      recorded,
      `Bundle fingerprint uses "${version || "sha256-v1 (pre-0.1.0)"}", this actionrepro computes "${FINGERPRINT_ALGO}". ` +
        `Re-create the bundle (actionrepro reproduce <target> --out ${input.bundleDir}) to verify against it.`,
    );
  }
  if (!fs.existsSync(input.logFile) || !fs.statSync(input.logFile).isFile()) {
    return inconclusive(
      input,
      meta,
      recorded,
      `Fresh log not found: ${input.logFile}. Re-run the repro command and save its output first.`,
    );
  }
  const loaded = loadLogsFromFile(input.logFile);
  if (loaded.raw.trim() === "") {
    return inconclusive(input, meta, recorded, "Fresh log is empty.");
  }
  const red = redactText(loaded.raw);
  const lines = red.text.split(/\r?\n/);
  const failure = extractFailure(lines);
  const recordedExitCode = meta.failure?.exitCode ?? null;
  const integrity = checkBundleIntegrity(input.bundleDir);
  // A changed bundle is still verifiable (users edit the repro command on
  // purpose), but the reader must be told the files differ from creation.
  const integrityNote =
    integrity.status === "mismatch"
      ? " Bundle integrity: MISMATCH — files in the bundle directory differ from bundle.sha256 (modified after creation)."
      : "";

  if (!failure.matched && failure.exitCode !== undefined && failure.exitCode !== 0) {
    // The command failed (non-zero exit) but printed no diagnostic we can
    // fingerprint. That is NOT evidence the CI failure is gone: calling it
    // NOT_REPRODUCED made `prove` report "fixed" for silent failures.
    return {
      verdict: "INCONCLUSIVE",
      bundleDir: input.bundleDir,
      logFile: input.logFile,
      recordedFingerprint: recorded,
      freshFingerprint: null,
      recordedExitCode,
      freshExitCode: failure.exitCode,
      recordedSummary: meta.failure?.summary,
      freshSummary: undefined,
      reason:
        `The fresh log shows a failing exit code (${failure.exitCode}) but no recognizable failure ` +
        "diagnostic, so it cannot be matched against the recorded failure. Inspect the output of the " +
        "command, or make it print its error, then verify again." +
        integrityNote,
      integrity: integrity.status,
    };
  }

  if (!failure.matched) {
    return {
      verdict: "NOT_REPRODUCED",
      bundleDir: input.bundleDir,
      logFile: input.logFile,
      recordedFingerprint: recorded,
      freshFingerprint: null,
      recordedExitCode,
      freshExitCode: failure.exitCode ?? null,
      recordedSummary: meta.failure?.summary,
      // No failure was found: the "Unknown failure near ..." fallback line
      // would only confuse the verdict, so it is not reported as a summary.
      freshSummary: undefined,
      reason:
        "The fresh log contains no failure evidence (no diagnostic line, and no runner exit marker) — " +
        "the reproduced command did not fail. The CI failure did not reproduce." +
        integrityNote,
      integrity: integrity.status,
    };
  }

  const fresh = fingerprintFailure({
    ecosystem: meta.ecosystem ?? detectEcosystem(lines, listCwdFiles()).id,
    reproCommand: failure.reproCommand ?? meta.failure?.reproCommand ?? "",
    // A fresh log without its own exit marker falls back to the recorded CI
    // code: the code confirms a failure, it does not define its identity.
    exitCode: failure.exitCode ?? recordedExitCode ?? undefined,
    anchor: failure.anchor,
    errorKind: failure.errorKind,
  });
  const cmp = compareFingerprints(recorded, fresh);
  return {
    verdict: cmp.verdict,
    bundleDir: input.bundleDir,
    logFile: input.logFile,
    recordedFingerprint: cmp.recordedFingerprint,
    freshFingerprint: cmp.freshFingerprint,
    recordedExitCode,
    freshExitCode: failure.exitCode ?? null,
    recordedSummary: meta.failure?.summary,
    freshSummary: failure.summary,
    reason: cmp.reason + integrityNote,
    integrity: integrity.status,
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
    `  integrity: ${r.integrity}${r.integrity === "mismatch" ? " (files differ from bundle.sha256)" : ""}`,
    `  reason: ${r.reason}`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}
