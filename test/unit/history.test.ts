import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendHistory,
  defaultHistoryFile,
  diffEntries,
  historyStats,
  lookupHistory,
  readHistory,
  resolveHistoryFile,
} from "../../src/core/history.js";
import { recordLog } from "../../src/commands/history.js";

const ENV_KEY = "ACTIONREPRO_HISTORY_FILE";
const savedEnv = process.env[ENV_KEY];

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-hist-"));
  return path.join(dir, "history.jsonl");
}

describe("resolveHistoryFile", () => {
  it("prefers explicit, then env, then the per-user default", () => {
    expect(resolveHistoryFile("/x/y.jsonl")).toBe("/x/y.jsonl");
    delete process.env[ENV_KEY];
    expect(resolveHistoryFile()).toBe(defaultHistoryFile());
    expect(
      defaultHistoryFile().endsWith(path.join(".actionrepro", "history.jsonl")),
    ).toBe(true);
    process.env[ENV_KEY] = "/e/nv.jsonl";
    expect(resolveHistoryFile()).toBe("/e/nv.jsonl");
    expect(resolveHistoryFile("/explicit.jsonl")).toBe("/explicit.jsonl");
  });
});

describe("append/read", () => {
  it("round-trips an entry and creates parent dirs", () => {
    const f = tmpFile();
    const e = appendHistory(f, {
      fingerprint: "abc123",
      summary: "boom",
      ts: "2026-10-01T00:00:00.000Z",
    });
    expect(e.kind).toBe("failure");
    expect(e.ts).toBe("2026-10-01T00:00:00.000Z");
    expect(readHistory(f)).toEqual({ entries: [e], corrupt: 0 });
  });

  it("returns empty for a missing file and rejects empty fingerprints", () => {
    expect(readHistory(path.join(os.tmpdir(), "actionrepro-nope-xyz.jsonl"))).toEqual({
      entries: [],
      corrupt: 0,
    });
    expect(() => appendHistory(tmpFile(), { fingerprint: "  " })).toThrow(/empty/);
  });

  it("skips corrupt lines while counting them", () => {
    const f = tmpFile();
    fs.writeFileSync(
      f,
      [
        "not json",
        JSON.stringify({ nope: true }),
        JSON.stringify({ v: 1, ts: "2026-10-01T00:00:00.000Z", kind: "failure" }),
        JSON.stringify({
          v: 1,
          ts: "2026-10-01T00:00:00.000Z",
          kind: "exploded",
          fingerprint: "x",
        }),
        JSON.stringify({
          v: 1,
          ts: "not-a-date",
          kind: "failure",
          fingerprint: "x",
        }),
        JSON.stringify({
          v: 1,
          ts: "2026-10-01T00:00:00.000Z",
          kind: "fixed",
          fingerprint: "good",
        }),
        "",
      ].join("\n"),
    );
    const { entries, corrupt } = readHistory(f);
    expect(entries.map((e) => e.fingerprint)).toEqual(["good"]);
    expect(corrupt).toBe(5);
  });
});

describe("lookup lifecycle", () => {
  it("tracks failures, fixes, and still-failing state", () => {
    const f = tmpFile();
    expect(lookupHistory(f, "fp1").failures).toBe(0);
    expect(lookupHistory(f, "fp1").stillFailing).toBe(false);
    appendHistory(f, { fingerprint: "fp1", ts: "2026-10-01T00:00:00.000Z" });
    appendHistory(f, {
      fingerprint: "fp1",
      summary: "boom v2",
      exitCode: 2,
      ts: "2026-10-02T00:00:00.000Z",
    });
    let l = lookupHistory(f, "fp1");
    expect(l.failures).toBe(2);
    expect(l.firstSeen).toBe("2026-10-01T00:00:00.000Z");
    expect(l.lastSeen).toBe("2026-10-02T00:00:00.000Z");
    expect(l.stillFailing).toBe(true);
    expect(l.changes).toContain('summary: null -> "boom v2"');
    appendHistory(f, {
      fingerprint: "fp1",
      kind: "fixed",
      ts: "2026-10-03T00:00:00.000Z",
    });
    l = lookupHistory(f, "fp1");
    expect(l.fixedCount).toBe(1);
    expect(l.lastFixed).toBe("2026-10-03T00:00:00.000Z");
    expect(l.stillFailing).toBe(false);
    expect(l.occurrences).toHaveLength(3);
    appendHistory(f, { fingerprint: "fp1", ts: "2026-10-04T00:00:00.000Z" });
    expect(lookupHistory(f, "fp1").stillFailing).toBe(true);
  });
});

describe("diffEntries", () => {
  it("lists only changed fields", () => {
    const a = {
      v: 1 as const,
      ts: "2026-10-01T00:00:00.000Z",
      kind: "failure" as const,
      fingerprint: "x",
      summary: "s",
      exitCode: 1,
    };
    expect(diffEntries(a, { ...a })).toEqual([]);
    expect(diffEntries(a, { ...a, summary: "t", exitCode: 2 })).toEqual([
      'summary: "s" -> "t"',
      "exitCode: 1 -> 2",
    ]);
  });
});

describe("historyStats", () => {
  it("counts events and ranks the most frequent failures", () => {
    const f = tmpFile();
    appendHistory(f, { fingerprint: "a", summary: "A", ts: "2026-10-01T00:00:00.000Z" });
    appendHistory(f, { fingerprint: "b", summary: "B", ts: "2026-10-02T00:00:00.000Z" });
    appendHistory(f, { fingerprint: "a", summary: "A", ts: "2026-10-03T00:00:00.000Z" });
    appendHistory(f, { fingerprint: "a", kind: "fixed", ts: "2026-10-04T00:00:00.000Z" });
    const s = historyStats(f);
    expect(s.failureEvents).toBe(3);
    expect(s.fixedEvents).toBe(1);
    expect(s.uniqueFailures).toBe(2);
    expect(s.firstSeen).toBe("2026-10-01T00:00:00.000Z");
    expect(s.top[0]).toMatchObject({ fingerprint: "a", failures: 2 });
    expect(s.top[1]).toMatchObject({ fingerprint: "b", failures: 1 });
  });
});

describe("noise tolerance (realistic log changes)", () => {
  const npmFail = path.join(process.cwd(), "fixtures/logs/npm-fail.log");
  const goFail = path.join(process.cwd(), "fixtures/logs/go-fail.log");

  function noisyVariant(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-noisy-"));
    const p = path.join(dir, "noisy.log");
    const raw = fs.readFileSync(npmFail, "utf8");
    // Shift every timestamp by a day+hour and bump the runner version:
    // pure noise that must not change the failure identity.
    const noisy = raw
      .replaceAll("2024-05-01T10:", "2024-05-02T11:")
      .replaceAll("2.311.0", "2.312.0");
    expect(noisy).not.toBe(raw);
    fs.writeFileSync(p, noisy);
    return p;
  }

  it("treats timestamp/version noise as the same failure", () => {
    const f = tmpFile();
    const a = recordLog(f, npmFail, "run-1");
    const b = recordLog(f, noisyVariant(), "run-2");
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(lookupHistory(f, a.fingerprint).failures).toBe(2);
  });

  it("treats a genuinely different failure as different", () => {
    const f = tmpFile();
    const a = recordLog(f, npmFail);
    const b = recordLog(f, goFail);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(historyStats(f).uniqueFailures).toBe(2);
  });
});
