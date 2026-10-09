import { tokenAllowedFor } from "./url.js";
import { spawnSync } from "node:child_process";

export interface GitHubRun {
  id: number;
  name?: string;
  workflowName?: string;
  head_branch?: string;
  head_sha?: string;
  event?: string;
  conclusion?: string | null;
  status?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface GitHubJob {
  id: number;
  run_id: number;
  name: string;
  conclusion?: string | null;
  status?: string;
  html_url?: string;
  runner_name?: string;
  runner_os?: string;
  runner_arch?: string;
  steps?: Array<{
    name: string;
    number?: number;
    conclusion?: string | null;
    status?: string;
  }>;
}

const API_BASE = "https://api.github.com";

/**
 * Upper bound for one API request (headers + body). Without it a stalled
 * connection would hang `reproduce`/`inspect` forever.
 */
export const HTTP_TIMEOUT_MS = 60_000;

/**
 * Request headers for a GitHub API call. When `url` is given, no token is ever sent to a host
 * that tokenAllowedFor() rejects (so a crafted URL cannot receive GITHUB_TOKEN from the
 * environment). Without `url` the caller is responsible for the host.
 */
export function authHeaders(token?: string, url?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "actionrepro",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (url !== undefined) {
    const host = new URL(url).host.toLowerCase();
    // The REST API host of github.com is api.github.com; it is the same trust domain.
    const webHost = host === "api.github.com" ? "github.com" : host;
    if (!tokenAllowedFor(webHost)) return h;
  }
  const t = (token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

export type TokenSource = "flag" | "env" | "gh" | "none";

const TOKEN_SHAPE = /^[A-Za-z0-9_.-]+$/;

/** Read the GitHub CLI token without ever printing it. Silent when unavailable. */
function tokenFromGh(): string | undefined {
  try {
    const r = spawnSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0) return undefined;
    const t = String(r.stdout ?? "").trim();
    if (!t || !TOKEN_SHAPE.test(t)) return undefined;
    return t;
  } catch {
    return undefined;
  }
}

/**
 * Token precedence: explicit --token flag, then GITHUB_TOKEN/GH_TOKEN env,
 * then the GitHub CLI (`gh auth token`). The `gh` subprocess runs locally
 * only; its output is validated and never printed.
 */
export function resolveTokenWithSource(explicit?: string): {
  token?: string;
  source: TokenSource;
} {
  const flag = (explicit ?? "").trim();
  if (flag) return { token: flag, source: "flag" };
  const env = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim();
  if (env) return { token: env, source: "env" };
  const gh = tokenFromGh();
  if (gh) return { token: gh, source: "gh" };
  return { source: "none" };
}

export function resolveToken(explicit?: string): string | undefined {
  return resolveTokenWithSource(explicit).token;
}

async function getJson(url: string, token?: string): Promise<any> {
  const res = await fetch(url, {
    headers: authHeaders(token, url),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 404) {
    throw new Error(
      `GitHub API 404 for ${url}. Check owner/repo/run id. For private repos set GITHUB_TOKEN ` +
        `(on GitHub Enterprise also set GH_HOST to the host name).`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const extra =
      remaining === "0"
        ? " Rate limit exhausted — set GITHUB_TOKEN to raise the limit."
        : " Authentication/permission failed — set GITHUB_TOKEN for private repos.";
    throw new Error(`GitHub API ${res.status} for ${url}.${extra}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function getText(url: string, token?: string): Promise<string> {
  const res = await fetch(url, {
    headers: authHeaders(token, url),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `GitHub API ${res.status} fetching logs: ${body.slice(0, 200)} ` +
          `(downloading Actions logs requires authentication even for public repos — ` +
          `set GITHUB_TOKEN; any token with no scopes works for public repos).`,
      );
    }
    throw new Error(`GitHub API ${res.status} fetching logs: ${body.slice(0, 300)}`);
  }
  return res.text();
}

const LOG_FETCH_FAILURE_PREFIX = "(could not fetch logs for job";

/**
 * Placeholder protocol (see ARCHITECTURE.md): an undownloadable job log is
 * `(could not fetch logs for job <id>: <reason>)`. The job id never contains
 * a colon, so the reason is always everything after the first `: `.
 */
export function logFetchPlaceholder(jobId: string | number, reason: string): string {
  return `${LOG_FETCH_FAILURE_PREFIX} ${jobId}: ${reason})`;
}

export function allLogsFailed(logsByJob: Map<string, string>): boolean {
  if (logsByJob.size === 0) return true;
  for (const logs of logsByJob.values()) {
    if (!logs.startsWith(LOG_FETCH_FAILURE_PREFIX)) return false;
  }
  return true;
}

export function firstLogError(logsByJob: Map<string, string>): string {
  for (const logs of logsByJob.values()) {
    if (logs.startsWith(LOG_FETCH_FAILURE_PREFIX)) {
      const m = logs.match(/^\(could not fetch logs for job [^:]+: (.*)\)$/s);
      return m ? m[1] : logs;
    }
  }
  return "unknown log fetch error";
}

export async function fetchRun(
  owner: string,
  repo: string,
  runId: string,
  token?: string,
  apiBase: string = API_BASE,
): Promise<GitHubRun> {
  return getJson(`${apiBase}/repos/${owner}/${repo}/actions/runs/${runId}`, token);
}

/** Upper bound on job-list pages (100 jobs each). The API's total_count normally stops the loop earlier. */
export const MAX_JOB_PAGES = 100;

export async function fetchJobs(
  owner: string,
  repo: string,
  runId: string,
  token?: string,
  apiBase: string = API_BASE,
): Promise<GitHubJob[]> {
  const jobs: GitHubJob[] = [];
  let page = 1;
  for (;;) {
    const data = await getJson(
      `${apiBase}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      token,
    );
    const batch: GitHubJob[] = data.jobs ?? [];
    jobs.push(...batch);
    const total: number = data.total_count ?? jobs.length;
    if (jobs.length >= total || batch.length === 0) break;
    page += 1;
    // Safety valve only: 100 pages x 100 jobs. The run's own total_count ends the loop normally.
    if (page > MAX_JOB_PAGES) break;
  }
  return jobs;
}

/** Plain-text logs for a single job (official endpoint, no scraping). */
export async function fetchJobLogs(
  owner: string,
  repo: string,
  jobId: number | string,
  token?: string,
  apiBase: string = API_BASE,
): Promise<string> {
  return getText(`${apiBase}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, token);
}

export interface WorkflowFile {
  path: string;
  sha: string;
  text: string;
}

/**
 * Fetch the workflow YAML at the exact head SHA of a run. Best-effort:
 * returns null on any failure (private repo without token, deleted file,
 * API hiccup). Never throws, never prints secrets.
 */
export async function fetchWorkflowFile(
  owner: string,
  repo: string,
  runId: string,
  headSha: string,
  token?: string,
  apiBase: string = API_BASE,
): Promise<WorkflowFile | null> {
  try {
    const run = (await getJson(
      `${apiBase}/repos/${owner}/${repo}/actions/runs/${runId}`,
      token,
    )) as { workflow_id?: number | string };
    // Build the workflow URL from the id on the same API base, instead of following the
    // response's workflow_url: every request then stays on the host the run came from.
    if (run.workflow_id === undefined || run.workflow_id === null) return null;
    const workflowId = encodeURIComponent(String(run.workflow_id));
    const workflow = (await getJson(
      `${apiBase}/repos/${owner}/${repo}/actions/workflows/${workflowId}`,
      token,
    )) as { path?: string };
    if (!workflow.path) return null;
    // Encode each path segment (names may contain spaces, #, ? ...) and the ref.
    const encodedPath = workflow.path.split("/").map(encodeURIComponent).join("/");
    const file = (await getJson(
      `${apiBase}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(headSha)}`,
      token,
    )) as { content?: string; sha?: string; type?: string };
    if (file.type && file.type !== "file") return null;
    if (!file.content) return null;
    const text = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
    if (!text.trim()) return null;
    return { path: workflow.path, sha: file.sha ?? headSha, text };
  } catch {
    return null;
  }
}

export interface RunBundle {
  run: GitHubRun;
  jobs: GitHubJob[];
  logsByJob: Map<string, string>;
  combinedLogs: string;
}

export async function fetchRunBundle(
  owner: string,
  repo: string,
  runId: string,
  token?: string,
  apiBase: string = API_BASE,
): Promise<RunBundle> {
  const run = await fetchRun(owner, repo, runId, token, apiBase);
  const jobs = await fetchJobs(owner, repo, runId, token, apiBase);
  const logsByJob = new Map<string, string>();
  const parts: string[] = [];
  for (const job of jobs) {
    try {
      const logs = await fetchJobLogs(owner, repo, job.id, token, apiBase);
      logsByJob.set(String(job.id), logs);
      parts.push(
        `\n===== JOB: ${job.name} (id=${job.id}, conclusion=${job.conclusion}) =====\n${logs}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const placeholder = logFetchPlaceholder(job.id, msg);
      logsByJob.set(String(job.id), placeholder);
      parts.push(`\n===== JOB: ${job.name} =====\n${placeholder}`);
    }
  }
  return { run, jobs, logsByJob, combinedLogs: parts.join("\n") };
}
