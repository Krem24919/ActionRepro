/**
 * Secret redaction. Deterministic, no network, no LLM.
 *
 * Goals:
 * - Never print credentials in CLI output, files, or GitHub comments.
 * - Redact well-known token formats + `key=value` secrets + URL-embedded creds.
 * - Also redact values of known-sensitive env var names found in logs.
 */

const SECRET_ENV_NAMES = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPMRC_TOKEN",
  "YARN_TOKEN",
  "PNPM_TOKEN",
  "CARGO_REGISTRY_TOKEN",
  "CRATES_IO_TOKEN",
  "PYPI_TOKEN",
  "PYPI_PASSWORD",
  "TWINE_PASSWORD",
  "DOCKER_PASSWORD",
  "DOCKERHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CREDENTIALS",
  "GOOGLE_CREDENTIALS",
  "GCP_SA_KEY",
  "PRIVATE_KEY",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "TOKEN",
  "API_KEY",
  "APIKEY",
  "AUTH_TOKEN",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "SESSION_TOKEN",
  "WEBHOOK_SECRET",
  "SIGNING_SECRET",
  "ENCRYPTION_KEY",
  "COOKIE_SECRET",
];

const PATTERNS: RegExp[] = [
  // GitHub tokens
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bghu_[A-Za-z0-9]{20,}\b/g,
  /\bghs_[A-Za-z0-9]{20,}\b/g,
  /\bghr_[A-Za-z0-9]{20,}\b/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  // Generic bearer / basic
  /\bBearer\s+[A-Za-z0-9\-._~+/=]{10,}/g,
  /\bBasic\s+[A-Za-z0-9+/=]{10,}/g,
  // AWS keys
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\s*[:=]\s*['"]?[^'"\s]+['"]?/gi,
  // Slack / Stripe-ish
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk_(live|test)_[A-Za-z0-9]{10,}/g,
  // PEM private keys (redact whole block)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // URL with credentials: https://user:pass@host
  /https?:\/\/[^/\s:]+:[^/\s@]+@[^\s]+/g,
  // key=value secrets (case-insensitive key match)
  /\b(password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"]?[^'"\s;,}]+['"]?/gi,
  // npmrc auth lines: //registry.../:_authToken=VALUE
  /_authToken\s*=\s*[^\s]+/g,
  /_auth\s*=\s*[^\s]+/g,
  /_password\s*=\s*[^\s]+/g,
];

export interface RedactResult {
  text: string;
  redactions: number;
}

export function redactText(input: string): RedactResult {
  let text = input;
  let redactions = 0;

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, (m) => {
      redactions += 1;
      // Keep key name for key=value matches so output stays debuggable.
      const kv = m.match(
        /^(\b[\w-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*)(.*)$/i,
      );
      if (kv) return `${kv[1]}[REDACTED]`;
      if (/^Bearer\s+/i.test(m)) return "Bearer [REDACTED]";
      if (/^Basic\s+/i.test(m)) return "Basic [REDACTED]";
      if (/^https?:\/\//.test(m)) return m.replace(/:\/\/[^@]+@/, "://[REDACTED]@");
      if (/BEGIN .*PRIVATE KEY/.test(m)) return "[REDACTED PRIVATE KEY BLOCK]";
      return "[REDACTED]";
    });
  }

  // Redact values assigned to known sensitive env names, e.g. `GITHUB_TOKEN=abc123`.
  for (const name of SECRET_ENV_NAMES) {
    const re = new RegExp(
      `\\b${escapeRegExp(name)}\\b\\s*[:=]\\s*['"]?[^'"\\s;,}]+['"]?`,
      "g",
    );
    text = text.replace(re, () => {
      redactions += 1;
      return `${name}=[REDACTED]`;
    });
    // Also `export NAME=value`
    const re2 = new RegExp(`\\bexport\\s+${escapeRegExp(name)}\\s*=\\s*[^\\s;,}]+`, "g");
    text = text.replace(re2, () => {
      redactions += 1;
      return `export ${name}=[REDACTED]`;
    });
  }

  return { text, redactions };
}

export function redactLines(lines: string[]): { lines: string[]; redactions: number } {
  let total = 0;
  const out = lines.map((l) => {
    const r = redactText(l);
    total += r.redactions;
    return r.text;
  });
  return { lines: out, redactions: total };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Quick check used in tests: no obvious credential survives. */
export function looksClean(text: string): boolean {
  const probe = redactText(text);
  return probe.text === text || !containsTokenShape(probe.text);
}

function containsTokenShape(text: string): boolean {
  return /\bghp_[A-Za-z0-9]{20,}\b/.test(text);
}
