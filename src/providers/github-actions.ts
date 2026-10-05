import { fetchRunBundle } from "../core/github.js";
import { parseGitHubRunUrl } from "../core/url.js";
import type { CiFetchResult, CiProvider } from "./types.js";

export class GitHubActionsProvider implements CiProvider {
  readonly id = "github-actions";

  matches(input: string): boolean {
    return parseGitHubRunUrl(input.trim()) !== null;
  }

  async fetch(input: string, opts: { token?: string }): Promise<CiFetchResult> {
    const parsed = parseGitHubRunUrl(input.trim());
    if (!parsed) throw new Error(`Not a GitHub Actions run URL: ${input}`);
    const bundle = await fetchRunBundle(
      parsed.owner,
      parsed.repo,
      parsed.runId,
      opts.token,
    );
    return {
      run: {
        id: bundle.run.id,
        name: bundle.run.name ?? bundle.run.workflowName ?? undefined,
        workflowName: bundle.run.name ?? bundle.run.workflowName ?? undefined,
        headBranch: bundle.run.head_branch ?? undefined,
        headSha: bundle.run.head_sha ?? undefined,
        event: bundle.run.event ?? undefined,
        conclusion: bundle.run.conclusion ?? undefined,
        htmlUrl: bundle.run.html_url,
        createdAt: bundle.run.created_at,
      },
      jobs: bundle.jobs.map((j) => ({
        id: j.id,
        name: j.name,
        conclusion: j.conclusion ?? undefined,
        steps: j.steps?.map((s) => ({
          name: s.name,
          number: s.number,
          conclusion: s.conclusion ?? undefined,
        })),
        runnerName: j.runner_name,
        runnerOs: j.runner_os,
        runnerArch: j.runner_arch,
      })),
      logsByJob: bundle.logsByJob,
      combinedLogs: bundle.combinedLogs,
    };
  }
}

export function failingJobName(result: CiFetchResult): string | undefined {
  const j = result.jobs.find((x) => x.conclusion === "failure");
  return j?.name;
}

export function failingStepName(result: CiFetchResult): string | undefined {
  for (const j of result.jobs) {
    const s = j.steps?.find((x) => x.conclusion === "failure");
    if (s) return s.name;
  }
  return undefined;
}
