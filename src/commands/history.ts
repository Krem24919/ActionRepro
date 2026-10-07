/**
 * History command logic shared by the CLI and the MCP `history` tool:
 * record failures (from a log file or an existing bundle), mark fixes,
 * look up a fingerprint, or summarize the whole log.
 */

import fs from "node:fs";
import path from "node:path";
import { loadLogsFromFile } from "../core/logs.js";
import { redactText } from "../core/redact.js";
import { extractFailure } from "../core/extract.js";
import { detectEcosystem } from "../core/ecosystems.js";
import { FINGERPRINT_ALGO, fingerprintFailure } from "../core/fingerprint.js";
import {
  appendHistory,
  historyStats,
  lookupHistory,
  resolveHistoryFile,
  type HistoryEntry,
  type HistoryLookup,
  type HistoryStats,
} from "../core/history.js";

function localProjectFiles(): string[] {
  try {
    return fs.readdirSync(process.cwd());
  } catch {
    return [];
  }
}

export function recordLog(
  historyFile: string | undefined,
  logFile: string,
  source?: string,
): HistoryEntry {
  let loaded: { raw: string };
  try {
    loaded = loadLogsFromFile(logFile);
  } catch (err) {
    throw new Error(
      `Cannot record "${logFile}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const red = redactText(loaded.raw);
  const lines = red.text.split(/\r?\n/);
  const failure = extractFailure(lines);
  if (failure.errorLines.length === 0) {
    throw new Error(`Cannot record "${logFile}": no failure content found.`);
  }
  const eco = detectEcosystem(lines, localProjectFiles());
  const reproCommand = failure.reproCommand ?? eco.testCommand;
  return appendHistory(resolveHistoryFile(historyFile), {
    kind: "failure",
    fpv: FINGERPRINT_ALGO,
    fingerprint: fingerprintFailure({
      ecosystem: eco.id,
      reproCommand,
      exitCode: failure.exitCode,
      anchor: failure.anchor,
      errorKind: failure.errorKind,
    }),
    summary: failure.summary,
    ecosystem: eco.id,
    reproCommand,
    exitCode: failure.exitCode ?? null,
    source: source ?? logFile,
  });
}

interface StoredBundle {
  fingerprint?: string;
  fingerprintVersion?: string;
  ecosystem?: string;
  failure?: {
    summary?: string;
    reproCommand?: string;
    exitCode?: number | null;
  };
}

export function recordBundle(
  historyFile: string | undefined,
  bundleDir: string,
): HistoryEntry {
  const metaPath = path.join(bundleDir, "repro.json");
  let meta: StoredBundle;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as StoredBundle;
  } catch {
    throw new Error(
      `Cannot record bundle "${bundleDir}": ${metaPath} is missing or not valid JSON.`,
    );
  }
  if (!meta.fingerprint) {
    throw new Error(
      `Cannot record bundle "${bundleDir}": no fingerprint recorded (created by an older version?).`,
    );
  }
  return appendHistory(resolveHistoryFile(historyFile), {
    kind: "failure",
    fpv: meta.fingerprintVersion ?? undefined,
    fingerprint: meta.fingerprint,
    summary: meta.failure?.summary,
    ecosystem: meta.ecosystem,
    reproCommand: meta.failure?.reproCommand,
    exitCode: meta.failure?.exitCode ?? null,
    source: bundleDir,
  });
}

export function markFixed(
  historyFile: string | undefined,
  fingerprint: string,
): HistoryEntry {
  if (!fingerprint || fingerprint.trim() === "") {
    throw new Error("Cannot mark fixed: fingerprint is empty.");
  }
  return appendHistory(resolveHistoryFile(historyFile), {
    kind: "fixed",
    fingerprint: fingerprint.trim(),
  });
}

export function lookup(
  historyFile: string | undefined,
  fingerprint: string,
): HistoryLookup {
  if (!fingerprint || fingerprint.trim() === "") {
    throw new Error("Cannot look up history: fingerprint is empty.");
  }
  const file = resolveHistoryFile(historyFile);
  const result = lookupHistory(file, fingerprint.trim());
  // Nothing recorded for this fingerprint: if the file holds entries from an
  // older fingerprint algorithm, say so instead of implying "never seen".
  if (result.failures === 0 && result.fixedCount === 0) {
    result.legacyEntries = historyStats(file, 0, FINGERPRINT_ALGO).legacyEntries;
  }
  return result;
}

export function stats(historyFile: string | undefined): HistoryStats {
  return historyStats(resolveHistoryFile(historyFile), 5, FINGERPRINT_ALGO);
}

export function formatLookupHuman(l: HistoryLookup): string {
  const lines = [
    "ActionRepro history",
    `  fingerprint: ${l.fingerprint}`,
    `  failures: ${l.failures}`,
    `  first seen: ${l.firstSeen ?? "(never)"}`,
    `  last seen: ${l.lastSeen ?? "(never)"}`,
    `  fixes recorded: ${l.fixedCount}`,
    `  last fixed: ${l.lastFixed ?? "(never)"}`,
    `  still failing: ${l.stillFailing ? "yes" : "no"}`,
  ];
  if (l.legacyEntries > 0) {
    lines.push(
      `  note: ${l.legacyEntries} entr${l.legacyEntries === 1 ? "y" : "ies"} for this fingerprint` +
        ` ${l.legacyEntries === 1 ? "was" : "were"} recorded with a different fingerprint algorithm`,
    );
  }
  if (l.changes.length > 0) {
    lines.push("  changed between first and last occurrence:");
    for (const c of l.changes) lines.push(`    - ${c}`);
  }
  return lines.join("\n");
}

export function formatStatsHuman(s: HistoryStats): string {
  const lines = [
    "ActionRepro history",
    `  file: ${s.file}`,
    `  failure events: ${s.failureEvents}`,
    `  fixed events: ${s.fixedEvents}`,
    `  distinct failures: ${s.uniqueFailures}`,
    `  first seen: ${s.firstSeen ?? "(none)"}`,
    `  last seen: ${s.lastSeen ?? "(none)"}`,
  ];
  if (s.corruptLines > 0) lines.push(`  corrupt lines skipped: ${s.corruptLines}`);
  if (s.legacyEntries > 0) {
    lines.push(`  legacy entries (different fingerprint algorithm): ${s.legacyEntries}`);
  }
  if (s.top.length > 0) {
    lines.push("  most frequent:");
    for (const t of s.top) {
      lines.push(
        `    - ${t.fingerprint}: ${t.failures}x${t.summary ? ` (${t.summary})` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
