import { describe, expect, it } from "vitest";
import { GitHostError, gitHostService } from "../src/services/git-hosts.js";

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
