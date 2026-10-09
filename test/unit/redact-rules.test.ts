import { describe, it, expect } from "vitest";
import { redactText } from "../../src/core/redact.js";

/**
 * Bearer/Basic rules: prose must survive, real credentials must not leak.
 * The old rule redacted any word after "Basic"/"Bearer", so ordinary CI
 * messages were mangled and the fingerprints built from them drifted.
 */
describe("Bearer / Basic false positives (prose must survive)", () => {
  it.each([
    "Basic authentication failed for registry",
    "Bearer authentication required",
    "Bearer token rejected by server",
    "Basic auth is not enabled on this host",
    "Basic configuration loaded",
  ])("keeps prose untouched: %s", (line) => {
    const { text, redactions } = redactText(line);
    expect(text).toBe(line);
    expect(redactions).toBe(0);
  });
});

describe("Bearer / Basic true positives (credentials must be redacted)", () => {
  it.each([
    ["Authorization: Bearer abcdefghij1234567890", "abcdefghij1234567890"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    [
      "Authorization: Bearer eyJhbGciOi.payload_part-2.signature",
      "eyJhbGciOi.payload_part-2.signature",
    ],
    [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyzABCD",
      "abcdefghijklmnopqrstuvwxyzABCD",
    ],
  ])("redacts the credential in %s", (line, secret) => {
    const { text, redactions } = redactText(line);
    expect(text).not.toContain(secret);
    expect(text).toMatch(/(Bearer|Basic) \[REDACTED\]/);
    expect(redactions).toBeGreaterThan(0);
  });
});

describe("other redaction rules still hold", () => {
  it("redacts GitHub PATs wherever they appear", () => {
    const t =
      "clone https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234@github.com/o/r";
    const { text } = redactText(t);
    expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234");
  });

  it("does not double-count the same secret", () => {
    const { redactions } = redactText("password=hunter2-secret");
    expect(redactions).toBe(1);
  });

  it("is idempotent: redacting twice changes nothing more", () => {
    const once = redactText("Authorization: Bearer abcdefghij1234567890").text;
    const twice = redactText(once);
    expect(twice.text).toBe(once);
    expect(twice.redactions).toBe(0);
  });
});
