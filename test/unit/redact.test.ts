import { describe, it, expect } from "vitest";
import { redactText } from "../../src/core/redact.js";

describe("redactText", () => {
  it("redacts GitHub tokens", () => {
    const { text, redactions } = redactText(
      "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234 done",
    );
    expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234");
    expect(text).toContain("[REDACTED]");
    expect(redactions).toBeGreaterThan(0);
  });

  it("redacts key=value secrets but keeps key name", () => {
    const { text } = redactText("password=hunter2-secret");
    expect(text).toContain("password=[REDACTED]");
    expect(text).not.toContain("hunter2");
  });

  it("redacts URL credentials", () => {
    const { text } = redactText("fetch https://deploy:s3cret@internal.example.com/x");
    expect(text).not.toContain("s3cret");
    expect(text).toContain("[REDACTED]@");
  });

  it("redacts private key blocks", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----";
    const { text } = redactText(`leak ${key} end`);
    expect(text).not.toContain("ABC");
    expect(text).toContain("[REDACTED PRIVATE KEY BLOCK]");
  });

  it("redacts known env var assignments", () => {
    const { text } = redactText("export GITHUB_TOKEN=s3cr3tvalue123");
    expect(text).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(text).not.toContain("s3cr3tvalue123");
  });

  it("redacts Bearer tokens", () => {
    const { text } = redactText("Authorization: Bearer abcdefghij1234567890");
    expect(text).toContain("Bearer [REDACTED]");
  });

  it("leaves clean logs untouched", () => {
    const clean = "npm ERR! code ELIFECYCLE\nProcess completed with exit code 1.";
    const { text, redactions } = redactText(clean);
    expect(text).toBe(clean);
    expect(redactions).toBe(0);
  });
});
