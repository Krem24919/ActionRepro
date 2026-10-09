import { describe, it, expect } from "vitest";
import { formatDoctorHuman, type DoctorResult } from "../../src/commands/doctor.js";

describe("formatDoctorHuman", () => {
  it("prints PASS/FAIL per check and a summary line when everything passes", () => {
    const r: DoctorResult = {
      ok: true,
      checks: [
        { name: "node", ok: true, detail: "v22.0.0" },
        { name: "git", ok: true, detail: "git version 2.39" },
      ],
    };
    const text = formatDoctorHuman(r);
    expect(text).toContain("PASS  node: v22.0.0");
    expect(text).toContain("PASS  git: git version 2.39");
    expect(text).toContain("all required checks passed");
  });

  it("marks a failing check and reports the failure summary", () => {
    const r: DoctorResult = {
      ok: false,
      checks: [
        { name: "node", ok: true, detail: "v22.0.0" },
        { name: "network(api.github.com)", ok: false, detail: "fetch failed" },
      ],
    };
    const text = formatDoctorHuman(r);
    expect(text).toContain("FAIL  network(api.github.com): fetch failed");
    expect(text).toContain("some required checks failed");
  });
});
