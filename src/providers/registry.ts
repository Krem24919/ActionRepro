import { GitHubActionsProvider } from "./github-actions.js";
import { GitLabProvider, resolveGitLabToken } from "./gitlab.js";
import { resolveToken } from "../core/github.js";
import type { CiProvider } from "./types.js";

export const PROVIDERS: CiProvider[] = [
  new GitHubActionsProvider(),
  new GitLabProvider(),
];

/** First provider whose URL shape matches, or undefined for local files/unknown input. */
export function findProvider(input: string): CiProvider | undefined {
  return PROVIDERS.find((p) => p.matches(input));
}

/**
 * Provider-aware token resolution: the explicit --token flag always wins,
 * otherwise each provider reads its own source (GitHub: GITHUB_TOKEN/
 * GH_TOKEN/gh CLI; GitLab: GITLAB_TOKEN). Tokens are never logged.
 */
export function resolveProviderToken(
  providerId: string,
  explicit?: string,
): string | undefined {
  if (providerId === "gitlab") return resolveGitLabToken(explicit);
  return resolveToken(explicit);
}
