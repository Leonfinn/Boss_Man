import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { GitHostError, gitHostService, MAX_LOG_CHARS } from "../src/services/git-hosts.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const cfg = (kind: "github" | "gitea") => ({ kind, apiBase: "https://host/api", owner: "leon", repo: "site" });

describe("jobLogBlock: a failed job's log for a ticket message (BOS-1667)", () => {
  const withLog = (res: () => Response) => gitHostService({ fetch: (async () => res()) as unknown as typeof fetch });
  it("never throws and never gives an empty block: each failure says what is wrong", async () => {
    expect((await withLog(() => json(403, {})).jobLogBlock(cfg("github"), "t", 7)).join(" ")).toMatch(/isn't allowed to read job logs/);
    expect((await withLog(() => json(404, {})).jobLogBlock(cfg("github"), "t", 7)).join(" ")).toMatch(/no longer has it/);
    expect((await withLog(() => new Response("x", { headers: { "content-length": "99000000" } })).jobLogBlock(cfg("github"), "t", 7)).join(" ")).toMatch(/too large/);
    expect((await withLog(() => new Response("")).jobLogBlock(cfg("github"), "t", 7)).join(" ")).toMatch(/was empty/);
    expect((await withLog(() => json(200, {})).jobLogBlock(cfg("gitea"), "t", 7)).join(" ")).toMatch(/isn't available from this git host/);
  });
  it("gives the error lines then the end of the log", async () => {
    const block = await withLog(() => new Response("setup\nFAIL a.test.ts\nmore\nlast line")).jobLogBlock(cfg("github"), "t", 7);
    expect(block).toEqual(["FAIL a.test.ts", "… end of the log:", "setup", "more", "last line"]);
  });
});

describe("CI on a commit for the merge gate (BOS-1070, read through Actions since BOS-1630)", () => {
  const SHA = "e".repeat(40);
  /**
   * A GitHub that answers Actions runs and jobs from fixed bodies. The Checks API (check runs, suites) is refused with 403,
   * as for a fine-grained token with Actions: Read-only and no Checks; `annotations`, when given, are readable.
   */
  const github = (runs: unknown[], jobs: Record<number, unknown[]> = {}, annotations?: Record<number, unknown[]>) => {
    const urls: string[] = [];
    const host = gitHostService({
      fetch: (async (u: string) => {
        urls.push(u);
        if (u.includes("/actions/runs?")) return json(200, { workflow_runs: runs });
        const j = /\/actions\/runs\/(\d+)\/jobs/.exec(u);
        if (j) return json(200, { jobs: jobs[Number(j[1])] ?? [] });
        const a = /\/check-runs\/(\d+)\/annotations/.exec(u);
        if (a && annotations) return json(200, annotations[Number(a[1])] ?? []);
        if (u.includes("/check-")) return json(403, { message: "Resource not accessible by personal access token" });
        return json(404, { message: "no" });
      }) as unknown as typeof fetch,
    });
    return { host, urls };
  };
  const run = (id: number, status: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({ id, name: "CI", workflow_id: 1, event: "push", head_sha: SHA, status, conclusion, created_at: "2026-11-16T10:00:00Z", html_url: `https://github.com/leon/site/actions/runs/${id}`, ...extra });
  const job = (id: number, name: string, conclusion: string, steps = [{ number: 1, name: "Run tests", status: "completed", conclusion }]) => ({ id, name, status: "completed", conclusion, runner_name: "GitHub Actions 2", html_url: `https://github.com/leon/site/actions/runs/9/job/${id}`, steps });

  it("reads pending while a workflow run is in progress, even when every job so far has passed, and asks nothing of Checks", async () => {
    // GitHub makes a job only when it is reached: the run stays in progress until its last job ends.
    const { host, urls } = github([run(9, "in_progress", null)]);
    expect(await host.ciStatus(cfg("github"), "t", SHA)).toEqual({ state: "pending", failed: [], waiting: ["CI"], billing: false });
    expect(urls).toEqual([`https://host/api/repos/leon/site/actions/runs?head_sha=${SHA}&per_page=100`]);
  });

  it("passes only when every newest run is done and green", async () => {
    expect((await github([run(9, "completed", "success"), run(8, "completed", "skipped", { workflow_id: 2, name: "Docs" })]).host.ciStatus(cfg("github"), "t", SHA)).state).toBe("passed");
    expect((await github([run(9, "completed", "success"), run(8, "queued", null, { workflow_id: 2 })]).host.ciStatus(cfg("github"), "t", SHA)).state).toBe("pending");
  });

  it("a re-run replaces the older run of the same workflow and event; another event's run still counts", async () => {
    const older = run(8, "completed", "failure");
    const newer = run(9, "completed", "success", { created_at: "2026-11-16T10:30:00Z" });
    expect((await github([newer, older]).host.ciStatus(cfg("github"), "t", SHA)).state).toBe("passed");
    expect((await github([older, newer]).host.ciStatus(cfg("github"), "t", SHA)).state).toBe("passed");
    const { host } = github([newer, run(7, "completed", "failure", { event: "pull_request" })], { 7: [job(70, "lint", "failure")] });
    expect((await host.ciStatus(cfg("github"), "t", SHA)).failed.map((f) => f.name)).toEqual(["lint"]);
  });

  it("names the failed jobs with their pages and failed step from the run's jobs, and says none when nothing ran", async () => {
    const { host } = github([run(9, "completed", "failure")], {
      9: [job(5, "check", "failure", [{ number: 1, name: "Set up job", status: "completed", conclusion: "success" }, { number: 2, name: "Run tests", status: "completed", conclusion: "failure" }]), job(6, "images (amd64)", "success")],
    });
    expect(await host.ciStatus(cfg("github"), "t", SHA)).toEqual({ state: "failed", failed: [{ id: 5, name: "check", url: "https://github.com/leon/site/actions/runs/9/job/5", step: "Run tests", runId: 9 }], waiting: [], billing: false });
    expect((await github([]).host.ciStatus(cfg("github"), "t", SHA)).state).toBe("none");
  });

  it("a cancelled run is no failure: its own state, unless a job in it really failed", async () => {
    const cancelledJob = { id: 5, name: "check", status: "completed", conclusion: "cancelled", runner_name: "GitHub Actions 2", steps: [] };
    const s = await github([run(9, "completed", "cancelled")], { 9: [cancelledJob] }).host.ciStatus(cfg("github"), "t", SHA);
    expect(s).toEqual({ state: "cancelled", failed: [], waiting: [], billing: false, cancelled: [{ id: 9, name: "CI", url: "https://github.com/leon/site/actions/runs/9" }] });
    const real = await github([run(9, "completed", "cancelled")], { 9: [cancelledJob, job(6, "lint", "failure")] }).host.ciStatus(cfg("github"), "t", SHA);
    expect(real.state).toBe("failed");
    // Another workflow still running: wait for it before saying anything about the cancelled one.
    expect((await github([run(9, "completed", "cancelled"), run(8, "in_progress", null, { workflow_id: 2 })], { 9: [cancelledJob] }).host.ciStatus(cfg("github"), "t", SHA)).state).toBe("pending");
  });

  it("a run that failed before any job is named by the run", async () => {
    const { host } = github([run(9, "completed", "startup_failure")]);
    expect((await host.ciStatus(cfg("github"), "t", SHA)).failed).toEqual([{ id: 0, name: "CI", url: "https://github.com/leon/site/actions/runs/9", runId: 9 }]);
  });

  it("annotations refused (no Checks): the failed step is the line, never an error; a job GitHub never started is billing", async () => {
    const { host } = github([]);
    expect(await host.failures(cfg("github"), "t", [{ id: 5, name: "check", url: "", step: "Run tests" }])).toEqual([{ run: { id: 5, name: "check", url: "", step: "Run tests" }, lines: ['failed at step "Run tests"'], billing: false, paths: null }]);
    expect((await host.failures(cfg("github"), "t", [{ id: 5, name: "check", url: "", unstarted: true }]))[0]!.billing).toBe(true);
  });

  it("only a job that failed with no step and no runner is taken as never started; a cancelled one isn't", async () => {
    const bare = (conclusion: string) => ({ id: 5, name: "check", status: "completed", conclusion, runner_name: null, steps: [] });
    const failed = async (conclusion: string) => (await github([run(9, "completed", "failure")], { 9: [bare(conclusion)] }).host.ciStatus(cfg("github"), "t", SHA)).failed[0];
    expect(await failed("failure")).toMatchObject({ unstarted: true });
    expect(await failed("cancelled")).not.toHaveProperty("unstarted");
  });

  it("a failing test that only mentions billing is a real failure", async () => {
    const { host } = github([], {}, {
      5: [
        // A test about GitHub's billing text, failing: it names its file, so it is the agent's to fix.
        { annotation_level: "failure", path: "apps/server/test/git-hosts.test.ts", start_line: 9, title: "billing", message: "expected 'The job was not started because your spending limit needs to be increased' to match" },
        { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." },
      ],
    });
    const [found] = await host.failures(cfg("github"), "t", [{ id: 5, name: "check", url: "" }]);
    expect(found!.billing).toBe(false);
    expect(found!.lines).toHaveLength(1);
  });

  it("GitHub's own account-level refusal in the annotations is billing", async () => {
    const { host } = github([], {}, {
      5: [{ annotation_level: "failure", path: ".github", message: "The job was not started because recent account payments have failed or your spending limit needs to be increased." }],
    });
    expect((await host.failures(cfg("github"), "t", [{ id: 5, name: "check", url: "" }]))[0]!.billing).toBe(true);
  });

  it("a refused Actions read is a GitHostError with the status, so the gate can tell a token problem from an outage", async () => {
    const host = gitHostService({ fetch: (async () => json(403, { message: "Resource not accessible by personal access token" })) as unknown as typeof fetch });
    await expect(host.ciStatus(cfg("github"), "t", SHA)).rejects.toMatchObject({ status: 403, message: expect.stringContaining("not accessible") });
  });

  it("Gitea still reads the commit statuses", async () => {
    const urls: string[] = [];
    const host = gitHostService({ fetch: (async (u: string) => (urls.push(u), json(200, { statuses: [{ context: "ci", status: "failure" }] }))) as unknown as typeof fetch });
    expect(await host.ciStatus(cfg("gitea"), "t", SHA)).toEqual({ state: "failed", failed: [{ id: 0, name: "ci", url: "" }], waiting: [], billing: false });
    expect(urls).toEqual([`https://host/api/repos/leon/site/commits/${SHA}/status`]);
    expect(await host.failures(cfg("gitea"), "t", [{ id: 0, name: "ci", url: "" }])).toEqual([]);
  });

  it("reads failing tests from the failed jobs' annotations, without git's generic exit line", async () => {
    const { host } = github([], {}, {
      5: [
        { annotation_level: "failure", path: "apps/web/test/a.test.ts", start_line: 3, title: "a > renders", message: "expected 1 to be 2\nat line 3" },
        { annotation_level: "warning", path: "x", message: "slow" },
        { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." },
      ],
    });
    expect(await host.failures(cfg("github"), "t", [{ id: 5, name: "web-browser", url: "" }])).toEqual([{ run: { id: 5, name: "web-browser", url: "" }, lines: ["apps/web/test/a.test.ts:3: a > renders: expected 1 to be 2"], billing: false, paths: ["apps/web/test/a.test.ts"] }]);
  });

  it("a token refused the annotations asks once more without it (a public repo's need none), and a private repo stays refused (BOS-1733)", async () => {
    const seen: Array<{ url: string; auth: boolean }> = [];
    const host = (publicRepo: boolean) =>
      gitHostService({
        fetch: (async (u: string, init?: RequestInit) => {
          const auth = !!(init?.headers as Record<string, string>)?.authorization;
          seen.push({ url: u, auth });
          if (auth) return json(403, { message: "Resource not accessible by personal access token" });
          return publicRepo ? json(200, [{ annotation_level: "failure", path: "apps/x.test.ts", start_line: 1, message: "boom" }]) : json(404, { message: "Not Found" });
        }) as unknown as typeof fetch,
      });
    expect(await host(true).failures(cfg("github"), "t", [{ id: 5, name: "check", url: "" }])).toEqual([{ run: { id: 5, name: "check", url: "" }, lines: ["apps/x.test.ts:1: boom"], billing: false, paths: ["apps/x.test.ts"] }]);
    expect(seen.map((s) => s.auth)).toEqual([true, false]);
    expect((await host(false).failures(cfg("github"), "t", [{ id: 5, name: "check", url: "", step: "Run tests" }]))[0]).toMatchObject({ lines: ['failed at step "Run tests"'], paths: null });
  });

  it("re-runs only a run's failed jobs, and reads a refusal or another host as false (BOS-1733)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const host = (status: number) => gitHostService({ fetch: (async (u: string, init?: RequestInit) => (calls.push({ url: u, method: String(init?.method) }), json(status, {}))) as unknown as typeof fetch });
    expect(await host(201).rerunFailedJobs(cfg("github"), "t", 9)).toBe(true);
    expect(calls).toEqual([{ url: "https://host/api/repos/leon/site/actions/runs/9/rerun-failed-jobs", method: "POST" }]);
    expect(await host(403).rerunFailedJobs(cfg("github"), "t", 9)).toBe(false);
    expect(await host(201).rerunFailedJobs(cfg("gitea"), "t", 9)).toBe(false);
    expect(await host(201).rerunFailedJobs(cfg("github"), "t", 0)).toBe(false);
  });

  it("the token check probes Actions runs and names only Actions: Read-only (and Metadata), never Checks", async () => {
    const urls: string[] = [];
    const access = (actions: number) =>
      gitHostService({
        fetch: (async (u: string) => {
          urls.push(u);
          if (u.includes("/actions/runs")) return json(actions, actions === 200 ? { workflow_runs: [] } : { message: "no" });
          if (u.includes("/check-")) return json(403, { message: "no" });
          return json(200, { default_branch: "main", permissions: { push: true } });
        }) as unknown as typeof fetch,
      }).checkAccess(cfg("github"), "t");
    const ok = await access(200);
    expect(ok).toMatchObject({ ok: true, canPush: true, canReadChecks: true, message: expect.stringContaining("can read GitHub Actions runs") });
    expect(urls).toContain("https://host/api/repos/leon/site/actions/runs?per_page=1");
    const no = await access(403);
    expect(no).toMatchObject({ ok: true, canReadChecks: false, message: expect.stringContaining("Actions: Read-only (and Metadata: Read-only)") });
    expect(`${ok.message} ${no.message}`).not.toMatch(/Checks/);
    expect(urls.some((u) => u.includes("/check-"))).toBe(false);
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
  it("says so when the token can't read checks or Actions runs", async () => {
    await expect(host(403, { message: "Resource not accessible by personal access token" }).checks(cfg("github"), "t", "a".repeat(40))).rejects.toMatchObject({ status: 403 });
  });
  it("a token refused the Checks API reads the commit's Actions runs instead (BOS-1630)", async () => {
    const answer = (runs: unknown[]) =>
      gitHostService({ fetch: (async (u: string) => (u.includes("/check-runs") ? json(403, { message: "Resource not accessible by personal access token" }) : json(200, { workflow_runs: runs }))) as unknown as typeof fetch }).checks(cfg("github"), "t", "a".repeat(40));
    const r = (name: string, status: string, conclusion: string | null, id: number) => ({ id, name, status, conclusion, html_url: `https://example.com/runs/${id}` });
    expect(await answer([r("CI", "completed", "success", 1), r("Docs", "completed", "failure", 2)])).toEqual({ state: "failed", failing: ["Docs"], total: 2, url: "https://example.com/runs/2" });
    expect(await answer([r("CI", "in_progress", null, 1)])).toMatchObject({ state: "pending", total: 1 });
    expect(await answer([])).toMatchObject({ state: "none", total: 0 });
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

  it("reads the workflow file of a run, and a compare's commits with parents and every changed file (BOS-1688)", async () => {
    const h = host((p) =>
      p.startsWith("/actions/runs?")
        ? json(200, { workflow_runs: [{ id: 5, name: "CI", event: "push", status: "completed", conclusion: "failure", head_sha: "a".repeat(40), path: ".github/workflows/ci.yml@refs/heads/main" }] })
        : json(200, {
            commits: [{ sha: "b".repeat(40), commit: { message: "Merge y\n\nbody" }, parents: [{ sha: "a".repeat(40) }, { sha: "e".repeat(40) }] }],
            files: [{ filename: "apps/server/test/a.test.ts" }, { filename: "new.ts", previous_filename: "old.ts" }],
          }),
    );
    expect((await h.workflowRuns(cfg("github"), "t", "main"))[0]!.path).toBe(".github/workflows/ci.yml");
    expect(await h.compareDetail(cfg("github"), "t", "a".repeat(40), "b".repeat(40))).toEqual({
      commits: [{ sha: "b".repeat(40), message: "Merge y", parents: ["a".repeat(40), "e".repeat(40)] }],
      files: ["apps/server/test/a.test.ts", "new.ts", "old.ts"],
    });
    await expect(host(() => json(403, { message: "Resource not accessible" })).compareDetail(cfg("github"), "t", "a", "b")).rejects.toMatchObject({ status: 403 });
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
