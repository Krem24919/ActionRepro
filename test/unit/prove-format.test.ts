import { describe, it, expect } from "vitest";
import {
  formatProveHuman,
  scriptNotRunReason,
  type ProveResult,
  type ProveState,
} from "../../src/commands/prove.js";

const base = (state: ProveState, extra: Partial<ProveResult> = {}): ProveResult => ({
  state,
  bundleDir: "/b",
  logFile: "/l.log",
  recordedFingerprint: "fp-rec",
  freshFingerprint: "fp-fresh",
  historyRecorded: false,
  reason: `reason for ${state}`,
  ...extra,
});

describe("scriptNotRunReason", () => {
  it("explains exit 3 (setup failed) as an environment problem", () => {
    expect(scriptNotRunReason(3)).toMatch(/dependency setup failed \(exit 3\)/);
  });

  it("explains exit 4 (aborted at prompt)", () => {
    expect(scriptNotRunReason(4)).toMatch(
      /aborted at the confirmation prompt \(exit 4\)/,
    );
  });

  it("explains exit 5 (no runnable command)", () => {
    expect(scriptNotRunReason(5)).toMatch(/no runnable repro command \(exit 5\)/);
  });

  it("returns null for ordinary exit codes and undefined", () => {
    expect(scriptNotRunReason(0)).toBeNull();
    expect(scriptNotRunReason(1)).toBeNull();
    expect(scriptNotRunReason(undefined)).toBeNull();
  });
});

describe("formatProveHuman", () => {
  const states: ProveState[] = [
    "fixed",
    "still-failing",
    "changed-failure",
    "inconclusive",
    "unable-to-reproduce",
  ];

  it.each(states)("prints the state and reason for %s", (state) => {
    const text = formatProveHuman(base(state));
    expect(text).toContain("ActionRepro proof");
    expect(text).toContain(`state: ${state}`);
    expect(text).toContain(`reason for ${state}`);
    expect(text).toContain("bundle: /b");
  });

  it("shows the run exit code when the bundle was executed", () => {
    expect(formatProveHuman(base("fixed", { runExitCode: 0 }))).toContain(
      "run exit code: 0",
    );
  });

  it("omits the run exit code line when there was no run", () => {
    expect(formatProveHuman(base("fixed"))).not.toContain("run exit code");
  });

  it("says the captured output is not kept when a run produced a tail but no log file", () => {
    const text = formatProveHuman(
      base("inconclusive", { logFile: "", runOutputTail: "tail" }),
    );
    expect(text).toContain("(captured run output; not kept)");
  });

  it("says (none) when there is neither a log file nor a run tail", () => {
    expect(formatProveHuman(base("unable-to-reproduce", { logFile: "" }))).toContain(
      "log: (none)",
    );
  });
});
