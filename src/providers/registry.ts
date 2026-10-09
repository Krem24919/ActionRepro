import { GitHubActionsProvider } from "./github-actions.js";
import { GitLabProvider, resolveGitLabToken } from "./gitlab.js";
import { resolveToken } from "../core/github.js";
import type { CiProvider } from "./types.js";

export const PROVIDERS: CiProvider[] = [
  new GitHubActionsProvider(),
  new GitLabProvider(),
];

/**
 * The provider whose URL shape matches, or undefined for local files/unknown input.
 * Provider URL shapes must not overlap: an input matching two providers is an error, because
 * silently taking the first one could send the request (and the token) to the wrong service.
 */
export function findProvider(input: string): CiProvider | undefined {
  const matches = PROVIDERS.filter((p) => p.matches(input));
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous CI provider for ${input}: ${matches.map((m) => m.id).join(", ")}. Use a local log file instead.`,
    );
  }
  return matches[0];
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
