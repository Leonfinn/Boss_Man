// Merge train (BOS-1366, DR-059), runner side, against a real bare "origin": prepare stacks a ticket on the prepared merge of
// the ticket ahead (`base`), and finish pushes only when main's tip is exactly the base the checked tree was built on
// (`expectBase`). Main must only ever receive the very commit that was prepared and checked.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function origin() {
  const bare = tmp("bm-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-seed-");
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "app.txt"), "line 1\nline 2\nline 3\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const pushChange = (file: string, content: string) => {
    git(seed, "pull", "-q", "origin", "main");
    writeFileSync(path.join(seed, file), content);
    git(seed, "add", ".");
    git(seed, "commit", "-qm", `edit ${file}`);
    git(seed, "push", "-q", "origin", "HEAD:main");
  };
  return { url: bare, pushChange, mainSha: () => git(bare, "rev-parse", "main") };
}

const project = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Two tickets on one runner (one shared repo per project), each with one commit. */
async function twoTickets(o: ReturnType<typeof origin>, a: [string, string], b: [string, string]) {
  const ws = new Workspaces(tmp("bm-ws-root-"));
  const make = async (ticketId: string, [file, content]: [string, string]) => {
    const spec = { projectId: project, ticketId, repoUrl: o.url, baseRef: "main" };
    const w = await ws.ensure(spec);
    writeFileSync(path.join(w.path, file), content);
    git(w.path, "add", ".");
    git(w.path, "commit", "-qm", `work on ${file}`);
    return spec;
  };
  return { ws, a: await make(A, a), b: await make(B, b) };
}

type Prepared = { status: "prepared"; commit: string; tree: string; targetSha: string };

describe("merge train on the runner (BOS-1366)", () => {
  it("stacks B on A's prepared merge, then lands A and B in order as the very commits that were prepared", async () => {
    const o = origin();
    const main0 = o.mainSha();
    const { ws, a, b } = await twoTickets(o, ["a.txt", "a\n"], ["b.txt", "b\n"]);
    const pa = (await ws.merge(a, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    expect(pa.status).toBe("prepared");
    const pb = (await ws.merge(b, "main", "Merge B", {}, null, { phase: "prepare", base: pa.commit })) as Prepared;
    expect(pb.status).toBe("prepared");
    expect(pb.targetSha).toBe(pa.commit);
    // B's tree holds A's work as well as its own: B is checked on main plus A.
    expect(git(o.url, "rev-parse", "main")).toBe(main0);

    // B can't land before A: main is not yet B's base.
    expect(await ws.merge(b, "main", "Merge B", {}, null, { phase: "finish", commit: pb.commit, tree: pb.tree, expectBase: pa.commit })).toEqual({ status: "main_moved" });
    expect(o.mainSha()).toBe(main0);

    const la = await ws.merge(a, "main", "Merge A", {}, null, { phase: "finish", commit: pa.commit, tree: pa.tree, expectBase: main0 });
    expect(la).toMatchObject({ status: "merged", commit: pa.commit });
    const lb = await ws.merge(b, "main", "Merge B", {}, null, { phase: "finish", commit: pb.commit, tree: pb.tree, expectBase: pa.commit });
    expect(lb).toMatchObject({ status: "merged", commit: pb.commit });
    // A fast-forward to exactly the checked commits: main is B's prepared commit, whose first parent is A's.
    expect(o.mainSha()).toBe(pb.commit);
    expect(git(o.url, "rev-parse", "main^1")).toBe(pa.commit);
    expect(git(o.url, "rev-parse", "main^{tree}")).toBe(pb.tree);
    expect(git(o.url, "show", "main:a.txt")).toBe("a");
    expect(git(o.url, "show", "main:b.txt")).toBe("b");
  });

  it("refuses a finish when main moved outside the train, even if the merge would give the same tree, and pushes nothing", async () => {
    const o = origin();
    const main0 = o.mainSha();
    const { ws, a } = await twoTickets(o, ["a.txt", "a\n"], ["b.txt", "b\n"]);
    const pa = (await ws.merge(a, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange("other.txt", "someone else\n");
    const moved = o.mainSha();
    expect(moved).not.toBe(main0);
    expect(await ws.merge(a, "main", "Merge A", {}, null, { phase: "finish", commit: pa.commit, tree: pa.tree, expectBase: main0 })).toEqual({ status: "main_moved" });
    expect(o.mainSha()).toBe(moved);
  });

  it("swapped order (a wrong rebuild after a restart): the member that was stacked on the other can't land first", async () => {
    // The rebuilt train thinks B is ahead of A, but B's checked tree was prepared on A. Safety must not depend on the order.
    const o = origin();
    const main0 = o.mainSha();
    const { ws, a, b } = await twoTickets(o, ["a.txt", "a\n"], ["b.txt", "b\n"]);
    const pa = (await ws.merge(a, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    const pb = (await ws.merge(b, "main", "Merge B", {}, null, { phase: "prepare", base: pa.commit })) as Prepared;
    // Claiming main0 as B's base doesn't help: the tree on main0 differs from B's checked tree.
    expect(await ws.merge(b, "main", "Merge B", {}, null, { phase: "finish", commit: pb.commit, tree: pb.tree, expectBase: main0 })).toEqual({ status: "main_moved" });
    expect(o.mainSha()).toBe(main0);
  });

  it("won't prepare on a base that isn't built on main's tip, or that this runner doesn't have", async () => {
    const o = origin();
    const { ws, a, b } = await twoTickets(o, ["a.txt", "a\n"], ["b.txt", "b\n"]);
    const pa = (await ws.merge(a, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange("other.txt", "someone else\n"); // A's prepared merge is now on an old main
    expect(await ws.merge(b, "main", "Merge B", {}, null, { phase: "prepare", base: pa.commit })).toEqual({ status: "main_moved" });
    expect(await ws.merge(b, "main", "Merge B", {}, null, { phase: "prepare", base: "0123456789abcdef0123456789abcdef01234567" })).toEqual({ status: "main_moved" });
    // Main itself as the base is plain prepare.
    const onMain = (await ws.merge(b, "main", "Merge B", {}, null, { phase: "prepare", base: o.mainSha() })) as Prepared;
    expect(onMain).toMatchObject({ status: "prepared", targetSha: o.mainSha() });
  });

  it("reports a clash with the ticket ahead as conflicts, without touching main", async () => {
    const o = origin();
    const main0 = o.mainSha();
    const { ws, a, b } = await twoTickets(o, ["app.txt", "line 1\nA's line 2\nline 3\n"], ["app.txt", "line 1\nB's line 2\nline 3\n"]);
    const pa = (await ws.merge(a, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    expect(await ws.merge(b, "main", "Merge B", {}, null, { phase: "prepare", base: pa.commit })).toEqual({ status: "conflicts", files: ["app.txt"] });
    // On main alone B is clean: the train must not send B back for a clash with a member that may never land.
    expect((await ws.merge(b, "main", "Merge B", {}, null, { phase: "prepare" })).status).toBe("prepared");
    expect(o.mainSha()).toBe(main0);
  });
});
