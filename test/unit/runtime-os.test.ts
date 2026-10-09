import { describe, it, expect } from "vitest";
import { detectRuntime, operatingSystem } from "../../src/core/runtime.js";

describe("operatingSystem()", () => {
  it("joins the real GitHub banner layout (name on its own line, version below, indented)", () => {
    expect(operatingSystem("Operating System\n  Ubuntu\n  22.04.4\n  LTS")).toBe(
      "Ubuntu 22.04.4 LTS",
    );
  });

  it("accepts the same block without indentation", () => {
    expect(
      operatingSystem("Operating System\nUbuntu\n24.04.1\nLTS\nRunner Image\n"),
    ).toBe("Ubuntu 24.04.1 LTS");
  });

  it("stops at the next section (Runner Image) and never swallows it", () => {
    const out = operatingSystem("Operating System\nUbuntu\nLTS\nRunner Image\nWindows");
    expect(out).toBe("Ubuntu LTS");
  });

  it("reads the inline 'Operating System <name>' form", () => {
    expect(operatingSystem("Operating System Ubuntu 24.04.3 LTS")).toBe(
      "Ubuntu 24.04.3 LTS",
    );
  });

  it("reads 'Running on <OS>' lines", () => {
    expect(operatingSystem("Running on Ubuntu 22.04 runner")).toBe("Ubuntu 22.04 runner");
    expect(operatingSystem("Running on Windows")).toBe("Windows");
  });

  it("returns undefined when there is no OS information", () => {
    expect(operatingSystem("nothing relevant here")).toBeUndefined();
    expect(operatingSystem("Operating System\n")).toBeUndefined();
  });
});

describe("detectRuntime architecture", () => {
  it("reads a labelled architecture line", () => {
    expect(detectRuntime(["Architecture: X64"]).arch).toBe("x64");
    expect(detectRuntime(["platform: arm64"]).arch).toBe("arm64");
    expect(detectRuntime(["Architecture: aarch64"]).arch).toBe("aarch64");
  });

  it("normalises amd64 to x64", () => {
    expect(detectRuntime(["Architecture: amd64"]).arch).toBe("x64");
  });

  it("ignores a bare x86_64 in a build flag (not the runner)", () => {
    expect(
      detectRuntime(["cargo build --target x86_64-unknown-linux-gnu"]).arch,
    ).toBeUndefined();
  });

  it("reports the OS alongside the architecture", () => {
    const info = detectRuntime([
      "Operating System",
      "  Ubuntu",
      "  24.04.1",
      "  LTS",
      "Architecture: X64",
    ]);
    expect(info.os).toBe("Ubuntu 24.04.1 LTS");
    expect(info.arch).toBe("x64");
  });
});
