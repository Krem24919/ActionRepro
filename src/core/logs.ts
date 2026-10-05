import fs from "node:fs";

export interface LoadedLogs {
  source: "file" | "github";
  displayName: string;
  raw: string;
  lines: string[];
}

export function loadLogsFromFile(filePath: string): LoadedLogs {
  const raw = fs.readFileSync(filePath, "utf8");
  return {
    source: "file",
    displayName: filePath,
    raw,
    lines: splitLines(raw),
  };
}

export function logsFromText(text: string, displayName: string): LoadedLogs {
  return { source: "github", displayName, raw: text, lines: splitLines(text) };
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Strip GitHub Actions timestamp prefix `2024-01-01T00:00:00.0000000Z msg`. */
export function stripTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?/, "");
}

export function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, "");
}

export function normalizeLine(line: string): string {
  return stripTimestamp(stripAnsi(line));
}

export function normalizedLines(lines: string[]): string[] {
  return lines.map(normalizeLine);
}
