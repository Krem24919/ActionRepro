import { describe, it, expect } from "vitest";
import { extractFailure } from "../../src/core/extract.js";

const ts = "2026-10-07T09:00:00.0000000Z";

describe("GitHub `##[group]Run` headers", () => {
  it("extracts the command from a group header with no echo line", () => {
    const lines = [
      `${ts} ##[group]Run node -e "process.exit(5)"`,
      `${ts} ##[endgroup]`,
      `${ts} ##[error]Process completed with exit code 5.`,
    ];
    const f = extractFailure(lines);
    expect(f.reproCommand).toBe('node -e "process.exit(5)"');
    expect(f.exitCode).toBe(5);
  });

  it("extracts a relative script with flags from a group header", () => {
    const lines = [
      `${ts} ##[group]Run ./scripts/check.sh --strict`,
      `${ts} ##[error]Process completed with exit code 1.`,
    ];
    expect(extractFailure(lines).reproCommand).toBe("./scripts/check.sh --strict");
  });

  it("prefers the command of the failing step over earlier successful steps", () => {
    const lines = [
      `${ts} ##[group]Run npm ci`,
      `${ts} ##[endgroup]`,
      `${ts} ##[group]Run npm test`,
      `${ts} ##[endgroup]`,
      `${ts} ##[error]Process completed with exit code 1.`,
    ];
    expect(extractFailure(lines).reproCommand).toBe("npm test");
  });
});

describe("`+` trace allowlist (Jest/diff output must not become a command)", () => {
  it("does not treat a Jest `+ Received` diff line as a command", () => {
    const lines = [
      `${ts} ##[group]Run npx jest`,
      `${ts}     Expected: 4`,
      `${ts}     Received: 3`,
      `${ts}   - Expected`,
      `${ts}   + Received`,
      `${ts} ##[error]Process completed with exit code 1.`,
    ];
    const cmd = extractFailure(lines).reproCommand;
    expect(cmd).not.toBe("Received");
    expect(cmd ?? "").not.toMatch(/Received/);
  });

  it("accepts a real traced command with a `+` prefix from an allowlisted tool", () => {
    const lines = [
      `${ts} + go test ./...`,
      `${ts} ##[error]Process completed with exit code 1.`,
    ];
    expect(extractFailure(lines).reproCommand).toBe("go test ./...");
  });

  it("accepts `+ npm test` (set -x trace of an allowlisted tool)", () => {
    const lines = [
      `${ts} + npm test`,
      `${ts} ##[error]Process completed with exit code 1.`,
    ];
    expect(extractFailure(lines).reproCommand).toBe("npm test");
  });
});
