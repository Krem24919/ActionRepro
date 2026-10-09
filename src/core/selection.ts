/**
 * Which job and step "failed" in a CI run. Shared by `inspect`, `reproduce`
 * and the MCP tools so every surface agrees on the same failing job.
 *
 * The failing step must come from the failing job. Picking "the first step
 * that failed in any job" could name a step from a different job and mislead
 * both the summary and the workflow lookup.
 */

export interface SelectableStep {
  name: string;
  conclusion?: string | null;
}

export interface SelectableJob {
  name: string;
  conclusion?: string | null;
  steps?: SelectableStep[];
}

export interface FailureSelection {
  failingJob?: string;
  failingStep?: string;
}

export function selectFailure(jobs: SelectableJob[]): FailureSelection {
  const failed = jobs.find((j) => j.conclusion === "failure");
  if (failed) {
    return {
      failingJob: failed.name,
      failingStep: failed.steps?.find((s) => s.conclusion === "failure")?.name,
    };
  }
  // No job-level failure recorded: fall back to the first job with a failed
  // step (some providers only report step conclusions).
  for (const j of jobs) {
    const step = j.steps?.find((s) => s.conclusion === "failure");
    if (step) return { failingJob: j.name, failingStep: step.name };
  }
  return {};
}
