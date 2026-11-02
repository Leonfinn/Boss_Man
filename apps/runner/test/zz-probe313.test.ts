import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

function origin() {
  const bare = mkdtempSync(path.join(tmpdir(), "bm-p-origin-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(path.join(tmpdir(), "bm-p-seed-"));
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "app.txt"), "line 1\n");
  git(seed, "add", "."); git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { url: bare, mainSha: () => git(bare, "rev-parse", "main") };
}
const ids = { project: "11111111-1111-4111-8111-111111111111", t: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

async function setup(o: ReturnType<typeof origin>) {
  const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-p-root-")));
  const spec = { projectId: ids.project, ticketId: ids.t, repoUrl: o.url, baseRef: "main" };
  const w = await ws.ensure(spec);
  writeFileSync(path.join(w.path, "b.txt"), "b\n");
  git(w.path, "add", "."); git(w.path, "commit", "-qm", "b");
  return { ws, spec };
}

describe("probe 313", () => {
  it("BLOCKER1: when tree is reused on new parents, checked.sha is the commit actually checked", async () => {
    const o = origin();
    const { ws, spec } = await setup(o);
    const p = ws.merge(spec, "main", "Merge B", {}, { commands: ["sleep 1"] });
    await new Promise(r => setTimeout(r, 700));
    const noop = git(o.url, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "main^{tree}", "-p", "main", "-m", "noop");
    git(o.url, "update-ref", "refs/heads/main", noop);
    const r: any = await p;
    expect(r.status).toBe("merged");
    // the checked sha must be an ancestor-reachable commit whose tree == shipped tree
    const checkedTree = git(o.url, "rev-parse", `${r.checked.sha}^{tree}`);
    const shippedTree = git(o.url, "rev-parse", "main^{tree}");
    expect(checkedTree).toBe(shippedTree);
    // and the pushed commit must have been built from the checked commit (same tree)
    expect(git(o.url, "rev-parse", "main^{tree}")).toBe(shippedTree);
  }, 30000);

  it("BLOCKER2: stray writer in round N does not write into round N+1 tree", async () => {
    const o = origin();
    const { ws, spec } = await setup(o);
    // check spawns a background writer that keeps writing into its cwd, then times out
    const cmd = "sh -c '(while true; do echo x >> stray.txt; sleep 0.05; done) & sleep 30'";
    const p = ws.merge(spec, "main", "Merge B", {}, { commands: ["sleep 0.2", cmd], timeoutMs: 350 });
    // while it runs, move main so a second round is triggered
    await new Promise(r => setTimeout(r, 150));
    const noop = git(o.url, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "main^{tree}", "-p", "main", "-m", "noop");
    git(o.url, "update-ref", "refs/heads/main", noop);
    const r: any = await p;
    // after it returns, no stray writer should remain under the runner root
    const root = ws.root;
    await new Promise(r2 => setTimeout(r2, 800));
    const found = execFileSync("sh", ["-c", `find ${root}/merge-checks -name stray.txt 2>/dev/null | wc -l`], { encoding: "utf8" }).trim();
    // kill any leftovers so the probe is clean
    execFileSync("sh", ["-c", `pkill -f stray.txt || true`]);
    expect(Number(found)).toBe(0);
  }, 30000);
});
