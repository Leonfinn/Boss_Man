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
