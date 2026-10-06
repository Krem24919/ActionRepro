/**
 * Minimal, strictly best-effort extraction of a step's `run:` script from
 * workflow YAML text. This is NOT a YAML parser: it finds `- name: <step>`
 * (or `- run:`) followed by a `run:` key and captures its inline value or
 * indented block lines. Returns null when unsure — callers must degrade
 * gracefully, never guess.
 */

export interface StepScript {
  stepName: string;
  script: string;
}

function indentOf(line: string): number {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

export function extractStepScript(yaml: string, stepName: string): StepScript | null {
  const lines = yaml.split(/\r?\n/);
  const want = stepName.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const stepMatch = lines[i].match(/^\s*-\s*name\s*:\s*(.+?)\s*$/);
    if (!stepMatch) continue;
    const found = stepMatch[1]
      .replace(/^['"]|['"]$/g, "")
      .trim()
      .toLowerCase();
    if (found !== want) continue;
    const baseIndent = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length; j++) {
      const lj = lines[j];
      if (lj.trim() === "" || lj.trim().startsWith("#")) continue;
      if (indentOf(lj) <= baseIndent && lj.trim() !== "") return null;
      const runMatch = lj.match(/^\s*run\s*:\s*(.*)$/);
      if (!runMatch) {
        if (/^\s*-\s*\w/.test(lj) && indentOf(lj) <= baseIndent + 2) return null;
        continue;
      }
      const rest = runMatch[1].trim();
      if (rest !== "" && !/^[|>][-+]?$/.test(rest)) {
        const unquoted =
          rest.length >= 2 &&
          ((rest.startsWith("'") && rest.endsWith("'")) ||
            (rest.startsWith('"') && rest.endsWith('"')))
            ? rest.slice(1, -1)
            : rest;
        return { stepName, script: unquoted };
      }
      // Block scalar: collect more-indented lines.
      const runIndent = indentOf(lj);
      const block: string[] = [];
      for (let k = j + 1; k < lines.length; k++) {
        const lk = lines[k];
        if (lk.trim() === "") {
          block.push("");
          continue;
        }
        if (indentOf(lk) <= runIndent) break;
        block.push(lk.slice(runIndent + 2));
      }
      const script = block.join("\n").replace(/\n+$/, "");
      return script ? { stepName, script } : null;
    }
    return null;
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
  if (norm(a) === norm(b)) return true;
  // The log often shows the expanded/resolved form; agree when one side
  // starts with the other (e.g. `npm test` vs `npm test -- --runInBand`).
  if (norm(b).startsWith(norm(a)) || norm(a).startsWith(norm(b))) return true;
  return false;
}
