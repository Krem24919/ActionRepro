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

export function detectRuntime(logLines: string[]): RuntimeInfo {
  const lines = normalizedLines(logLines);
  const joined = lines.join("\n");
  const info: RuntimeInfo = {};

  const osMatch =
    joined.match(/Running on (Ubuntu|Windows|macOS)([^\n]*)/i) ??
    joined.match(/Current runner version:[^\n]*\n[^\n]*Operating System:\s*([^\n]+)/i) ??
    joined.match(/Operating System:\s*([^\n]+)/i);
  if (osMatch) info.os = osMatch[1]?.trim() ?? osMatch[0].trim();

  const arch = joined.match(/\b(x64|x86_64|arm64|aarch64)\b/);
  if (arch) info.arch = arch[1];

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
