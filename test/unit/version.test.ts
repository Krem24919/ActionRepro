import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../../src/utils/version.js";

describe("VERSION", () => {
  it("matches package.json (single source of truth)", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("looks like semver", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
