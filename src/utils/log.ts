export function info(msg: string): void {
  console.log(msg);
}

export function warn(msg: string): void {
  console.warn(`warning: ${msg}`);
}

export function error(msg: string): void {
  console.error(`error: ${msg}`);
}

/**
 * Neutralize GitHub Actions workflow-command markers (`##[`, `::`) in
 * human-readable stdout so log text copied from CI failures (e.g.
 * `##[error]Process completed with exit code 1.`) is never parsed by the
 * runner into phantom failure annotations. Deterministic: same input always
 * gives the same output. Machine-readable output (`--json`, `repro.json`)
 * and bundle files are left byte-identical.
 */
export function sanitizeActionsOutput(text: string): string {
  return text.replace(/##\[/g, "## [");
}
