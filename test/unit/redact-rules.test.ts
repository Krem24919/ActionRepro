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

describe("extended token formats (GitLab, npm, JWT, sk-, Google, Slack, docker)", () => {
  // NOTE: secrets are assembled with repeat/concat so the checked-in file
  // contains no literal scanner-matching credential (push protection).
  // The regexes still see the full real shape at runtime.
  const glpat = "glpat-" + "a1".repeat(10);
  const glrt = "glrt-" + "b2".repeat(10);
  const glcbt = "glcbt-" + "c3".repeat(10);
  const npmt = "npm_" + "d4".repeat(13);
  const jwt = ["eyJ" + "e".repeat(29), "f".repeat(24), "g".repeat(12)].join(".");
  const sk = "sk-" + "h5".repeat(12);
  const skant = "sk-ant-" + "j6".repeat(10);
  const gkey = "AIza" + "G7".repeat(17) + "H";
  const slackPath = "TAAA/BBBB/" + "x".repeat(24);
  const dockb64 = "dXNl" + "cjpwYXNz";
  it.each([
    [`GITLAB_TOKEN=${glpat}`, glpat],
    [`runner token ${glrt} here`, glrt],
    [`token ${glcbt} here`, glcbt],
    [`npm publish --//:_authToken=${npmt}`, npmt],
    [`id_token=${jwt}`, jwt],
    [`OPENAI_KEY=${sk}`, sk],
    [`key ${skant} here`, skant],
    [`maps key ${gkey} end`, gkey],
    [`post https://hooks.slack.com/services/${slackPath} now`, "x".repeat(24)],
    [`{"auths":{"r":{"auth":"${dockb64}"}}}`, dockb64],
  ])("redacts the credential in %s", (line, secret) => {
    const { text, redactions } = redactText(line);
    expect(text).not.toContain(secret);
    expect(redactions).toBeGreaterThan(0);
  });

  it("keeps the Slack webhook host for debuggability", () => {
    const { text } = redactText(
      "x https://hooks.slack.com/services/T/B/secret-seed-value-123 y",
    );
    expect(text).toContain("https://hooks.slack.com/services/[REDACTED]");
  });

  it("keeps the docker auth key name for debuggability", () => {
    const { text } = redactText(`{"auth":"${dockb64}"}`);
    expect(text).toContain('"auth":"[REDACTED]"');
  });

  it.each([
    "task-123 failed, disk-space low",
    "npm_foo is not defined",
    '"auth": "ok"',
    "saw eyJ.a.b in the docs",
  ])("leaves lookalike prose untouched: %s", (line) => {
    const { text, redactions } = redactText(line);
    expect(text).toBe(line);
    expect(redactions).toBe(0);
  });
});
