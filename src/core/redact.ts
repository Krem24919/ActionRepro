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
  "GITLAB_TOKEN",
  "GITLAB_PAT",
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
  // GitLab tokens (the tool reads GitLab pipelines, so its own PAT formats
  // must be covered): glpat- personal/project/group tokens, glrt- runner
  // tokens, glcbt- CI/build tokens. The prefixes never occur in prose.
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bglrt-[A-Za-z0-9_-]{20,}/g,
  /\bglcbt-[A-Za-z0-9_-]{20,}/g,
  // npm granular access tokens (`npm_` + 36 chars). Short `npm_foo`
  // identifiers in code are left alone by the length floor.
  /\bnpm_[A-Za-z0-9]{20,}/g,
  // Bare JWTs (`eyJ` = base64 `{"`, three dot-separated segments). The
  // `Authorization: Bearer` form above already covers header use.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Other `sk-` secret keys (OpenAI, Anthropic `sk-ant-`, ...). The `\b`
  // keeps words like `task-123` or `disk-space` safe; the length floor keeps
  // short `sk-foo` identifiers safe. (`sk_live_`/`sk_test_` match too.)
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // Google API keys: `AIza` + exactly 35 base64url chars.
  /\bAIza[0-9A-Za-z_-]{35}/g,
  // Slack incoming-webhook URLs: the whole URL is the secret.
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/g,
  // Docker config.json auth entries: `"auth": "<base64(user:pass)>"`.
  /"auth"\s*:\s*"[A-Za-z0-9+/=]{8,}"/g,
  // An `Authorization:` header value is a credential whatever it looks like (a short base64 Basic
  // value such as `dXNlcjpwYXNz` has no digits, so the shape rules below would miss it).
  // Digest parameters are space-separated (`username="x", response="..."`), so that scheme takes the rest of the line.
  /\bauthorization\s*[:=]\s*['"]?(?:Digest\s+(?!\[REDACTED)[^\r\n]+|(?:Basic|Bearer|Token)\s+(?!\[REDACTED)[^\s'",;]+)/gi,
  // Generic bearer / basic. A value counts as a credential only when it looks
  // like one: >= 10 chars with a digit or symbol, or an inner case change such as
  // `dXNl` (base64), or all capitals; or a pure-letter run of >= 24 chars. Plain prose such as "Basic authentication failed" or
  // "Bearer token rejected" must not be mangled into "[REDACTED]".
  /\bBearer\s+(?:(?=[A-Za-z0-9\-._~+/=]*(?:[0-9._~+/=-]|[a-z][A-Z]))[A-Za-z0-9\-._~+/=]{10,}|(?=[A-Z]{10})[A-Z]{10,}|[A-Za-z]{24,})/g,
  /\bBasic\s+(?:(?=[A-Za-z0-9+/=]*(?:[0-9+/=-]|[a-z][A-Z]))[A-Za-z0-9+/=]{10,}|(?=[A-Z]{10})[A-Z]{10,}|[A-Za-z]{24,})/g,
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
      const header = m.match(
        /^(authorization\s*[:=]\s*['"]?(?:Basic|Bearer|Token|Digest)\s+)/i,
      );
      if (header) return `${header[1]}[REDACTED]`;
      if (/^Bearer\s+/i.test(m)) return "Bearer [REDACTED]";
      if (/^Basic\s+/i.test(m)) return "Basic [REDACTED]";
      if (/^https:\/\/hooks\.slack\.com\/services\//.test(m))
        return "https://hooks.slack.com/services/[REDACTED]";
      if (/^"auth"\s*:/.test(m)) return '"auth":"[REDACTED]"';
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
