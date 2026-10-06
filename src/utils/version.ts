// Single source of truth is package.json; test/unit/version.test.ts fails
// the build if these drift apart.
export const VERSION = "0.1.1";

export function isCiReproUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function safeTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... [truncated ${text.length - maxChars} chars]`;
}
