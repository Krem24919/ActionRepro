/**
 * Best-effort extraction of a step's `run:` script from workflow YAML text.
 * The YAML is parsed with a real parser (`yaml`, pure JavaScript, no code
 * execution, alias expansion limited), so indentation style does not matter.
 *
 * Lookup order:
 *
 *   1. Scope to the failing *job* (by Jobs-API name) when it identifies
 *      exactly one job — otherwise the first name match in the file wins,
 *      which can be the wrong job when step names repeat.
 *   2. Match `name:` exactly (case-insensitive).
 *   3. Match unnamed `run:` steps via GitHub's synthesized display name
 *      `Run <first script line>` (that is how they appear in the Steps API).
 *
 * Returns null when unsure or when the YAML does not parse — callers must
 * degrade gracefully, never guess.
 */
import { parse } from "yaml";

export interface StepScript {
  stepName: string;
  script: string;
}

/** Parse options: aliases are capped (YAML alias bombs), duplicate keys are rejected. */
const PARSE_OPTIONS = { maxAliasCount: 100 } as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseWorkflow(yaml: string): Record<string, unknown> | null {
  try {
    const doc: unknown = parse(yaml, PARSE_OPTIONS);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** Every step object under any `steps:` list in this subtree, in document order. */
function collectSteps(
  node: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectSteps(item, out);
    return out;
  }
  if (!isRecord(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === "steps" && Array.isArray(value)) {
      for (const step of value) if (isRecord(step)) out.push(step);
    } else {
      collectSteps(value, out);
    }
  }
  return out;
}

/** Display name of a job: its `name:` when set, otherwise nothing (the id is used). */
function jobDisplayName(job: unknown): string | null {
  return isRecord(job) && typeof job.name === "string" ? job.name : null;
}

/** Trailing newlines from block scalars are not part of the command. */
function cleanScript(run: string): string {
  return run.replace(/\n+$/, "");
}

/**
 * Does a Jobs-API job name identify this workflow job? The API name is the
 * job id, its `name:`, or either with a matrix/slice suffix the API appends
 * (`test (20.x)`, `build / linux`).
 */
function jobMatches(id: string, name: string | null, wantRaw: string): boolean {
  const want = wantRaw.trim().toLowerCase();
  const lid = id.toLowerCase();
  if (!want || !lid) return false;
  if (want === lid) return true;
  if (name && want === name.toLowerCase()) return true;
  if (want.startsWith(`${lid} `) || want.startsWith(`${lid}/`)) return true;
  return false;
}

export function extractStepScript(
  yaml: string,
  stepName: string,
  jobName?: string,
): StepScript | null {
  const doc = parseWorkflow(yaml);
  if (!doc) return null;

  let scope: unknown = doc;
  if (jobName?.trim() && isRecord(doc.jobs)) {
    const hits = Object.entries(doc.jobs).filter(([id, job]) =>
      jobMatches(id, jobDisplayName(job), jobName),
    );
    if (hits.length === 1) scope = hits[0][1];
  }
  const steps = collectSteps(scope);
  const want = stepName.trim().toLowerCase();

  // Pass 1: exact `name:` match. A named step without a usable `run:` is not
  // guessed at: return null.
  for (const step of steps) {
    if (typeof step.name !== "string" || step.name.trim().toLowerCase() !== want)
      continue;
    if (typeof step.run !== "string") return null;
    const script = cleanScript(step.run);
    return script ? { stepName, script } : null;
  }

  // Pass 2: unnamed `run:` steps, shown by the API as `Run <first line>`.
  for (const step of steps) {
    if (typeof step.run !== "string") continue;
    const script = cleanScript(step.run);
    if (!script) continue;
    if (`run ${firstMeaningfulLine(script).toLowerCase()}` === want) {
      return { stepName, script };
    }
  }
  return null;
}

function firstMeaningfulLine(script: string): string {
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line;
  }
  return "";
}

/**
 * Compare the workflow-defined command with the log-derived one.
 * Returns true (match), false (conflict), or null (cannot tell).
 */
export function commandsAgree(
  workflowScript: string,
  logCommand: string,
): boolean | null {
  const a = firstMeaningfulLine(workflowScript);
  const b = logCommand.trim().split("\n")[0]?.trim() ?? "";
  if (!a || !b) return null;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // The log often shows the expanded/resolved form; agree when one side is the
  // other plus extra arguments (`npm test` vs `npm test -- --runInBand`). The
  // boundary must be a space: `go test` must not "agree" with `go testify`.
  const extendsWords = (short: string, long: string) => long.startsWith(`${short} `);
  if (extendsWords(na, nb) || extendsWords(nb, na)) return true;
  return false;
}
