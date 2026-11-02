// Per-ticket clones (BOS-323): every workspace and merge test again with BOSSMAN_TICKET_COPIES=clone,
// then what only clones give: one ticket can't reach another's branch or plant config the runner
// runs in another's copy, and the shared repo keeps the objects clones borrow.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { branchFor, isClone, Workspaces } from "../src/workspace.js";

vi.stubEnv("BOSSMAN_TICKET_COPIES", "clone");
afterAll(() => vi.unstubAllEnvs());
await import("./workspace.test.js");
await import("./merge.test.js");

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

function remote() {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "v1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "v1");
  return dir;
}

const ids = { project: "11111111-1111-4111-8111-111111111111", a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

/** Two tickets' copies on one runner, made as the runner's setting says. */
async function twoTickets() {
  const url = remote();
  const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
  const spec = (ticketId: string) => ({ projectId: ids.project, ticketId, repoUrl: url, baseRef: "main" });
  const a = await ws.ensure(spec(ids.a));
  const b = await ws.ensure(spec(ids.b));
  return { ws, a, b, spec, repo: ws.repoDir(ids.project) };
}

describe("per-ticket clones (BOS-323)", () => {
  it("makes each copy its own clone, borrowing the shared repo's objects, with origin's branches current", async () => {
    const { a, repo } = await twoTickets();
    expect(isClone(a.path)).toBe(true);
    expect(git(a.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branchFor(ids.a));
    expect(git(a.path, "rev-parse", "origin/main")).toBe(git(repo, "rev-parse", "refs/remotes/origin/main"));
    expect(git(a.path, "remote", "get-url", "origin")).toBe(git(repo, "remote", "get-url", "origin"));
    expect(git(a.path, "rev-parse", "--git-common-dir")).toBe(".git");
    expect(git(repo, "config", "gc.pruneExpire")).toBe("never");
  });

  it("keeps one ticket's branch out of another's reach", async () => {
    const { ws, a, b, spec, repo } = await twoTickets();
    writeFileSync(path.join(b.path, "b.txt"), "b's work\n");
    git(b.path, "add", ".");
    git(b.path, "commit", "-qm", "b's work");
    await ws.checkpoint(spec(ids.b), "after a turn");
    const bHead = git(repo, "rev-parse", `refs/heads/${branchFor(ids.b)}`);

    // From a's copy: delete b's branch, point it somewhere else, and "share" a fake one.
    execFileSync("git", ["update-ref", "-d", `refs/heads/${branchFor(ids.b)}`], { cwd: a.path, stdio: "ignore" });
    execFileSync("sh", ["-c", `git branch -f ${branchFor(ids.b)} HEAD 2>/dev/null; true`], { cwd: a.path });
    await ws.checkpoint(spec(ids.a), "after a turn");

    expect(git(repo, "rev-parse", `refs/heads/${branchFor(ids.b)}`)).toBe(bHead);
    expect(git(b.path, "log", "-1", "--format=%s")).toBe("b's work");
    git(repo, "fsck", "--connectivity-only", "--no-progress");
  });

  it("never runs a filter one ticket sets up when the runner looks at another ticket's copy", async () => {
    const { ws, a, b, spec } = await twoTickets();
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "bm-marker-")), "ran");
    // a's agent sets a clean filter for every path, in the repo config and attributes git reads for its copy.
    git(a.path, "config", "filter.planted.clean", `sh -c 'touch ${marker}; cat'`);
    const common = path.resolve(a.path, git(a.path, "rev-parse", "--git-common-dir"));
    writeFileSync(path.join(common, "info", "attributes"), "* filter=planted\n");

    // The runner records b's turn and makes b's review copy: a's filter must not run for them.
    writeFileSync(path.join(b.path, "b.txt"), "b\n");
    await ws.checkpoint(spec(ids.b), "after a turn");
    await ws.ensureReview({ ...spec(ids.b), review: true });
    await ws.diff(spec(ids.b));
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps objects a clone borrows when the shared repo is cleaned up", async () => {
    const { a, repo } = await twoTickets();
    const borrowed = git(a.path, "rev-parse", "origin/main");
    // Nothing in the shared repo points at that commit any more, as after a force-push to main.
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    for (const ref of git(repo, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean)) git(repo, "update-ref", "-d", ref);
    git(repo, "reflog", "expire", "--all", "--expire=now");
    git(repo, "gc", "--quiet");
    expect(git(a.path, "cat-file", "-t", borrowed)).toBe("commit");
    git(a.path, "fsck", "--connectivity-only", "--no-progress");
  });

  it("refuses to merge rather than merge a stale branch when the clone's branch can't be read", async () => {
    const { ws, a, spec } = await twoTickets();
    git(a.path, "checkout", "-q", "--detach");
    git(a.path, "branch", "-D", branchFor(ids.a));
    await expect(ws.merge(spec(ids.a), "main", "Merge")).rejects.toThrow(/Couldn't bring ticket .* branch over from its copy/);
  });

  it("clears out a clone whose shared repo has gone, but not a live one", async () => {
    const { ws, a, b } = await twoTickets();
    writeFileSync(path.join(b.path, ".git", "objects", "info", "alternates"), "/nonexistent/repos/x.git/objects\n");
    const later = await ws.housekeeping(Date.now() + 2 * 3_600_000);
    expect(later.removed).toEqual([ids.b]);
    expect(existsSync(a.path)).toBe(true);
    expect(later.tickets.map((t) => t.ticketId)).toEqual([ids.a]);
  });
});
