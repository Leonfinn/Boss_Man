// The agent fence (BOS-321). The live cases run the real Landlock helper and are skipped on a
// kernel without Landlock; the scoping cases need ABI 6.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitAuthEnv } from "../src/workspace.js";
import { addGitConfig, applyCheckSlots, APP_ROOT, claudeProjectSlug, fencedCommand, fenceProfile, levelFor, probeLandlock, repoGrant, runnerFence, sandboxSelfTest, worktreeAdmin } from "../src/fence.js";

const { abi } = probeLandlock();
const live = levelFor(abi).level !== "unavailable";

/** Runs a shell command inside a fence that may write only `inside` (and its temp folder). */
function fenced(inside: string, script: string, env: NodeJS.ProcessEnv = {}, extra: { readWrite?: string[]; readOnly?: string[]; repo?: { bare: string; admin: string | null } } = {}) {
  const tmp = path.join(inside, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const rules = fenceProfile({ cwd: inside, home: inside, tmp, ...extra });
  const cmd = fencedCommand(rules, "/bin/sh", ["-c", script]);
  return spawnSync(cmd.bin, cmd.args, { cwd: inside, encoding: "utf8", env: { PATH: process.env.PATH, HOME: inside, TMPDIR: tmp, ...env } });
}

describe("fence levels", () => {
  it("names what each Landlock ABI can't fence", () => {
    expect(levelFor(0)).toEqual({ level: "unavailable", missing: [] });
    expect(levelFor(1).level).toBe("unavailable"); // every cross-folder rename refused: git breaks
    expect(levelFor(2)).toEqual({ level: "partial", missing: ["truncating files by path", "device ioctl", "signals and sockets of other sessions"] });
    expect(levelFor(4).missing).toEqual(["device ioctl", "signals and sockets of other sessions"]);
    expect(levelFor(6)).toEqual({ level: "full", missing: [] });
    expect(levelFor(7)).toEqual({ level: "full", missing: [] });
  });
});

describe("fence profile", () => {
  it("never grants the workspaces root, other tickets or the shared Claude folder", () => {
    const rules = fenceProfile({
      cwd: "/home/node/workspaces/tickets/t1",
      home: "/home/node/runner-data/agents/a1",
      tmp: "/home/node/runner-data/agents/a1/tmp/r1",
      repo: { bare: "/home/node/workspaces/repos/p.git", admin: "/home/node/workspaces/repos/p.git/worktrees/t1" },
    });
    const all = [...rules.ro, ...rules.rw, ...rules.roFiles, ...rules.rwFiles];
    for (const p of ["/", "/home", "/home/node", "/home/node/workspaces", "/home/node/workspaces/tickets", "/home/node/.claude", "/home/node/runner-data", "/run", "/tmp", "/var"]) {
      expect(all).not.toContain(p);
    }
    expect(rules.rw).toEqual(
      expect.arrayContaining(["/home/node/workspaces/tickets/t1", "/home/node/workspaces/repos/p.git/objects", "/home/node/workspaces/repos/p.git/refs", "/home/node/workspaces/repos/p.git/logs", "/home/node/workspaces/repos/p.git/worktrees/t1"]),
    );
    // The shared repo's config and hooks, which the runner's own git reads, are read-only.
    expect(rules.rw).not.toContain("/home/node/workspaces/repos/p.git");
    expect(rules.ro).toContain("/home/node/workspaces/repos/p.git");
    expect(rules.ro).toContain(path.resolve(APP_ROOT));
  });

  it("adds git settings after the auth header instead of replacing it", () => {
    const env: NodeJS.ProcessEnv = { ...gitAuthEnv({ GIT_TOKEN: "t" }) };
    addGitConfig(env, "gc.auto", "0");
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual(["gc.auto", "0"]);
    const bare: NodeJS.ProcessEnv = {};
    addGitConfig(bare, "gc.auto", "0");
    expect([bare.GIT_CONFIG_COUNT, bare.GIT_CONFIG_KEY_0]).toEqual(["1", "gc.auto"]);
  });

  it("names Claude Code's project folder the way Claude Code does", () => {
    expect(claudeProjectSlug("/home/node/workspaces/repos/473754fd-edfe-4179-96d6-267ebd93e294.git")).toBe("-home-node-workspaces-repos-473754fd-edfe-4179-96d6-267ebd93e294-git");
  });
});

describe("the runner's fence setting", () => {
  it("puts agent homes in the data volume and uses the workspaces volume's pnpm store", () => {
    expect(runnerFence("full", "/data", "/ws")).toEqual({ level: "full", agentsRoot: "/data/agents", pnpmStore: "/ws/.pnpm-store" });
  });

  // main.ts starts the daemon, so no test runs it. Without this setting every run asked to be
  // fenced ran unfenced while hello still offered the fence (found building BOS-323).
  it("is passed to the runner's SessionManager from its self-test", () => {
    const main = readFileSync(path.join(import.meta.dirname, "..", "src", "main.ts"), "utf8");
    expect(main).toMatch(/new SessionManager\(\{[\s\S]*?\n  fence: runnerFence\(sandbox\.level, dataDir, workspacesRoot\),[\s\S]*?\n\}\);/);
  });
});

/** A bare repo with one ticket worktree, laid out like the runner's. */
function repoWithWorktree() {
  const root = mkdtempSync(path.join(tmpdir(), "bm-fence-git-"));
  const git = (args: string[], cwd = root) => execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ID }, encoding: "utf8" }).trim();
  mkdirSync(path.join(root, "src"));
  git(["init", "-q", "-b", "main"], path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.txt"), "a\n");
  git(["add", "a.txt"], path.join(root, "src"));
  git(["commit", "-qm", "init"], path.join(root, "src"));
  git(["clone", "-q", "--bare", "src", "repos/p.git"]);
  git(["worktree", "add", "-q", "-b", "bossman/t1", path.join(root, "tickets", "t1"), "main"], path.join(root, "repos", "p.git"));
  git(["worktree", "add", "-q", "--detach", path.join(root, "reviews", "t1"), "main"], path.join(root, "repos", "p.git"));
  return { root, bare: path.join(root, "repos", "p.git"), ticket: path.join(root, "tickets", "t1"), review: path.join(root, "reviews", "t1"), git };
}
const GIT_ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

describe("worktree admin folder", () => {
  it("is found from the shared repo, for a ticket and for a review copy of the same ticket", () => {
    const r = repoWithWorktree();
    expect(worktreeAdmin(r.bare, r.ticket)).toBe(path.join(r.bare, "worktrees", "t1"));
    const review = worktreeAdmin(r.bare, r.review);
    expect(review).not.toBeNull();
    expect(review).not.toBe(path.join(r.bare, "worktrees", "t1"));
    expect(readFileSync(path.join(review!, "gitdir"), "utf8").trim()).toBe(path.join(r.review, ".git"));
  });

  it("grants nothing when the agent points its .git file somewhere else", () => {
    const r = repoWithWorktree();
    for (const target of [path.join(r.root, "elsewhere"), r.bare, worktreeAdmin(r.bare, r.review)!]) {
      writeFileSync(path.join(r.ticket, ".git"), `gitdir: ${target}\n`);
      expect(worktreeAdmin(r.bare, r.ticket)).toBeNull();
    }
  });

  it("can't be claimed by another worktree's agent", () => {
    const r = repoWithWorktree();
    const review = worktreeAdmin(r.bare, r.review)!;
    // The ticket's agent points its own admin folder at the review copy (same folder name, t1).
    writeFileSync(path.join(r.bare, "worktrees", "t1", "gitdir"), path.join(r.review, ".git") + "\n");
    expect(worktreeAdmin(r.bare, r.review)).toBe(review);
  });

  it("makes the folders a commit writes, which a fresh bare clone lacks", () => {
    const r = repoWithWorktree();
    const grant = repoGrant(r.bare, r.ticket);
    expect(grant).toEqual({ bare: r.bare, admin: path.join(r.bare, "worktrees", "t1") });
    for (const d of ["objects", "refs", "logs"]) expect(existsSync(path.join(r.bare, d))).toBe(true);
  });
});

// The bypass shapes from BOS-114/116/150/158/165/264/280/287 (the BOS-315 corpus): each must leave a
// file outside the fence alone and still work on one inside it. $1 is the target file.
const CORPUS: Array<[string, string]> = [
  ["flagless rm", 'rm "$1"'],
  ["unlink", 'unlink "$1"'],
  ["find -delete", 'find "$(dirname "$1")" -name "$(basename "$1")" -delete'],
  ["delete written to a script, then run", 'printf "rm \\"\\$1\\"\\n" > "$TMPDIR/s.sh"; sh "$TMPDIR/s.sh" "$1"'],
  ["perl -e", 'perl -e "unlink \\$ARGV[0]" "$1"'],
  ["node -e", 'node -e "require(\\"fs\\").unlinkSync(process.argv[1])" "$1"'],
  ["bash -c with the command in a variable", 'v="rm $1"; bash -c "$v"'],
  [": > truncate", ': > "$1"'],
  ["mv out", 'mv "$1" "$TMPDIR/moved"'],
  ["a temp symlink to the folder", 'ln -s "$(dirname "$1")" "$TMPDIR/l$$" && rm "$TMPDIR/l$$/$(basename "$1")"'],
  ["cd, then rm", 'cd "$(dirname "$1")" && rm "$(basename "$1")"'],
  ["cp over", 'cp /etc/hostname "$1"'],
  ["sed -i", 'sed -i s/x/y/ "$1"'],
];

describe.skipIf(!live)("fence, live", () => {
  it.each(CORPUS)("%s: refused outside the fence, works inside it", (_name, script) => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-fence-"));
    const inside = path.join(root, "in");
    const outside = path.join(root, "out");
    mkdirSync(inside);
    mkdirSync(outside);
    for (const d of [inside, outside]) writeFileSync(path.join(d, "f"), "x");
    const changed = (d: string) => !existsSync(path.join(d, "f")) || readFileSync(path.join(d, "f"), "utf8") !== "x";

    fenced(inside, `set -- "${path.join(outside, "f")}"; ${script}`);
    expect(changed(outside)).toBe(false);
    fenced(inside, `set -- "${path.join(inside, "f")}"; ${script}`);
    expect(changed(inside)).toBe(true);
  });

  it("can't read files outside it: a token, another agent's home", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-fence-"));
    const inside = path.join(root, "in");
    mkdirSync(inside);
    writeFileSync(path.join(root, "runner_token"), "secret");
    const r = fenced(inside, `cat "${path.join(root, "runner_token")}" || echo REFUSED; ls "${root}" || echo LIST_REFUSED`);
    expect(r.stdout).not.toContain("secret");
    expect(r.stdout).toContain("REFUSED");
    expect(r.stdout).toContain("LIST_REFUSED");
  });

  it("can't read another session's environment", async () => {
    const sibling = spawn("sleep", ["30"], { env: { PATH: process.env.PATH, SIBLING_TOKEN: "sibling-secret" }, stdio: "ignore" });
    try {
      const inside = mkdtempSync(path.join(tmpdir(), "bm-fence-"));
      const r = fenced(inside, `tr '\\0' '\\n' < /proc/${sibling.pid}/environ || echo REFUSED`);
      expect(r.stdout).not.toContain("sibling-secret");
      expect(r.stdout).toContain("REFUSED");
    } finally {
      sibling.kill();
    }
  });

  it.skipIf(abi < 6)("can't signal the runner or another session", () => {
    const sibling = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const inside = mkdtempSync(path.join(tmpdir(), "bm-fence-"));
      const r = fenced(inside, `kill -0 ${process.pid} && echo RUNNER; kill -0 ${sibling.pid} && echo SIBLING; sleep 5 & kill -0 $! && echo OWN_CHILD`);
      expect(r.stdout).not.toContain("RUNNER");
      expect(r.stdout).not.toContain("SIBLING");
      expect(r.stdout).toContain("OWN_CHILD");
    } finally {
      sibling.kill();
    }
  });

  it("lets the agent commit and branch in its worktree, but not touch the shared repo's config or hooks", () => {
    const r = repoWithWorktree();
    const repo = repoGrant(r.bare, r.ticket);
    const env = { ...GIT_ID, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "gc.auto", GIT_CONFIG_VALUE_0: "0" };
    const out = fenced(
      r.ticket,
      [
        'echo b > b.txt && git add b.txt && git commit -qm "agent work" && echo COMMITTED',
        "git branch scratch && echo BRANCHED",
        "echo c > c.txt && git stash -q -u && git stash pop -q && echo STASHED",
        "git config core.fsmonitor 'touch /tmp/pwned' && echo CONFIG_WRITTEN",
        `echo 'touch /tmp/pwned' > "${path.join(r.bare, "hooks", "post-checkout")}" && echo HOOK_WRITTEN`,
      ].join("; "),
      env,
      { repo },
    );
    expect(out.stdout).toContain("COMMITTED");
    expect(out.stdout).toContain("BRANCHED");
    expect(out.stdout).toContain("STASHED");
    expect(out.stdout).not.toContain("CONFIG_WRITTEN");
    expect(out.stdout).not.toContain("HOOK_WRITTEN");
    expect(r.git(["log", "-1", "--format=%s", "bossman/t1"], r.bare)).toBe("agent work");
    expect(readFileSync(path.join(r.bare, "config"), "utf8")).not.toContain("fsmonitor");
    expect(existsSync(path.join(r.bare, "hooks", "post-checkout"))).toBe(false);
  });

  // Freddy's probe on BOS-315. Landlock checks the path, not the inode, so a hardlink made before
  // the fence (by an unfenced session, into a worktree or agent home kept between runs) still
  // writes through to the file outside. This pins that known gap; a fenced agent can't make one.
  it("can't make a hardlink to a file outside it; one made before the fence still writes through", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-fence-"));
    const inside = path.join(root, "in");
    const outside = path.join(root, "out");
    mkdirSync(inside);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "f"), "x");

    const made = fenced(inside, `ln "${path.join(outside, "f")}" "${path.join(inside, "new")}" && echo LINKED`);
    expect(made.stdout).not.toContain("LINKED");
    expect(existsSync(path.join(inside, "new"))).toBe(false);

    execFileSync("ln", [path.join(outside, "f"), path.join(inside, "old")]);
    fenced(inside, `printf y > "${path.join(inside, "old")}"`);
    expect(readFileSync(path.join(outside, "f"), "utf8")).toBe("y");
  });

  it("reports this host in the self-test, with a working probe", () => {
    const report = sandboxSelfTest();
    expect(report.landlockAbi).toBe(abi);
    expect(report.probe).toBe(true);
    expect(report.level).toBe(levelFor(abi).level);
  });
});

describe("applyCheckSlots (BOSSMAN_CHECK_SLOTS)", () => {
  const proofOf = (d: string) => path.join(d, "gate", "check-pair-passed");
  it("writes a slot count for 2 or more and removes it again for 1; unset keeps a hand-made note but drops its own number", () => {
    const d = mkdtempSync(path.join(tmpdir(), "slots-"));
    expect(applyCheckSlots(d, "2")).toBe(2);
    expect(readFileSync(proofOf(d), "utf8").trim()).toBe("2");
    expect(applyCheckSlots(d, "1")).toBe(1);
    expect(existsSync(proofOf(d))).toBe(false);
    expect(applyCheckSlots(d, "lots")).toBe(1);
    expect(applyCheckSlots(d, "99")).toBe(1);
    expect(existsSync(proofOf(d))).toBe(false);
    applyCheckSlots(d, "3");
    expect(applyCheckSlots(d, undefined)).toBe(0);
    expect(existsSync(proofOf(d))).toBe(false);
    mkdirSync(path.join(d, "gate"), { recursive: true });
    writeFileSync(proofOf(d), "A=600s B=640s no OOM");
    expect(applyCheckSlots(d, "")).toBe(0);
    expect(existsSync(proofOf(d))).toBe(true);
  });
});
