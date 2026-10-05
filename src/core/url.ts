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

export function parseGitHubRunUrl(input: string): ParsedRunUrl | null {
  const trimmed = input.trim();
  let m = trimmed.match(RUN_URL_RE);
  if (m) {
    return { owner: m[1], repo: m[2].replace(/\.git$/, ""), runId: m[3] };
  }
  m = trimmed.match(API_URL_RE);
  if (m) {
    return { owner: m[1], repo: m[2], runId: m[3] };
  }
  return null;
}

export function isGitHubRunUrl(input: string): boolean {
  return parseGitHubRunUrl(input) !== null;
}

export function toRunHtmlUrl(owner: string, repo: string, runId: string): string {
  return `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
}
