import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { detectEcosystem } from "../../src/core/ecosystems.js";

function lines(name: string): string[] {
  return fs
    .readFileSync(path.join(process.cwd(), "fixtures/logs", name), "utf8")
    .split("\n");
}

describe("detectEcosystem", () => {
  it("detects npm", () => {
    expect(detectEcosystem(lines("npm-fail.log")).id).toBe("npm");
  });
  it("detects pip/pytest", () => {
    const e = detectEcosystem(lines("python-fail.log"));
    expect(["pip", "uv"]).toContain(e.id);
  });
  it("detects cargo", () => {
    expect(detectEcosystem(lines("cargo-fail.log")).id).toBe("cargo");
  });
  it("detects go", () => {
    expect(detectEcosystem(lines("go-fail.log")).id).toBe("go");
  });
  it("detects pnpm", () => {
    expect(detectEcosystem(lines("pnpm-fail.log")).id).toBe("pnpm");
  });
  it("detects maven", () => {
    const e = detectEcosystem(lines("maven-fail.log"));
    expect(e.id).toBe("maven");
    expect(e.confidence).toBe("high");
  });
  it("detects gradle", () => {
    const e = detectEcosystem(lines("gradle-fail.log"));
    expect(e.id).toBe("gradle");
    expect(e.confidence).toBe("high");
  });
  it("detects dotnet", () => {
    const e = detectEcosystem(lines("dotnet-fail.log"));
    expect(e.id).toBe("dotnet");
    expect(e.confidence).toBe("high");
  });
  it("detects ruby", () => {
    const e = detectEcosystem(lines("ruby-fail.log"));
    expect(e.id).toBe("ruby");
    expect(e.confidence).toBe("high");
  });
  it("detects node --test (TAP) instead of misreading it as pip", () => {
    const e = detectEcosystem(lines("node-test-fail.log"));
    expect(e.id).toBe("node");
    expect(e.confidence).toBe("high");
  });
  it("detects new ecosystems from project manifests alone", () => {
    expect(detectEcosystem([], ["pom.xml"]).id).toBe("maven");
    expect(detectEcosystem([], ["build.gradle.kts"]).id).toBe("gradle");
    expect(detectEcosystem([], ["Gemfile", "README.md"]).id).toBe("ruby");
  });
  it("is deterministic", () => {
    const a = detectEcosystem(lines("npm-fail.log"));
    const b = detectEcosystem(lines("npm-fail.log"));
    expect(a).toEqual(b);
  });
  it("returns unknown for empty logs", () => {
    expect(detectEcosystem([]).id).toBe("unknown");
  });
});
