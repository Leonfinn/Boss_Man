import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { GitHostError, gitHostService, MAX_LOG_CHARS } from "../src/services/git-hosts.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const cfg = (kind: "github" | "gitea") => ({ kind, apiBase: "https://host/api", owner: "leon", repo: "site" });

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
