import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { GitHostError, gitHostService, MAX_LOG_CHARS } from "../src/services/git-hosts.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const cfg = (kind: "github" | "gitea") => ({ kind, apiBase: "https://host/api", owner: "leon", repo: "site" });

describe("CI on a commit for the merge gate (BOS-1070)", () => {
  /** A GitHub that answers check suites, check runs and annotations from fixed bodies. */
  const github = (suites: unknown[], runs: unknown[], annotations: Record<number, unknown[]> = {}) => {
    const urls: string[] = [];
    const host = gitHostService({
      fetch: (async (u: string) => {
        urls.push(u);
        if (u.includes("/check-suites")) return json(200, { check_suites: suites });
        if (u.includes("/check-runs?")) return json(200, { check_runs: runs });
        const a = /\/check-runs\/(\d+)\/annotations/.exec(u);
        if (a) return json(200, annotations[Number(a[1])] ?? []);
        return json(404, { message: "no" });
      }) as unknown as typeof fetch,
    });
    return { host, urls };
  };
  const done = (name: string, conclusion: string, id = 1) => ({ id, name, status: "completed", conclusion, html_url: `https://github.com/leon/site/runs/${id}` });

  it("reads pending while the workflow's suite runs, even when every job started so far has passed", async () => {
    // GitHub makes a job's run only when it starts: "changes" passed, the jobs after it don't exist yet.
    const { host } = github([{ status: "in_progress", conclusion: null, latest_check_runs_count: 1 }], [done("changes", "success")]);
    expect(await host.ciStatus(cfg("github"), "t", "e".repeat(40))).toEqual({ state: "pending", failed: [], waiting: [], billing: false });
  });

  it("passes only when every suite with runs is done and green; other apps' empty queued suites don't count", async () => {
    const { host } = github(
      [{ status: "completed", conclusion: "success", latest_check_runs_count: 3 }, { status: "queued", conclusion: null, latest_check_runs_count: 0 }],
      [done("changes", "success"), done("check", "success"), done("images (arm64)", "skipped")],
    );
    expect((await host.ciStatus(cfg("github"), "t", "e".repeat(40))).state).toBe("passed");
  });

  it("names failed jobs with their pages, and says none when nothing ran", async () => {
    const { host } = github([{ status: "in_progress", conclusion: null, latest_check_runs_count: 2 }], [done("check", "failure", 5), { id: 6, name: "images (amd64)", status: "in_progress", conclusion: null }]);
    expect(await host.ciStatus(cfg("github"), "t", "e".repeat(40))).toEqual({ state: "failed", failed: [{ id: 5, name: "check", url: "https://github.com/leon/site/runs/5" }], waiting: ["images (amd64)"], billing: false });
    expect((await github([], []).host.ciStatus(cfg("github"), "t", "e".repeat(40))).state).toBe("none");
  });

  it("tells a spending-limit start failure apart from a real one", async () => {
    const { host } = github([{ status: "completed", conclusion: "failure", latest_check_runs_count: 1 }], [{ ...done("check", "startup_failure"), output: { title: "", summary: "The job was not started because your account's spending limit needs to be increased." } }]);
    expect((await host.ciStatus(cfg("github"), "t", "e".repeat(40))).billing).toBe(true);
  });

  it("a failing test that only mentions billing is a real failure, in the run's output or its annotations", async () => {
    const { host } = github(
      [{ status: "completed", conclusion: "failure", latest_check_runs_count: 1 }],
      [{ ...done("check", "failure", 5), output: { title: "1 failed", summary: "billing > spending limit card: payment failed" } }],
      {
        5: [
          // A test about GitHub's billing text, failing: it names its file, so it is the agent's to fix.
          { annotation_level: "failure", path: "apps/server/test/git-hosts.test.ts", start_line: 9, title: "billing", message: "expected 'The job was not started because your spending limit needs to be increased' to match" },
          { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." },
        ],
      },
    );
    expect((await host.ciStatus(cfg("github"), "t", "e".repeat(40))).billing).toBe(false);
    const [found] = await host.failures(cfg("github"), "t", [{ id: 5, name: "check", url: "" }]);
    expect(found!.billing).toBe(false);
    expect(found!.lines).toHaveLength(1);
  });

  it("GitHub's own account-level refusal in the annotations is billing", async () => {
    const { host } = github([], [], {
      5: [{ annotation_level: "failure", path: ".github", message: "The job was not started because recent account payments have failed or your spending limit needs to be increased." }],
    });
    expect((await host.failures(cfg("github"), "t", [{ id: 5, name: "check", url: "" }]))[0]!.billing).toBe(true);
  });

  it("a refused read is a GitHostError with the status, so the gate can tell a token problem from an outage", async () => {
    const host = gitHostService({ fetch: (async () => json(403, { message: "Resource not accessible by personal access token" })) as unknown as typeof fetch });
    await expect(host.ciStatus(cfg("github"), "t", "e".repeat(40))).rejects.toMatchObject({ status: 403, message: expect.stringContaining("not accessible") });
  });

  it("reads failing tests from the failed jobs' annotations, without git's generic exit line", async () => {
    const { host } = github([], [], {
      5: [
        { annotation_level: "failure", path: "apps/web/test/a.test.ts", start_line: 3, title: "a > renders", message: "expected 1 to be 2\nat line 3" },
        { annotation_level: "warning", path: "x", message: "slow" },
        { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." },
      ],
    });
    expect(await host.failures(cfg("github"), "t", [{ id: 5, name: "web-browser", url: "" }])).toEqual([{ run: { id: 5, name: "web-browser", url: "" }, lines: ["apps/web/test/a.test.ts:3: a > renders: expected 1 to be 2"], billing: false }]);
  });

  it("the token check says whether GitHub checks can be read", async () => {
    const access = (checks: number) =>
      gitHostService({
        fetch: (async (u: string) => (u.includes("/check-runs") ? json(checks, checks === 200 ? { check_runs: [] } : { message: "no" }) : json(200, { default_branch: "main", permissions: { push: true } }))) as unknown as typeof fetch,
      }).checkAccess(cfg("github"), "t");
    expect(await access(200)).toMatchObject({ ok: true, canPush: true, canReadChecks: true, message: expect.stringContaining("can read GitHub checks") });
    expect(await access(403)).toMatchObject({ ok: true, canReadChecks: false, message: expect.stringContaining("Checks: Read-only") });
  });
});

describe("branchHead", () => {
  it("reads commit.sha on GitHub and commit.id on Gitea, with the branch path escaped", async () => {
    const urls: string[] = [];
    const answer = (body: unknown) => gitHostService({ fetch: (async (u: string) => (urls.push(u), json(200, body))) as unknown as typeof fetch });
    expect(await answer({ commit: { sha: "a".repeat(40) } }).branchHead(cfg("github"), "t", "release/1.2")).toBe("a".repeat(40));
    expect(await answer({ commit: { id: "b".repeat(40) } }).branchHead(cfg("gitea"), "t", "main")).toBe("b".repeat(40));
    expect(urls[0]).toBe("https://host/api/repos/leon/site/branches/release/1.2");
  });

  it("throws a GitHostError when the host refuses or answers something else", async () => {
    const host = (status: number, body: unknown) => gitHostService({ fetch: (async () => json(status, body)) as unknown as typeof fetch });
    await expect(host(404, { message: "Branch not found" }).branchHead(cfg("github"), "t", "main")).rejects.toMatchObject({ status: 404, message: expect.stringContaining("Branch not found") });
    await expect(host(200, {}).branchHead(cfg("gitea"), "t", "main")).rejects.toBeInstanceOf(GitHostError);
  });
});

describe("the commits a pull request is made of, and a compare (BOS-130)", () => {
  it("pages the pull request's commits and stops at the reviewed head", async () => {
    const urls: string[] = [];
    const pages: Record<string, unknown> = {
      "/api/repos/leon/site/pulls/7": { number: 7, html_url: "https://host/pr/7", merged: false, state: "open" },
      "/api/repos/leon/site/pulls/7/commits?per_page=100&page=1": [{ sha: "a".repeat(40) }, { sha: "b".repeat(40) }],
    };
    const host = gitHostService({
      fetch: (async (u: string) => {
        urls.push(u);
        const path = u.replace("https://host", "");
        return path in pages ? json(200, pages[path]) : json(200, []);
      }) as unknown as typeof fetch,
    });
    const r = await host.getWithCommits(cfg("github"), "tok", 7, "b".repeat(40));
    expect(r.pull.number).toBe(7);
    expect(r.commits).toEqual(["a".repeat(40), "b".repeat(40)]);
    // One page was enough, so the second was never asked for.
    expect(urls.filter((u) => u.includes("/commits"))).toHaveLength(1);
  });

  it("reads a compare's commits in order, and Gitea's own compare isn't assumed", async () => {
    const seen: string[] = [];
    const host = gitHostService({
      fetch: (async (u: string) => {
        seen.push(u);
        return json(200, { commits: [{ sha: "c".repeat(40) }, { sha: "d".repeat(40) }] });
      }) as unknown as typeof fetch,
    });
    expect(await host.compare(cfg("github"), "tok", "targetsha", "branch/name")).toEqual(["c".repeat(40), "d".repeat(40)]);
    expect(seen[0]).toBe("https://host/api/repos/leon/site/compare/targetsha...branch%2Fname?per_page=250");
  });
});

describe("checks on a commit (DR-024 #2)", () => {
  const host = (status: number, body: unknown) => gitHostService({ fetch: (async () => json(status, body)) as unknown as typeof fetch });
  it("counts GitHub check runs and names the failing ones", async () => {
    const ok = await host(200, { check_runs: [{ name: "check", status: "completed", conclusion: "success" }, { name: "rehearse", status: "completed", conclusion: "success" }] }).checks(cfg("github"), "t", "a".repeat(40));
    expect(ok).toEqual({ state: "passed", failing: [], total: 2 });
    const bad = await host(200, { check_runs: [{ name: "rehearse", status: "completed", conclusion: "failure" }] }).checks(cfg("github"), "t", "a".repeat(40));
    expect(bad).toMatchObject({ state: "failed", failing: ["rehearse"] });
  });
  it("links the first failing run, else the first run, and skips non-http links (BOS-1418)", async () => {
    const rows = { check_runs: [{ name: "a", status: "completed", conclusion: "success", html_url: "https://example.com/runs/1" }, { name: "b", status: "completed", conclusion: "failure", html_url: "https://example.com/runs/2" }] };
    expect(await host(200, rows).checks(cfg("github"), "t", "a".repeat(40))).toMatchObject({ state: "failed", url: "https://example.com/runs/2" });
    expect(await host(200, { check_runs: [rows.check_runs[0]] }).checks(cfg("github"), "t", "a".repeat(40))).toMatchObject({ url: "https://example.com/runs/1" });
    const gitea = await host(200, { statuses: [{ context: "ci", status: "pending", target_url: "javascript:alert(1)" }] }).checks(cfg("gitea"), "t", "a".repeat(40));
    expect(gitea).toEqual({ state: "pending", failing: [], total: 1 });
  });
  it("says so when the token can't read checks", async () => {
    await expect(host(403, { message: "Resource not accessible by personal access token" }).checks(cfg("github"), "t", "a".repeat(40))).rejects.toMatchObject({ status: 403 });
  });
});

describe("reading a branch's Actions runs (BOS-1072)", () => {
  const host = (answer: (path: string) => Response) => gitHostService({ fetch: (async (u: string) => answer(u.replace("https://host/api/repos/leon/site", ""))) as unknown as typeof fetch });

  it("reads the runs, the jobs with their steps, and says nothing on Gitea", async () => {
    const h = host((p) =>
      p.startsWith("/actions/runs?")
        ? json(200, { workflow_runs: [{ id: 5, run_attempt: 2, name: "CI", event: "schedule", status: "completed", conclusion: "failure", head_sha: "a".repeat(40), head_commit: { message: "Merge x" }, html_url: "https://gh/run/5", created_at: "t1" }] })
        : json(200, { jobs: [{ id: 9, name: "test", status: "completed", conclusion: "failure", html_url: "https://gh/job/9", steps: [{ number: 1, name: "Run tests", status: "completed", conclusion: "failure" }] }] }),
    );
    const [run] = await h.workflowRuns(cfg("github"), "t", "main");
    expect(run).toMatchObject({ id: 5, attempt: 2, event: "schedule", conclusion: "failure", headMessage: "Merge x", url: "https://gh/run/5" });
    const [job] = await h.runJobs(cfg("github"), "t", 5);
    expect(job).toMatchObject({ id: 9, name: "test", steps: [{ name: "Run tests", conclusion: "failure" }] });
    expect(await h.workflowRuns(cfg("gitea"), "t", "main")).toEqual([]);
  });

  it("throws a GitHostError when the token can't read the runs", async () => {
    await expect(host(() => json(403, { message: "Resource not accessible" })).workflowRuns(cfg("github"), "t", "main")).rejects.toMatchObject({ status: 403 });
  });

  it("reads a job log whether GitHub sends a zip or plain text", async () => {
    const zip = zipSync({ "2_b.txt": strToU8("second"), "1_a.txt": strToU8("first") });
    expect(await host(() => new Response(zip)).jobLog(cfg("github"), "t", 9)).toBe("first\nsecond");
    expect(await host(() => new Response("plain log")).jobLog(cfg("github"), "t", 9)).toBe("plain log");
  });

  it("keeps only the end of a very long log, and skips a step log that is too big", async () => {
    const big = "x".repeat(MAX_LOG_CHARS + 500) + "THE END";
    const tail = await host(() => new Response(big)).jobLog(cfg("github"), "t", 9);
    expect(tail).toHaveLength(MAX_LOG_CHARS);
    expect(tail.endsWith("THE END")).toBe(true);
    const zip = zipSync({ "1_big.txt": strToU8("y".repeat(MAX_LOG_CHARS + 1)), "2_ok.txt": strToU8("kept") });
    expect(await host(() => new Response(zip)).jobLog(cfg("github"), "t", 9)).toBe("kept");
  });

  it("collects the error annotations of failed check runs only", async () => {
    const h = host((p) =>
      p.startsWith("/commits/")
        ? json(200, { check_runs: [{ id: 1, name: "test", conclusion: "failure" }, { id: 2, name: "lint", conclusion: "success" }] })
        : json(200, [{ path: "a.ts", start_line: 3, message: "boom" }]),
    );
    expect(await h.commitAnnotations(cfg("github"), "t", "a".repeat(40))).toEqual([{ name: "test", lines: ["a.ts:3 boom"] }]);
  });
});
