import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { resolveTokenWithSource } from "../core/github.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
}

function toolVersion(cmd: string, args: string[]): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
    if (r.status === 0) {
      const out = `${r.stdout ?? ""} ${r.stderr ?? ""}`.trim().split("\n")[0]?.trim();
      return out?.slice(0, 120) || "installed";
    }
    return null;
  } catch {
    return null;
  }
}

async function networkOk(): Promise<{ ok: boolean; detail: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("https://api.github.com/rate_limit", {
      headers: { "User-Agent": "actionrepro", Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok || res.status === 403 || res.status === 401) {
      return { ok: true, detail: `reachable (HTTP ${res.status})` };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function doctor(): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "node",
    ok: true,
    detail: `${process.version} (platform=${os.platform()} arch=${os.arch()})`,
  });

  const tools: Array<[string, string[]]> = [
    ["git", ["--version"]],
    ["npm", ["--version"]],
    ["node", ["--version"]],
    ["pnpm", ["--version"]],
    ["yarn", ["--version"]],
    ["python3", ["--version"]],
    ["pip", ["--version"]],
    ["uv", ["--version"]],
    ["cargo", ["--version"]],
    ["go", ["version"]],
    ["mvn", ["--version"]],
    ["gradle", ["--version"]],
    ["dotnet", ["--version"]],
    ["ruby", ["--version"]],
    ["bash", ["--version"]],
  ];
  for (const [cmd, args] of tools) {
    const v = toolVersion(cmd, args);
    checks.push({
      name: cmd,
      ok: cmd === "git" || cmd === "node" || cmd === "bash" ? v !== null : true,
      detail:
        v ??
        ([
          "pnpm",
          "yarn",
          "uv",
          "cargo",
          "go",
          "python3",
          "pip",
          "npm",
          "mvn",
          "gradle",
          "dotnet",
          "ruby",
        ].includes(cmd)
          ? "not installed (optional — needed only for matching projects)"
          : "not found"),
    });
    // Optional tools should not fail doctor; mark ok=true with note.
    const last = checks[checks.length - 1];
    if (
      [
        "pnpm",
        "yarn",
        "python3",
        "pip",
        "uv",
        "cargo",
        "go",
        "npm",
        "mvn",
        "gradle",
        "dotnet",
        "ruby",
      ].includes(cmd)
    ) {
      last.ok = true;
    }
  }

  const { token, source } = resolveTokenWithSource();
  checks.push({
    name: "github-token",
    ok: true,
    detail:
      source === "none"
        ? "absent — set GITHUB_TOKEN, or install + auth the gh CLI (used automatically)"
        : `available via ${source} (will be used for API; never printed)`,
  });
  void token;

  const net = await networkOk();
  checks.push({ name: "network(api.github.com)", ok: net.ok, detail: net.detail });

  const termux = fs.existsSync("/data/data/com.termux/files/usr/bin");
  checks.push({
    name: "environment",
    ok: true,
    detail: termux
      ? "Termux detected — best-effort Linux path enabled (pkg install git nodejs python)"
      : `${os.type()} ${os.release()} — Linux/macOS/WSL recommended; Windows uses reproduce.ps1`,
  });

  // Required = node, git, bash (unless Windows), network.
  const requiredNames = ["node", "git", "network(api.github.com)"];
  if (process.platform !== "win32") requiredNames.push("bash");
  const ok = requiredNames.every((n) => checks.find((c) => c.name === n)?.ok);
  return { checks, ok };
}

export function formatDoctorHuman(r: DoctorResult): string {
  const lines = r.checks.map(
    (c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`,
  );
  lines.push(
    r.ok ? "doctor: all required checks passed" : "doctor: some required checks failed",
  );
  return ["ActionRepro doctor", ...lines].join("\n");
}
