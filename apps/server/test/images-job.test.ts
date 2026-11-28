// BOS-2907: GitHub's images job on a ticket's bossman-ci branch, shown on `tickets read` step by step, so a criterion only
// Docker can prove (BOS-2804's "two installs side by side") is marked from a run anyone can read.
import { describe, expect, it } from "vitest";
import { branchCommitFor, imagesJobLines, installTail, jobLine } from "../src/services/images-job.js";
import { GitHostError, type GitHostConfig, type WorkflowJob, type WorkflowRun } from "../src/services/git-hosts.js";

const TICKET = "fc99be33-6015-46a3-be83-a54840ec7517";
const cfg: GitHostConfig = { kind: "github", apiBase: "https://api.example.com", owner: "leon", repo: "site" };

// The shape of an images job log: the shell tests step runs install-images.test.sh without a release (its compose checks,
// then "skip: real install"), and the install step's echoed command comes before the real install's lines.
const LOG = [
  "2026-11-28T04:21:04.0000000Z ##[group]Run sudo apt-get install -y shellcheck >/dev/null",
  "2026-11-28T04:21:05.0000000Z ok   nothing is built",
  "2026-11-28T04:21:05.1000000Z skip: real install (set INSTALL_RELEASE_JSON to run it)",
  "2026-11-28T04:30:04.0000000Z ##[group]Run set -euo pipefail",
  '2026-11-28T04:30:04.0000000Z \u001b[36;1mINSTALL_HELPER_MOVE=1 INSTALL_RELEASE_JSON="$RUNNER_TEMP/release.json" scripts/test-shell.sh scripts/install-images.test.sh\u001b[0m',
  "2026-11-28T04:30:04.1000000Z ##[endgroup]",
  "2026-11-28T04:30:10.0000000Z ok   nothing is built",
  "2026-11-28T04:30:50.0000000Z  Container bminstall1b-updater Started",
  "2026-11-28T04:31:00.0000000Z ok   the second install answers /api/health beside the first",
  "2026-11-28T04:31:01.0000000Z FAIL pack volumes: bminstall1_claude-pack and bminstall1b_claude-pack must both exist",
  "2026-11-28T04:31:02.0000000Z ok   the first install still answers after the second was removed",
  "2026-11-28T04:31:03.0000000Z test-shell: FAILED scripts/install-images.test.sh (exit 1)",
].join("\n");

const step = (number: number, name: string, conclusion: string | null, status = "completed") => ({ number, name, status, conclusion });
const INSTALL = "Install from the images this branch just built, by digest, through a throwaway local registry (BOS-974, docs/35-install-from-images.md)";
const job = (id: number, name: string, conclusion: string | null, steps: WorkflowJob["steps"], status = "completed"): WorkflowJob => ({ id, name, status, conclusion, url: `https://example.com/job/${id}`, steps });
const run = (o: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 46106922869,
  attempt: 1,
  name: "CI",
  event: "push",
  status: "completed",
  conclusion: "failure",
  headSha: "8c7712b206bcf3cfb5ea68840a3faf89e335da6b",
  headMessage: "GitHub CI before review (workflows from main)",
  path: ".github/workflows/ci.yml",
  url: "https://example.com/runs/46106922869",
  createdAt: "2026-11-28T04:18:32Z",
  updatedAt: "2026-11-28T04:51:22Z",
  ...o,
});

describe("installTail", () => {
  it("counts only the real install's lines, after the install step's command", () => {
    const t = installTail(LOG)!;
    expect(t.ok).toBe(3);
    expect(t.failed).toBe(1);
    expect(t.fails).toEqual(["FAIL pack volumes: bminstall1_claude-pack and bminstall1b_claude-pack must both exist", "test-shell: FAILED scripts/install-images.test.sh (exit 1)"]);
    expect(t.last).toEqual(["FAIL pack volumes: bminstall1_claude-pack and bminstall1b_claude-pack must both exist", "ok the first install still answers after the second was removed", "test-shell: FAILED scripts/install-images.test.sh (exit 1)"]);
  });

  it("is null when the install step never ran (only the compose-only run and its skip)", () => {
    expect(installTail(LOG.split("\n").slice(0, 3).join("\n"))).toBeNull();
  });

  it("redacts a secret-looking value in a result line", () => {
    const t = installTail(`INSTALL_RELEASE_JSON=x scripts/install-images.test.sh\nFAIL token ghp_${"a".repeat(36)} refused`)!;
    expect(t.fails[0]).not.toContain("a".repeat(36));
  });
});

describe("branchCommitFor", () => {
  const kinds = { started: "ci_preflight_started", result: "ci_preflight" };
  const at = (iso: string) => new Date(iso);
  it("names the branch commit whose before-review run started just before the GitHub run", () => {
    const rows = [
      { kind: "ci_preflight_started", sha: "aaaa1111", at: at("2026-11-28T03:10:00Z") },
      { kind: "ci_preflight", sha: "aaaa1111", at: at("2026-11-28T03:40:00Z") },
      { kind: "ci_preflight_started", sha: "bbbb2222", at: at("2026-11-28T04:18:00Z") },
    ];
    expect(branchCommitFor("2026-11-28T04:18:32Z", rows, kinds)).toBe("bbbb2222");
    expect(branchCommitFor("2026-11-28T03:15:00Z", rows, kinds)).toBe("aaaa1111");
  });

  it("names none for a run made after that before-review run had already ended (the merge gate's copy)", () => {
    const rows = [
      { kind: "ci_preflight_started", sha: "aaaa1111", at: at("2026-11-28T03:10:00Z") },
      { kind: "ci_preflight", sha: "aaaa1111", at: at("2026-11-28T03:40:00Z") },
    ];
    expect(branchCommitFor("2026-11-28T05:00:00Z", rows, kinds)).toBeNull();
    expect(branchCommitFor("2026-11-28T03:00:00Z", rows, kinds)).toBeNull();
  });
});

describe("jobLine", () => {
  it("says where a job failed and that the install step was never reached", () => {
    const j = job(1, "images (arm64)", "failure", [step(3, "Build the server image", "failure"), step(28, INSTALL, "skipped")]);
    expect(jobLine(j, "arm64", null)).toBe('- images (arm64): FAILED at step "Build the server image"; install step: not reached. https://example.com/job/1');
  });

  it("says a skipped job ran no image steps", () => {
    expect(jobLine(job(2, "images (amd64)", "skipped", []), "amd64", null)).toContain("skipped (GitHub ran no image jobs");
  });

  it("names the step a running job is at", () => {
    const j = job(3, "images (amd64)", null, [step(27, "Shell script tests (deploy.sh, the host deployer, backup and Penpot)", null, "in_progress"), step(28, INSTALL, null, "queued")], "in_progress");
    expect(jobLine(j, "amd64", null)).toBe('- images (amd64): still running (at step "Shell script tests (deploy.sh, the host deployer, backup and Penpot)"); install step: not reached. https://example.com/job/3');
  });
});

describe("imagesJobLines", () => {
  const jobs = [
    job(10, "changes", "success", []),
    job(11, "images (amd64)", "failure", [step(27, "Shell script tests (deploy.sh, the host deployer, backup and Penpot)", "success"), step(28, INSTALL, "failure")]),
    job(12, "images (arm64)", "success", [step(28, INSTALL, "success")]),
    job(13, "images (join amd64 + arm64)", "skipped", []),
  ];
  const fake = (o: { runs?: WorkflowRun[]; jobs?: WorkflowJob[]; logs?: Record<number, string>; runsError?: Error } = {}) => {
    const calls = { runs: [] as string[], logs: [] as number[] };
    const hosts = {
      workflowRuns: async (_c: GitHostConfig, _t: string, branch: string) => {
        calls.runs.push(branch);
        if (o.runsError) throw o.runsError;
        return o.runs ?? [run({ id: 1, createdAt: "2026-11-28T03:00:00Z" }), run()];
      },
      runJobs: async () => o.jobs ?? jobs,
      jobLog: async (_c: GitHostConfig, _t: string, id: number) => {
        calls.logs.push(id);
        const l = (o.logs ?? { 11: LOG })[id];
        if (l === undefined) throw new GitHostError(403, "nope");
        return l;
      },
    };
    return { hosts, calls };
  };

  it("shows the newest CI run on the ticket's bossman-ci branch, each architecture and the install test's lines", async () => {
    const { hosts, calls } = fake();
    const lines = (await imagesJobLines(hosts, cfg, "x", TICKET, async () => "39b99e03aaaa"))!;
    expect(calls.runs).toEqual([`bossman-ci/${TICKET}`]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("run 46106922869 attempt 1, finished failure");
    expect(lines[0]).toContain('it tested pushed commit 8c7712b2 "GitHub CI before review (workflows from main)", your branch commit 39b99e03 merged with main');
    expect(lines[1]).toContain("- images (amd64): FAILED; install step: FAILED; install-images.test.sh: 3 ok, 1 FAIL");
    expect(lines[1]).toContain('"ok the first install still answers after the second was removed"');
    // A log that can't be read (job 12 here) is said, not passed over.
    expect(lines[2]).toBe("- images (arm64): passed; install step: passed; install-images.test.sh lines: the job log couldn't be read (open the job page). https://example.com/job/12");
  });

  it("reads a finished job's log once, then answers from what it kept", async () => {
    const { hosts, calls } = fake({ runs: [run({ id: 777 })], jobs: [job(91, "images (amd64)", "failure", [step(28, INSTALL, "failure")])], logs: { 91: LOG } });
    await imagesJobLines(hosts, cfg, "x", TICKET, async () => null);
    const again = (await imagesJobLines(hosts, cfg, "x", TICKET, async () => null))!;
    expect(calls.logs).toEqual([91]);
    expect(again[0]).toContain("the merge gate's copy or an earlier before-review run");
    expect(again[1]).toContain("3 ok, 1 FAIL");
  });

  it("shows nothing when there is no run, or the run has no images jobs, or the host isn't GitHub", async () => {
    expect(await imagesJobLines(fake({ runs: [] }).hosts, cfg, "x", TICKET, async () => null)).toBeNull();
    expect(await imagesJobLines(fake({ jobs: [job(10, "changes", "success", [])] }).hosts, cfg, "x", TICKET, async () => null)).toBeNull();
    expect(await imagesJobLines(fake().hosts, { ...cfg, kind: "gitea" }, "x", TICKET, async () => null)).toBeNull();
  });

  it("says plainly when GitHub refuses the runs", async () => {
    const lines = await imagesJobLines(fake({ runsError: new GitHostError(403, "Couldn't read the workflow runs: Resource not accessible") }).hosts, cfg, "x", TICKET, async () => null);
    expect(lines).toEqual(["GitHub images job: not available (Couldn't read the workflow runs: Resource not accessible)."]);
  });
});
