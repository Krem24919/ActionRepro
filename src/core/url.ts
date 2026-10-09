export interface ParsedRunUrl {
  owner: string;
  repo: string;
  runId: string;
  attempt?: string;
  jobId?: string;
  /** Host the run lives on: `github.com`, or a GitHub Enterprise host. */
  host: string;
  /** REST API base for that host. */
  apiBase: string;
}

export const GITHUB_COM_HOST = "github.com";

/**
 * Accepts `https://github.com/OWNER/REPO/actions/runs/ID` and GitHub Enterprise
 * URLs of the same shape (`https://ghe.example.com/OWNER/REPO/actions/runs/ID`).
 */
const RUN_URL_RE =
  /^https?:\/\/((?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/.*)?(?:[?#].*)?$/i;
const API_URL_RE =
  /^https?:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/i;

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** REST API base URL for a host: api.github.com for github.com, `/api/v3` on Enterprise hosts. */
export function apiBaseFor(host: string): string {
  const h = host.toLowerCase();
  return h === GITHUB_COM_HOST ? "https://api.github.com" : `https://${h}/api/v3`;
}

/**
 * Whether the GitHub token may be sent to `host`. Only github.com always qualifies; an
 * Enterprise host qualifies only when the user names it in `GH_HOST` (the same variable the
 * `gh` CLI uses), so a crafted URL cannot receive the token.
 */
export function tokenAllowedFor(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const h = host.toLowerCase();
  if (h === GITHUB_COM_HOST) return true;
  const configured = (env.GH_HOST ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return configured !== "" && configured === h;
}

function toParsed(
  host: string,
  owner: string,
  repo: string,
  runId: string,
): ParsedRunUrl | null {
  const cleanRepo = repo.replace(/\.git$/, "");
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(cleanRepo)) return null;
  if (owner === "." || owner === ".." || cleanRepo === "." || cleanRepo === "..") {
    return null;
  }
  const h = host.toLowerCase();
  return { owner, repo: cleanRepo, runId, host: h, apiBase: apiBaseFor(h) };
}

export function parseGitHubRunUrl(input: string): ParsedRunUrl | null {
  const trimmed = input.trim();
  let m = trimmed.match(RUN_URL_RE);
  if (m) {
    return toParsed(m[1], m[2], m[3], m[4]);
  }
  m = trimmed.match(API_URL_RE);
  if (m) {
    return toParsed(GITHUB_COM_HOST, m[1], m[2], m[3]);
  }
  return null;
}

export function isGitHubRunUrl(input: string): boolean {
  return parseGitHubRunUrl(input) !== null;
}
