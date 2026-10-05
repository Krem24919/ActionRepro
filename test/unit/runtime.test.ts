import { describe, it, expect } from "vitest";
import { detectRuntime } from "../../src/core/runtime.js";
import fs from "node:fs";
import path from "node:path";

const fx = (n: string) =>
  fs.readFileSync(path.join(process.cwd(), "fixtures/logs", n), "utf8").split("\n");

describe("detectRuntime", () => {
  it("detects OS + node", () => {
    const lines = fx("npm-fail.log");
    const r = detectRuntime(lines);
    expect(r.os).toMatch(/Ubuntu/i);
    expect(r.node).toBe("20.12.1");
  });
  it("detects python", () => {
    const lines = fx("python-fail.log");
    expect(detectRuntime(lines).python).toBe("3.11.9");
  });
  it("detects go + rust", () => {
    const go = fx("go-fail.log");
    expect(detectRuntime(go).go).toBe("1.22.2");
    const rs = fx("cargo-fail.log");
    expect(detectRuntime(rs).rust).toBe("1.78.0");
  });
});
