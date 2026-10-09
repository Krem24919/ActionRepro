import type { CiFetchResult, CiJob, CiProvider, CiRun } from "./types.js";
import { logFetchPlaceholder } from "../core/github.js";

/** Same ceiling as the GitHub provider: a stalled connection must fail, not hang. */
const HTTP_TIMEOUT_MS = 60_000;
/** GitLab's maximum page size; also the pagination stop condition. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export interface ParsedGitLabUrl {
  /** e.g. https://gitlab.com (self-hosted hosts work the same way). */
  base: string;
  /** URL-encoded project path, e.g. group%2Fsubgroup%2Frepo. */
  project: string;
  kind: "pipeline" | "job";
  id: string;
}

/**
 * GitLab pipeline/job URLs:
 *   https://<host>/<group>/[.../<subgroup>/]<repo>/-/pipelines/<iid>
 *   https://<host>/<group>/[.../<subgroup>/]<repo>/-/jobs/<id>
 */
export function parseGitLabUrl(input: string): ParsedGitLabUrl | null {
  const m = input
    .trim()
    .match(/^(https?:\/\/[^/]+)\/(.+?)\/-\/(pipelines|jobs)\/(\d+)\/?(?:[?#].*)?$/);
  if (!m) return null;
  return {
    base: m[1],
    project: encodeURIComponent(m[2]),
    kind: m[3] === "jobs" ? "job" : "pipeline",
    id: m[4],
  };
}

/** Token precedence for GitLab: explicit --token flag, then GITLAB_TOKEN env. */
export function resolveGitLabToken(explicit?: string): string | undefined {
  const t = (explicit ?? process.env["GITLAB_TOKEN"] ?? "").trim();
  return t === "" ? undefined : t;
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "actionrepro",
    Accept: "application/json",
  };
  if (token) h["PRIVATE-TOKEN"] = token;
  return h;
}

/** GitLab statuses use different words; normalize to the shared vocabulary. */
export function mapGitLabStatus(status: string | undefined): string | undefined {
  switch ((status ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "canceled":
      return "cancelled";
    default:
      return status;
  }
}

interface GitLabPipeline {
  id: number;
  sha?: string;
  ref?: string;
  status?: string;
  web_url?: string;
  created_at?: string;
}

interface GitLabJob {
  id: number;
  name: string;
  status?: string;
  stage?: string;
  web_url?: string;
  pipeline?: { id: number };
}

async function getJson(url: string, token: string | undefined): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: headers(token),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `GitLab API unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "GitLab API authentication failed (401/403). Set GITLAB_TOKEN (any token with read_api works for private projects; public projects usually need none).",
    );
  }
  if (res.status === 404) {
    throw new Error(
      `GitLab API 404 for ${url}. Check group/project/pipeline id. Private projects need GITLAB_TOKEN.`,
    );
  }
  if (!res.ok) {
    throw new Error(`GitLab API HTTP ${res.status} for ${url}.`);
  }
  return res.json() as Promise<unknown>;
}

async function getTrace(url: string, token: string | undefined): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { ...headers(token), Accept: "text/plain" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `GitLab trace download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Cannot download GitLab job trace (HTTP ${res.status}). Private projects need GITLAB_TOKEN.`,
    );
  }
  return res.text();
}

/**
 * All jobs of a pipeline. The API returns at most PAGE_SIZE per request, so a
 * pipeline with more jobs would otherwise silently lose the later ones (and
 * possibly the failing one).
 */
async function listPipelineJobs(
  api: string,
  pipelineId: number,
  token: string | undefined,
): Promise<GitLabJob[]> {
  const all: GitLabJob[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = ((await getJson(
      `${api}/pipelines/${pipelineId}/jobs?per_page=${PAGE_SIZE}&page=${page}`,
      token,
    )) ?? []) as GitLabJob[];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

export class GitLabProvider implements CiProvider {
  readonly id = "gitlab";

  matches(input: string): boolean {
    return parseGitLabUrl(input) !== null;
  }

  async fetch(input: string, opts: { token?: string }): Promise<CiFetchResult> {
    const parsed = parseGitLabUrl(input);
    if (!parsed) throw new Error(`Not a GitLab pipeline/job URL: ${input}`);
    const token = resolveGitLabToken(opts.token);
    const api = `${parsed.base}/api/v4/projects/${parsed.project}`;

    let pipelineIid = parsed.id;
    if (parsed.kind === "job") {
      const job = (await getJson(`${api}/jobs/${parsed.id}`, token)) as GitLabJob;
      if (!job?.pipeline?.id) {
        throw new Error(`GitLab job ${parsed.id} has no pipeline attached.`);
      }
      pipelineIid = String(job.pipeline.id);
    }

    const pipeline = (await getJson(
      `${api}/pipelines/${pipelineIid}`,
      token,
    )) as GitLabPipeline;
    const jobs = await listPipelineJobs(api, pipeline.id, token);

    const logsByJob = new Map<string, string>();
    const parts: string[] = [];
    for (const job of jobs ?? []) {
      let trace: string;
      try {
        trace = await getTrace(`${api}/jobs/${job.id}/trace`, token);
      } catch (err) {
        // Same placeholder protocol as the GitHub provider: allLogsFailed /
        // firstLogError in core/github.ts recognize this prefix, so a
        // pipeline with no downloadable traces fails fast with a token hint
        // instead of producing a bundle from error text.
        const why = err instanceof Error ? err.message : String(err);
        trace = logFetchPlaceholder(job.id, why);
      }
      logsByJob.set(String(job.id), trace);
      parts.push(`===== job: ${job.name} (status: ${job.status ?? "?"}) =====\n${trace}`);
    }

    const run: CiRun = {
      id: pipeline.id,
      workflowName: undefined,
      headBranch: pipeline.ref,
      headSha: pipeline.sha,
      conclusion: mapGitLabStatus(pipeline.status),
      htmlUrl: pipeline.web_url ?? input.trim(),
      createdAt: pipeline.created_at,
    };
    const ciJobs: CiJob[] = (jobs ?? []).map((j) => ({
      id: j.id,
      name: j.name,
      conclusion: mapGitLabStatus(j.status),
    }));
    return { run, jobs: ciJobs, logsByJob, combinedLogs: parts.join("\n") };
  }
}
