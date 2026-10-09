import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectTarget } from "../../src/commands/inspect.js";
import { reproduceTarget } from "../../src/commands/reproduce.js";

/**
 * URL mode end to end with a stubbed GitHub API: run -> jobs -> log -> workflow file at the
 * exact head SHA. No network is used.
 */
const NPM_LOG = fs.readFileSync(
  path.join(process.cwd(), "fixtures/logs/npm-fail.log"),
  "utf8",
);
const WORKFLOW = [
  "name: CI",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - name: Run tests",
  "        run: npm test",
  "",
].join("\n");

type Auth = string | undefined;

function stubGitHub(opts: { logsStatus?: number; workflowText?: string } = {}) {
  const seen: Array<{ url: string; auth: Auth }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
      seen.push({ url, auth });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/actions/runs/77")) {
        return json({
          id: 77,
          name: "CI",
          head_branch: "main",
          head_sha: "abc123",
          conclusion: "failure",
          html_url: "https://github.com/o/r/actions/runs/77",
          created_at: "2026-01-01T00:00:00Z",
          workflow_id: 9,
        });
      }
      if (url.includes("/actions/runs/77/jobs")) {
        return json({
          total_count: 1,
          jobs: [
            {
              id: 500,
              name: "test",
              conclusion: "failure",
              steps: [{ name: "Run tests", number: 2, conclusion: "failure" }],
            },
          ],
        });
      }
      if (url.endsWith("/actions/jobs/500/logs")) {
        if (opts.logsStatus) return new Response("denied", { status: opts.logsStatus });
        return new Response(NPM_LOG, { status: 200 });
      }
      if (url.endsWith("/actions/workflows/9")) {
        return json({ path: ".github/workflows/ci.yml" });
      }
      if (url.includes("/contents/.github/workflows/ci.yml")) {
        return json({
          type: "file",
          sha: "blob1",
          content: Buffer.from(opts.workflowText ?? WORKFLOW).toString("base64"),
        });
      }
      return new Response("missing", { status: 404 });
    },
  );
  return seen;
}

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_TOKEN;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "actionrepro-url-"));
  dirs.push(d);
  return d;
};

describe("inspectTarget in URL mode", () => {
  it("reports the run URL, the failing job and the step, and uses the explicit token for api.github.com", async () => {
    const seen = stubGitHub();
    const r = await inspectTarget({
      target: "https://github.com/o/r/actions/runs/77",
      token: "tok-flag",
    });
    expect(r.runUrl).toBe("https://github.com/o/r/actions/runs/77");
    expect(r.ecosystem).toBe("npm");
    expect(r.failingJob).toBe("test");
    expect(r.failingStep).toBe("Run tests");
    expect(r.summary.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(seen.some((s) => s.auth === "Bearer tok-flag")).toBe(true);
  });

  it("explains a log download failure instead of inventing a diagnosis", async () => {
    stubGitHub({ logsStatus: 403 });
    const r = await inspectTarget({ target: "https://github.com/o/r/actions/runs/77" });
    expect(r.ecosystem).toBe("unknown");
    expect(r.summary).toMatch(/^Logs unavailable:/);
    expect(r.hint).toContain("GITHUB_TOKEN");
  });

  it("an Enterprise run URL is fetched from the Enterprise API base without a token", async () => {
    const seen = stubGitHub();
    await inspectTarget({
      target: "https://ghe.example.com/o/r/actions/runs/77",
      token: "tok",
    });
    expect(
      seen[0].url.startsWith("https://ghe.example.com/api/v3/repos/o/r/actions/runs/77"),
    ).toBe(true);
    expect(seen.every((s) => s.auth === undefined)).toBe(true);
  });
});

describe("reproduceTarget in URL mode", () => {
  it("cross-checks the workflow file at the head SHA and records the step command", async () => {
    stubGitHub();
    const out = path.join(tmp(), "bundle");
    const r = await reproduceTarget({
      target: "https://github.com/o/r/actions/runs/77",
      outDir: out,
    });
    expect(r.ecosystem).toBe("npm");
    const meta = JSON.parse(fs.readFileSync(path.join(out, "repro.json"), "utf8"));
    expect(meta.workflow.path).toBe(".github/workflows/ci.yml");
    expect(meta.workflow.sha).toBe("blob1");
    expect(meta.workflow.stepCommand).toBe("npm test");
    expect(meta.runUrl).toBe("https://github.com/o/r/actions/runs/77");
    expect(meta.failure.failingJob).toBe("test");
  });

  it("when the workflow file cannot be fetched, the bundle still builds with no workflow block", async () => {
    stubGitHub({ workflowText: "" }); // empty content -> treated as unavailable
    const out = path.join(tmp(), "bundle");
    await reproduceTarget({
      target: "https://github.com/o/r/actions/runs/77",
      outDir: out,
    });
    const meta = JSON.parse(fs.readFileSync(path.join(out, "repro.json"), "utf8"));
    expect(meta.workflow).toBeNull();
  });

  it("the token never reaches a foreign host even when a GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ENV-SECRET";
    const seen = stubGitHub();
    await reproduceTarget({
      target: "https://ghe.example.com/o/r/actions/runs/77",
      outDir: path.join(tmp(), "bundle"),
    }).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.auth === undefined)).toBe(true);
  });
});
