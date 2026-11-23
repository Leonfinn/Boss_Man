// BOS-2345: the gate's GitHub Actions writes (the one flake retry, a cancelled run's re-run) use the second account's
// GIT_CI_TOKEN when the company granted one, and fall back to GIT_TOKEN when GitHub refuses it. Reads stay on GIT_TOKEN.
import { describe, expect, it } from "vitest";
import { publishAndWait, rerunFailedJobsWith, withActionsToken, type CiTarget, type PublishDeps } from "../src/services/ci-publish.js";
import type { CiStatus, GitHostConfig, RerunAnswer } from "../src/services/git-hosts.js";

const cfg: GitHostConfig = { kind: "github", apiBase: "https://api.example.com", owner: "acme", repo: "app" };
const timing = { pollMs: 1, graceMs: 1_000, ceilingMs: 60_000, retryMs: 1 };
const failed: CiStatus = { state: "failed", failed: [{ id: 1, name: "test", url: "https://example.com/run/7", runId: 7 }], waiting: [], billing: false };
const passed: CiStatus = { state: "passed", failed: [], waiting: [], billing: false };

/** A fake GitHub: one failure, then a pass once a re-run was accepted. `refuse` lists the tokens it refuses re-runs from. */
function fakeHosts(refuse: string[]) {
  const reads: string[] = [];
  const reruns: string[] = [];
  let accepted = false;
  const hosts = {
    ciStatus: async (_c: GitHostConfig, token: string, sha: string) => {
      reads.push(token);
      if (sha === "target") return passed;
      return accepted ? passed : failed;
    },
    workflowRuns: async () => [],
    rerunRun: async () => false,
    rerunFailedJobs: async (_c: GitHostConfig, token: string): Promise<RerunAnswer> => {
      reruns.push(token);
      if (refuse.includes(token)) return { ok: false, status: 403, why: `refused for ${token === "main-token" ? "main" : "ci"}` };
      accepted = true;
      return { ok: true };
    },
  };
  return { hosts, reads, reruns };
}

async function run(target: CiTarget, refuse: string[]) {
  const f = fakeHosts(refuse);
  const announced: Array<{ accepted: boolean; refused?: string }> = [];
  const deps: PublishDeps = {
    hosts: f.hosts as unknown as PublishDeps["hosts"],
    target,
    timing,
    publish: async (commit) => ({ status: "published", branch: "bossman-ci/x", hasWorkflows: true, commit }) as never,
    announce: async () => {},
    flakeRetry: async () => ({ retry: true, files: ["test/a.test.ts"] }),
    announceFlakeRetry: async (_a, accepted, refused) => void announced.push({ accepted, ...(refused ? { refused } : {}) }),
  };
  const outcome = await publishAndWait(deps, { commit: "merge", tree: "tree", targetSha: "target" }, { stopped: false });
  return { outcome, announced, ...f };
}

describe("BOS-2345: the flake retry's token", () => {
  it("re-runs with GIT_CI_TOKEN when granted; every read stays on GIT_TOKEN", async () => {
    const r = await run({ cfg, token: "main-token", actionsToken: "ci-token" }, ["main-token"]);
    expect(r.reruns).toEqual(["ci-token"]);
    expect(r.outcome.kind).toBe("passed");
    expect(new Set(r.reads)).toEqual(new Set(["main-token"]));
  });

  it("falls back to GIT_TOKEN when GitHub refuses the second account's token", async () => {
    const r = await run({ cfg, token: "main-token", actionsToken: "ci-token" }, ["ci-token"]);
    expect(r.reruns).toEqual(["ci-token", "main-token"]);
    expect(r.outcome.kind).toBe("passed");
    expect(r.announced).toEqual([{ accepted: true }]);
  });

  it("uses GIT_TOKEN alone, as before, when no second account's token is granted", async () => {
    const r = await run({ cfg, token: "main-token" }, []);
    expect(r.reruns).toEqual(["main-token"]);
    expect(r.outcome.kind).toBe("passed");
  });

  it("a refusal on both tokens says the second account's was refused first, and the ticket goes back as before", async () => {
    const r = await run({ cfg, token: "main-token", actionsToken: "ci-token" }, ["ci-token", "main-token"]);
    expect(r.reruns).toEqual(["ci-token", "main-token"]);
    expect(r.outcome).toMatchObject({ kind: "failed", why: expect.stringContaining("GIT_CI_TOKEN") });
    expect(r.announced[0]).toEqual({ accepted: false, refused: "the second account's token (GIT_CI_TOKEN) was refused: refused for ci; GIT_TOKEN was refused too" });
  });
});

describe("withActionsToken", () => {
  it("doesn't ask twice when the second account's token is the same as GIT_TOKEN", async () => {
    const used: string[] = [];
    const { got, first } = await withActionsToken({ cfg, token: "same", actionsToken: "same" }, async (t) => (used.push(t), false), Boolean);
    expect(used).toEqual(["same"]);
    expect(got).toBe(false);
    expect(first).toBeUndefined();
  });

  it("rerunFailedJobsWith passes GitHub's answer through when the second account's token is accepted", async () => {
    const got = await rerunFailedJobsWith({ rerunFailedJobs: async (_c, t) => (t === "ci" ? { ok: true } : { ok: false, why: "no" }) }, { cfg, token: "main", actionsToken: "ci" }, 7);
    expect(got).toEqual({ ok: true });
  });
});
