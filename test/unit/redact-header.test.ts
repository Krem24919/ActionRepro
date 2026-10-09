import { describe, it, expect } from "vitest";
import { redactText } from "../../src/core/redact.js";

const secretGone = (input: string, secret: string) => {
  const { text } = redactText(input);
  expect(text).not.toContain(secret);
  return text;
};

describe("Authorization header rule", () => {
  it("redacts a Basic value that has no digits or symbols", () => {
    const out = secretGone("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz");
    expect(out).toBe("Authorization: Basic [REDACTED]");
  });

  it("redacts a short token-scheme value (the old shape rule missed it)", () => {
    const out = secretGone("Authorization: token ghx_short", "ghx_short");
    expect(out).toBe("Authorization: token [REDACTED]");
  });

  it("redacts a Digest header to the end of the line, including response=", () => {
    const out = secretGone(
      'Authorization: Digest username="x", realm="r", response="abcdef1234"',
      "abcdef1234",
    );
    expect(out).toBe("Authorization: Digest [REDACTED]");
  });

  it("redacts a quoted JSON header value", () => {
    const out = secretGone(
      '"Authorization": "Bearer abc123def456ghi789"',
      "abc123def456ghi789",
    );
    expect(out).toBe('"Authorization": "Bearer [REDACTED]"');
  });

  it("is idempotent on the header form: a second pass changes nothing and counts nothing", () => {
    const once = redactText("Authorization: Basic dXNlcjpwYXNz").text;
    const twice = redactText(once);
    expect(twice.text).toBe(once);
    expect(twice.redactions).toBe(0);
  });

  it("works with = as the separator", () => {
    const out = secretGone(
      "authorization=Bearer ZZZZZZZZZZZZZZZZZZZZ",
      "ZZZZZZZZZZZZZZZZZZZZ",
    );
    expect(out).toBe("authorization=Bearer [REDACTED]");
  });
});

describe("bare Basic / Bearer shape rule", () => {
  it("redacts a bare short base64 Basic value (regression guard)", () => {
    expect(redactText("Basic dXNlcjpwYXNz").text).toBe("Basic [REDACTED]");
  });

  it("redacts bare Bearer values with digits, mixed case, or all caps", () => {
    expect(redactText("Bearer ABCDEFGHIJKLMN").text).toBe("Bearer [REDACTED]");
    expect(redactText("Bearer abcdefghijklmnop1").text).toBe("Bearer [REDACTED]");
    expect(redactText("Bearer dXNlcjpwYXNzdXNl").text).toBe("Bearer [REDACTED]");
  });

  it("keeps ordinary prose that starts with Basic or Bearer", () => {
    for (const prose of [
      "Basic authentication failed for registry",
      "Basic Authentication failed",
      "Bearer token rejected by server",
      "Bearer Authentication required",
      "Basic configuration loaded",
      "authorization header missing",
    ]) {
      expect(redactText(prose).text, prose).toBe(prose);
    }
  });

  it("documented limit: a bare all-lowercase 16-char value without a header is not redacted", () => {
    // Accepted trade-off (see AUDIT_REPORT.md): without a header, a letters-only lowercase value
    // is indistinguishable from prose. The header form above is always redacted.
    expect(redactText("Bearer abcdefghijklmnop").text).toBe("Bearer abcdefghijklmnop");
  });
});
