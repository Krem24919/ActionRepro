import { createHash } from "node:crypto";

/**
 * Failure fingerprints: stable identities for "the same failure".
 *
 * Normalization removes run-specific noise (timestamps, ANSI codes, temp
 * paths, durations, memory addresses, absolute workspace paths) while KEEPING
 * semantically meaningful values (exit codes, assertion values, error types,
 * file:line locations relative to the repo). Same failure -> same hash;
 * different failure -> different hash. No probabilities, no guessing.
 */

export const FINGERPRINT_ALGO = "sha256-v1";

export interface FingerprintInput {
  ecosystem: string;
  reproCommand?: string;
  exitCode?: number;
  errorLines: string[];
}

export function normalizeFailureLine(line: string): string {
  let s = line;
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, "");
  s = s.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?/, "");
  // Temp dirs with random segments: /tmp/xxx-123, C:\Users\X\AppData\Local\Temp\yyy
  s = s.replace(/(?:\/tmp\/|\/var\/folders\/[^\s]*\/T\/)[^\s]*/g, "<TMP>");
  s = s.replace(/[A-Za-z]:\\[^\s]*\\Temp\\[^\s]*/g, "<TMP>");
  s = s.replace(/\/tmp\/[^\s]*/g, "<TMP>");
  // Durations: 0.21s, 1.23s, 12ms
  s = s.replace(/\b\d+\.\d+s\b/g, "<SECS>");
  s = s.replace(/\b\d+ms\b/g, "<MS>");
  // Memory addresses and raw pointers
  s = s.replace(/\b0x[0-9a-fA-F]+\b/g, "<ADDR>");
  // Absolute workspace/checkout paths -> repo-relative marker
  s = s.replace(
    /(\/home\/[^\s/]+\/work\/[^\s/]+\/[^\s/]+|\/home\/runner\/work\/[^\s/]+\/[^\s/]+|[A-Za-z]:\\[^\s]*|D:\\a\\[^\s]*)/g,
    "<WORKSPACE>",
  );
  // DeprecationWarning noise with PIDs
  s = s.replace(/\(node:\d+\)/g, "(node:<PID>)");
  return s.trim();
}

export function fingerprintFailure(input: FingerprintInput): string {
  const canonical = [
    `ecosystem=${input.ecosystem}`,
    `command=${(input.reproCommand ?? "").trim()}`,
    `exit=${input.exitCode ?? "unknown"}`,
    ...input.errorLines
      .slice(0, 20)
      .map(normalizeFailureLine)
      .filter((l) => l !== ""),
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

export type VerifyVerdict = "REPRODUCED" | "NOT_REPRODUCED" | "INCONCLUSIVE";

export interface VerifyComparison {
  verdict: VerifyVerdict;
  recordedFingerprint: string;
  freshFingerprint: string | null;
  reason: string;
}

export function compareFingerprints(
  recorded: string,
  fresh: string | null,
): VerifyComparison {
  if (!recorded) {
    return {
      verdict: "INCONCLUSIVE",
      recordedFingerprint: recorded,
      freshFingerprint: fresh,
      reason: "Bundle has no recorded fingerprint (created by an older version?).",
    };
  }
  if (!fresh) {
    return {
      verdict: "INCONCLUSIVE",
      recordedFingerprint: recorded,
      freshFingerprint: fresh,
      reason: "Could not extract a failure fingerprint from the fresh log.",
    };
  }
  if (recorded === fresh) {
    return {
      verdict: "REPRODUCED",
      recordedFingerprint: recorded,
      freshFingerprint: fresh,
      reason: "Fresh failure fingerprint matches the recorded CI fingerprint.",
    };
  }
  return {
    verdict: "NOT_REPRODUCED",
    recordedFingerprint: recorded,
    freshFingerprint: fresh,
    reason: "Fresh failure fingerprint differs from the recorded CI fingerprint.",
  };
}

/** sha256 over bundle content files (hex). Excludes itself by construction. */
export function hashBundleFiles(files: Array<{ name: string; content: string }>): string {
  const h = createHash("sha256");
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const f of sorted) {
    h.update(`--- ${f.name} ---\n`, "utf8");
    h.update(f.content, "utf8");
    h.update("\n", "utf8");
  }
  return h.digest("hex");
}
