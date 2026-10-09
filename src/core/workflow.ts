/**
 * Minimal, strictly best-effort extraction of a step's `run:` script from
 * workflow YAML text. This is NOT a YAML parser. Lookup order:
 *
 *   1. Scope to the failing *job* (by Jobs-API name) when it identifies
 *      exactly one `jobs:<id>` block — otherwise the first name match in the
 *      file wins, which can be the wrong job when step names repeat.
 *   2. Match `- name: <step>` exactly (case-insensitive).
 *   3. Match unnamed `run:` steps via GitHub's synthesized display name
 *      `Run <first script line>` (that is how they appear in the Steps API).
 *
 * Returns null when unsure — callers must degrade gracefully, never guess.
 */

export interface StepScript {
  stepName: string;
  script: string;
}

function indentOf(line: string): number {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return t.length >= 2 &&
    ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))
    ? t.slice(1, -1)
    : t;
}

/** Read the `run:` value starting at line `runIdx` (`rest` = text after `run:`). */
function readRunValue(lines: string[], runIdx: number, rest: string): string | null {
  const text = rest.trim();
  if (text !== "" && !/^[|>][-+]?$/.test(text)) {
    return stripQuotes(text) || null;
  }
  // Block scalar: collect more-indented lines.
  const runIndent = indentOf(lines[runIdx]);
  const block: string[] = [];
  for (let k = runIdx + 1; k < lines.length; k++) {
    const lk = lines[k];
    if (lk.trim() === "") {
      block.push("");
      continue;
    }
    if (indentOf(lk) <= runIndent) break;
    block.push(lk.slice(runIndent + 2));
  }
  const script = block.join("\n").replace(/\n+$/, "");
  return script || null;
}

interface JobBlock {
  id: string;
  name: string | null;
  start: number;
  end: number;
}

/** Split the `jobs:` mapping into per-job line ranges (best-effort). */
function jobBlocks(lines: string[]): JobBlock[] | null {
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (jobsIdx < 0) return null;
  const blocks: JobBlock[] = [];
  let cur: { id: string; start: number } | null = null;
  const close = (end: number) => {
    if (!cur) return;
    let nm: string | null = null;
    for (let k = cur.start + 1; k < end; k++) {
      const m = lines[k].match(/^ {4}name\s*:\s*(.+?)\s*$/);
      if (m) {
        nm = stripQuotes(m[1]);
        break;
      }
    }
    blocks.push({ id: cur.id, name: nm, start: cur.start, end });
    cur = null;
  };
  for (let i = jobsIdx + 1; i <= lines.length; i++) {
    const done = i >= lines.length;
    const l = done ? "" : lines[i];
    const m = done ? null : l.match(/^ {2}([^:\s#][^:]*?):\s*(#.*)?$/);
    if (m) {
      close(i);
      cur = { id: m[1].trim(), start: i };
      continue;
    }
    if (
      done ||
      (l.trim() !== "" &&
        !l.startsWith(" ") &&
        !l.startsWith("\t") &&
        !l.trim().startsWith("#"))
    ) {
      close(i); // Left the jobs: section (or EOF).
      break;
    }
  }
  return blocks;
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
  const lines = yaml.split(/\r?\n/);
  let scope = lines;
  if (jobName?.trim()) {
    const blocks = jobBlocks(lines);
    if (blocks) {
      const hits = blocks.filter((b) => jobMatches(b.id, b.name, jobName));
      if (hits.length === 1) scope = lines.slice(hits[0].start, hits[0].end);
    }
  }
  const want = stepName.trim().toLowerCase();

  // Pass 1: exact `- name:` match.
  for (let i = 0; i < scope.length; i++) {
    const stepMatch = scope[i].match(/^\s*-\s*name\s*:\s*(.+?)\s*$/);
    if (!stepMatch) continue;
    const found = stripQuotes(stepMatch[1]).toLowerCase();
    if (found !== want) continue;
    const baseIndent = indentOf(scope[i]);
    for (let j = i + 1; j < scope.length; j++) {
      const lj = scope[j];
      if (lj.trim() === "" || lj.trim().startsWith("#")) continue;
      if (indentOf(lj) <= baseIndent && lj.trim() !== "") return null;
      const runMatch = lj.match(/^\s*run\s*:\s*(.*)$/);
      if (!runMatch) {
        if (/^\s*-\s*\w/.test(lj) && indentOf(lj) <= baseIndent + 2) return null;
        continue;
      }
      const script = readRunValue(scope, j, runMatch[1]);
      return script ? { stepName, script } : null;
    }
    return null;
  }

  // Pass 2: unnamed `run:` steps, shown by the API as `Run <first line>`.
  for (let i = 0; i < scope.length; i++) {
    const runMatch = scope[i].match(/^\s*-\s*run\s*:(.*)$/);
    if (!runMatch) continue;
    const script = readRunValue(scope, i, runMatch[1]);
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
