export interface ParsedRunUrl {
  owner: string;
  repo: string;
  runId: string;
  attempt?: string;
  jobId?: string;
}

const RUN_URL_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/.*)?(?:[?#].*)?$/i;
const API_URL_RE =
  /^https?:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/i;

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function toParsed(owner: string, repo: string, runId: string): ParsedRunUrl | null {
  const cleanRepo = repo.replace(/\.git$/, "");
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(cleanRepo)) return null;
  if (owner === "." || owner === ".." || cleanRepo === "." || cleanRepo === "..") {
    return null;
  }
  return { owner, repo: cleanRepo, runId };
}

export function parseGitHubRunUrl(input: string): ParsedRunUrl | null {
  const trimmed = input.trim();
  let m = trimmed.match(RUN_URL_RE);
  if (m) {
    return toParsed(m[1], m[2], m[3]);
  }
  m = trimmed.match(API_URL_RE);
  if (m) {
    return toParsed(m[1], m[2], m[3]);
  }
  return null;
}

export function isGitHubRunUrl(input: string): boolean {
  return parseGitHubRunUrl(input) !== null;
}
