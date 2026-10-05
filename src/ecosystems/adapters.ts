import type { EcosystemAdapter } from "./types.js";

export const npmAdapter: EcosystemAdapter = {
  id: "npm",
  installCommand: "npm ci",
  testCommand: "npm test",
  runHint: "Node.js with npm.",
  manifests: ["package.json", "package-lock.json"],
};

export const pnpmAdapter: EcosystemAdapter = {
  id: "pnpm",
  installCommand: "pnpm install --frozen-lockfile",
  testCommand: "pnpm test",
  runHint: "Node.js with pnpm.",
  manifests: ["pnpm-lock.yaml"],
};

export const yarnAdapter: EcosystemAdapter = {
  id: "yarn",
  installCommand: "yarn install --frozen-lockfile",
  testCommand: "yarn test",
  runHint: "Node.js with Yarn.",
  manifests: ["yarn.lock"],
};

export const pipAdapter: EcosystemAdapter = {
  id: "pip",
  installCommand: "python -m pip install -r requirements.txt",
  testCommand: "pytest",
  runHint: "Python with pip.",
  manifests: ["requirements.txt", "pyproject.toml"],
};

export const uvAdapter: EcosystemAdapter = {
  id: "uv",
  installCommand: "uv sync",
  testCommand: "uv run pytest",
  runHint: "Python with uv.",
  manifests: ["uv.lock", "pyproject.toml"],
};

export const cargoAdapter: EcosystemAdapter = {
  id: "cargo",
  installCommand: "cargo fetch",
  testCommand: "cargo test",
  runHint: "Rust with Cargo.",
  manifests: ["Cargo.toml", "Cargo.lock"],
};

export const goAdapter: EcosystemAdapter = {
  id: "go",
  installCommand: "go mod download",
  testCommand: "go test ./...",
  runHint: "Go toolchain.",
  manifests: ["go.mod"],
};
