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
