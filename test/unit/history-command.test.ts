import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatLookupHuman,
  formatStatsHuman,
  lookup,
  markFixed,
  recordLog,
  stats,
} from "../../src/commands/history.js";
import { appendHistory, lookupHistory, historyStats } from "../../src/core/history.js";
import { FINGERPRINT_ALGO } from "../../src/core/fingerprint.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmpHistory = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-histcmd-"));
  dirs.push(d);
  return path.join(d, "history.jsonl");
};
const NPM_FAIL = path.join(process.cwd(), "fixtures/logs/npm-fail.log");

describe("recordLog", () => {
  it("records a failure with a fingerprint and the current algorithm version", () => {
    const file = tmpHistory();
    const entry = recordLog(file, NPM_FAIL);
    expect(entry.kind).toBe("failure");
    expect(entry.fpv).toBe(FINGERPRINT_ALGO);
    expect(entry.fingerprint.length).toBeGreaterThan(8);
    expect(entry.ecosystem).toBe("npm");
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("recording the same log twice yields the same fingerprint", () => {
    const file = tmpHistory();
    expect(recordLog(file, NPM_FAIL).fingerprint).toBe(
      recordLog(file, NPM_FAIL).fingerprint,
    );
  });

  it("uses the explicit source label when given", () => {
    expect(recordLog(tmpHistory(), NPM_FAIL, "ci-run-42").source).toBe("ci-run-42");
  });

  it("rejects a missing log file with the path in the message", () => {
    expect(() => recordLog(tmpHistory(), "/nope/missing.log")).toThrow(
      /Cannot record "\/nope\/missing.log"/,
    );
  });

  it("rejects an empty or whitespace-only log instead of recording a placeholder failure", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-empty-"));
    dirs.push(dir);
    const empty = path.join(dir, "empty.log");
    fs.writeFileSync(empty, "");
    expect(() => recordLog(tmpHistory(), empty)).toThrow(/no failure content found/);
    const blank = path.join(dir, "blank.log");
    fs.writeFileSync(blank, "  \n\t\n");
    expect(() => recordLog(tmpHistory(), blank)).toThrow(/no failure content found/);
  });
});

describe("markFixed, lookup and stats", () => {
  it("a recorded failure looks up as still failing, then a fix flips it", () => {
    const file = tmpHistory();
    const fp = recordLog(file, NPM_FAIL).fingerprint;
    const before = lookup(file, fp);
    expect(before.failures).toBe(1);
    expect(before.stillFailing).toBe(true);
    expect(before.legacyEntries).toBe(0);

    markFixed(file, fp);
    const after = lookup(file, fp);
    expect(after.fixedCount).toBe(1);
    expect(after.stillFailing).toBe(false);
  });

  it("markFixed trims the fingerprint and rejects an empty one", () => {
    const file = tmpHistory();
    const fp = recordLog(file, NPM_FAIL).fingerprint;
    expect(markFixed(file, `  ${fp}  `).fingerprint).toBe(fp);
    expect(() => markFixed(file, "   ")).toThrow(/fingerprint is empty/);
  });

  it("lookup rejects an empty fingerprint", () => {
    expect(() => lookup(tmpHistory(), "")).toThrow(/fingerprint is empty/);
  });

  it("an unknown fingerprint reports zero failures and no legacy entries", () => {
    const file = tmpHistory();
    recordLog(file, NPM_FAIL);
    const l = lookup(file, "deadbeefdeadbeef");
    expect(l.failures).toBe(0);
    expect(l.legacyEntries).toBe(0);
  });

  it("stats counts unique failures and fixed events", () => {
    const file = tmpHistory();
    const fp = recordLog(file, NPM_FAIL).fingerprint;
    recordLog(file, NPM_FAIL);
    markFixed(file, fp);
    const s = stats(file);
    expect(s.failureEvents).toBe(2);
    expect(s.fixedEvents).toBe(1);
    expect(s.uniqueFailures).toBe(1);
    expect(s.top[0].fingerprint).toBe(fp);
  });

  it("legacy entries from an older algorithm are counted for an unseen fingerprint", () => {
    // Regression guard for the legacyEntries wiring: the command layer passes FINGERPRINT_ALGO.
    const file = tmpHistory();
    appendHistory(file, {
      kind: "failure",
      fingerprint: "aaaa1111bbbb2222",
      summary: "old",
    });
    const l = lookup(file, "cccc3333dddd4444");
    expect(l.failures).toBe(0);
    expect(l.legacyEntries).toBe(1);
    expect(stats(file).legacyEntries).toBe(1);
  });
});

describe("core lookupHistory and historyStats with legacy entries", () => {
  it("a current-algorithm entry is not counted as legacy", () => {
    const file = tmpHistory();
    appendHistory(file, { kind: "failure", fpv: FINGERPRINT_ALGO, fingerprint: "fp1" });
    expect(lookupHistory(file, "other", FINGERPRINT_ALGO).legacyEntries).toBe(0);
  });

  it("without currentAlgo, no legacy count is reported", () => {
    const file = tmpHistory();
    appendHistory(file, { kind: "failure", fingerprint: "old" });
    expect(lookupHistory(file, "nope").legacyEntries).toBe(0);
    expect(historyStats(file).legacyEntries).toBe(0);
  });
});

describe("human formatting", () => {
  it("formatLookupHuman names the fingerprint and the failure count", () => {
    const file = tmpHistory();
    const fp = recordLog(file, NPM_FAIL).fingerprint;
    const text = formatLookupHuman(lookup(file, fp));
    expect(text).toContain(fp);
    expect(text).toMatch(/1/);
  });

  it("formatLookupHuman explains a legacy-only history", () => {
    const file = tmpHistory();
    appendHistory(file, { kind: "failure", fingerprint: "aaaa1111bbbb2222" });
    expect(formatLookupHuman(lookup(file, "cccc3333dddd4444"))).toMatch(
      /algorithm|older|legacy/i,
    );
  });

  it("formatStatsHuman lists the top failure", () => {
    const file = tmpHistory();
    const fp = recordLog(file, NPM_FAIL).fingerprint;
    expect(formatStatsHuman(stats(file))).toContain(fp);
  });
});
