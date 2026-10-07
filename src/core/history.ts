/**
 * Failure history: append-only JSONL log of failure fingerprints that lets
 * ActionRepro recognize repeated failures across runs.
 *
 * Each line is one HistoryEntry. Readers tolerate missing files (empty
 * history) and skip corrupt lines while counting them — history must never
 * break the command that consults it.
 *
 * Default location is per-user (`~/.actionrepro/history.jsonl`), outside any
 * shareable bundle: history is local working state, not evidence.
 * Override with --history-file or ACTIONREPRO_HISTORY_FILE.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir } from "../utils/fs.js";

export type HistoryKind = "failure" | "fixed";

export interface HistoryEntry {
  v: 1;
  ts: string;
  kind: HistoryKind;
  fingerprint: string;
  summary?: string;
  ecosystem?: string;
  reproCommand?: string;
  exitCode?: number | null;
  source?: string;
}

export interface RecordInput {
  fingerprint: string;
  kind?: HistoryKind;
  summary?: string;
  ecosystem?: string;
  reproCommand?: string;
  exitCode?: number | null;
  source?: string;
  ts?: string;
}

export function defaultHistoryFile(): string {
  return path.join(os.homedir(), ".actionrepro", "history.jsonl");
}

export function resolveHistoryFile(explicit?: string): string {
  const env = process.env["ACTIONREPRO_HISTORY_FILE"];
  if (explicit && explicit.trim() !== "") return explicit;
  if (env && env.trim() !== "") return env;
  return defaultHistoryFile();
}

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (typeof e["fingerprint"] !== "string" || e["fingerprint"].trim() === "")
    return false;
  if (e["kind"] !== "failure" && e["kind"] !== "fixed") return false;
  if (typeof e["ts"] !== "string" || Number.isNaN(Date.parse(e["ts"]))) return false;
  return true;
}

export function appendHistory(file: string, input: RecordInput): HistoryEntry {
  if (!input.fingerprint || input.fingerprint.trim() === "") {
    throw new Error("Cannot record history: fingerprint is empty.");
  }
  const entry: HistoryEntry = {
    v: 1,
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind ?? "failure",
    fingerprint: input.fingerprint,
  };
  if (input.summary !== undefined) entry.summary = input.summary;
  if (input.ecosystem !== undefined) entry.ecosystem = input.ecosystem;
  if (input.reproCommand !== undefined) entry.reproCommand = input.reproCommand;
  if (input.exitCode !== undefined) entry.exitCode = input.exitCode;
  if (input.source !== undefined) entry.source = input.source;
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function readHistory(file: string): { entries: HistoryEntry[]; corrupt: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { entries: [], corrupt: 0 };
  }
  const entries: HistoryEntry[] = [];
  let corrupt = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isEntry(v)) entries.push(v);
      else corrupt += 1;
    } catch {
      corrupt += 1;
    }
  }
  return { entries, corrupt };
}

export interface HistoryLookup {
  fingerprint: string;
  failures: number;
  firstSeen: string | null;
  lastSeen: string | null;
  fixedCount: number;
  lastFixed: string | null;
  /** True when the most recent event for this fingerprint is a failure. */
  stillFailing: boolean;
  /** Human-readable field changes between first and last failure occurrence. */
  changes: string[];
  occurrences: HistoryEntry[];
}

/** Field-level diff between two entries (first vs last answers "what changed?"). */
export function diffEntries(a: HistoryEntry, b: HistoryEntry): string[] {
  const notes: string[] = [];
  const fields = ["summary", "ecosystem", "reproCommand", "exitCode", "source"] as const;
  for (const f of fields) {
    const x = a[f] ?? null;
    const y = b[f] ?? null;
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      notes.push(`${f}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
    }
  }
  return notes;
}

export function lookupHistory(file: string, fingerprint: string): HistoryLookup {
  const { entries } = readHistory(file);
  const mine = entries.filter((e) => e.fingerprint === fingerprint);
  const failures = mine.filter((e) => e.kind === "failure");
  const fixes = mine.filter((e) => e.kind === "fixed");
  const tsOf = (list: HistoryEntry[]): string | null => {
    if (list.length === 0) return null;
    return (
      list
        .map((e) => e.ts)
        .sort()
        .at(-1) ?? null
    );
  };
  const firstFailure = [...failures].sort((a, b) => (a.ts < b.ts ? -1 : 1))[0];
  const lastFailure = [...failures].sort((a, b) => (a.ts < b.ts ? -1 : 1)).at(-1);
  const lastEvent = [...mine].sort((a, b) => (a.ts < b.ts ? -1 : 1)).at(-1);
  return {
    fingerprint,
    failures: failures.length,
    firstSeen: firstFailure?.ts ?? null,
    lastSeen: tsOf(failures),
    fixedCount: fixes.length,
    lastFixed: tsOf(fixes),
    stillFailing: mine.length > 0 && lastEvent?.kind === "failure",
    changes:
      firstFailure && lastFailure && firstFailure !== lastFailure
        ? diffEntries(firstFailure, lastFailure)
        : [],
    occurrences: mine,
  };
}

export interface HistoryStats {
  file: string;
  failureEvents: number;
  fixedEvents: number;
  uniqueFailures: number;
  firstSeen: string | null;
  lastSeen: string | null;
  corruptLines: number;
  top: Array<{ fingerprint: string; failures: number; summary?: string }>;
}

export function historyStats(file: string, topN = 5): HistoryStats {
  const { entries, corrupt } = readHistory(file);
  const failures = entries.filter((e) => e.kind === "failure");
  const byFp = new Map<string, HistoryEntry[]>();
  for (const e of failures) {
    const list = byFp.get(e.fingerprint) ?? [];
    list.push(e);
    byFp.set(e.fingerprint, list);
  }
  const top = [...byFp.entries()]
    .map(([fingerprint, list]) => ({
      fingerprint,
      failures: list.length,
      summary: list.find((e) => e.summary)?.summary,
    }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, Math.max(0, topN));
  const allTs = entries.map((e) => e.ts).sort();
  return {
    file,
    failureEvents: failures.length,
    fixedEvents: entries.length - failures.length,
    uniqueFailures: byFp.size,
    firstSeen: allTs[0] ?? null,
    lastSeen: allTs.at(-1) ?? null,
    corruptLines: corrupt,
    top,
  };
}
