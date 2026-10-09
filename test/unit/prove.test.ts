import { describe, it, expect } from "vitest";
import { scriptNotRunReason } from "../../src/commands/prove.js";

describe("scriptNotRunReason (script-level exit codes never count as fixed)", () => {
  it.each([3, 4, 5])("exit %i means the failure was never reproduced", (code) => {
    expect(scriptNotRunReason(code)).toEqual(expect.any(String));
  });

  it.each([0, 1, 2, 7, 127, undefined])("exit %s is left to verification", (code) => {
    expect(scriptNotRunReason(code)).toBeNull();
  });

  it("names the setup failure and the missing command distinctly", () => {
    expect(scriptNotRunReason(3)).toMatch(/dependency setup failed/);
    expect(scriptNotRunReason(5)).toMatch(/no runnable repro command/);
    expect(scriptNotRunReason(4)).toMatch(/aborted/);
  });
});
