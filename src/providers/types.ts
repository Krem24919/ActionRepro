/**
 * CI provider abstraction. MVP implements GitHub Actions only.
 * Future providers (GitLab CI, CircleCI, Jenkins, ...) implement this interface.
 */
export interface FailedStep {
  name: string;
  number?: number;
  conclusion?: string;
}

export interface CiJob {
  id: string | number;
  name: string;
  conclusion?: string;
  steps?: FailedStep[];
  runnerName?: string;
  runnerOs?: string;
  runnerArch?: string;
}

export interface CiRun {
  id: string | number;
  name?: string;
  workflowName?: string;
  headBranch?: string;
  headSha?: string;
  event?: string;
  conclusion?: string;
  htmlUrl?: string;
  createdAt?: string;
}

export interface CiFetchResult {
  run: CiRun;
  jobs: CiJob[];
  logsByJob: Map<string, string>;
  combinedLogs: string;
}

export interface CiProvider {
  readonly id: string;
  /** Return true if this provider can handle the given input string. */
  matches(input: string): boolean;
  /** Fetch run metadata + jobs + logs. */
  fetch(input: string, opts: { token?: string }): Promise<CiFetchResult>;
}
