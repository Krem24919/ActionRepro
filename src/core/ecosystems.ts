import { normalizedLines } from "./logs.js";

export type EcosystemId =
  | "npm"
  | "node"
  | "pnpm"
  | "yarn"
  | "pip"
  | "uv"
  | "cargo"
  | "go"
  | "maven"
  | "gradle"
  | "dotnet"
  | "ruby"
  | "unknown";

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
  node: {
    id: "node",
    installCommand: "npm ci",
    testCommand: "node --test",
    runHint:
      "Node.js built-in test runner (no npm involved). Installs via npm when package.json exists.",
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
  maven: {
    id: "maven",
    installCommand: "mvn -B dependency:resolve",
    testCommand: "mvn -B test",
    runHint: "Java with Apache Maven. Uses pom.xml when present.",
  },
  gradle: {
    id: "gradle",
    installCommand:
      "if [ -f gradlew ]; then ./gradlew -q dependencies; else gradle -q dependencies; fi",
    testCommand: "./gradlew test",
    runHint: "Java with Gradle. Uses the gradlew wrapper when present.",
  },
  dotnet: {
    id: "dotnet",
    installCommand: "dotnet restore",
    testCommand: "dotnet test",
    runHint: ".NET SDK. Uses the solution/project files when present.",
  },
  ruby: {
    id: "ruby",
    installCommand: "bundle install",
    testCommand: "bundle exec rspec",
    runHint:
      "Ruby with Bundler (RSpec; use `bundle exec rake test` for Minitest projects).",
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
  // Node's built-in runner (TAP output, no npm anywhere in the log).
  if (has(/^TAP version \d+/m) || has(/^\s*Run\s+node\s+(--test|test)\b/m)) {
    pushEvidence(scores, "node", 10, "log mentions node --test");
  }
  if (has(/^not ok \d+/m)) {
    pushEvidence(scores, "node", 8, "log contains TAP failure");
  }
  if (has(/\bnode --test\b/) || has(/\bERR_ASSERTION\b/)) {
    pushEvidence(scores, "node", 6, "log contains Node assertion marker");
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
  if (
    has(/^\s*Run\s+mvn\b/m) ||
    has(/\bmvn\s+(-B\b|test|verify|package|compile|dependency)\b/) ||
    has(/pom\.xml/)
  ) {
    pushEvidence(scores, "maven", 10, "log mentions Maven command");
  }
  if (
    has(/^\s*Run\s+(\.\/)?gradlew?\b/m) ||
    has(/\bgradle(w)?\s+(test|build|check)\b/) ||
    has(/build\.gradle(\.kts)?/)
  ) {
    pushEvidence(scores, "gradle", 10, "log mentions Gradle command");
  }
  if (
    has(/^\s*Run\s+dotnet\b/m) ||
    has(/\bdotnet\s+(test|build|run|restore|publish)\b/) ||
    has(/\.csproj\b/) ||
    has(/\.sln\b/)
  ) {
    pushEvidence(scores, "dotnet", 10, "log mentions dotnet command");
  }
  if (
    has(/^\s*Run\s+(bundle\s+exec\s+)?(rspec|rake)\b/m) ||
    has(/\bbundle\s+exec\b/) ||
    has(/\bGemfile\b/)
  ) {
    pushEvidence(scores, "ruby", 10, "log mentions Ruby test command");
  }

  // --- Error signatures ---
  if (has(/npm ERR!/)) pushEvidence(scores, "npm", 6, "log contains npm ERR!");
  if (has(/ERR_PNPM_/) || has(/pnpm only supports/))
    pushEvidence(scores, "pnpm", 6, "log contains pnpm error");
  if (has(/yarn error|error Command failed.*yarn/i))
    pushEvidence(scores, "yarn", 6, "log contains yarn error");
  if (has(/Traceback \(most recent call last\)|ModuleNotFoundError|FAILED .*\.py/)) {
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
  if (
    has(/Tests run:\s*\d+,\s*(Failures|Errors):\s*[1-9]/) ||
    has(/BUILD FAILURE/) ||
    has(/maven-surefire-plugin/)
  ) {
    pushEvidence(scores, "maven", 6, "log contains Maven failure markers");
  }
  if (has(/FAILURE: Build failed/) || has(/> Task .* FAILED/)) {
    pushEvidence(scores, "gradle", 6, "log contains Gradle failure markers");
  }
  if (has(/error (CS|MSB)\d+/) || has(/Failed:\s*\d+,\s*Passed:/)) {
    pushEvidence(scores, "dotnet", 6, "log contains .NET failure markers");
  }
  if (
    has(/Failure\/Error: /) ||
    has(/^Failures:$/m) ||
    (has(/^(Failure|Error):$/m) && has(/\.rb:\d+/))
  ) {
    pushEvidence(scores, "ruby", 6, "log contains Ruby test failure");
  }
  if (has(/\.rb:\d+/)) {
    pushEvidence(scores, "ruby", 4, "log contains Ruby backtrace");
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
  if (hasFile("pom.xml")) pushEvidence(scores, "maven", 4, "project has pom.xml");
  if (hasFile("build.gradle", "build.gradle.kts", "gradlew")) {
    pushEvidence(scores, "gradle", 4, "project has Gradle build file");
  }
  if (hasFile("gemfile", "gemfile.lock", "rakefile")) {
    pushEvidence(scores, "ruby", 4, "project has Ruby manifest");
  }

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
    case "node":
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
    case "maven":
      return "mvn -B dependency:resolve";
    case "gradle":
      return "./gradlew -q dependencies";
    case "dotnet":
      return "dotnet restore";
    case "ruby":
      return "bundle install";
    default:
      return "# install your project dependencies first";
  }
}
