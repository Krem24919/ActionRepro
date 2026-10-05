import { normalizedLines } from "./logs.js";

export type EcosystemId =
  "npm" | "pnpm" | "yarn" | "pip" | "uv" | "cargo" | "go" | "unknown";

export interface EcosystemInfo {
  id: EcosystemId;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  installCommand: string;
  testCommand: string;
  runHint: string;
}

const DEFINITIONS: Record<
  Exclude<EcosystemId, "unknown">,
  Omit<EcosystemInfo, "evidence" | "confidence">
> = {
  npm: {
    id: "npm",
    installCommand: "npm ci",
    testCommand: "npm test",
    runHint: "Node.js with npm. Uses package.json / package-lock.json when present.",
  },
  pnpm: {
    id: "pnpm",
    installCommand: "pnpm install --frozen-lockfile",
    testCommand: "pnpm test",
    runHint: "Node.js with pnpm. Requires pnpm-lock.yaml.",
  },
  yarn: {
    id: "yarn",
    installCommand: "yarn install --frozen-lockfile",
    testCommand: "yarn test",
    runHint: "Node.js with Yarn. Uses yarn.lock when present.",
  },
  pip: {
    id: "pip",
    installCommand: "python -m pip install -r requirements.txt",
    testCommand: "pytest",
    runHint: "Python with pip. Uses requirements.txt / pyproject.toml when present.",
  },
  uv: {
    id: "uv",
    installCommand: "uv sync",
    testCommand: "uv run pytest",
    runHint: "Python with uv. Uses pyproject.toml / uv.lock when present.",
  },
  cargo: {
    id: "cargo",
    installCommand: "cargo fetch",
    testCommand: "cargo test",
    runHint: "Rust with Cargo. Uses Cargo.toml / Cargo.lock when present.",
  },
  go: {
    id: "go",
    installCommand: "go mod download",
    testCommand: "go test ./...",
    runHint: "Go toolchain. Uses go.mod when present.",
  },
};

interface Scored {
  id: Exclude<EcosystemId, "unknown">;
  score: number;
  evidence: string[];
}

function pushEvidence(
  map: Map<string, Scored>,
  id: Scored["id"],
  points: number,
  ev: string,
): void {
  const cur = map.get(id) ?? { id, score: 0, evidence: [] };
  cur.score += points;
  if (!cur.evidence.includes(ev)) cur.evidence.push(ev);
  map.set(id, cur);
}

/**
 * Deterministic ecosystem detection from logs (and optional file list).
 * Priority: explicit `Run <pm> ...` lines > error signatures > lockfile names.
 */
export function detectEcosystem(
  logLines: string[],
  projectFiles: string[] = [],
): EcosystemInfo {
  const lines = normalizedLines(logLines);
  const joined = lines.join("\n");
  const scores = new Map<string, Scored>();

  const has = (re: RegExp) => re.test(joined);

  // --- Strong signals: explicit Run lines from GitHub Actions ---
  if (has(/^\s*Run\s+npm\s/m) || has(/\bnpm (ci|install|test|run)\b/)) {
    pushEvidence(scores, "npm", 10, "log mentions npm command");
  }
  if (
    has(/^\s*Run\s+pnpm\s/m) ||
    has(/\bpnpm\s+(install|test|run|exec)\b/) ||
    has(/pnpm-lock\.yaml/)
  ) {
    pushEvidence(scores, "pnpm", 10, "log mentions pnpm command");
  }
  if (has(/^\s*Run\s+yarn\s/m) || has(/\byarn\s+(install|test|jest|vitest)\b/)) {
    pushEvidence(scores, "yarn", 10, "log mentions yarn command");
  }
  if (has(/^\s*Run\s+uv\s/m) || has(/\buv\s+(sync|run|pip)\b/)) {
    pushEvidence(scores, "uv", 10, "log mentions uv command");
  }
  if (
    has(/\bpython\s+-m\s+pip\b/) ||
    has(/\bpip\s+install\b/) ||
    has(/requirements\.txt/) ||
    has(/\bpytest\b/)
  ) {
    pushEvidence(scores, "pip", 8, "log mentions pip/pytest");
  }
  if (has(/\bcargo\s+(test|build|run|fetch)\b/) || has(/Cargo\.toml/)) {
    pushEvidence(scores, "cargo", 10, "log mentions cargo command");
  }
  if (has(/\bgo\s+test\b/) || has(/\bgo\s+build\b/) || has(/go\.mod/)) {
    pushEvidence(scores, "go", 10, "log mentions go command");
  }

  // --- Error signatures ---
  if (has(/npm ERR!/)) pushEvidence(scores, "npm", 6, "log contains npm ERR!");
  if (has(/ERR_PNPM_/) || has(/pnpm only supports/))
    pushEvidence(scores, "pnpm", 6, "log contains pnpm error");
  if (has(/yarn error|error Command failed.*yarn/i))
    pushEvidence(scores, "yarn", 6, "log contains yarn error");
  if (
    has(
      /Traceback \(most recent call last\)|ModuleNotFoundError|AssertionError|FAILED .*\.py/,
    )
  ) {
    pushEvidence(scores, "pip", 5, "log contains Python traceback");
  }
  if (
    has(/error\[E\d+\]|panicked at|test result: FAILED.*passed.*failed/i) &&
    has(/cargo|rust/i)
  ) {
    pushEvidence(scores, "cargo", 5, "log contains Rust failure");
  }
  if (has(/FAIL\s+\S+\s+\[build failed\]|FAIL\s+\S+ .*\.go|panic: /)) {
    pushEvidence(scores, "go", 5, "log contains Go failure");
  }
  // Node test runners are npm-family; only count if no stronger signal yet
  if (has(/\b(vitest|jest|mocha)\b.*(fail|FAIL|Error)/)) {
    pushEvidence(scores, "npm", 2, "log mentions JS test runner failure");
  }

  // --- Project files (local cwd hints) ---
  const files = new Set(projectFiles.map((f) => f.toLowerCase()));
  const hasFile = (...names: string[]) => names.some((n) => files.has(n));
  if (hasFile("pnpm-lock.yaml"))
    pushEvidence(scores, "pnpm", 4, "project has pnpm-lock.yaml");
  if (hasFile("yarn.lock")) pushEvidence(scores, "yarn", 4, "project has yarn.lock");
  if (hasFile("package-lock.json", "package.json"))
    pushEvidence(scores, "npm", 3, "project has package.json");
  if (hasFile("pyproject.toml", "requirements.txt", "uv.lock")) {
    if (hasFile("uv.lock")) pushEvidence(scores, "uv", 4, "project has uv.lock");
    else pushEvidence(scores, "pip", 3, "project has Python manifest");
  }
  if (hasFile("cargo.toml")) pushEvidence(scores, "cargo", 4, "project has Cargo.toml");
  if (hasFile("go.mod")) pushEvidence(scores, "go", 4, "project has go.mod");

  if (scores.size === 0) {
    return {
      id: "unknown",
      confidence: "low",
      evidence: ["no clear package manager signal in logs"],
      installCommand:
        "# install dependencies for your project, then re-run the failing command",
      testCommand: "# see failure.txt for the failing command",
      runHint: "Could not determine the package ecosystem. See failure.txt.",
    };
  }

  const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const def = DEFINITIONS[best.id];
  const confidence = best.score >= 10 ? "high" : best.score >= 5 ? "medium" : "low";
  return { ...def, confidence, evidence: best.evidence };
}

export function ecosystemInstallFallback(id: EcosystemId): string {
  switch (id) {
    case "npm":
      return "npm ci";
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "pip":
      return "python -m pip install -r requirements.txt";
    case "uv":
      return "uv sync";
    case "cargo":
      return "cargo fetch";
    case "go":
      return "go mod download";
    default:
      return "# install your project dependencies first";
  }
}
