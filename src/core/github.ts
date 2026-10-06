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

export function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "actionrepro",
    "X-GitHub-Api-Version": "2022-11-28",
  };
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
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) {
    throw new Error(
      `GitHub API 404 for ${url}. Check owner/repo/run id. For private repos set GITHUB_TOKEN.`,
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
  const res = await fetch(url, { headers: authHeaders(token) });
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
): Promise<GitHubRun> {
  return getJson(`${API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}`, token);
}

export async function fetchJobs(
  owner: string,
  repo: string,
  runId: string,
  token?: string,
): Promise<GitHubJob[]> {
  const jobs: GitHubJob[] = [];
  let page = 1;
  for (;;) {
    const data = await getJson(
      `${API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      token,
    );
    const batch: GitHubJob[] = data.jobs ?? [];
    jobs.push(...batch);
    const total: number = data.total_count ?? jobs.length;
    if (jobs.length >= total || batch.length === 0) break;
    page += 1;
    if (page > 10) break;
  }
  return jobs;
}

/** Plain-text logs for a single job (official endpoint, no scraping). */
export async function fetchJobLogs(
  owner: string,
  repo: string,
  jobId: number | string,
  token?: string,
): Promise<string> {
  return getText(`${API_BASE}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, token);
}

export async function fetchJobLogsById(
  owner: string,
  repo: string,
  jobId: number | string,
  token?: string,
): Promise<string> {
  return getText(`${API_BASE}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, token);
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
): Promise<WorkflowFile | null> {
  try {
    const run = (await getJson(
      `${API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}`,
      token,
    )) as { workflow_url?: string };
    if (!run.workflow_url) return null;
    const workflow = (await getJson(run.workflow_url, token)) as { path?: string };
    if (!workflow.path) return null;
    const file = (await getJson(
      `${API_BASE}/repos/${owner}/${repo}/contents/${workflow.path}?ref=${headSha}`,
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
): Promise<RunBundle> {
  const run = await fetchRun(owner, repo, runId, token);
  const jobs = await fetchJobs(owner, repo, runId, token);
  const logsByJob = new Map<string, string>();
  const parts: string[] = [];
  for (const job of jobs) {
    try {
      const logs = await fetchJobLogs(owner, repo, job.id, token);
      logsByJob.set(String(job.id), logs);
      parts.push(
        `\n===== JOB: ${job.name} (id=${job.id}, conclusion=${job.conclusion}) =====\n${logs}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const placeholder = `(could not fetch logs for job ${job.name}: ${msg})`;
      logsByJob.set(String(job.id), placeholder);
      parts.push(`\n===== JOB: ${job.name} =====\n${placeholder}`);
    }
  }
  return { run, jobs, logsByJob, combinedLogs: parts.join("\n") };
}

export function pickFailingJob(jobs: GitHubJob[]): GitHubJob | undefined {
  return (
    jobs.find((j) => j.conclusion === "failure") ??
    jobs.find((j) => j.steps?.some((s) => s.conclusion === "failure"))
  );
}

export function pickFailingStep(job?: GitHubJob): string | undefined {
  return job?.steps?.find((s) => s.conclusion === "failure")?.name;
}
