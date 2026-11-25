import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { allTimeouts, GitHostError, gitHostService, logExcerpt, MAX_LINE, MAX_LOG_CHARS, MAX_LINES, rerunRefusal, summaryCovered } from "../src/services/git-hosts.js";
import { namedTestFiles } from "../src/services/ci-flake.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const cfg = (kind: "github" | "gitea") => ({ kind, apiBase: "https://host/api", owner: "leon", repo: "site" });

describe("logExcerpt: the error lines and the end of a failed job's log (BOS-1667)", () => {
  it("keeps the error lines, cleans timestamps and colour codes, and drops them from the tail", () => {
    const log = [
      "npm run test",
      "PASS a.test.ts",
      "FAIL b.test.ts > adds one",
      "Error: expected 2 to be 3",
      "at b.test.ts:7:9",
      "Tests: 1 failed, 1 passed",
      '2026-11-16T10:00:00.1234567Z \u001b[31m##[error]Process completed with exit code 1\u001b[0m',
      "done",
    ].join("\n");
    expect(logExcerpt(log)).toEqual({
      errors: ["FAIL b.test.ts > adds one", "Error: expected 2 to be 3", "Tests: 1 failed, 1 passed", "error: Process completed with exit code 1"],
      tail: ["npm run test", "PASS a.test.ts", "at b.test.ts:7:9", "done"],
    });
  });

  it("falls back to the end of the log when nothing looks like an error, leaving the tail empty", () => {
    expect(logExcerpt("one\ntwo\nthree")).toEqual({ errors: ["one", "two", "three"], tail: [] });
  });

  it("gives nothing for an empty or blank log", () => {
    expect(logExcerpt("")).toEqual({ errors: [], tail: [] });
    expect(logExcerpt("  \n\t\n")).toEqual({ errors: [], tail: [] });
  });

  it("caps the errors near the failure and the tail at ten lines", () => {
    const log = [...Array.from({ length: 20 }, (_, i) => `error ${i + 1}`), ...Array.from({ length: 12 }, (_, i) => `note ${i + 1}`)].join("\n");
    const { errors, tail } = logExcerpt(log);
    expect(errors).toHaveLength(MAX_LINES);
    expect(errors[0]).toBe("error 6");
    expect(errors.at(-1)).toBe("error 20");
    expect(tail).toEqual(["note 3", "note 4", "note 5", "note 6", "note 7", "note 8", "note 9", "note 10", "note 11", "note 12"]);
  });

  it("shortens a tail line over the limit", () => {
    const { errors, tail } = logExcerpt(`error: boom\n${"y".repeat(400)}`);
    expect(errors).toEqual(["error: boom"]);
    expect(tail).toEqual([`${"y".repeat(MAX_LINE)}…`]);
  });
});

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
    expect(await host.ciStatus(cfg("github"), "t", SHA)).toEqual({ state: "failed", failed: [{ id: 5, name: "check", url: "https://github.com/leon/site/actions/runs/9/job/5", step: "Run tests", runId: 9, workflowId: 1 }], waiting: [], billing: false });
    expect((await github([]).host.ciStatus(cfg("github"), "t", SHA)).state).toBe("none");
  });

  it("BOS-2082: gives the failed step's time, and a job's usual step time from the workflow's green runs", async () => {
    const step = (name: string, conclusion: string, seconds?: number) => ({ number: 2, name, status: "completed", conclusion, ...(seconds !== undefined ? { started_at: "2026-11-20T11:00:00Z", completed_at: new Date(Date.parse("2026-11-20T11:00:00Z") + seconds * 1000).toISOString() } : {}) });
    const web = (id: number, conclusion: string, seconds?: number, stepName = "Web tests") => ({ id, name: "web-browser", status: "completed", conclusion, runner_name: "GitHub Actions 2", html_url: "", steps: [step(stepName, conclusion, seconds)] });
    const urls: string[] = [];
    const runs: Record<number, unknown[]> = {
      9: [web(5, "failure", 698)],
      // Green runs: two usable, one where the job failed, one with another step name, one with no times, then a usable one.
      21: [web(31, "success", 211)],
      22: [web(32, "success", 343)],
      23: [web(33, "failure", 900)],
      24: [web(34, "success", 250, "Other step")],
      25: [web(35, "success")],
      26: [web(36, "success", 260)],
    };
    const host = gitHostService({
      fetch: (async (u: string) => {
        urls.push(u);
        if (/\/actions\/runs\?head_sha=/.test(u)) return json(200, { workflow_runs: [run(9, "completed", "failure", { workflow_id: 77 })] });
        if (/\/actions\/workflows\/77\/runs\?status=success/.test(u)) return json(200, { workflow_runs: [9, 21, 22, 23, 24, 25, 26].map((id) => ({ id })) });
        const j = /\/actions\/runs\/(\d+)\/jobs/.exec(u);
        if (j) return json(200, { jobs: runs[Number(j[1])] ?? [] });
        return json(404, {});
      }) as unknown as typeof fetch,
    });
    const s = await host.ciStatus(cfg("github"), "t", SHA);
    expect(s.failed).toEqual([{ id: 5, name: "web-browser", url: "", step: "Web tests", runId: 9, workflowId: 77, stepSeconds: 698 }]);
    expect(await host.stepTimes(cfg("github"), "t", { workflowId: 77, job: "web-browser", step: "Web tests", exceptRunId: 9, want: 8 })).toEqual([211, 343, 260]);
    // It stops reading once it has enough, and the failing run itself is never read as a baseline.
    urls.length = 0;
    expect(await host.stepTimes(cfg("github"), "t", { workflowId: 77, job: "web-browser", step: "Web tests", exceptRunId: 9, want: 2 })).toEqual([211, 343]);
    expect(urls.filter((u) => /\/runs\/\d+\/jobs/.test(u)).map((u) => /runs\/(\d+)\/jobs/.exec(u)![1])).toEqual(["21", "22"]);
    expect(await host.stepTimes(cfg("gitea"), "t", { workflowId: 77, job: "web-browser", step: "Web tests", want: 8 })).toEqual([]);
  });

  it("BOS-2082: says whether every test failure was a timeout, judged on the message, not the test's title", async () => {
    const notes = (rows: unknown[]) => github([], {}, { 5: rows }).host.failures(cfg("github"), "t", [{ id: 5, name: "web-browser", url: "" }]);
    const exit = { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." };
    const timedOut = { annotation_level: "failure", path: "apps/web/test/a.test.ts", title: "a > renders", message: "Error: Test timed out in 15000ms." };
    const playwright = { annotation_level: "failure", path: "apps/web/test/b.test.ts", title: "b", message: "TimeoutError: page.waitForSelector: Timeout 30000ms exceeded." };
    const assertion = { annotation_level: "failure", path: "apps/web/test/c.test.ts", title: "c > handles a timeout", message: "AssertionError: expected 1 to be 2" };
    expect((await notes([timedOut, playwright, exit]))[0]!.timeoutsOnly).toBe(true);
    expect((await notes([timedOut, assertion, exit]))[0]!.timeoutsOnly).toBe(false);
    expect((await notes([exit]))[0]!.timeoutsOnly).toBe(false);
    // ci.yml's web-browser summary: one annotation on ".github", entries joined by " | ", each judged on its own.
    const summary = (msg: string) => ({ annotation_level: "failure", path: ".github", title: "web tests failed", message: msg });
    const t = (n: number) => `f${n}.test.tsx: renders: Error: Test timed out in 15000ms.`;
    expect((await notes([summary([t(1), t(2), t(3)].join(" | ")), exit]))[0]!.timeoutsOnly).toBe(true);
    expect((await notes([summary([t(1), "f2.test.tsx: renders: AssertionError: expected 1 to be 2", t(3)].join(" | ")), exit]))[0]!.timeoutsOnly).toBe(false);
  });

  it("BOS-2082: allTimeouts lets only the last entry of a summary cut at its cap lack the word", () => {
    const t = (n: number) => `wrap-up-layout-${n}.test.tsx: keeps the layout when the panel opens: Error: Test timed out in 30000ms.`;
    const full = Array.from({ length: 14 }, (_, i) => t(i)).join(" | ");
    expect(full.length).toBeGreaterThan(1400);
    // ci.yml cuts the joined text at 1500 characters, mid-entry: whole timeout entries, then a cut last one.
    expect(allTimeouts(`${full} | board-wheel.test.tsx: scrolls the bo`)).toBe(true);
    expect(allTimeouts(`${t(1)} | board-wheel.test.tsx: scrolls the bo`)).toBe(false);
    expect(allTimeouts(`${full} | x.test.tsx: AssertionError: no | ${t(2)}`)).toBe(false);
    expect(allTimeouts("")).toBe(false);
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
    expect(await host.failures(cfg("github"), "t", [{ id: 5, name: "web-browser", url: "" }])).toEqual([{ run: { id: 5, name: "web-browser", url: "" }, lines: ["apps/web/test/a.test.ts:3: a > renders: expected 1 to be 2"], billing: false, paths: ["apps/web/test/a.test.ts"], timeoutsOnly: false }]);
  });

  describe("a job's own summary note (BOS-2082)", () => {
    // Real annotations, copied from GitHub's run pages. Run 44899835927 (21 Nov 11:35), job web-browser: one test failed by
    // chance, and the job wrote only its summary, which has no file, so nothing could be re-run.
    const SUMMARY_44899835927 =
      "page-intro-browser.test.ts: safari-1550x1611: each place shows its lead and folds the rest away until pressed: AssertionError: server: the lead is on the page: expected 'Boss Man\\nBoss Man Co\\n0 agents\\n▾\\nS…' to contain 'Stops every company from starting new…'";
    const exit = { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." };
    const summary = { annotation_level: "failure", path: ".github", title: "web tests failed", message: SUMMARY_44899835927 };
    // What ci.yml's web-browser job now writes beside the summary: the failed file on its repo path.
    const onFile = { annotation_level: "failure", path: "apps/web/test/page-intro-browser.test.ts", title: "web test failed", message: "safari-1550x1611: each place shows its lead…" };
    const read = async (rows: unknown[]) => (await github([], {}, { 5: rows }).host.failures(cfg("github"), "t", [{ id: 5, name: "web-browser", url: "" }]))[0]!;

    it("a summary alone (the old web-browser job) still names no test file, so nothing is re-run", async () => {
      const f = await read([exit, summary]);
      expect(f.paths).toEqual([""]);
      expect(namedTestFiles([{ job: "web-browser", paths: f.paths }]).unnamed).toEqual(["web-browser"]);
    });

    it("a summary whose every entry a file note names is left out, so the job names its file (failed on the old code)", async () => {
      const f = await read([exit, summary, onFile]);
      expect(f.paths).toEqual(["apps/web/test/page-intro-browser.test.ts"]);
      expect(namedTestFiles([{ job: "web-browser", paths: f.paths }])).toEqual({ files: ["apps/web/test/page-intro-browser.test.ts"], unnamed: [], unsafe: [] });
      // The summary is still shown to the agent.
      expect(f.lines.some((l) => l.startsWith("web tests failed: page-intro-browser.test.ts"))).toBe(true);
    });

    it("a summary naming a file no note names, or a note with no file names at all, keeps the job unnamed", async () => {
      const other = { ...summary, message: `${SUMMARY_44899835927} | board-wheel.test.ts: wheels: page.waitForSelector: Timeout 15000ms exceeded.` };
      expect((await read([exit, other, onFile])).paths).toEqual(["", "apps/web/test/page-intro-browser.test.ts"]);
      const noReport = { annotation_level: "failure", path: ".github", title: "web tests failed", message: "no JSON report was written" };
      expect((await read([exit, noReport, onFile])).paths).toEqual(["", "apps/web/test/page-intro-browser.test.ts"]);
    });

    it("run 44943053114 (BOS-2119's flake, check job): the notice-level 'no runner test failed' never counted, and still doesn't", async () => {
      const f = await read([
        { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." },
        {
          annotation_level: "failure",
          path: "apps/web/test/self-deploy-waiting-changes.test.tsx",
          start_line: 121,
          title: "test/self-deploy-waiting-changes.test.tsx > Settings → Updates lists the changes waiting to go live (BOS-875) > shows no waiting list when main is up to date",
          message: "AssertionError: expected 'Checking…' to be 'Up to date' // Object.is equality\n\nExpected: \"Up to date\"\nReceived: \"Checking…\"\n\n ❯ test/self-deploy-waiting-changes.test.tsx:121:67",
        },
        { annotation_level: "notice", path: ".github", title: "no runner test failed", message: "the runner report shows no failed test; look at the other packages' test output" },
      ]);
      expect(f.paths).toEqual(["apps/web/test/self-deploy-waiting-changes.test.tsx"]);
    });

    describe("run 45323213260 (BOS-2393's chance failure, check-worker-image job, 24 Nov 04:25): BOS-2448", () => {
      // GitHub's annotations for check run 138206495160, as the public API returned them (messages cut where marked).
      const exit = { annotation_level: "failure", path: ".github", start_line: 5760, title: "", message: "Process completed with exit code 1." };
      const failedTests = {
        annotation_level: "failure",
        path: ".github",
        start_line: 5759,
        title: "check worker image: failed tests",
        message: " × gives up at the caller's own deadline and reports not-stopped 79ms| ✓ fits the popover on screen at the Brave 1667×724 fold 5008ms|",
      };
      const firstErrors = {
        annotation_level: "failure",
        path: ".github",
        start_line: 5758,
        title: "check worker image: first errors",
        message:
          " FAIL test/docker.test.ts > docker wait for the Claude pack installer (BOS-972) > gives up at the caller's own deadline and reports not-stopped|AssertionError: expected 1 to be greater than 1| ❯ test/docker.test.ts:229:23|…",
      };
      const vitestNote = (path: string) => ({
        annotation_level: "failure",
        path,
        start_line: 229,
        title: "test/docker.test.ts > docker wait for the Claude pack installer (BOS-972) > gives up at the caller's own deadline and reports not-stopped",
        message: "AssertionError: expected 1 to be greater than 1\n ❯ test/docker.test.ts:229:23\n\n",
      });
      const read = async (rows: unknown[]) => (await github([], {}, { 5: rows }).host.failures(cfg("github"), "t", [{ id: 5, name: "check-worker-image", url: "" }]))[0]!;

      it("as it ran: the two file-less summary notes at failure level still leave the job unnamed (why ci.yml changes too)", async () => {
        const f = await read([exit, failedTests, firstErrors, vitestNote("/work/apps/launcher/test/docker.test.ts")]);
        const named = namedTestFiles([{ job: "check-worker-image", paths: f.paths }]);
        expect(named.files).toEqual(["apps/launcher/test/docker.test.ts"]);
        expect(named.unnamed).toEqual(["check-worker-image"]);
      });

      it("the /work path is read as the repo file once the summaries are warnings (failed on the old code: path refused)", async () => {
        const warn = (a: typeof failedTests) => ({ ...a, annotation_level: "warning" });
        // /work: as vitest named it in this run. The other two: ci.yml now mounts at $GITHUB_WORKSPACE, which GitHub's runner
        // makes repo-relative (or leaves under /home/runner/work); every form is read as the same file.
        for (const path of ["/work/apps/launcher/test/docker.test.ts", "apps/launcher/test/docker.test.ts", "/home/runner/work/Boss_Man/Boss_Man/apps/launcher/test/docker.test.ts"]) {
          const f = await read([exit, warn(failedTests), warn(firstErrors), vitestNote(path)]);
          expect(namedTestFiles([{ job: "check-worker-image", paths: f.paths }])).toEqual({ files: ["apps/launcher/test/docker.test.ts"], unnamed: [], unsafe: [] });
        }
      });
    });

    it("summaryCovered reads base names only from entry starts, and a cut entry is not covered", () => {
      const named = ["apps/runner/test/a.test.ts", "apps/runner/test/b.test.ts"];
      expect(summaryCovered("a.test.ts: waits: boom | b.test.ts: x: y", named)).toBe(true);
      expect(summaryCovered("a.test.ts: waits: boom | b.te", named)).toBe(false);
      expect(summaryCovered("the runner report says it failed (or has no test files) but names no failed test", named)).toBe(false);
      expect(summaryCovered("a.test.ts: waits", [])).toBe(false);
    });
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
    expect(await host(true).failures(cfg("github"), "t", [{ id: 5, name: "check", url: "" }])).toEqual([{ run: { id: 5, name: "check", url: "" }, lines: ["apps/x.test.ts:1: boom"], billing: false, paths: ["apps/x.test.ts"], timeoutsOnly: false }]);
    expect(seen.map((s) => s.auth)).toEqual([true, false]);
    expect((await host(false).failures(cfg("github"), "t", [{ id: 5, name: "check", url: "", step: "Run tests" }]))[0]).toMatchObject({ lines: ['failed at step "Run tests"'], paths: null });
  });

  it("re-runs only a run's failed jobs, and reads a refusal or another host as not ok (BOS-1733)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const host = (status: number, body: unknown = {}) => gitHostService({ fetch: (async (u: string, init?: RequestInit) => (calls.push({ url: u, method: String(init?.method) }), json(status, body))) as unknown as typeof fetch });
    expect(await host(201).rerunFailedJobs(cfg("github"), "t", 9)).toEqual({ ok: true });
    expect(calls).toEqual([{ url: "https://host/api/repos/leon/site/actions/runs/9/rerun-failed-jobs", method: "POST" }]);
    expect((await host(403).rerunFailedJobs(cfg("github"), "t", 9)).ok).toBe(false);
    expect((await host(201).rerunFailedJobs(cfg("gitea"), "t", 9)).ok).toBe(false);
    expect((await host(201).rerunFailedJobs(cfg("github"), "t", 0)).ok).toBe(false);
  });

  it("a refused re-run keeps GitHub's own status and message, so the cause is on record (BOS-2082)", async () => {
    const host = (status: number, body: unknown) => gitHostService({ fetch: (async () => json(status, body)) as unknown as typeof fetch });
    // GitHub's answer to a fine-grained token with Actions: Read-only.
    const perm = await host(403, { message: "Resource not accessible by personal access token" }).rerunFailedJobs(cfg("github"), "t", 9);
    expect(perm).toEqual({ ok: false, status: 403, why: "the git token can't re-run GitHub jobs (it needs Actions: Read and write); GitHub answered 403: Resource not accessible by personal access token" });
    // Anything else is not blamed on the token.
    const other = await host(409, { message: "This workflow is already running" }).rerunFailedJobs(cfg("github"), "t", 9);
    expect(other).toEqual({ ok: false, status: 409, why: "GitHub refused to re-run the failed jobs (HTTP 409: This workflow is already running)" });
    expect(rerunRefusal(0, "fetch failed")).toBe("GitHub refused to re-run the failed jobs (no answer: fetch failed)");
  });

  it("cancels only a commit's unfinished runs, keeps GitHub's answer when refused, and counts a just-finished one as gone (BOS-2301)", async () => {
    const SHA = "e".repeat(40);
    const calls: Array<{ url: string; method: string }> = [];
    const host = (cancel: (id: number) => number, list: number | Array<Record<string, unknown>>) =>
      gitHostService({
        fetch: (async (u: string, init?: RequestInit) => {
          calls.push({ url: u, method: String(init?.method) });
          const m = /\/actions\/runs\/(\d+)\/cancel$/.exec(u);
          if (m) {
            const status = cancel(Number(m[1]));
            return json(status, status === 202 ? {} : { message: status === 409 ? "Cannot cancel a workflow run that is completed." : "Resource not accessible by personal access token" });
          }
          return typeof list === "number" ? json(list, { message: "Bad credentials" }) : json(200, { total_count: list.length, workflow_runs: list });
        }) as unknown as typeof fetch,
      });
    const runs = [
      { id: 1, head_sha: SHA, status: "in_progress", conclusion: null },
      { id: 2, head_sha: SHA, status: "queued", conclusion: null },
      { id: 3, head_sha: SHA, status: "completed", conclusion: "failure" },
      { id: 4, head_sha: "f".repeat(40), status: "in_progress", conclusion: null },
    ];
    // Runs 1 and 2 are still going and get cancelled; the finished one and another commit's run are never touched.
    expect(await host(() => 202, runs).cancelRuns(cfg("github"), "t", SHA)).toEqual({ cancelled: 2, still: 0 });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["https://host/api/repos/leon/site/actions/runs/1/cancel", "https://host/api/repos/leon/site/actions/runs/2/cancel"]);
    expect(calls[0]!.url).toContain(`/actions/runs?head_sha=${SHA}`);
    // A run that finished between the read and the cancel (409) is not left going.
    expect(await host((id) => (id === 1 ? 409 : 202), runs).cancelRuns(cfg("github"), "t", SHA)).toEqual({ cancelled: 1, still: 0 });
    // Actions: Read-only: refused, and the refusal names the permission and GitHub's own words.
    expect(await host(() => 403, runs).cancelRuns(cfg("github"), "t", SHA)).toEqual({ cancelled: 0, still: 2, refused: "the git token can't cancel GitHub runs (it needs Actions: Read and write); GitHub answered 403: Resource not accessible by personal access token" });
    // The runs can't be read: unknown, not "nothing to cancel".
    expect(await host(() => 202, 401).cancelRuns(cfg("github"), "t", SHA)).toMatchObject({ cancelled: 0, still: null });
    // Nothing still going: nothing to do.
    expect(await host(() => 202, [runs[2]!]).cancelRuns(cfg("github"), "t", SHA)).toEqual({ cancelled: 0, still: 0 });
    expect((await host(() => 202, runs).cancelRuns(cfg("gitea"), "t", SHA)).cancelled).toBe(0);
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

  it("asks for the page it is given (BOS-2468)", async () => {
    const asked: string[] = [];
    const h = host((p) => (asked.push(p), json(200, { workflow_runs: [] })));
    await h.workflowRuns(cfg("github"), "t", "main", 100, 3);
    await h.workflowRuns(cfg("github"), "t", "main");
    expect(asked).toEqual(["/actions/runs?branch=main&per_page=100&page=3", "/actions/runs?branch=main&per_page=30"]);
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

describe("the gate's CI branches (BOS-1749): list and delete only bossman-ci/", () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fake = (): typeof fetch =>
    (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url) });
      const u = String(url);
      if (u.includes("/git/matching-refs/")) return json(200, [{ ref: "refs/heads/bossman-ci/t1", object: { sha: "a".repeat(40) } }, { ref: "refs/heads/bossman-ci/t2", object: { sha: "b".repeat(40) } }]);
      if (u.includes("/git/commits/" + "a".repeat(40))) return json(200, { committer: { date: "2026-11-17T01:00:00Z" } });
      if (u.includes("/git/commits/")) return json(404, {});
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
  it("lists them with the commit time, an unreadable commit counting as old", async () => {
    calls.length = 0;
    const list = await gitHostService({ fetch: fake() }).ciBranches(cfg("github"), "t");
    expect(list).toEqual([
      { branch: "bossman-ci/t1", sha: "a".repeat(40), committedAt: Date.parse("2026-11-17T01:00:00Z") },
      { branch: "bossman-ci/t2", sha: "b".repeat(40), committedAt: 0 },
    ]);
    expect(calls[0]!.url).toContain("/git/matching-refs/heads/bossman-ci/");
  });
  it("deletes a bossman-ci branch and refuses every other name", async () => {
    calls.length = 0;
    const h = gitHostService({ fetch: fake() });
    expect(await h.deleteCiBranch(cfg("github"), "t", "bossman-ci/t1")).toBe(true);
    for (const bad of ["main", "bossman/t1", "bossman-ci/", "bossman-ci/../main", "x/bossman-ci/t1"]) expect(await h.deleteCiBranch(cfg("github"), "t", bad)).toBe(false);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE https://host/api/repos/leon/site/git/refs/heads/bossman-ci/t1"]);
  });
});
