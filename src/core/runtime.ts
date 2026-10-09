import { normalizedLines } from "./logs.js";

export interface RuntimeInfo {
  os?: string;
  arch?: string;
  node?: string;
  python?: string;
  go?: string;
  rust?: string;
  java?: string;
  dotnet?: string;
  ruby?: string;
  packageManager?: string;
  runnerName?: string;
}

/**
 * Operating system from the runner's setup banner. Real GitHub logs put the name on its own line
 * with the version on the following indented lines ("Operating System" / "  Ubuntu" / "  22.04.4" /
 * "  LTS"), so the value is joined across those lines.
 */
export function operatingSystem(joined: string): string | undefined {
  const lines = joined.split("\n");
  const idx = lines.findIndex((l) => /^\s*Operating System\s*$/.test(l));
  if (idx >= 0) {
    // Continuation lines: at most three short lines, stopping at a blank line or the next section.
    const parts: string[] = [];
    for (let i = idx + 1; i < lines.length && parts.length < 3; i++) {
      const t = lines[i].trim();
      if (t === "" || t.includes(":") || NEXT_SECTION_RE.test(t)) break;
      parts.push(t);
    }
    if (parts.length > 0) return parts.join(" ");
  }
  const inline = joined.match(/^[ \t]*Operating System:?[ \t]+(\S[^\n]*)$/m);
  if (inline) return inline[1].trim();
  const running = joined.match(/Running on (Ubuntu|Windows|macOS)([^\n]*)/i);
  if (running) return `${running[1]}${running[2]}`.trim();
  return undefined;
}

const NEXT_SECTION_RE =
  /^(Runner Image|Runner Name|Runner name|Runner Group|Machine name|Current runner|Hosted Compute|Included Software|Image Release)\b/i;

export function detectRuntime(logLines: string[]): RuntimeInfo {
  const lines = normalizedLines(logLines);
  const joined = lines.join("\n");
  const info: RuntimeInfo = {};

  const os = operatingSystem(joined);
  if (os) info.os = os;

  // Only labelled architecture lines describe the runner. A bare "x86_64" usually comes from a
  // build flag (for example `--target x86_64-unknown-linux-gnu`), which is not the runner.
  const arch = joined.match(
    /\b(?:architecture|arch|platform)\b[^\n]{0,20}?\b(x64|x86_64|amd64|arm64|aarch64)\b/i,
  );
  if (arch) info.arch = arch[1].toLowerCase() === "amd64" ? "x64" : arch[1].toLowerCase();

  const node =
    joined.match(/Node(?:\.js)? (?:version )?v?(\d+\.\d+\.\d+)/i) ??
    joined.match(/node\/v?(\d+\.\d+\.\d+)/i) ??
    joined.match(/hostedtoolcache\/node\/(\d+\.\d+\.\d+)/i);
  if (node) info.node = node[1];

  const py =
    joined.match(/(?:CPython|Python)[^\d\n]*(\d+\.\d+\.\d+)/) ??
    joined.match(/python3? (\d+\.\d+\.\d+)/i);
  if (py) info.python = py[1];

  const go = joined.match(/go version go(\d+\.\d+(?:\.\d+)?)/i);
  if (go) info.go = go[1];

  const rust = joined.match(/rustc (\d+\.\d+\.\d+)/i);
  if (rust) info.rust = rust[1];

  const java = joined.match(/(?:openjdk|java) version "([^"]+)"/i);
  if (java) info.java = java[1];

  const dotnet = joined.match(/\.NET SDK[\s\S]{0,300}?Version:\s*([0-9][^\s]*)/i);
  if (dotnet) info.dotnet = dotnet[1];

  const ruby = joined.match(/\bruby (\d+\.\d+\.\d+)/i);
  if (ruby) info.ruby = ruby[1];

  const pm =
    joined.match(/\bnpm[@\s]v?(\d+\.\d+\.\d+)/i) ??
    joined.match(/\bpnpm (\d+\.\d+\.\d+)/i) ??
    joined.match(/\byarn (\d+\.\d+\.\d+)/i);
  if (pm) info.packageManager = pm[0].trim();

  const runner = joined.match(/Runner name:\s*([^\n]+)/i);
  if (runner) info.runnerName = runner[1].trim();

  return info;
}

export function formatEnvironment(info: RuntimeInfo): string {
  const rows: [string, string][] = [
    ["OS", info.os ?? "unknown (CI runner, likely Ubuntu latest)"],
    ["Arch", info.arch ?? "unknown"],
    ["Node", info.node ?? "not detected"],
    ["Python", info.python ?? "not detected"],
    ["Go", info.go ?? "not detected"],
    ["Rust", info.rust ?? "not detected"],
    ["Java", info.java ?? "not detected"],
    [".NET", info.dotnet ?? "not detected"],
    ["Ruby", info.ruby ?? "not detected"],
    ["Package manager", info.packageManager ?? "not detected"],
    ["Runner", info.runnerName ?? "GitHub-hosted runner"],
  ];
  return rows.map(([k, v]) => `${k}: ${v}`).join("\n");
}
