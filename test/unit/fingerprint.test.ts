import { describe, it, expect } from "vitest";
import {
  fingerprintFailure,
  compareFingerprints,
  normalizeFailureLine,
  hashBundleFiles,
} from "../../src/core/fingerprint.js";

function fp(over: Partial<Parameters<typeof fingerprintFailure>[0]> = {}): string {
  return fingerprintFailure({
    ecosystem: "npm",
    reproCommand: "npm test",
    exitCode: 1,
    errorLines: ["npm ERR! Exit status 1", "AssertionError: expected 3 to equal 4"],
    ...over,
  });
}

describe("normalizeFailureLine", () => {
  it("strips timestamps and ANSI codes", () => {
    expect(normalizeFailureLine("2024-05-01T10:00:12.0000000Z npm ERR! x")).toBe(
      "npm ERR! x",
    );
    // string-literal escapes below are intentional test data
    expect(normalizeFailureLine("\x1B[31mFAIL\x1B[39m y")).toBe("FAIL y");
  });

  it("masks temp paths, durations, addresses, and PIDs", () => {
    expect(normalizeFailureLine("wrote /tmp/ci-repro-cli-abc123/out")).toBe(
      "wrote <TMP>",
    );
    expect(normalizeFailureLine("done in 0.21s")).toBe("done in <SECS>");
    expect(normalizeFailureLine("at 0x7f2a91bc")).toBe("at <ADDR>");
    expect(normalizeFailureLine("(node:7692) warn")).toBe("(node:<PID>) warn");
  });

  it("keeps assertion values and error types intact", () => {
    expect(normalizeFailureLine("AssertionError: expected 3 to equal 4")).toBe(
      "AssertionError: expected 3 to equal 4",
    );
    expect(normalizeFailureLine("error[E0308]: mismatched types")).toBe(
      "error[E0308]: mismatched types",
    );
  });
});

describe("fingerprintFailure", () => {
  it("is deterministic", () => {
    expect(fp()).toBe(fp());
  });

  it("changes when the failure changes", () => {
    expect(fp()).not.toBe(fp({ exitCode: 2 }));
    expect(fp()).not.toBe(fp({ reproCommand: "npm run build" }));
    expect(fp()).not.toBe(fp({ ecosystem: "pip" }));
    expect(fp()).not.toBe(fp({ errorLines: ["something else entirely"] }));
  });

  it("ignores run-specific noise", () => {
    const a = fp({ errorLines: ["done in 0.21s", "npm ERR! x"] });
    const b = fp({ errorLines: ["done in 1.87s", "npm ERR! x"] });
    expect(a).toBe(b);
  });

  it("returns a short hex string", () => {
    expect(fp()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("compareFingerprints", () => {
  it("matches identical fingerprints", () => {
    const r = compareFingerprints("abc", "abc");
    expect(r.verdict).toBe("REPRODUCED");
  });

  it("flags different fingerprints without claiming a cause", () => {
    const r = compareFingerprints("abc", "def");
    expect(r.verdict).toBe("NOT_REPRODUCED");
    expect(r.reason).not.toMatch(/because|caused by/i);
  });

  it("is inconclusive when either side is missing", () => {
    expect(compareFingerprints("", "abc").verdict).toBe("INCONCLUSIVE");
    expect(compareFingerprints("abc", null).verdict).toBe("INCONCLUSIVE");
  });
});

describe("hashBundleFiles", () => {
  it("is order-independent and content-sensitive", () => {
    const a = hashBundleFiles([
      { name: "b.txt", content: "2" },
      { name: "a.txt", content: "1" },
    ]);
    const b = hashBundleFiles([
      { name: "a.txt", content: "1" },
      { name: "b.txt", content: "2" },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      hashBundleFiles([
        { name: "a.txt", content: "1" },
        { name: "b.txt", content: "CHANGED" },
      ]),
    ).not.toBe(a);
  });
});
